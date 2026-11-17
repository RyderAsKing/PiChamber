import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn as spawnChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { resolvePiChamberDataDir } from '../../pichamber-data-dir.js';
import { readSmallRegularFile } from '../../server/cross-process-lock.js';
import { resolveServerProfile } from '../../server/server-profile.js';
import { isLocalSessionDaemonEndpoint } from './session-daemon.js';
import { requestSessionDaemon, SessionDaemonClientError, subscribeSessionDaemon } from './ipc-client.js';

const PROTOCOL_VERSION = 1;
const OPERATION_TIMEOUT_MS = 5_000;
const DAEMON_READY_TIMEOUT_MS = 15_000;
// A sandbox daemon starts the same Node process behind nono's setup and its
// network proxy. On a slow machine two of them starting together took over
// 15 s; the start still fails closed, it only waits longer.
const SANDBOX_DAEMON_READY_TIMEOUT_MS = 45_000;
const RETRY_DELAY_MS = 100;
// sun_path holds 108 bytes on Linux and 104 on macOS, including the
// terminating NUL.
const maxUnixSocketPathBytes = (platform) => (platform === 'darwin' ? 103 : 107);
const DAEMON_ENTRYPOINT = fileURLToPath(new URL('./daemon-process.js', import.meta.url));

