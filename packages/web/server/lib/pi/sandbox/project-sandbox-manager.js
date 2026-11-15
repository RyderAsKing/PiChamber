import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { MAIN_DAEMON_KEY, publicDaemonStreamId } from '../session-daemon/daemon-pool.js';

import { createOpenUrlIntake } from '../../open-url/intake.js';
import { findPiSessionJsonlById } from '../session-daemon/session-jsonl.js';
import { createSandboxedPiSessionDaemonSupervisor } from '../session-daemon/supervisor.js';
import { prepareProjectSandbox } from './project-sandbox.js';
import { normalizeProjectSandboxSetting, readProjectSandbox } from './project-sandbox-setting.js';

// Commands a sandboxed project may run on the main daemon while its own
// daemon is stopped or unavailable. Listing reads transcripts on disk and
// runs no Pi code; an archive signal only publishes an event. Everything
// else would start a Pi runtime (extensions, tools) and must run in the
// sandbox or not at all.
const MAIN_DAEMON_READS = new Set(['sessions.list', 'archive.publish']);
// Polling and status reads that do not count as using a project: the
// sidebar and pending-input polls must not keep an idle daemon running.
const PASSIVE_COMMANDS = new Set(['sessions.list', 'sessions.pendingInput', 'sessions.sendReceipt']);
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const GIT_PROJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DEFAULT_IDLE_STOP_MS = 10 * 60_000;
const DEFAULT_IDLE_CHECK_MS = 60_000;
const DEFAULT_DRAIN_POLL_MS = 1_000;
// How long a token must stay valid after the main daemon's refresh before
// a sandbox daemon starts or keeps running (Pi itself refreshes inside the
// last five minutes, which a sandbox cannot do: auth.json is read-only).
const OAUTH_MIN_VALIDITY_MS = 30 * 60_000;
// A send made from the old daemon's epoch right after its session moved is
// accepted by the new daemon for this long (see `sendEpochFor`).
const MOVED_EPOCH_TTL_MS = 2 * 60_000;
const MOVED_LIMIT = 4096;
const DRAIN_FAILURE_LIMIT = 3;
// Pi config files a sandbox reads through single-file grants. Replacing one
// (write temp file, rename) leaves a running sandbox reading nothing, so a
// change to any of them replaces the daemon at its next idle edge.
const PI_CONFIG_FILES = ['settings.json', 'auth.json', 'models.json', 'trust.json', 'mcp.json'];
// Pi's own error text when a turn needs an OAuth token refresh it cannot
// write (`refreshStoredOAuthCredential` in pi-ai): the sandbox's auth.json
// is read-only, so the refresh must happen in the main daemon.
const OAUTH_REFRESH_FAILURE = /\b(?:OAuth refresh failed|Credential store modify failed) for \S/;

const sandboxUnavailable = (reason) => {
  const error = new Error('The project sandbox is unavailable.');
  error.code = 'SANDBOX_UNAVAILABLE';
  error.reason = typeof reason === 'string' && REASON_PATTERN.test(reason) ? reason : 'SANDBOX_LAUNCH_FAILED';
  return error;
};

const reasonOf = (error) => (error?.code === 'SANDBOX_UNAVAILABLE' ? error.reason : error?.code);

/**
 * The project id PiChamber's worktrees are filed under
 * (`<dataDir>/worktree/<id>`), read from `<project>/.git/pichamber`. A
 * sandboxed agent can write that file, so only a commit-hash-shaped id is
 * accepted; anything else grants no worktree folder.
 */
const readGitProjectId = async (projectRoot) => {
  try {
    const id = (await readFile(join(projectRoot, '.git', 'pichamber'), 'utf8')).trim();
    return GIT_PROJECT_ID.test(id) ? id : null;
  } catch {
    return null;
  }
};

const listWorktreeDirs = async (worktreeRoot) => {
  try {
    const entries = await readdir(worktreeRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(worktreeRoot, entry.name)).sort();
  } catch {
    return [];
  }
};

const settingKey = (setting) => JSON.stringify(setting);


const isEntryList = (value) => Array.isArray(value) && value.every((item) => item
  && typeof item.sessionId === 'string' && item.sessionId.length > 0
  && typeof item.directory === 'string' && isAbsolute(item.directory));

/** Whether a sandboxed turn's error is Pi failing to refresh an OAuth token. */
const isOAuthRefreshFailure = (message) => typeof message === 'string' && OAUTH_REFRESH_FAILURE.test(message);

