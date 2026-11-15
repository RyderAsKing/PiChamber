import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { createOpenUrlIntake } from '../../open-url/intake.js';
import { findPiSessionJsonlById } from '../session-daemon/session-jsonl.js';
import { createSandboxedPiSessionDaemonSupervisor } from '../session-daemon/supervisor.js';
import { prepareGitSandbox, prepareProjectSandbox } from './project-sandbox.js';
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
  prepareGit = prepareGitSandbox,
  createIntake = createOpenUrlIntake,
  idleStopMs = DEFAULT_IDLE_STOP_MS,
  idleCheckMs = DEFAULT_IDLE_CHECK_MS,
  now = Date.now,
  setInterval: startTimer = setInterval,
  clearInterval: stopTimer = clearInterval,
  log = (message, code) => console.warn(`[pi-sandbox] ${message}`, code ?? ''),
}) => {
  const projects = new Map();
  let probe = null;
  let probing = null;
  let timer = null;
  let stopped = false;
  let agentDirValue = null;
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

  const notifyPool = (entry) => {
    if (projects.get(entry.projectId) !== entry) return;
    daemonPool.register(entry.key, { runtime: entry.runtime, directories: entry.directories });
  };

  const stopDaemon = async (entry) => {
    const { supervisor, intake } = entry;
    if (!supervisor) return;
    entry.supervisor = null;
    entry.intake = null;
    entry.idleSince = null;
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

  const launch = async (entry) => {
    const status = await probeLauncher();
    if (!status.available) throw sandboxUnavailable(status.code);
    if (entry.invalid) throw sandboxUnavailable('INVALID_SANDBOX_SETTING');
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
    let supervisor;
    try {
      const sandbox = await prepareSandbox({
        dataDir,
        agentDir: await resolveAgentDir(),
        projectRoot: entry.projectRoot,
        ...(entry.gitProjectId ? { projectId: entry.gitProjectId } : {}),
        worktreeDirs: entry.worktreeRoot ? await listWorktreeDirs(entry.worktreeRoot) : [],
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
    return { supervisor, intake, settingKey: entry.settingKey };
  };

  const ensureStarted = async (entry) => {
    if (entry.supervisor) return entry.supervisor;
    if (entry.stopping) await entry.stopping;
    if (!entry.starting) {
      entry.starting = launch(entry)
        .then(async ({ supervisor, intake, settingKey: launchedKey }) => {
          if (projects.get(entry.projectId) !== entry || stopped) {
            await Promise.allSettled([supervisor.stop(), intake.stop()]);
            throw sandboxUnavailable('SANDBOX_SETTING_CHANGED');
          }
          entry.supervisor = supervisor;
          entry.intake = intake;
          entry.launchedKey = launchedKey;
          entry.failure = null;
          entry.idleSince = null;
          notifyPool(entry);
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

  const createRuntime = (entry) => ({
    // Only a running sandbox daemon is live: pending input and the
    // notification watcher fan out to it, and never start one.
    isLive: () => Boolean(entry.supervisor),
    request: async (command, payload) => {
      if (!entry.supervisor && MAIN_DAEMON_READS.has(command)) {
        const main = daemonPool.main();
        if (!main) throw Object.assign(new Error('The Pi session daemon is unavailable.'), { code: 'DAEMON_UNAVAILABLE' });
        return main.request(command, payload);
      }
      const active = !PASSIVE_COMMANDS.has(command);
      if (active) {
        entry.inFlight += 1;
        entry.lastUsedAt = now();
      }
      try {
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

  // Stop a daemon once it has had no resident sessions and no requests for
  // `idleStopMs`. A daemon started with an older setting stops at its first
  // idle check, so the next open uses the new grants.
  const checkIdle = async () => {
    for (const entry of projects.values()) {
      const { supervisor } = entry;
      if (!supervisor || entry.inFlight > 0) continue;
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
      const stale = entry.launchedKey !== entry.settingKey;
      if (stale || now() - since >= idleStopMs) await stopDaemon(entry);
    }
  };

  const ensureTimer = () => {
    if (timer || stopped) return;
    timer = startTimer(() => checkIdle().catch(() => {}), idleCheckMs);
    timer?.unref?.();
  };

  const removeEntry = async (entry) => {
    projects.delete(entry.projectId);
    daemonPool.unregister(entry.key);
    if (entry.starting) await entry.starting.catch(() => {});
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
      if (!entry) {
        entry = {
          projectId,
          key: `sandbox:${projectId}`,
          projectRoot: next.projectRoot,
          supervisor: null,
          intake: null,
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
    sandboxFor: (directory) => {
      const owner = daemonPool.forDirectory(directory);
      for (const entry of projects.values()) {
        if (entry.runtime === owner) return { launcher: launcher.id };
      }
      return null;
    },
    /**
     * How git runs for a folder (#248): null when the folder is in no
     * sandboxed project, so its git is unchanged; otherwise `{ binDir,
     * prepare }` whose `prepare({ argv, env })` wraps one short-lived
     * process in the launcher with the project's git grants. Throws
     * SANDBOX_UNAVAILABLE when the launcher or setting is unusable, never
     * falling back to unsandboxed git. Starts no daemon.
     */
    gitLaunchFor: async (directory) => {
      const owner = daemonPool.forDirectory(directory);
      const entry = [...projects.values()].find((item) => item.runtime === owner);
      if (!entry) return null;
      const status = await probeLauncher();
      if (!status.available) throw sandboxUnavailable(status.code);
      if (entry.invalid) throw sandboxUnavailable('INVALID_SANDBOX_SETTING');
      // Re-read: the first managed worktree writes the id after reconcile.
      const gitProjectId = await readGitProjectId(entry.projectRoot);
      const cacheKey = `${entry.settingKey}\0${gitProjectId ?? ''}`;
      if (entry.gitSandbox?.key !== cacheKey) {
        let sandbox;
        try {
          sandbox = await prepareGit({
            dataDir,
            projectRoot: entry.projectRoot,
            ...(gitProjectId ? { projectId: gitProjectId } : {}),
            serverPort: getServerPort(),
            extraFolders: entry.setting.extraFolders,
            allowHosts: entry.setting.allowHosts,
            allowLocalPorts: entry.setting.allowLocalPorts,
          });
        } catch (error) {
          throw sandboxUnavailable(reasonOf(error));
        }
        entry.gitSandbox = { key: cacheKey, sandbox };
      }
      const { sandbox } = entry.gitSandbox;
      return {
        binDir: sandbox.binDir,
        prepare: async ({ argv, env }) => {
          try {
            return await launcher.prepare({ argv, env, grants: sandbox.grants, network: sandbox.network, tmpDir: sandbox.tmpDir });
          } catch (error) {
            throw sandboxUnavailable(reasonOf(error));
          }
        },
      };
    },
    /** The folder a persisted session belongs to, from its transcript header. */
    directoryForSession: async (sessionId) => {
      const found = await findPiSessionJsonlById({ sessionId, agentDir: await resolveAgentDir() });
      return typeof found?.cwd === 'string' && isAbsolute(found.cwd) ? found.cwd : null;
    },
    checkIdle,
    stop: async () => {
      stopped = true;
      if (timer) stopTimer(timer);
      timer = null;
      await Promise.allSettled([...projects.values()].map(removeEntry));
    },
  };
};