class PiSessionDaemonUnavailableError extends Error {
  constructor(code) {
    super('The Pi session daemon is unavailable.');
    this.code = code;
  }
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const rejectAfter = (promise, timeoutMs, code) => new Promise((resolvePromise, rejectPromise) => {
  const timer = setTimeout(() => rejectPromise(new SessionDaemonClientError(code)), timeoutMs);
  // The wrapped request owns its own timeout lifecycle; never hold process
  // shutdown on this outer deadline.
  timer.unref?.();
  promise.then(
    (value) => {
      clearTimeout(timer);
      resolvePromise(value);
    },
    (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    },
  );
});

const getWindowsOwnerKey = () => {
  try {
    return createHash('sha256').update(userInfo().username).digest('hex').slice(0, 16);
  } catch {
    return 'owner';
  }
};

const hasValidStateIdentity = (state) => (
  state
  && state.protocolVersion === PROTOCOL_VERSION
  && Number.isInteger(state.pid)
  && state.pid > 0
  && typeof state.endpoint === 'string'
  && typeof state.profileKey === 'string'
  && state.profileKey.length > 0
);

const isValidState = (state) => hasValidStateIdentity(state) && typeof state.startedAt === 'string';

const daemonEntrypointMatches = (state) => (
  typeof state?.entrypoint === 'string' && state.entrypoint === DAEMON_ENTRYPOINT
);

const isValidFailureState = (state) => hasValidStateIdentity(state)
  && state.state === 'failed'
  && typeof state.error?.code === 'string';

const isPermanentStartupFailure = (code) => code === 'MALFORMED_SESSION_JSONL' || code === 'SESSION_JSONL_UNREADABLE';

const buildSessionDaemonChildEnv = ({ env = {}, electronVersion } = {}) => {
  const next = { ...env };
  if (typeof electronVersion === 'string' && electronVersion.length > 0) {
    next.ELECTRON_RUN_AS_NODE = '1';
  }
  return next;
};

// The server's own settings stay out of a sandbox: its UI password, JWT
// secret and tunnel token would let sandboxed code sign in to this server and
// run anything through it, and a shared endpoint override would point the
// sandbox at the main daemon's socket. Only what a daemon reads is kept, so a
// server variable added later is left out unless it is listed here.
const SANDBOX_KEPT_PICHAMBER_ENV = new Set(['PICHAMBER_DATA_DIR', 'PICHAMBER_PI_AGENT_DIR']);
const sandboxDaemonEnv = (env = {}) => Object.fromEntries(
  Object.entries(env).filter(([name]) => (
    !name.toUpperCase().startsWith('PICHAMBER_') || SANDBOX_KEPT_PICHAMBER_ENV.has(name)
  )),
);

const isPidAlive = (processLike, pid) => {
  try {
    processLike.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

// What identifies a process besides its pid, so a recorded launcher pid that
// was reused by another process is never signaled. Linux: the start time
// (clock ticks since boot) from /proc/<pid>/stat; a zombie counts as gone.
// macOS: `ps` state and start time, which has one-second resolution, so a pid
// reused within the same second is not told apart. Elsewhere (Windows has no
// sandbox launcher) nothing is checked and the answer is null, which signals
// nothing.
const readProcessIdentityFor = (platform) => async (pid) => {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (platform === 'linux') {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      // The command name (field 2) can hold spaces and parentheses, so fields
      // are counted from the last ')'. fields[0] is the state (field 3) and
      // fields[19] the start time (field 22).
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z' || fields[0] === 'X') return null;
      return /^\d+$/.test(fields[19] ?? '') ? `linux-start:${fields[19]}` : null;
    } catch {
      return null;
    }
  }
  if (platform === 'darwin') {
    return new Promise((resolveIdentity) => {
      execFile('/bin/ps', ['-o', 'stat=', '-o', 'lstart=', '-p', String(pid)], { timeout: 2_000 }, (error, stdout) => {
        const line = typeof stdout === 'string' ? stdout.trim() : '';
        if (error || !line || line.startsWith('Z')) {
          resolveIdentity(null);
          return;
        }
        resolveIdentity(`darwin-start:${line.replace(/^\S+\s+/, '').replace(/\s+/g, ' ')}`);
      });
    });
  }
  return null;
};

const RETRYABLE_LOCK_CREATE_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY', 'EAGAIN']);
const FRESH_LOCK_MS = 250;

const chmodIfPossible = async (filePath, mode) => {
  try {
    // A sandbox daemon can write its own profile folder; chmod follows a
    // symlink, so one planted here must not reach the file it points at.
    if ((await lstat(filePath)).isSymbolicLink()) return;
    await chmod(filePath, mode);
  } catch {
    // Windows and some filesystems reject POSIX mode bits; the lock/credential
    // still exists and must remain usable.
  }
};

const readLockClaim = async (lockFile) => {
  try {
    const claim = JSON.parse(await readFile(lockFile, 'utf8'));
    if (Number.isInteger(claim?.pid) && claim.pid > 0) return { claim };
    return { stale: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { missing: true };
    return { stale: true };
  }
};

const shouldStealOperationLock = async (lockFile, processLike) => {
  const result = await readLockClaim(lockFile);
  if (result.missing) return false;
  if (result.claim && isPidAlive(processLike, result.claim.pid)) return false;
  if (result.stale) {
    try {
      const info = await stat(lockFile);
      if (Date.now() - info.mtimeMs < FRESH_LOCK_MS) return false;
    } catch (error) {
      return error?.code === 'ENOENT' ? false : true;
    }
  }
  return true;
};

const resolvePiSessionDaemonPaths = ({
  env = process.env,
  dataDir = resolvePiChamberDataDir({ env }),
  pathModule = { join, resolve, isAbsolute },
  platform = process.platform,
  profile,
  port,
  runtime,
  version,
  // The runtime folder's name (default: the profile key). Sandbox daemons
  // pass a short one so their socket path fits a Unix socket address.
  runtimeName,
} = {}) => {
  const resolvedProfile = profile && typeof profile.profileKey === 'string'
    ? profile
    : resolveServerProfile({ env, port, runtime, version });
  const {
    profileKey,
    serverInstanceId,
    runtime: profileRuntime,
    source: profileSource,
    development: profileDevelopment,
    buildId,
  } = resolvedProfile;
  const profileDir = pathModule.join(dataDir, 'pi', 'daemons', profileKey);
  const runtimeFolder = runtimeName ?? profileKey;
  const runtimeBaseDir = typeof env.XDG_RUNTIME_DIR === 'string' && env.XDG_RUNTIME_DIR.trim()
    ? pathModule.join(pathModule.resolve(env.XDG_RUNTIME_DIR.trim()), 'pichamber', 'pi-daemons', runtimeFolder)
    : pathModule.join(dataDir, 'runtime', 'pi-daemons', runtimeFolder);
  const configuredEndpoint = typeof env.PICHAMBER_PI_SESSION_DAEMON_ENDPOINT === 'string'
    ? env.PICHAMBER_PI_SESSION_DAEMON_ENDPOINT.trim()
    : '';
  // An explicit endpoint override keeps per-profile sidecars but shares the
  // socket path. A profile never adopts, unlinks, or signals an endpoint it
  // cannot authenticate and identify as its own.
  const endpoint = configuredEndpoint || (platform === 'win32'
    ? `\\\\.\\pipe\\pichamber-pi-session-daemon-${getWindowsOwnerKey()}-${profileKey}`
    : pathModule.join(runtimeBaseDir, 'daemon.sock'));

  if (!isLocalSessionDaemonEndpoint(endpoint, platform)) {
    throw new PiSessionDaemonUnavailableError('INVALID_DAEMON_ENDPOINT');
  }

  const configuredAgentDir = typeof env.PICHAMBER_PI_AGENT_DIR === 'string' ? env.PICHAMBER_PI_AGENT_DIR.trim() : '';
  return {
    endpoint,
    agentDir: configuredAgentDir ? pathModule.resolve(configuredAgentDir) : undefined,
    piDataDir: pathModule.join(dataDir, 'pi'),
    profileDir,
    runtimeDir: runtimeBaseDir,
    credentialFile: pathModule.join(profileDir, 'session-daemon.key'),
    // Open request intake socket (lib/open-url). The server binds it; the
    // daemon points `$BROWSER` children at it. Unused on Windows.
    openUrlSocket: platform === 'win32' ? undefined : pathModule.join(runtimeBaseDir, 'open-url.sock'),
    stateFile: pathModule.join(profileDir, 'daemon-state.json'),
    lockFile: pathModule.join(profileDir, 'operation.lock'),
    logFile: pathModule.join(dataDir, 'logs', `pi-daemon-${profileKey}.log`),
    profileKey,
    serverInstanceId,
    profileRuntime,
    profileSource,
    profileDevelopment: profileDevelopment === true,
    buildId,
  };
};

const LEGACY_DAEMON_FILES = (dataDir) => ({
  stateFile: join(dataDir, 'pi', 'session-daemon-state.json'),
});

// Best-effort removal of a dead legacy (pre-profile) daemon record. A live
// legacy daemon is never signaled or adopted; it keeps running until its own
// owner stops it.
const cleanupDeadLegacyDaemonState = async ({ dataDir, processLike }) => {
  try {
    const raw = await readFile(LEGACY_DAEMON_FILES(dataDir).stateFile, 'utf8');
    const state = JSON.parse(raw);
    if (!Number.isInteger(state?.pid) || state.pid <= 0) return;
    try {
      processLike.kill(state.pid, 0);
      return;
    } catch (error) {
      if (error?.code === 'EPERM') return;
    }
    await rm(LEGACY_DAEMON_FILES(dataDir).stateFile, { force: true });
  } catch {
    // Legacy cleanup must never block profile daemon startup.
  }
};

/**
 * Owns a single daemon for the local PiChamber host. The state sidecar is
 * deliberately non-secret; the credential is read only by this process and
 * the child daemon, never passed to a browser or logged.
 */
export const createPiSessionDaemonSupervisor = ({
  env = process.env,
  cwd = process.cwd(),
  dataDir,
  platform = process.platform,
  processLike = process,
  request = requestSessionDaemon,
  spawn = spawnChildProcess,
  wait = delay,
  startupTimeoutMs = OPERATION_TIMEOUT_MS,
  daemonReadyTimeoutMs = DAEMON_READY_TIMEOUT_MS,
  profile,
  port,
  runtime,
  version,
  launch,
  leaseAgentDir,
  leaseScope,
  runtimeName,
  readProcessIdentity = readProcessIdentityFor(platform),
} = {}) => {
  const resolvedPaths = resolvePiSessionDaemonPaths({ env, dataDir, platform, profile, port, runtime, version, runtimeName });
  // A daemon started through a launcher runs untrusted code (the agent's
  // shell commands, project extensions) with read-write access to its own
  // profile folder, so its state sidecar, credential and anything else there
  // can be forged. The server keeps what it must trust about that daemon (the
  // launcher it spawned, and the operation lock) in
  // `<dataDir>/pi/launchers/<profileKey>/`. No sandbox grant covers it: the
  // grants are the project, folders under `<dataDir>/pi/sandbox/<key>/`, the
  // session and lease folders under the Pi agent folder,
  // `<dataDir>/worktree/<projectId>`, the profile folder under
  // `<dataDir>/pi/daemons/`, and socket binds in the runtime folder. It sits
  // in the data folder rather than the runtime folder so the record survives
  // a server restart: the detached daemon outlives it and the next server
  // reuses or stops it.
  const launcherDir = launch ? join(resolvedPaths.piDataDir, 'launchers', resolvedPaths.profileKey) : null;
  const paths = launch
    ? {
      ...resolvedPaths,
      lockFile: join(launcherDir, 'operation.lock'),
      launcherFile: join(launcherDir, 'launcher.json'),
      // The server sends the credential to the daemon on every request, so
      // it must be a file the sandbox cannot replace: there the daemon may
      // read it (one read-only file grant) and nothing more.
      credentialFile: join(launcherDir, 'session-daemon.key'),
    }
    : resolvedPaths;
  const serverPid = processLike.pid;
  let startPromise = null;
  let intentionallyStopped = false;

  const withOperationLock = async (operation) => {
    const deadline = Date.now() + startupTimeoutMs;
    const nonce = randomUUID();
    // The profile folder for the main daemon; the launcher folder for a
    // launcher daemon.
    await mkdir(dirname(paths.lockFile), { recursive: true, mode: 0o700 });
    await chmodIfPossible(dirname(paths.lockFile), 0o700);
    while (true) {
      try {
        await writeFile(
          paths.lockFile,
          JSON.stringify({ pid: processLike.pid, nonce, claimedAt: new Date().toISOString() }),
          { flag: 'wx', mode: 0o600 },
        );
        await chmodIfPossible(paths.lockFile, 0o600);
      } catch (error) {
        if (!RETRYABLE_LOCK_CREATE_CODES.has(error?.code)) throw new PiSessionDaemonUnavailableError('DAEMON_LOCK_UNAVAILABLE');
        if (await shouldStealOperationLock(paths.lockFile, processLike)) {
          await rm(paths.lockFile, { force: true });
        }
        if (Date.now() >= deadline) throw new PiSessionDaemonUnavailableError('DAEMON_LOCK_TIMEOUT');
        await wait(RETRY_DELAY_MS);
        continue;
      }
      try {
        return await operation();
      } finally {
        try {
          const claim = JSON.parse(await readFile(paths.lockFile, 'utf8'));
          if (claim?.pid === processLike.pid && claim?.nonce === nonce) await rm(paths.lockFile, { force: true });
        } catch {
          // A missing or already-replaced lock must not remove another owner.
        }
      }
    }
  };

  // A launcher daemon writes its own state file, so it is read as hostile
  // input: never through a symlink, and never a FIFO that would block.
  const readState = async () => {
    try {
      const state = JSON.parse(await readSmallRegularFile(paths.stateFile));
      return isValidState(state) ? state : null;
    } catch {
      return null;
    }
  };

  const readFailureState = async () => {
    try {
      const state = JSON.parse(await readSmallRegularFile(paths.stateFile));
      return isValidFailureState(state) ? state : null;
    } catch {
      return null;
    }
  };

  const readCredential = async () => {
    try {
      const credential = (await readSmallRegularFile(paths.credentialFile)).trim();
      if (credential.length < 32) throw new Error('invalid credential');
      return credential;
    } catch {
      throw new PiSessionDaemonUnavailableError('DAEMON_CREDENTIAL_UNAVAILABLE');
    }
  };

  const ensureCredential = async () => {
    await mkdir(paths.profileDir, { recursive: true, mode: 0o700 });
    await chmodIfPossible(paths.profileDir, 0o700);
    await mkdir(dirname(paths.credentialFile), { recursive: true, mode: 0o700 });
    await chmodIfPossible(dirname(paths.credentialFile), 0o700);
    try {
      const credential = await readCredential();
      await chmodIfPossible(paths.credentialFile, 0o600);
      return credential;
    } catch (error) {
      if (error.code !== 'DAEMON_CREDENTIAL_UNAVAILABLE') throw error;
    }

    const credential = randomBytes(32).toString('hex');
    try {
      await writeFile(paths.credentialFile, `${credential}\n`, { flag: 'wx', mode: 0o600 });
      await chmodIfPossible(paths.credentialFile, 0o600);
      return credential;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw new PiSessionDaemonUnavailableError('DAEMON_CREDENTIAL_UNAVAILABLE');
      return readCredential();
    }
  };

  const probe = async (credential) => {
    const state = await readState();
    if (!state || state.endpoint !== paths.endpoint || state.profileKey !== paths.profileKey) {
      const failure = await readFailureState();
      if (failure?.endpoint === paths.endpoint && failure?.profileKey === paths.profileKey) {
        throw new PiSessionDaemonUnavailableError(failure.error.code);
      }
      throw new PiSessionDaemonUnavailableError('DAEMON_UNAVAILABLE');
    }
    try {
      const health = await rejectAfter(request({
        endpoint: paths.endpoint,
        credential,
        command: 'runtime.health',
        timeoutMs: startupTimeoutMs,
      }), startupTimeoutMs, 'DAEMON_UNAVAILABLE');
      if (health?.state !== 'ready'
        || health.daemonPid !== state.pid
        || health.profileKey !== paths.profileKey
        || (typeof state.daemonId === 'string' && health.daemonId !== state.daemonId)
        || (typeof state.serverInstanceId === 'string' && health.serverInstanceId !== state.serverInstanceId)
        || (Number.isInteger(state.serverPid) && health.serverPid !== state.serverPid)
        || (typeof state.buildId === 'string' && health.buildId !== state.buildId)) {
        throw new PiSessionDaemonUnavailableError('DAEMON_IDENTITY_MISMATCH');
      }
      return { state, health };
    } catch (error) {
      if (error instanceof PiSessionDaemonUnavailableError) throw error;
      throw new PiSessionDaemonUnavailableError(
        error instanceof SessionDaemonClientError && error.code !== 'DAEMON_CONNECTION_REFUSED'
          ? error.code
          : 'DAEMON_UNAVAILABLE',
      );
    }
  };

  const endpointExists = async () => {
    if (platform === 'win32') return false;
    try {
      await lstat(paths.endpoint);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw new PiSessionDaemonUnavailableError('DAEMON_ENDPOINT_UNREADABLE');
    }
  };

  const removeStaleState = async (state) => {
    const current = await readState() ?? await readFailureState();
    if (current?.pid === state?.pid
      && current.endpoint === paths.endpoint
      && current.profileKey === paths.profileKey) {
      await rm(paths.stateFile, { force: true });
    }
  };

  // Launcher record: the process this server spawned for a launcher daemon
  // (the launcher itself, `child.pid`), its identity, and the server instance
  // that owns it. It is the only pid a launcher daemon's stop signals.
  const readLauncherRecord = async () => {
    if (!launch) return null;
    try {
      const record = JSON.parse(await readFile(paths.launcherFile, 'utf8'));
      if (!Number.isInteger(record?.pid) || record.pid <= 1
        || typeof record.identity !== 'string' || record.identity.length === 0
        || record.profileKey !== paths.profileKey
        || typeof record.serverInstanceId !== 'string') return null;
      return record;
    } catch {
      return null;
    }
  };

  const writeLauncherRecord = async (record) => {
    await mkdir(launcherDir, { recursive: true, mode: 0o700 });
    const temporary = `${paths.launcherFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await rename(temporary, paths.launcherFile);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };

  const removeLauncherRecord = async (record) => {
    const current = await readLauncherRecord();
    if (current?.pid === record.pid && current.identity === record.identity) {
      await rm(paths.launcherFile, { force: true });
    }
  };

  const isLauncherAlive = async (record) => (
    Boolean(record) && (await readProcessIdentity(record.pid)) === record.identity
  );

  // Wait for a launcher daemon to stop, signaling only the launcher process
  // this server recorded, after confirming its identity. A launcher daemon's
  // `state.pid` is never signaled: the sandbox can write any pid there.
  // Under `nono run` (0.82.0) the launcher is nono's supervisor process. It
  // forwards SIGTERM to the sandboxed daemon and exits after the daemon does,
  // so waiting on it waits on the daemon. The daemon shares nono's process
  // group (it has no terminal, so nono opens no PTY and makes no new
  // session), so the group is not signaled: the daemon would get SIGTERM
  // twice, and its handler is one-shot, so the second would kill it before
  // its own shutdown finished.
  const finishLauncherDaemonStop = async (state) => {
    const record = await readLauncherRecord();
    const deadline = Date.now() + startupTimeoutMs;
    if (!record) {
      // No record (a daemon started before records existed, or a lost
      // record): signal nothing and give the authenticated shutdown time to
      // take effect. A forged `state.pid` can only make this wait time out.
      while (state && Date.now() < deadline) {
        if (!isPidAlive(processLike, state.pid)) {
          await removeStaleState(state);
          return;
        }
        await wait(RETRY_DELAY_MS);
      }
      if (state) throw new PiSessionDaemonUnavailableError('DAEMON_STOP_TIMEOUT');
      return;
    }
    if (await isLauncherAlive(record)) {
      try {
        processLike.kill(record.pid, 'SIGTERM');
      } catch {
        if (await isLauncherAlive(record)) throw new PiSessionDaemonUnavailableError('DAEMON_STOP_FAILED');
      }
      while (await isLauncherAlive(record)) {
        if (Date.now() >= deadline) throw new PiSessionDaemonUnavailableError('DAEMON_STOP_TIMEOUT');
        await wait(RETRY_DELAY_MS);
      }
    }
    await removeLauncherRecord(record);
    if (state) await removeStaleState(state);
  };

  // Transfer a same-profile daemon to this server instance only after its
  // prior server owner has exited. The daemon persists the new owner before
  // acknowledging the claim, keeping IPC identity and the sidecar in sync.
  const claimDaemonOwnership = async (credential) => {
    try {
      await request({
        endpoint: paths.endpoint,
        credential,
        command: 'runtime.claim',
        payload: { serverInstanceId: paths.serverInstanceId, serverPid },
        timeoutMs: startupTimeoutMs,
      });
    } catch (error) {
      if (error instanceof SessionDaemonClientError && error.code === 'UNKNOWN_COMMAND') return false;
      if (error instanceof SessionDaemonClientError && error.code === 'OWNERSHIP_CONFLICT') {
        throw new PiSessionDaemonUnavailableError('DAEMON_PROFILE_IN_USE');
      }
      if (error instanceof SessionDaemonClientError) {
        throw new PiSessionDaemonUnavailableError(error.code);
      }
      throw error;
    }
    return true;
  };

  const recoverVerifiedStaleEndpoint = async (state, credential) => {
    if (platform === 'win32' || !state || isPidAlive(processLike, state.pid)) return false;
    try {
      const endpoint = await lstat(paths.endpoint);
      if (!endpoint.isSocket()) return false;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw new PiSessionDaemonUnavailableError('DAEMON_ENDPOINT_UNREADABLE');
    }

    try {
      await request({
        endpoint: paths.endpoint,
        credential,
        command: 'runtime.health',
        timeoutMs: startupTimeoutMs,
      });
      return false;
    } catch (error) {
      // A dead owner plus an owner-only socket that either refuses or never
      // completes authenticated IPC is a verified stale endpoint. Protocol,
      // authentication, or malformed-response errors remain unverifiable.
      if (!(error instanceof SessionDaemonClientError) || !['DAEMON_CONNECTION_REFUSED', 'DAEMON_UNAVAILABLE'].includes(error.code)) return false;
    }

    await rm(paths.endpoint, { force: false });
    return true;
  };

  // Authenticated shutdown: prove profile ownership over IPC before
  // signaling anything. A stale server whose daemon was claimed by a newer
  // instance receives an ownership error and must not terminate anything.
  const requestShutdownOverIpc = async (state, credential) => {
    try {
      await request({
        endpoint: paths.endpoint,
        credential,
        command: 'runtime.shutdown',
        payload: { serverInstanceId: paths.serverInstanceId, daemonId: state.daemonId },
        timeoutMs: startupTimeoutMs,
      });
    } catch (error) {
      if (error instanceof SessionDaemonClientError
        && (error.code === 'DAEMON_OWNERSHIP_MISMATCH' || error.code === 'OWNERSHIP_MISMATCH')) {
        throw new PiSessionDaemonUnavailableError('DAEMON_OWNERSHIP_MISMATCH');
      }
      if (error instanceof SessionDaemonClientError
        && !['DAEMON_CONNECTION_REFUSED', 'DAEMON_UNAVAILABLE'].includes(error.code)
        && error.code !== 'UNKNOWN_COMMAND') {
        throw new PiSessionDaemonUnavailableError(error.code);
      }
      // UNKNOWN_COMMAND (a daemon that predates shutdown) and unreachable
      // daemons fall through to the PID wait below; only a verified owner
      // reaches the signal.
    }
  };

  const requestDaemonShutdown = async (state, credential) => {
    if (!state || !Number.isInteger(state.pid) || state.pid <= 0) return;
    if (state.profileKey !== paths.profileKey) {
      throw new PiSessionDaemonUnavailableError('DAEMON_OWNERSHIP_MISMATCH');
    }
    await requestShutdownOverIpc(state, credential);
    if (launch) {
      await finishLauncherDaemonStop(state);
      return;
    }
    try {
      processLike.kill(state.pid, 'SIGTERM');
    } catch {
      if (isPidAlive(processLike, state.pid)) throw new PiSessionDaemonUnavailableError('DAEMON_STOP_FAILED');
      await removeStaleState(state);
      return;
    }
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      if (!isPidAlive(processLike, state.pid)) {
        await removeStaleState(state);
        return;
      }
      await wait(RETRY_DELAY_MS);
    }
    throw new PiSessionDaemonUnavailableError('DAEMON_STOP_TIMEOUT');
  };

  const start = async () => {
    intentionallyStopped = false;
    if (startPromise) return startPromise;
    startPromise = withOperationLock(async () => {
      const credential = await ensureCredential();
      await cleanupDeadLegacyDaemonState({ dataDir: dirname(paths.piDataDir), processLike });
      try {
        const existing = await probe(credential);
        const isCompatibleBuild = daemonEntrypointMatches(existing.state)
          && existing.state.buildId === paths.buildId
          && existing.health.buildId === paths.buildId
          && (!paths.profileDevelopment || existing.state.serverInstanceId === paths.serverInstanceId);
        const claimed = await claimDaemonOwnership(credential);
        if (claimed) {
          // The daemon now answers to this server, so the launcher record,
          // which a launcher daemon's stop checks ownership against, does too.
          const record = await readLauncherRecord();
          if (record && record.serverInstanceId !== paths.serverInstanceId) {
            await writeLauncherRecord({ ...record, serverInstanceId: paths.serverInstanceId });
          }
        }
        if (isCompatibleBuild && claimed) {
          const ready = await probe(credential);
          return {
            state: 'ready',
            reused: true,
            protocolVersion: PROTOCOL_VERSION,
            capabilities: ready.health.capabilities ?? [],
            ...(typeof ready.health.streamEpoch === 'string' && ready.health.streamEpoch.length > 0
              ? { streamEpoch: ready.health.streamEpoch }
              : {}),
          };
        }
        // Replace an older protocol/build, and always replace a development
        // daemon so a source restart cannot keep running stale module code.
        await requestDaemonShutdown(existing.state, credential);
      } catch (error) {
        if (!(error instanceof PiSessionDaemonUnavailableError)) throw error;
        if (error.code === 'DAEMON_STOP_FAILED' || error.code === 'DAEMON_STOP_TIMEOUT'
          || error.code === 'DAEMON_OWNERSHIP_MISMATCH' || error.code === 'DAEMON_PROFILE_IN_USE') throw error;
      }

      const staleState = await readState() ?? await readFailureState();
      if (staleState && isPidAlive(processLike, staleState.pid)) {
        throw new PiSessionDaemonUnavailableError('DAEMON_UNAVAILABLE');
      }
      // A launcher this server spawned that is still running holds a daemon
      // that does not answer yet; never start a second one beside it, and
      // never lose its record by writing another.
      const previousLauncher = await readLauncherRecord();
      if (previousLauncher) {
        if (await isLauncherAlive(previousLauncher)) throw new PiSessionDaemonUnavailableError('DAEMON_UNAVAILABLE');
        await removeLauncherRecord(previousLauncher);
      }
      if (await endpointExists()) {
        const recovered = await recoverVerifiedStaleEndpoint(staleState, credential);
        if (!recovered) {
          // Do not unlink a socket we could not authenticate and identify.
          throw new PiSessionDaemonUnavailableError('DAEMON_ENDPOINT_UNVERIFIED');
        }
      }
      if (staleState) await removeStaleState(staleState);
      await mkdir(dirname(paths.stateFile), { recursive: true, mode: 0o700 });
      if (platform !== 'win32') {
        await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
        await chmod(paths.runtimeDir, 0o700);
      }
      await mkdir(dirname(paths.logFile), { recursive: true, mode: 0o700 });
      await chmodIfPossible(dirname(paths.logFile), 0o700);

      const daemonId = randomUUID();
      let logFd = null;
      try {
        logFd = openSync(paths.logFile, 'a');
      } catch {
        logFd = null;
      }
      let child;
      let spawnError = null;
      let command = processLike.execPath;
      let args = [
        DAEMON_ENTRYPOINT,
        '--endpoint', paths.endpoint,
        '--credential-file', paths.credentialFile,
        '--state-file', paths.stateFile,
        '--cwd', cwd,
        '--profile-key', paths.profileKey,
        '--server-instance-id', paths.serverInstanceId,
        '--server-pid', String(serverPid),
        '--daemon-id', daemonId,
        '--runtime', paths.profileRuntime,
        '--build-id', paths.buildId,
        ...(paths.agentDir ? ['--agent-dir', paths.agentDir] : []),
        ...(leaseAgentDir ? ['--lease-agent-dir', leaseAgentDir] : []),
        ...(leaseScope ? ['--lease-scope', leaseScope] : []),
        ...(paths.openUrlSocket ? ['--open-url-socket', paths.openUrlSocket] : []),
        // A daemon started without a launcher is the main daemon: it must
        // stay out of the folders sandbox daemons own.
        ...(launch ? [] : ['--sandboxed-folders-file', join(paths.piDataDir, 'sandboxed-folders.json')]),
      ];
      let childEnv = buildSessionDaemonChildEnv({
        env,
        electronVersion: processLike.versions?.electron,
      });
      try {
        // A sandbox launcher wraps the unchanged daemon command. Its stop
        // signals only the launcher process recorded below, never the pid in
        // the state sidecar.
        if (launch) ({ command, args, env: childEnv } = await launch({ command, args, env: childEnv, cwd, paths }));
      } catch (error) {
        if (logFd !== null) {
          try { closeSync(logFd); } catch { /* nothing was spawned */ }
        }
        throw new PiSessionDaemonUnavailableError(typeof error?.code === 'string' ? error.code : 'SANDBOX_LAUNCH_FAILED');
      }
      try {
        child = spawn(command, args, {
          cwd,
          detached: platform !== 'win32',
          stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
          windowsHide: true,
          env: childEnv,
        });
      } catch {
        throw new PiSessionDaemonUnavailableError('DAEMON_SPAWN_FAILED');
      } finally {
        if (logFd !== null) {
          try { closeSync(logFd); } catch { /* the child holds its own copy */ }
        }
      }
      if (typeof child?.once === 'function') {
        child.once('error', (err) => {
          spawnError = err ?? true;
        });
      }
      child?.unref?.();
      if (launch && Number.isInteger(child?.pid) && child.pid > 1) {
        // Record the launcher before waiting for readiness, so a daemon that
        // never becomes ready can still be found and stopped. A launcher
        // whose identity cannot be read (already gone, or no way to check on
        // this platform) gets no record, and stop signals nothing.
        const identity = await readProcessIdentity(child.pid);
        if (identity) {
          try {
            await writeLauncherRecord({
              pid: child.pid,
              identity,
              profileKey: paths.profileKey,
              serverInstanceId: paths.serverInstanceId,
              recordedAt: new Date().toISOString(),
            });
          } catch {
            // Without its record the daemon could never be stopped by
            // signal, so it does not get to run.
            try { processLike.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
            throw new PiSessionDaemonUnavailableError('DAEMON_LAUNCHER_RECORD_FAILED');
          }
        }
      }

      // Loading Pi settings, providers, and a larger local model catalog can
      // legitimately exceed the short lock/stop operation budget.
      const deadline = Date.now() + daemonReadyTimeoutMs;
      while (Date.now() < deadline) {
        if (spawnError) throw new PiSessionDaemonUnavailableError('DAEMON_SPAWN_FAILED');
        try {
          const started = await probe(credential);
          return {
            state: 'ready',
            reused: false,
            protocolVersion: PROTOCOL_VERSION,
            capabilities: started.health.capabilities ?? [],
            ...(typeof started.health.streamEpoch === 'string' && started.health.streamEpoch.length > 0
              ? { streamEpoch: started.health.streamEpoch }
              : {}),
          };
        } catch (error) {
          if (spawnError) throw new PiSessionDaemonUnavailableError('DAEMON_SPAWN_FAILED');
          if (error instanceof PiSessionDaemonUnavailableError && isPermanentStartupFailure(error.code)) throw error;
          await wait(RETRY_DELAY_MS);
        }
      }
      try {
        if (child?.pid) {
          processLike.kill(child.pid, 'SIGTERM');
        }
      } catch {
        // The child may have exited before the timeout; either way it is not ready.
      }
      throw new PiSessionDaemonUnavailableError('DAEMON_START_TIMEOUT');
    });

    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  };

  const ensureReady = async () => {
    let credential = await readCredential();
    try {
      const ready = await probe(credential);
      if (daemonEntrypointMatches(ready.state)
        && ready.state.buildId === paths.buildId
        && ready.health.buildId === paths.buildId
        && (!paths.profileDevelopment || ready.state.serverInstanceId === paths.serverInstanceId)) {
        return { credential, ready };
      }
    } catch (probeError) {
      if (intentionallyStopped) throw new PiSessionDaemonUnavailableError('DAEMON_UNAVAILABLE');
      if (probeError instanceof PiSessionDaemonUnavailableError && isPermanentStartupFailure(probeError.code)) {
        throw probeError;
      }
    }
    if (intentionallyStopped) throw new PiSessionDaemonUnavailableError('DAEMON_UNAVAILABLE');
    await start();
    credential = await readCredential();
    return { credential, ready: await probe(credential) };
  };

  const requestDaemon = async (command, payload) => {
    try {
      const { credential } = await ensureReady();
      return await request({ endpoint: paths.endpoint, credential, command, payload });
    } catch (error) {
      throw new PiSessionDaemonUnavailableError(
        error instanceof SessionDaemonClientError && error.code !== 'DAEMON_CONNECTION_REFUSED'
          ? error.code
          : error instanceof PiSessionDaemonUnavailableError ? error.code : 'DAEMON_UNAVAILABLE',
      );
    }
  };

  const subscribe = async ({ sessionId, fromSequence, streamEpoch, onEvent, onError, signal }) => {
    try {
      if (signal?.aborted) return () => {};
      const { credential } = await ensureReady();
      if (signal?.aborted) return () => {};
      return await subscribeSessionDaemon({ endpoint: paths.endpoint, credential, sessionId, fromSequence, streamEpoch, onEvent, onError, signal });
    } catch (error) {
      throw new PiSessionDaemonUnavailableError(
        error instanceof SessionDaemonClientError && error.code !== 'DAEMON_CONNECTION_REFUSED'
          ? error.code
          : error instanceof PiSessionDaemonUnavailableError ? error.code : 'DAEMON_UNAVAILABLE',
      );
    }
  };

  const health = async () => {
    try {
      const { ready } = await ensureReady();
      return {
        state: 'ready',
        protocolVersion: PROTOCOL_VERSION,
        capabilities: ready.health.capabilities ?? [],
        ...(typeof ready.health.streamEpoch === 'string' && ready.health.streamEpoch.length > 0
          ? { streamEpoch: ready.health.streamEpoch }
          : {}),
      };
    } catch (error) {
      return {
        state: 'unavailable',
        protocolVersion: PROTOCOL_VERSION,
        error: { code: error instanceof PiSessionDaemonUnavailableError ? error.code : 'DAEMON_UNAVAILABLE' },
      };
    }
  };

  // Stop a launcher daemon this server has a record for. Ownership comes from
  // the server-owned record, which a claim rewrites, not from the state
  // sidecar. The authenticated shutdown is still asked for first, but the
  // credential, sidecar and health answer all sit where the sandbox can
  // write, so a missing, forged or refused answer cannot keep the server
  // from stopping the launcher it started.
  const stopRecordedLauncherDaemon = async (record) => {
    if (record.serverInstanceId !== paths.serverInstanceId) {
      throw new PiSessionDaemonUnavailableError('DAEMON_OWNERSHIP_MISMATCH');
    }
    let state = null;
    try {
      const credential = await readCredential();
      ({ state } = await probe(credential));
      await requestShutdownOverIpc(state, credential);
    } catch (error) {
      if (!(error instanceof PiSessionDaemonUnavailableError)) throw error;
    }
    await finishLauncherDaemonStop(state ?? await readState() ?? await readFailureState());
  };

  const stop = async () => {
    intentionallyStopped = true;
    const pendingStart = startPromise;
    if (pendingStart) await pendingStart.catch(() => {});
    return withOperationLock(async () => {
      const launcherRecord = await readLauncherRecord();
      if (launcherRecord) {
        await stopRecordedLauncherDaemon(launcherRecord);
        intentionallyStopped = true;
        return { state: 'stopped' };
      }
      let credential;
      try {
        credential = await readCredential();
      } catch (error) {
        if (error?.code !== 'DAEMON_CREDENTIAL_UNAVAILABLE') throw error;
        intentionallyStopped = true;
        return { state: 'stopped' };
      }
      const recordedState = await readState();
      if (!recordedState) {
        const failureState = await readFailureState();
        if (failureState && !isPidAlive(processLike, failureState.pid)) await removeStaleState(failureState);
        intentionallyStopped = true;
        return { state: 'stopped' };
      }
      const { state } = await probe(credential);
      // A stale server must never stop a daemon claimed by a newer instance
      // of the same profile (for example a development server stopping after
      // the installed server claimed the profile daemon).
      if (state.serverInstanceId !== paths.serverInstanceId) {
        throw new PiSessionDaemonUnavailableError('DAEMON_OWNERSHIP_MISMATCH');
      }
      await requestDaemonShutdown(state, credential);
      intentionallyStopped = true;
      return { state: 'stopped' };
    });
  };

  return { paths, start, health, request: requestDaemon, subscribe, stop };
};

/**
 * Supervise a project's sandbox daemon: the same daemon command, started
 * through a sandbox launcher. The profile key carries the launch identity,
 * so a changed launcher version, policy, grant set or network never reuses
 * an older daemon. Fails closed with SANDBOX_UNAVAILABLE and the launcher's
 * reason code when the launcher cannot sandbox on this host.
 */
export const createSandboxedPiSessionDaemonSupervisor = async ({
  launcher,
  sandbox,
  env = process.env,
  port,
  runtime,
  version,
  ...options
}) => {
  const probe = await launcher.probe();
  if (!probe.available) {
    const error = new PiSessionDaemonUnavailableError('SANDBOX_UNAVAILABLE');
    error.reason = probe.code;
    throw error;
  }
  const identity = launcher.identity({ grants: sandbox.grants, network: sandbox.network });
  const base = resolveServerProfile({ env, port, runtime, version });
  const profile = { ...base, profileKey: `${base.profileKey}-sbx-${sandbox.projectKey}-${identity}` };
  // The full key is about 40 characters. Without XDG_RUNTIME_DIR (macOS) the
  // runtime folder sits under the data folder, where a socket path built
  // from it would pass macOS's 103-byte limit, so it is named by a hash.
  const runtimeName = `sbx-${createHash('sha256').update(profile.profileKey).digest('hex').slice(0, 16)}`;
  const ownEnv = sandboxDaemonEnv(env);
  const supervisor = createPiSessionDaemonSupervisor({
    daemonReadyTimeoutMs: SANDBOX_DAEMON_READY_TIMEOUT_MS,
    ...options,
    env: { ...ownEnv, PICHAMBER_PI_AGENT_DIR: sandbox.agentDir },
    cwd: sandbox.cwd,
    profile,
    runtimeName,
    // The daemon reads Pi config through the shadow folder but keys session
    // leases on the real one, like the main daemon.
    leaseAgentDir: sandbox.leaseAgentDir,
    // Its own lease folder, the only one it is granted.
    leaseScope: sandbox.leaseScope,
    launch: ({ command, args, env: childEnv, cwd, paths }) => launcher.prepare({
      argv: [command, ...args],
      env: childEnv,
      cwd,
      tmpDir: sandbox.tmpDir,
      cacheDir: sandbox.cacheDir,
      network: sandbox.network,
      // The daemon's own profile and runtime folders derive from the
      // identity, so they are added here rather than hashed into it.
      grants: [
        ...sandbox.grants,
        { kind: 'readWrite', path: paths.profileDir },
        { kind: 'readFile', path: paths.credentialFile },
        { kind: 'unixSocketBind', dir: paths.runtimeDir },
      ],
    }),
  });
  // A long data folder or XDG_RUNTIME_DIR can still push the socket path
  // past the Unix socket address limit, and the daemon's listen would then
  // fail with EINVAL, so refuse it up front with a stable code.
  if (Buffer.byteLength(supervisor.paths.endpoint) > maxUnixSocketPathBytes(options.platform ?? process.platform)) {
    throw new PiSessionDaemonUnavailableError('SANDBOX_ENDPOINT_TOO_LONG');
  }
  return { ...supervisor, sandbox: { launcher: launcher.id, version: probe.version, identity } };
};