/**
 * Owns the sandbox daemons of sandboxed projects (#242). For every project
 * whose setting is `nono` it registers one runtime in the daemon pool that
 * owns the project root and its worktree root, so nothing in that project
 * can route to the main daemon. The daemon starts on the first Pi-running
 * command, through the launcher, with grants built from the project, its
 * existing worktrees and extras, and a network allowlist of the signed-in
 * providers' hosts plus the project's own. Each daemon gets its own Open
 * request intake. When the launcher or the launch fails, every Pi-running
 * command fails with SANDBOX_UNAVAILABLE and the reason; listing still works.
 * A daemon with no resident sessions for `idleStopMs` stops.
 *
 * Moves (#247). Whenever a project's sessions change daemons (turned on or
 * off, a changed setting, a stale daemon after a Pi config change, a new
 * worktree), the old daemon drains: it is asked to release the project's
 * folders, idle sessions move at once, and busy ones (mid-turn, compacting,
 * custom surface, pending dialog) stay until their next idle edge. Every
 * move is announced through the pool so clients refetch the session.
 */
export const createProjectSandboxManager = ({
  daemonPool,
  uiSettingsStore,
  launcher,
  dataDir,
  // The real Pi agent folder, or an (async) function returning it, so the
  // Pi SDK loads only once a project is sandboxed.
  agentDir,
  getServerPort = () => null,
  hasConnectedDevices = () => false,
  // Extra supervisor options (port, version); a function is read at launch
  // so the bound port is known.
  supervisorOptions = {},
  readRoots,
  createSupervisor = createSandboxedPiSessionDaemonSupervisor,
  prepareSandbox = prepareProjectSandbox,
  createIntake = createOpenUrlIntake,
  // Folders switched from sandboxed to off whose Pi trust must stay "ask"
  // (sandbox/trust-ask.js); without one nothing is recorded.
  trustAsk,
  idleStopMs = DEFAULT_IDLE_STOP_MS,
  idleCheckMs = DEFAULT_IDLE_CHECK_MS,
  drainPollMs = DEFAULT_DRAIN_POLL_MS,
  now = Date.now,
  setInterval: startTimer = setInterval,
  clearInterval: stopTimer = clearInterval,
  log = (message, code) => console.warn(`[pi-sandbox] ${message}`, code ?? ''),
}) => {
  const projects = new Map();
  // Daemons still holding sessions of a folder they no longer own.
  const drains = new Set();
  // sessionId -> drain still running it.
  const pendingBySession = new Map();
  // sessionId -> { fromEpoch, at } for sessions that just moved.
  const moved = new Map();
  // folder -> pool keys draining it.
  const drainingKeys = new Map();
  let probe = null;
  let probing = null;
  let timer = null;
  let drainTimer = null;
  let stopped = false;
  let agentDirValue = null;
  let oauthRefreshing = null;
  const resolveAgentDir = async () => {
    if (!agentDirValue) agentDirValue = resolve(typeof agentDir === 'function' ? await agentDir() : agentDir);
    return agentDirValue;
  };

  const probeLauncher = async ({ recheck = false } = {}) => {
    if (probe && !recheck) return probe;
    if (!probing) {
      probing = launcher.probe()
        .then((result) => {
          probe = result?.available === true
            ? { available: true, version: typeof result.version === 'string' ? result.version : undefined }
            : { available: false, code: REASON_PATTERN.test(result?.code ?? '') ? result.code : 'SETUP_CHECK_FAILED' };
          return probe;
        })
        .catch(() => {
          probe = { available: false, code: 'SETUP_CHECK_FAILED' };
          return probe;
        })
        .finally(() => { probing = null; });
    }
    return probing;
  };

  // Identity of the Pi config files a sandbox pins: a replaced, rewritten,
  // added or removed file changes it.
  const configFingerprint = async () => {
    const dir = await resolveAgentDir();
    const parts = await Promise.all(PI_CONFIG_FILES.map(async (name) => {
      try {
        const info = await stat(join(dir, name));
        return `${name}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
      } catch {
        return `${name}:-`;
      }
    }));
    return parts.join('|');
  };

  // Ask the main daemon to refresh OAuth tokens near expiry. Shared by
  // concurrent callers; a failure (or an older daemon) only logs, because a
  // sandbox can still use API keys and a stale token fails its own turn.
  const refreshOAuth = () => {
    if (!oauthRefreshing) {
      oauthRefreshing = (async () => {
        const main = daemonPool.main();
        if (!main) return;
        try {
          await main.request('providers.oauth.refresh', { minValidityMs: OAUTH_MIN_VALIDITY_MS });
        } catch (error) {
          log('OAuth refresh failed', error?.code);
        }
      })().finally(() => { oauthRefreshing = null; });
    }
    return oauthRefreshing;
  };

  const notifyPool = (entry) => {
    if (projects.get(entry.projectId) !== entry) return;
    daemonPool.register(entry.key, { runtime: entry.runtime, directories: entry.directories });
  };

  const closeWatch = (entry) => {
    const close = entry.watch;
    entry.watch = null;
    if (typeof close === 'function') {
      try { close(); } catch {}
    }
  };

  const stopDaemon = async (entry) => {
    const { supervisor, intake } = entry;
    if (!supervisor) return;
    entry.supervisor = null;
    entry.intake = null;
    entry.idleSince = null;
    closeWatch(entry);
    entry.stopping = (async () => {
      await Promise.allSettled([supervisor.stop(), intake?.stop()]);
    })();
    try {
      await entry.stopping;
    } finally {
      entry.stopping = null;
    }
    notifyPool(entry);
  };

  // --- Draining -----------------------------------------------------------

  const applyDraining = (directory) => {
    const keys = drainingKeys.get(directory);
    daemonPool.setDraining(directory, keys ? [...keys] : []);
  };

  const rememberMoved = (sessionId, fromEpoch) => {
    moved.delete(sessionId);
    if (typeof fromEpoch === 'string' && fromEpoch.length > 0) moved.set(sessionId, { fromEpoch, at: now() });
    while (moved.size > MOVED_LIMIT) moved.delete(moved.keys().next().value);
  };

  const finishDrain = async (drain) => {
    if (!drains.delete(drain)) return;
    for (const [sessionId, owner] of [...pendingBySession]) {
      if (owner !== drain) continue;
      pendingBySession.delete(sessionId);
      rememberMoved(sessionId, drain.epoch);
      daemonPool.announceMove(sessionId, drain.pending.get(sessionId));
    }
    for (const directory of drain.directories) {
      const keys = drainingKeys.get(directory);
      keys?.delete(drain.key);
      if (keys && keys.size === 0) drainingKeys.delete(directory);
      applyDraining(directory);
    }
    if (drain.stop) await drain.stop();
    if (drain.unregister) {
      // Only drop the key while it still holds this drain's runtime; a
      // later registration under the same key is someone else's.
      daemonPool.unregister(drain.key, drain.runtime);
    }
  };

  // Ask the draining daemon to let go of its folders: idle sessions are
  // disposed now, busy ones at their next idle edge. A session gone from
  // both lists since the last poll was disposed in between.
  const pollDrain = (drain) => {
    if (drain.polling) return drain.polling;
    drain.polling = (async () => {
      let result;
      try {
        result = await drain.runtime.request('sessions.release', { directories: drain.directories });
        if (!isEntryList(result?.released) || !isEntryList(result?.pending)) throw Object.assign(new Error('malformed'), { code: 'DAEMON_PROTOCOL_MISMATCH' });
        drain.failures = 0;
      } catch (error) {
        drain.failures += 1;
        // A daemon that is gone holds nothing; one that keeps failing is
        // given up on (session leases still keep a session in one daemon).
        if (error?.code === 'DAEMON_UNAVAILABLE' || drain.failures >= DRAIN_FAILURE_LIMIT) {
          log('Draining daemon stopped answering', error?.code);
          await finishDrain(drain);
        }
        return;
      }
      if (typeof result.streamEpoch === 'string' && result.streamEpoch.length > 0) drain.epoch = result.streamEpoch;
      const stillPending = new Map(result.pending.map((item) => [item.sessionId, item.directory]));
      const moves = [];
      for (const item of result.released) {
        if (!stillPending.has(item.sessionId)) moves.push([item.sessionId, item.directory]);
      }
      for (const [sessionId, directory] of drain.pending) {
        if (!stillPending.has(sessionId) && !moves.some(([id]) => id === sessionId)) moves.push([sessionId, directory]);
      }
      const newlyPending = [...stillPending].filter(([sessionId]) => !drain.pending.has(sessionId));
      drain.pending = stillPending;
      for (const [sessionId] of stillPending) pendingBySession.set(sessionId, drain);
      for (const [sessionId, directory] of moves) {
        if (pendingBySession.get(sessionId) === drain) pendingBySession.delete(sessionId);
        rememberMoved(sessionId, drain.epoch);
        daemonPool.announceMove(sessionId, directory);
      }
      // A session that now waits to switch modes changed state too: clients
      // refetch it and learn it switches after this turn. A daemon
      // replacement is not a switch, so nothing changes for them yet.
      if (drain.to) for (const [sessionId, directory] of newlyPending) daemonPool.announceMove(sessionId, directory);
      if (stillPending.size === 0) await finishDrain(drain);
    })().finally(() => { drain.polling = null; });
    return drain.polling;
  };

  const ensureDrainTimer = () => {
    if (drainTimer || stopped) return;
    drainTimer = startTimer(() => {
      for (const drain of [...drains]) pollDrain(drain).catch(() => {});
    }, drainPollMs);
    drainTimer?.unref?.();
  };

  /**
   * Start draining `directories` out of the daemon `key`/`runtime`. `to` is
   * the mode its sessions switch to (`nono` or `off`), or null when only
   * the daemon is replaced (setting or config change), which clients do not
   * see as a switch. `sandboxed` says whether the old daemon is a sandbox.
   */
  const startDrain = async ({ key, runtime, directories, to = null, sandboxed, stop, unregister = false }) => {
    const drain = {
      key,
      runtime,
      directories: [...directories],
      to,
      sandboxed,
      stop,
      unregister,
      stream: key === MAIN_DAEMON_KEY ? undefined : publicDaemonStreamId(key),
      pending: new Map(),
      epoch: undefined,
      failures: 0,
      polling: null,
    };
    drains.add(drain);
    for (const directory of drain.directories) {
      if (!drainingKeys.has(directory)) drainingKeys.set(directory, new Set());
      drainingKeys.get(directory).add(key);
      applyDraining(directory);
    }
    ensureDrainTimer();
    await pollDrain(drain);
  };

  /**
   * Hand the running sandbox daemon of `entry` over to a drain, so the
   * entry's next command starts a fresh one. The old daemon keeps its pool
   * key (and so its event stream) but owns no folder; the entry moves to a
   * new key.
   */
  const retire = async (entry, { to = null, removed = false } = {}) => {
    const { supervisor, intake } = entry;
    if (!supervisor) return;
    entry.supervisor = null;
    entry.intake = null;
    entry.idleSince = null;
    closeWatch(entry);
    const oldKey = entry.key;
    const directories = entry.launchedDirectories ?? entry.directories;
    const runtime = {
      isLive: () => true,
      request: (command, payload) => supervisor.request(command, payload),
      subscribe: (options) => supervisor.subscribe(options),
      health: () => supervisor.health(),
    };
    daemonPool.register(oldKey, { runtime, directories: [] });
    if (!removed) {
      entry.generation += 1;
      entry.key = `sandbox:${entry.projectId}:${entry.generation}`;
      notifyPool(entry);
    }
    await startDrain({
      key: oldKey,
      runtime,
      directories,
      to,
      sandboxed: true,
      unregister: true,
      stop: async () => { await Promise.allSettled([supervisor.stop(), intake?.stop()]); },
    });
  };

  // --- Launching ----------------------------------------------------------

  const launch = async (entry) => {
    const status = await probeLauncher();
    if (!status.available) throw sandboxUnavailable(status.code);
    if (entry.invalid) throw sandboxUnavailable('INVALID_SANDBOX_SETTING');
    // auth.json is read-only in the sandbox: tokens are refreshed by the
    // main daemon first, and the config identity is taken afterwards so
    // that refresh does not make the new daemon stale at once.
    await refreshOAuth();
    const fingerprint = await configFingerprint();
    let providerHosts;
    try {
      const main = daemonPool.main();
      if (!main) throw new Error('main daemon unavailable');
      const result = await main.request('providers.hosts');
      if (!Array.isArray(result?.hosts) || result.hosts.some((host) => typeof host !== 'string')) throw new Error('malformed');
      providerHosts = result.hosts;
    } catch {
      throw sandboxUnavailable('PROVIDER_HOSTS_UNAVAILABLE');
    }
    const { setting } = entry;
    const worktreeDirs = entry.worktreeRoot ? await listWorktreeDirs(entry.worktreeRoot) : [];
    let supervisor;
    try {
      const sandbox = await prepareSandbox({
        dataDir,
        agentDir: await resolveAgentDir(),
        projectRoot: entry.projectRoot,
        ...(entry.gitProjectId ? { projectId: entry.gitProjectId } : {}),
        worktreeDirs,
        serverPort: getServerPort(),
        ...(readRoots ? { readRoots } : {}),
        extraFolders: setting.extraFolders,
        allowHosts: [...providerHosts, ...setting.allowHosts],
        allowLocalPorts: setting.allowLocalPorts,
      });
      const options = typeof supervisorOptions === 'function' ? supervisorOptions() : supervisorOptions;
      supervisor = await createSupervisor({ ...options, dataDir, launcher, sandbox });
    } catch (error) {
      throw sandboxUnavailable(reasonOf(error));
    }
    // Bound before the daemon starts so its first `$BROWSER` call reaches it.
    const intake = createIntake({
      socketPath: supervisor.paths?.openUrlSocket,
      publish: (payload) => supervisor.request('openUrl.publish', payload),
      hasConnectedDevices,
    });
    try {
      await intake.start();
    } catch (error) {
      log('Open request intake unavailable', error?.code);
    }
    try {
      await supervisor.start();
    } catch (error) {
      await Promise.allSettled([intake.stop(), supervisor.stop?.()]);
      throw sandboxUnavailable(reasonOf(error));
    }
    return {
      supervisor,
      intake,
      settingKey: entry.settingKey,
      fingerprint,
      worktreeDirs,
      directories: [...entry.directories],
    };
  };

  // A sandboxed turn that failed because Pi could not refresh its OAuth
  // token: the main daemon refreshes, and the changed auth.json replaces
  // this daemon at its next idle edge.
  const watchDaemon = async (entry, supervisor) => {
    try {
      const close = await supervisor.subscribe({
        onEvent: (frame) => {
          if (frame?.event !== 'session.error' || !isOAuthRefreshFailure(frame.payload?.message)) return;
          refreshOAuth()
            .then(() => checkStale(entry))
            .catch((error) => log('OAuth recovery failed', error?.code));
        },
        onError: () => {},
      });
      if (entry.supervisor === supervisor && !entry.watch) entry.watch = close;
      else if (typeof close === 'function') close();
    } catch (error) {
      log('Sandbox daemon event watch unavailable', error?.code);
    }
  };

  const ensureStarted = async (entry) => {
    if (entry.supervisor) return entry.supervisor;
    if (entry.stopping) await entry.stopping;
    if (!entry.starting) {
      entry.starting = launch(entry)
        .then(async (launched) => {
          const { supervisor, intake } = launched;
          if (projects.get(entry.projectId) !== entry || stopped || launched.settingKey !== entry.settingKey) {
            await Promise.allSettled([supervisor.stop(), intake.stop()]);
            throw sandboxUnavailable('SANDBOX_SETTING_CHANGED');
          }
          entry.supervisor = supervisor;
          entry.intake = intake;
          entry.launchedKey = launched.settingKey;
          entry.launchedFingerprint = launched.fingerprint;
          entry.launchedWorktrees = launched.worktreeDirs;
          entry.launchedDirectories = launched.directories;
          entry.failure = null;
          entry.idleSince = null;
          notifyPool(entry);
          void watchDaemon(entry, supervisor);
          return supervisor;
        })
        .catch((error) => {
          entry.failure = error.reason;
          throw error;
        })
        .finally(() => { entry.starting = null; });
    }
    return entry.starting;
  };

  const requestDirectory = (payload) => {
    const value = typeof payload?.directory === 'string' ? payload.directory : payload?.cwd;
    return typeof value === 'string' && isAbsolute(value) ? resolve(value) : null;
  };

  // A folder in the project's worktree root that the running daemon has no
  // grant for (a worktree added since it started).
  const isUngrantedWorktree = (entry, directory) => {
    if (!directory || !entry.worktreeRoot || !entry.launchedWorktrees) return false;
    const root = entry.worktreeRoot;
    if (directory === root || !directory.startsWith(`${root}/`)) return false;
    return !entry.launchedWorktrees.some((dir) => directory === dir || directory.startsWith(`${dir}/`));
  };

  const createRuntime = (entry) => ({
    // Only a running sandbox daemon is live: pending input and the
    // notification watcher fan out to it, and never start one.
    isLive: () => Boolean(entry.supervisor),
    request: async (command, payload) => {
      if (!entry.supervisor && MAIN_DAEMON_READS.has(command)) {
        const main = daemonPool.main();
        if (!main) throw Object.assign(new Error('The Pi session daemon is unavailable.'), { code: 'DAEMON_UNAVAILABLE' });
        const result = await main.request(command, payload);
        // The list answers for this project's stream, but live state in it
        // is numbered by the main daemon's: drop it. Sessions the main
        // daemon still runs here reach clients through the drain merge,
        // stamped with the main stream.
        if (command !== 'sessions.list' || !Array.isArray(result?.sessions)) return result;
        const { streamEpoch: _mainEpoch, ...rest } = result;
        return {
          ...rest,
          sessions: result.sessions.map((item) => {
            if (!item || typeof item !== 'object') return item;
            const { live: _live, inputState: _inputState, ...row } = item;
            return row;
          }),
        };
      }
      const active = !PASSIVE_COMMANDS.has(command);
      if (active) {
        entry.inFlight += 1;
        entry.lastUsedAt = now();
      }
      try {
        // A new worktree changes the grants: the running daemon drains and
        // a new one with the worktree starts.
        if (active && entry.supervisor && isUngrantedWorktree(entry, requestDirectory(payload))) await retire(entry);
        const supervisor = await ensureStarted(entry);
        return await supervisor.request(command, payload);
      } finally {
        if (active) {
          entry.inFlight -= 1;
          entry.lastUsedAt = now();
        }
      }
    },
    subscribe: (options) => {
      if (!entry.supervisor) throw Object.assign(new Error('The project sandbox daemon is not running.'), { code: 'DAEMON_UNAVAILABLE' });
      return entry.supervisor.subscribe(options);
    },
    health: () => {
      if (!entry.supervisor) throw Object.assign(new Error('The project sandbox daemon is not running.'), { code: 'DAEMON_UNAVAILABLE' });
      return entry.supervisor.health();
    },
  });

  // A running daemon whose Pi config files or worktrees changed since it
  // started is replaced: it drains, and the next command starts a new one.
  const checkStale = async (entry) => {
    if (!entry.supervisor || projects.get(entry.projectId) !== entry) return false;
    const supervisor = entry.supervisor;
    const [fingerprint, worktrees] = await Promise.all([
      configFingerprint(),
      entry.worktreeRoot ? listWorktreeDirs(entry.worktreeRoot) : Promise.resolve([]),
    ]);
    if (entry.supervisor !== supervisor) return false;
    const stale = fingerprint !== entry.launchedFingerprint
      || JSON.stringify(worktrees) !== JSON.stringify(entry.launchedWorktrees ?? []);
    if (stale) await retire(entry);
    return stale;
  };

  // Stop a daemon once it has had no resident sessions and no requests for
  // `idleStopMs`, and replace one whose config went stale.
  const checkIdle = async () => {
    for (const entry of projects.values()) {
      const { supervisor } = entry;
      if (!supervisor) continue;
      try {
        if (await checkStale(entry)) continue;
      } catch (error) {
        log('Sandbox staleness check failed', error?.code);
      }
      if (entry.supervisor !== supervisor || entry.inFlight > 0) continue;
      let resident;
      try {
        resident = (await supervisor.request('runtime.health'))?.residentSessions;
      } catch {
        continue;
      }
      if (entry.supervisor !== supervisor || entry.inFlight > 0) continue;
      if (!Number.isInteger(resident) || resident > 0) {
        entry.idleSince = null;
        continue;
      }
      const since = Math.max(entry.idleSince ?? now(), entry.lastUsedAt ?? 0);
      entry.idleSince = entry.idleSince ?? now();
      if (now() - since >= idleStopMs) await stopDaemon(entry);
    }
    if (trustResets.size > 0) await resetTrust([...trustResets]);
  };

  const ensureTimer = () => {
    if (timer || stopped) return;
    timer = startTimer(() => checkIdle().catch(() => {}), idleCheckMs);
    timer?.unref?.();
  };

  // Folders whose Pi trust still has to be set back to "ask" (the main
  // daemon was unavailable when the project was switched off).
  const trustResets = new Set();
  const resetTrust = async (directories) => {
    for (const directory of directories) trustResets.add(directory);
    try {
      await trustAsk?.add(directories);
    } catch (error) {
      log('Could not record the trust reset', error?.code);
    }
    const main = daemonPool.main();
    if (!main) return;
    for (const directory of directories) {
      try {
        await main.request('settings.set', { scope: 'project', directory, trust: null });
        trustResets.delete(directory);
      } catch (error) {
        // A folder removed since then has no trust to reset.
        if (error?.code === 'INVALID_ARGUMENT' || error?.code === 'INVALID_DIRECTORY') trustResets.delete(directory);
        else log('Could not reset project trust', error?.code);
      }
    }
  };

  // A project that stops being sandboxed: its trust goes back to "ask" so
  // project extensions written in the sandbox do not run outside it
  // unasked, and its daemon drains into the main daemon.
  const removeEntry = async (entry, { switchOff = true } = {}) => {
    projects.delete(entry.projectId);
    if (entry.starting) await entry.starting.catch(() => {});
    if (switchOff && !stopped) {
      const worktrees = entry.worktreeRoot ? await listWorktreeDirs(entry.worktreeRoot) : [];
      await resetTrust([entry.projectRoot, ...worktrees]);
    }
    if (entry.supervisor && switchOff && !stopped) {
      await retire(entry, { to: 'off', removed: true });
      return;
    }
    daemonPool.unregister(entry.key);
    await stopDaemon(entry);
  };

  /** Bring the pool in line with the stored project settings. */
  const reconcile = async () => {
    if (stopped) return;
    const settings = await uiSettingsStore.read();
    const stored = Array.isArray(settings.projects) ? settings.projects : [];
    const wanted = new Map();
    for (const project of stored) {
      if (!project || typeof project.id !== 'string' || typeof project.path !== 'string' || !isAbsolute(project.path)) continue;
      const { setting, invalid } = readProjectSandbox(project);
      if (!invalid && setting?.mode !== 'nono') continue;
      wanted.set(project.id, { projectRoot: resolve(project.path), setting: setting ?? { mode: 'nono', allowHosts: [], allowLocalPorts: [], extraFolders: [] }, invalid: Boolean(invalid) });
    }
    for (const entry of [...projects.values()]) {
      const next = wanted.get(entry.projectId);
      if (!next || next.projectRoot !== entry.projectRoot) await removeEntry(entry);
    }
    for (const [projectId, next] of wanted) {
      const gitProjectId = await readGitProjectId(next.projectRoot);
      const worktreeRoot = gitProjectId ? join(dataDir, 'worktree', gitProjectId) : null;
      const directories = worktreeRoot ? [next.projectRoot, worktreeRoot] : [next.projectRoot];
      let entry = projects.get(projectId);
      const created = !entry;
      if (!entry) {
        entry = {
          projectId,
          key: `sandbox:${projectId}`,
          generation: 0,
          projectRoot: next.projectRoot,
          supervisor: null,
          intake: null,
          watch: null,
          starting: null,
          stopping: null,
          failure: null,
          inFlight: 0,
          idleSince: null,
          lastUsedAt: null,
          launchedKey: null,
        };
        entry.runtime = createRuntime(entry);
        projects.set(projectId, entry);
      }
      const changed = entry.settingKey !== settingKey(next.setting) || entry.invalid !== next.invalid;
      Object.assign(entry, {
        setting: next.setting,
        settingKey: settingKey(next.setting),
        invalid: next.invalid,
        gitProjectId,
        worktreeRoot,
        directories,
      });
      if (changed) entry.failure = null;
      daemonPool.register(entry.key, { runtime: entry.runtime, directories });
      // Sessions the main daemon runs in a newly sandboxed project move
      // into the sandbox; a changed setting replaces a running daemon.
      const main = daemonPool.main();
      if (created && main) {
        await startDrain({ key: MAIN_DAEMON_KEY, runtime: main, directories, to: 'nono', sandboxed: false });
      } else if (changed && entry.supervisor && entry.launchedKey !== entry.settingKey) {
        await retire(entry);
      }
    }
    if (projects.size > 0) ensureTimer();
  };

  const availabilityOf = (entry, status) => {
    if (!entry) return { state: 'off' };
    if (entry.invalid) return { state: 'unavailable', reason: 'INVALID_SANDBOX_SETTING' };
    if (status && !status.available) return { state: 'unavailable', reason: status.code };
    if (entry.failure) return { state: 'unavailable', reason: entry.failure };
    return { state: 'available' };
  };

  const projectView = (project, status) => {
    const { setting } = readProjectSandbox(project);
    const entry = projects.get(project.id);
    const mode = entry ? 'nono' : 'off';
    return {
      projectId: project.id,
      mode,
      launcher: mode === 'off' ? null : 'nono',
      availability: availabilityOf(entry, status),
      allowHosts: setting?.allowHosts ?? [],
      allowLocalPorts: setting?.allowLocalPorts ?? [],
      extraFolders: setting?.extraFolders ?? [],
    };
  };

  const listProjects = async () => {
    const settings = await uiSettingsStore.read();
    const stored = (Array.isArray(settings.projects) ? settings.projects : [])
      .filter((project) => project && typeof project.id === 'string');
    const status = projects.size > 0 ? await probeLauncher() : probe;
    return stored.map((project) => projectView(project, status));
  };

  const sandboxForDirectory = (directory) => {
    const owner = daemonPool.forDirectory(directory);
    for (const entry of projects.values()) {
      if (entry.runtime === owner) return { launcher: launcher.id };
    }
    return null;
  };

  return {
    /** Launcher state for the public status route (no paths, no raw output). */
    launcherStatus: async ({ recheck = false } = {}) => {
      const status = await probeLauncher({ recheck });
      return [{
        id: launcher.id,
        available: status.available,
        ...(status.available && status.version ? { version: status.version } : {}),
        ...(!status.available ? { reason: status.code } : {}),
      }];
    },
    listProjects,
    /** Save one project's setting, apply it, and return its public state. */
    setProjectSandbox: async (projectId, value) => {
      const setting = normalizeProjectSandboxSetting(value);
      await uiSettingsStore.setProjectSandbox(projectId, setting);
      await reconcile();
      return (await listProjects()).find((project) => project.projectId === projectId);
    },
    reconcile,
    /** Whether any project is sandboxed (directory-less session commands
     *  then route by the transcript's folder). */
    hasSandboxedProjects: () => projects.size > 0,
    /** The launcher a directory's sessions run under, or null. */
    sandboxFor: sandboxForDirectory,
    /**
     * Where a session runs right now, for its public row: `sandboxed` when
     * a sandbox daemon runs it, and `pendingSwitch: { to }` while it waits
     * in the old daemon to switch mode after its turn.
     */
    sessionState: (sessionId, directory) => {
      const drain = pendingBySession.get(sessionId);
      if (drain) {
        return {
          sandboxed: drain.sandboxed,
          ...(drain.to ? { pendingSwitch: { to: drain.to } } : {}),
        };
      }
      return { sandboxed: Boolean(sandboxForDirectory(directory)) };
    },
    /**
     * The daemon still running a session that waits to move: `{ runtime,
     * stream }` (stream undefined for the main daemon), or null.
     */
    drainingSession: (sessionId) => {
      const drain = pendingBySession.get(sessionId);
      return drain ? { runtime: drain.runtime, stream: drain.stream } : null;
    },
    /**
     * The epoch a send should carry on `runtime`. A client that sends right
     * after its session moved, before it has seen the new daemon's first
     * frame, still holds the old daemon's epoch; for a short while that one
     * epoch is mapped to the new daemon's current epoch. Any other epoch is
     * passed through, so the daemon still refuses stale sends.
     */
    sendEpochFor: async (sessionId, epoch, runtime) => {
      const record = moved.get(sessionId);
      if (!record || record.fromEpoch !== epoch) return epoch;
      if (now() - record.at > MOVED_EPOCH_TTL_MS) {
        moved.delete(sessionId);
        return epoch;
      }
      try {
        const health = await runtime.request('runtime.health');
        return typeof health?.streamEpoch === 'string' && health.streamEpoch.length > 0 ? health.streamEpoch : epoch;
      } catch {
        return epoch;
      }
    },
    /**
     * PiChamber wrote Pi config (models, settings, credentials, trust):
     * running sandbox daemons drain and are replaced.
     */
    configChanged: async () => {
      for (const entry of [...projects.values()]) {
        if (entry.supervisor) await retire(entry);
      }
    },
    /** The folder a persisted session belongs to, from its transcript header. */
    directoryForSession: async (sessionId) => {
      const found = await findPiSessionJsonlById({ sessionId, agentDir: await resolveAgentDir() });
      return typeof found?.cwd === 'string' && isAbsolute(found.cwd) ? found.cwd : null;
    },
    checkIdle,
    checkDrains: async () => {
      await Promise.allSettled([...drains].map(pollDrain));
    },
    stop: async () => {
      stopped = true;
      if (timer) stopTimer(timer);
      if (drainTimer) stopTimer(drainTimer);
      timer = null;
      drainTimer = null;
      await Promise.allSettled([...projects.values()].map((entry) => removeEntry(entry, { switchOff: false })));
      await Promise.allSettled([...drains].map(async (drain) => {
        drains.delete(drain);
        await drain.stop?.();
      }));
    },
  };
};
