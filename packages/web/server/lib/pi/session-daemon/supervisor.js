import { createHash, randomBytes } from 'node:crypto';
import { spawn as spawnChildProcess } from 'node:child_process';
import { chmod, lstat, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { resolvePiChamberDataDir } from '../../pichamber-data-dir.js';
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
);

const isValidState = (state) => hasValidStateIdentity(state) && typeof state.startedAt === 'string';

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

const resolvePiSessionDaemonPaths = ({
  env = process.env,
  dataDir = resolvePiChamberDataDir({ env }),
  pathModule = { join, resolve, isAbsolute },
  platform = process.platform,
} = {}) => {
  const piDataDir = pathModule.join(dataDir, 'pi');
  const runtimeDir = typeof env.XDG_RUNTIME_DIR === 'string' && env.XDG_RUNTIME_DIR.trim()
    ? pathModule.join(pathModule.resolve(env.XDG_RUNTIME_DIR.trim()), 'pichamber')
    : pathModule.join(dataDir, 'runtime');
  const configuredEndpoint = typeof env.PICHAMBER_PI_SESSION_DAEMON_ENDPOINT === 'string'
    ? env.PICHAMBER_PI_SESSION_DAEMON_ENDPOINT.trim()
    : '';
  const endpoint = configuredEndpoint || (platform === 'win32'
    ? `\\\\.\\pipe\\pichamber-pi-session-daemon-${getWindowsOwnerKey()}`
    : pathModule.join(runtimeDir, 'pi-session-daemon.sock'));

  if (!isLocalSessionDaemonEndpoint(endpoint, platform)) {
    throw new PiSessionDaemonUnavailableError('INVALID_DAEMON_ENDPOINT');
  }

  const configuredAgentDir = typeof env.PICHAMBER_PI_AGENT_DIR === 'string' ? env.PICHAMBER_PI_AGENT_DIR.trim() : '';
  return {
    endpoint,
    agentDir: configuredAgentDir ? pathModule.resolve(configuredAgentDir) : undefined,
    piDataDir,
    runtimeDir,
    credentialFile: pathModule.join(piDataDir, 'session-daemon.key'),
    stateFile: pathModule.join(piDataDir, 'session-daemon-state.json'),
    lockFile: pathModule.join(piDataDir, 'session-daemon.lock'),
  };
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
} = {}) => {
  const paths = resolvePiSessionDaemonPaths({ env, dataDir, platform });
  let startPromise = null;
  let intentionallyStopped = false;

  const withOperationLock = async (operation) => {
    const deadline = Date.now() + startupTimeoutMs;
    await mkdir(paths.piDataDir, { recursive: true, mode: 0o700 });
    await chmod(paths.piDataDir, 0o700);
    while (true) {
      let handle;
      try {
        handle = await open(paths.lockFile, 'wx', 0o600);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw new PiSessionDaemonUnavailableError('DAEMON_LOCK_UNAVAILABLE');
        try {
          const claim = JSON.parse(await readFile(paths.lockFile, 'utf8'));
          if (!isPidAlive(processLike, claim?.pid)) await rm(paths.lockFile, { force: true });
        } catch (readError) {
          if (readError?.code !== 'ENOENT') throw new PiSessionDaemonUnavailableError('DAEMON_LOCK_UNAVAILABLE');
        }
        if (Date.now() >= deadline) throw new PiSessionDaemonUnavailableError('DAEMON_LOCK_TIMEOUT');
        await wait(RETRY_DELAY_MS);
        continue;
      }

      try {
        await handle.writeFile(JSON.stringify({ pid: processLike.pid, claimedAt: new Date().toISOString() }));
        await chmod(paths.lockFile, 0o600);
      } finally {
        await handle.close();
      }
      try {
        return await operation();
      } finally {
        try {
          const claim = JSON.parse(await readFile(paths.lockFile, 'utf8'));
          if (claim?.pid === processLike.pid) await rm(paths.lockFile, { force: true });
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
    await mkdir(paths.piDataDir, { recursive: true, mode: 0o700 });
    await chmod(paths.piDataDir, 0o700);
    try {
      const credential = await readCredential();
      await chmod(paths.credentialFile, 0o600);
      return credential;
    } catch (error) {
      if (error.code !== 'DAEMON_CREDENTIAL_UNAVAILABLE') throw error;
    }

    const credential = randomBytes(32).toString('hex');
    try {
      await writeFile(paths.credentialFile, `${credential}\n`, { flag: 'wx', mode: 0o600 });
      await chmod(paths.credentialFile, 0o600);
      return credential;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw new PiSessionDaemonUnavailableError('DAEMON_CREDENTIAL_UNAVAILABLE');
      return readCredential();
    }
  };

  const probe = async (credential) => {
    const state = await readState();
    if (!state || state.endpoint !== paths.endpoint) {
      const failure = await readFailureState();
      if (failure?.endpoint === paths.endpoint) throw new PiSessionDaemonUnavailableError(failure.error.code);
      throw new PiSessionDaemonUnavailableError('DAEMON_UNAVAILABLE');
    }
    try {
      const health = await request({ endpoint: paths.endpoint, credential, command: 'runtime.health' });
      if (health?.state !== 'ready' || health.daemonPid !== state.pid) {
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
    if (current?.pid === state?.pid && current.endpoint === paths.endpoint) {
      await rm(paths.stateFile, { force: true });
    }
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
      await request({ endpoint: paths.endpoint, credential, command: 'runtime.health' });
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

  const start = async () => {
    intentionallyStopped = false;
    if (startPromise) return startPromise;
    startPromise = withOperationLock(async () => {
      const credential = await ensureCredential();
      try {
        const existing = await probe(credential);
        return { state: 'ready', reused: true, protocolVersion: PROTOCOL_VERSION, capabilities: existing.health.capabilities ?? [] };
      } catch (error) {
        if (!(error instanceof PiSessionDaemonUnavailableError)) throw error;
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

      const child = spawn(processLike.execPath, [
        DAEMON_ENTRYPOINT,
        '--endpoint', paths.endpoint,
        '--credential-file', paths.credentialFile,
        '--state-file', paths.stateFile,
        '--cwd', cwd,
        ...(paths.agentDir ? ['--agent-dir', paths.agentDir] : []),
      ], {
        cwd,
        detached: platform !== 'win32',
        stdio: 'ignore',
        windowsHide: true,
        env: buildSessionDaemonChildEnv({
          env,
          electronVersion: processLike.versions?.electron,
        }),
      });
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
      return { credential, ready };
    } catch (probeError) {
      if (intentionallyStopped) throw new PiSessionDaemonUnavailableError('DAEMON_UNAVAILABLE');
      if (probeError instanceof PiSessionDaemonUnavailableError && isPermanentStartupFailure(probeError.code)) {
        throw probeError;
      }
      await start();
      credential = await readCredential();
      return { credential, ready: await probe(credential) };
    }
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
    const { credential } = await ensureReady();
    return subscribeSessionDaemon({ endpoint: paths.endpoint, credential, sessionId, fromSequence, onEvent, onError });
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
    const pendingStart = startPromise;
    if (pendingStart) await pendingStart.catch(() => {});
    return withOperationLock(async () => {
      const credential = await readCredential();
      const { state } = await probe(credential);
      try {
        processLike.kill(state.pid, 'SIGTERM');
      } catch {
        throw new PiSessionDaemonUnavailableError('DAEMON_STOP_FAILED');
      }

      const deadline = Date.now() + startupTimeoutMs;
      while (Date.now() < deadline) {
        if (!isPidAlive(processLike, state.pid)) {
          await removeStaleState(state);
          intentionallyStopped = true;
          return { state: 'stopped' };
        }
        await wait(RETRY_DELAY_MS);
      }
      throw new PiSessionDaemonUnavailableError('DAEMON_STOP_TIMEOUT');
    });
  };

  return { paths, start, health, request: requestDaemon, subscribe, stop };
};
