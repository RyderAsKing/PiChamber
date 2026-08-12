import { createServer } from 'node:net';
import { chmod, mkdir, lstat, rm } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

import { createSessionRuntimeRegistry } from './runtime-registry.js';
import { getPiSessionDirectory, validatePiSessionJsonlDirectory, validatePiSessionJsonlFile } from './session-jsonl.js';

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 1024 * 1024;

class SessionDaemonProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function isLocalSessionDaemonEndpoint(endpoint, platform = process.platform) {
  if (typeof endpoint !== 'string' || endpoint.length === 0) return false;

  if (platform === 'win32') {
    return /^\\\\\.\\pipe\\[^\\/]+$/.test(endpoint);
  }

  return isAbsolute(endpoint);
}

async function createPiSessionRuntime({ cwd, agentDir = getAgentDir(), sessionFile }) {
  const createRuntime = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      resourceLoaderOptions: {
        // Third-party native extensions are intentionally disabled for the Pi core milestone.
        noExtensions: true,
      },
    });

    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  return createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: sessionFile
      ? SessionManager.open(sessionFile, getPiSessionDirectory({ cwd, agentDir }), cwd)
      : SessionManager.create(cwd, getPiSessionDirectory({ cwd, agentDir })),
  });
}

export function createSessionDaemon({
  endpoint,
  credential,
  cwd,
  agentDir = getAgentDir(),
  createRuntime = createPiSessionRuntime,
  healthMetadata = {},
  idleTimeoutMs = 5 * 60 * 1_000,
  platform = process.platform,
} = {}) {
  if (!isLocalSessionDaemonEndpoint(endpoint, platform)) {
    throw new SessionDaemonProtocolError('INVALID_ENDPOINT', 'The session daemon endpoint must be local.');
  }
  if (typeof credential !== 'string' || credential.length < 16) {
    throw new SessionDaemonProtocolError('INVALID_CREDENTIAL', 'The session daemon credential is invalid.');
  }
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new SessionDaemonProtocolError('INVALID_CWD', 'The session daemon working directory is invalid.');
  }
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 0) {
    throw new SessionDaemonProtocolError('INVALID_IDLE_TIMEOUT', 'The session daemon idle timeout is invalid.');
  }

  let server;
  let runtime;
  let runtimeRegistry;
  let runtimeStartPromise;
  let idleDisposeTimer;
  let dormantSession;
  let sequence = 0;
  let started = false;
  const clients = new Set();

  const publish = (event, payload, sessionId = runtime?.session?.sessionId) => {
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      kind: 'event',
      event,
      sequence: ++sequence,
      payload: {
        sessionId,
        ...payload,
      },
    };
    for (const client of clients) writeFrame(client, message);
  };

  const getSessionState = () => runtime
    ? { sessionId: runtime.session.sessionId, isStreaming: runtime.session.isStreaming }
    : { sessionId: dormantSession?.sessionId, isStreaming: false };

  const rememberRuntimeSession = () => {
    const sessionId = runtime?.session?.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    dormantSession = {
      sessionId,
      sessionFile: runtime.session.sessionManager?.getSessionFile?.(),
    };
  };

  const publishSnapshot = (socket) => {
    const session = getSessionState();
    writeFrame(socket, {
      protocolVersion: PROTOCOL_VERSION,
      kind: 'event',
      event: 'session.snapshot',
      sequence: ++sequence,
      payload: {
        sessionId: session.sessionId,
        isStreaming: session.isStreaming,
        lastSequence: sequence,
      },
    });
  };

  const clearIdleDisposal = () => {
    if (idleDisposeTimer) clearTimeout(idleDisposeTimer);
    idleDisposeTimer = undefined;
  };

  const disposeRuntime = async () => {
    clearIdleDisposal();
    if (runtimeRegistry) {
      const hadTrackedRuntime = runtimeRegistry.size > 0;
      await runtimeRegistry.disposeAll();
      if (!hadTrackedRuntime) await runtime?.dispose?.();
      runtimeRegistry = undefined;
    } else {
      await runtime?.dispose?.();
    }
    runtime = undefined;
  };

  const startRuntime = async ({ sessionFile } = {}) => {
    if (sessionFile) await validatePiSessionJsonlFile(sessionFile);
    runtime = await createRuntime({ cwd, agentDir, ...(sessionFile ? { sessionFile } : {}) });
    bindSession();
    rememberRuntimeSession();
    return runtime;
  };

  const ensureRuntime = () => {
    if (runtime) return Promise.resolve(runtime);
    if (!runtimeStartPromise) {
      runtimeStartPromise = startRuntime({ sessionFile: dormantSession?.sessionFile }).finally(() => {
        runtimeStartPromise = undefined;
      });
    }
    return runtimeStartPromise;
  };

  const scheduleIdleDisposal = (sessionId) => {
    clearIdleDisposal();
    idleDisposeTimer = setTimeout(() => {
      idleDisposeTimer = undefined;
      if (!runtime || runtime.session.sessionId !== sessionId || runtime.session.isStreaming) return;
      rememberRuntimeSession();
      void disposeRuntime().catch(() => publish('session.error', { code: 'RUNTIME_DISPOSAL_FAILED' }, sessionId));
    }, idleTimeoutMs);
  };

  const publishSessionEvent = (sessionId, event) => {
    switch (event.type) {
      case 'message_update': {
        const update = event.assistantMessageEvent;
        if (update.type === 'text_delta') {
          publish('assistant.message.delta', { contentIndex: update.contentIndex, delta: update.delta }, sessionId);
        } else if (update.type === 'thinking_delta') {
          publish('assistant.thinking.delta', { contentIndex: update.contentIndex, delta: update.delta }, sessionId);
        }
        break;
      }
      case 'tool_execution_start':
        publish('session.tool.start', { toolCallId: event.toolCallId, toolName: event.toolName }, sessionId);
        break;
      case 'tool_execution_update':
        publish('session.tool.update', { toolCallId: event.toolCallId, toolName: event.toolName }, sessionId);
        break;
      case 'tool_execution_end':
        publish('session.tool.end', { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError }, sessionId);
        break;
      case 'queue_update':
        publish('session.queue', { steering: event.steering.length, followUp: event.followUp.length }, sessionId);
        break;
      case 'agent_start':
        clearIdleDisposal();
        publish('session.lifecycle', { state: 'running' }, sessionId);
        break;
      case 'agent_settled':
        publish('session.lifecycle', { state: 'idle' }, sessionId);
        scheduleIdleDisposal(sessionId);
        break;
      default:
        break;
    }
  };

  const bindSession = () => {
    runtimeRegistry = createSessionRuntimeRegistry({
      onSessionEvent: ({ sessionId }, event) => publishSessionEvent(sessionId, event),
    });
    runtimeRegistry.register(runtime, { cwd });
  };

  const handleRequest = (socket, message) => {
    if (message.protocolVersion !== PROTOCOL_VERSION || message.kind !== 'request' || typeof message.requestId !== 'string') {
      throw new SessionDaemonProtocolError('INVALID_REQUEST', 'The daemon request is invalid.');
    }

    switch (message.command) {
      case 'runtime.health':
        writeFrame(socket, {
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          requestId: message.requestId,
          result: {
            state: 'ready',
            sessionId: getSessionState().sessionId,
            lastSequence: sequence,
            ...(Number.isInteger(healthMetadata.daemonPid) ? { daemonPid: healthMetadata.daemonPid } : {}),
          },
        });
        return;
      case 'sessions.prompt': {
        const text = message.payload?.text;
        if (typeof text !== 'string' || text.length === 0 || Buffer.byteLength(text) > 64 * 1024) {
          throw new SessionDaemonProtocolError('INVALID_PROMPT', 'The session prompt is invalid.');
        }
        void ensureRuntime().then((activeRuntime) => activeRuntime.session.prompt(text)).catch((error) => {
          publish('session.error', { code: error?.code ?? 'PROMPT_FAILED' }, getSessionState().sessionId);
        });
        writeFrame(socket, {
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          requestId: message.requestId,
          result: { accepted: true },
        });
        return;
      }
      default:
        throw new SessionDaemonProtocolError('UNKNOWN_COMMAND', 'The daemon command is not supported.');
    }
  };

  const onConnection = (socket) => {
    let authenticated = false;
    const decoder = new StringDecoder('utf8');
    let buffer = '';

    const reject = (error) => {
      if (authenticated) {
        writeFrame(socket, {
          protocolVersion: PROTOCOL_VERSION,
          kind: 'error',
          error: { code: error.code ?? 'INVALID_REQUEST' },
        });
      }
      socket.destroy();
    };

    socket.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        reject(new SessionDaemonProtocolError('FRAME_TOO_LARGE', 'The daemon frame is too large.'));
        return;
      }

      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) continue;

        try {
          const message = JSON.parse(line);
          if (!authenticated) {
            if (message.kind !== 'authenticate' || message.credential !== credential) {
              throw new SessionDaemonProtocolError('UNAUTHORIZED', 'The daemon client is not authorized.');
            }
            authenticated = true;
            clients.add(socket);
            writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'authenticated' });
            publishSnapshot(socket);
            continue;
          }
          handleRequest(socket, message);
        } catch (error) {
          reject(error);
          return;
        }
      }
    });

    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  };

  return {
    get endpoint() {
      return endpoint;
    },
    get isStarted() {
      return started;
    },
    async start() {
      if (started) return;
      await validatePiSessionJsonlDirectory({ cwd, agentDir });
      await startRuntime();

      try {
        if (platform !== 'win32') {
          await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
          await chmod(dirname(endpoint), 0o700);
          try {
            await lstat(endpoint);
            throw new SessionDaemonProtocolError('ENDPOINT_IN_USE', 'The daemon endpoint already exists.');
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
        }

        server = createServer(onConnection);
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(endpoint, () => {
            server.off('error', reject);
            resolve();
          });
        });
        if (platform !== 'win32') await chmod(endpoint, 0o600);
        started = true;
      } catch (error) {
        await disposeRuntime();
        server = undefined;
        throw error;
      }
    },
    async stop() {
      if (!started) return;
      for (const client of clients) client.destroy();
      clients.clear();
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await disposeRuntime();
      server = undefined;
      started = false;
      if (platform !== 'win32') await rm(endpoint, { force: true });
    },
  };
}

function writeFrame(socket, frame) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
}
