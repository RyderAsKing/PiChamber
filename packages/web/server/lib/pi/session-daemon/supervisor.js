import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn as spawnChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { resolvePiChamberDataDir } from '../../pichamber-data-dir.js';
import { resolveServerProfile } from '../../server/server-profile.js';
import { isLocalSessionDaemonEndpoint } from './session-daemon.js';
import { requestSessionDaemon, SessionDaemonClientError, subscribeSessionDaemon } from './ipc-client.js';

const PROTOCOL_VERSION = 1;
const OPERATION_TIMEOUT_MS = 5_000;
const DAEMON_READY_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 100;
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

const isPidAlive = (processLike, pid) => {
  try {
    processLike.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const RETRYABLE_LOCK_CREATE_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY', 'EAGAIN']);
const FRESH_LOCK_MS = 250;

const chmodIfPossible = async (filePath, mode) => {
  try {
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
  const runtimeBaseDir = typeof env.XDG_RUNTIME_DIR === 'string' && env.XDG_RUNTIME_DIR.trim()
    ? pathModule.join(pathModule.resolve(env.XDG_RUNTIME_DIR.trim()), 'pichamber', 'pi-daemons', profileKey)
    : pathModule.join(dataDir, 'runtime', 'pi-daemons', profileKey);
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
} = {}) => {
  const paths = resolvePiSessionDaemonPaths({ env, dataDir, platform, profile, port, runtime, version });
  const serverPid = processLike.pid;
  let startPromise = null;
  let intentionallyStopped = false;

  const withOperationLock = async (operation) => {
    const deadline = Date.now() + startupTimeoutMs;
    const nonce = randomUUID();
    await mkdir(paths.profileDir, { recursive: true, mode: 0o700 });
    await chmodIfPossible(paths.profileDir, 0o700);
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

  const readState = async () => {
    try {
      const state = JSON.parse(await readFile(paths.stateFile, 'utf8'));
      return isValidState(state) ? state : null;
    } catch {
      return null;
    }
  };

  const readFailureState = async () => {
    try {
      const state = JSON.parse(await readFile(paths.stateFile, 'utf8'));
      return isValidFailureState(state) ? state : null;
    } catch {
      return null;
    }
  };

  const readCredential = async () => {
    try {
      const credential = (await readFile(paths.credentialFile, 'utf8')).trim();
      if (credential.length < 32) throw new Error('invalid credential');
      return credential;
    } catch {
      throw new PiSessionDaemonUnavailableError('DAEMON_CREDENTIAL_UNAVAILABLE');
    }
  };

  const ensureCredential = async () => {
    await mkdir(paths.profileDir, { recursive: true, mode: 0o700 });
    await chmodIfPossible(paths.profileDir, 0o700);
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
  const requestDaemonShutdown = async (state, credential) => {
    if (!state || !Number.isInteger(state.pid) || state.pid <= 0) return;
    if (state.profileKey !== paths.profileKey) {
      throw new PiSessionDaemonUnavailableError('DAEMON_OWNERSHIP_MISMATCH');
    }
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
        if (isCompatibleBuild && claimed) {
          const ready = await probe(credential);
          return { state: 'ready', reused: true, protocolVersion: PROTOCOL_VERSION, capabilities: ready.health.capabilities ?? [] };
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
      try {
        child = spawn(processLike.execPath, [
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
        ], {
          cwd,
          detached: platform !== 'win32',
          stdio: logFd === null ? 'ignore' : ['ignore', logFd, logFd],
          windowsHide: true,
          env: buildSessionDaemonChildEnv({
            env,
            electronVersion: processLike.versions?.electron,
          }),
        });
      } finally {
        if (logFd !== null) {
          try { closeSync(logFd); } catch { /* the child holds its own copy */ }
        }
      }
      child?.unref?.();

      // Loading Pi settings, providers, and a larger local model catalog can
      // legitimately exceed the short lock/stop operation budget.
      const deadline = Date.now() + daemonReadyTimeoutMs;
      while (Date.now() < deadline) {
        try {
          const started = await probe(credential);
          return { state: 'ready', reused: false, protocolVersion: PROTOCOL_VERSION, capabilities: started.health.capabilities ?? [] };
        } catch (error) {
          if (error instanceof PiSessionDaemonUnavailableError && isPermanentStartupFailure(error.code)) throw error;
          await wait(RETRY_DELAY_MS);
        }
      }
      try {
        processLike.kill(child.pid, 'SIGTERM');
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

  const subscribe = async ({ sessionId, fromSequence, onEvent, onError }) => {
    try {
      const { credential } = await ensureReady();
      return await subscribeSessionDaemon({ endpoint: paths.endpoint, credential, sessionId, fromSequence, onEvent, onError });
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
      return { state: 'ready', protocolVersion: PROTOCOL_VERSION, capabilities: ready.health.capabilities ?? [] };
    } catch (error) {
      return {
        state: 'unavailable',
        protocolVersion: PROTOCOL_VERSION,
        error: { code: error instanceof PiSessionDaemonUnavailableError ? error.code : 'DAEMON_UNAVAILABLE' },
      };
    }
  };

  const stop = async () => {
    intentionallyStopped = true;
    const pendingStart = startPromise;
    if (pendingStart) await pendingStart.catch(() => {});
    return withOperationLock(async () => {
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
