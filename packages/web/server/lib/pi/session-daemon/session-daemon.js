import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { chmod, mkdir, lstat, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { hasTrustRequiringProjectResources } from '@earendil-works/pi-coding-agent';
import { StringDecoder } from 'node:string_decoder';
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

import { createPiModelConfigStore } from '../model-config-store.js';
import { createSessionRuntimeRegistry } from './runtime-registry.js';
import { getPiSessionDirectory, validatePiSessionJsonlDirectory, validatePiSessionJsonlFile } from './session-jsonl.js';

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

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
  listSessions = ({ cwd: sessionCwd, agentDir: sessionAgentDir = agentDir }) => SessionManager.list(
    sessionCwd,
    getPiSessionDirectory({ cwd: sessionCwd, agentDir: sessionAgentDir }),
  ),
  createSettingsManager = ({ cwd: settingsCwd, agentDir: settingsAgentDir = agentDir, projectTrusted }) => SettingsManager.create(
    settingsCwd,
    settingsAgentDir,
    { projectTrusted },
  ),
  createTrustStore = (settingsAgentDir = agentDir) => new ProjectTrustStore(settingsAgentDir),
  modelConfigStore = createPiModelConfigStore({ file: join(agentDir, 'models.json') }),
  renamePersistedSession = ({ sessionFile, title, cwd: sessionCwd = cwd, agentDir: sessionAgentDir = agentDir }) => {
    const manager = SessionManager.open(sessionFile, getPiSessionDirectory({ cwd: sessionCwd, agentDir: sessionAgentDir }), sessionCwd);
    manager.appendSessionInfo(title);
  },
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
  const knownDirectories = new Set([cwd]);
  let activeDirectory = cwd;
  const servicesCache = new Map();
  const clients = new Set();
  // A reconnect replays only a contiguous retained gap; otherwise it receives
  // a new authoritative snapshot before later events can arrive.
  const eventLog = [];
  const streamingMessageIds = new Map();
  const latestAssistantMessageIds = new Map();
  const messageStartedAt = new Map();
  const toolStartedAt = new Map();
  const latestUserMessageIds = new Map();
  const streamingRedactionBuffers = new Map();
  const loginAttempts = new Map();
  const MAX_REPLAY_EVENTS = 1_024;

  const validateDirectoryPath = async (dir) => {
    if (typeof dir !== 'string' || dir.trim().length === 0) {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The directory path is required.');
    }
    const normalized = dir.trim();
    if (!isAbsolute(normalized)) {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The directory path must be absolute.');
    }
    try {
      const stats = await stat(normalized);
      if (!stats.isDirectory()) {
        throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The specified path is not a directory.');
      }
    } catch (error) {
      if (error instanceof SessionDaemonProtocolError) throw error;
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The directory path does not exist or is inaccessible.');
    }
    return normalized;
  };

  const resolveDirectory = async (requested) => {
    if (typeof requested === 'string' && requested.trim().length > 0) {
      const validated = await validateDirectoryPath(requested);
      knownDirectories.add(validated);
      return validated;
    }
    return activeDirectory || cwd;
  };

  const deriveSessionTitle = (text, maxLength = 50) => {
    if (!text || typeof text !== 'string') return '';
    const cleaned = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]+`/g, ' ')
      .replace(/\[(?:attachment|file|image|audio|video):[^\]]*\]/gi, ' ')
      .replace(/@\S+/g, ' ')
      .replace(/^[#>\s*\-+]+/gm, '');
    const lines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) return '';
    let title = lines[0].replace(/\s+/g, ' ').trim();
    if (title.length > maxLength) {
      title = `${title.slice(0, maxLength).trim()}…`;
    }
    return title;
  };

  const getServices = async (targetCwd = activeDirectory || cwd) => {
    const existing = servicesCache.get(targetCwd);
    if (existing) return existing;
    const services = await createAgentSessionServices({
      cwd: targetCwd,
      agentDir,
      resourceLoaderOptions: { noExtensions: true },
    });
    servicesCache.set(targetCwd, services);
    return services;
  };

  const publish = (event, payload, sessionId = runtime?.session?.sessionId, directory) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    const targetDirectory = directory || activeDirectory || cwd;
    const message = {
      protocolVersion: PROTOCOL_VERSION,
      kind: 'event',
      event,
      sequence: ++sequence,
      payload: {
        sessionId,
        directory: targetDirectory,
        ...payload,
      },
    };
    eventLog.push(message);
    if (eventLog.length > MAX_REPLAY_EVENTS) eventLog.shift();
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

  const publishSnapshot = (socket, requestedSessionId) => {
    const targetRuntime = requestedSessionId ? runtimeRegistry?.findBySessionId(requestedSessionId) : runtime;
    const session = targetRuntime?.session
      ? { sessionId: targetRuntime.session.sessionId, isStreaming: targetRuntime.session.isStreaming }
      : getSessionState();
    if (requestedSessionId && requestedSessionId !== session.sessionId) return;
    const activeSession = targetRuntime?.session || runtime?.session;
    const targetDirectory = targetRuntime?.cwd || activeDirectory || cwd;
    const messages = activeSession ? projectMessageEntries(activeSession, targetDirectory) : [];
    const lastAssistant = [...messages].reverse().find((entry) => entry.message.role === 'assistant')?.message;
    const model = activeSession?.model;
    const snapshotSequence = ++sequence;
    writeFrame(socket, {
      protocolVersion: PROTOCOL_VERSION,
      kind: 'event',
      event: 'session.snapshot',
      sequence: snapshotSequence,
      payload: {
        ...(session.sessionId ? { sessionId: session.sessionId } : {}),
        directory: targetDirectory,
        isStreaming: session.isStreaming ?? false,
        lifecycle: session.isStreaming ? 'busy' : 'idle',
        queue: activeSession ? {
          steering: activeSession.getSteeringMessages?.().length ?? 0,
          followUp: activeSession.getFollowUpMessages?.().length ?? 0,
        } : { steering: 0, followUp: 0 },
        ...(model?.provider && model?.id ? { model: { providerId: model.provider, modelId: model.id } } : {}),
        ...(activeSession?.thinkingLevel ? { thinking: activeSession.thinkingLevel } : {}),
        ...(typeof lastAssistant?.text === 'string' ? { lastText: lastAssistant.text } : {}),
        ...(typeof lastAssistant?.thinking === 'string' ? { lastThinking: lastAssistant.thinking } : {}),
        lastSequence: snapshotSequence,
      },
    });
  };

  const idleDisposeTimers = new Map();

  const clearIdleDisposal = (sessionId) => {
    if (sessionId) {
      const timer = idleDisposeTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      idleDisposeTimers.delete(sessionId);
    } else {
      for (const timer of idleDisposeTimers.values()) clearTimeout(timer);
      idleDisposeTimers.clear();
    }
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

  const startRuntime = async ({ cwd: runtimeCwd = activeDirectory || cwd, sessionFile } = {}) => {
    if (sessionFile) await validatePiSessionJsonlFile(sessionFile);
    const newRuntime = await createRuntime({ cwd: runtimeCwd, agentDir, ...(sessionFile ? { sessionFile } : {}) });
    if (!newRuntime.cwd) {
      newRuntime.cwd = runtimeCwd;
    }
    if (!runtimeRegistry) {
      runtimeRegistry = createSessionRuntimeRegistry({
        onSessionEvent: ({ cwd: eventCwd, sessionId: eventSessionId }, event) => publishSessionEvent(eventSessionId, event, eventCwd),
      });
    }
    runtimeRegistry.register(newRuntime, { cwd: runtimeCwd });
    runtime = newRuntime;
    activeDirectory = runtimeCwd;
    rememberRuntimeSession();
    return newRuntime;
  };

  const ensureRuntime = (targetCwd = activeDirectory || cwd) => {
    if (runtime) return Promise.resolve(runtime);
    if (!runtimeStartPromise) {
      runtimeStartPromise = startRuntime({ cwd: targetCwd, sessionFile: dormantSession?.sessionFile }).finally(() => {
        runtimeStartPromise = undefined;
      });
    }
    return runtimeStartPromise;
  };

  const scheduleIdleDisposal = (sessionId) => {
    clearIdleDisposal(sessionId);
    const timer = setTimeout(async () => {
      idleDisposeTimers.delete(sessionId);
      const targetRuntime = runtimeRegistry?.findBySessionId(sessionId);
      if (!targetRuntime || targetRuntime.session?.isStreaming) return;
      try {
        if (targetRuntime === runtime) {
          rememberRuntimeSession();
        }
        await runtimeRegistry.dispose(targetRuntime);
        if (targetRuntime === runtime) {
          runtime = undefined;
        }
      } catch {
        publish('session.error', { code: 'RUNTIME_DISPOSAL_FAILED' }, sessionId);
      }
    }, idleTimeoutMs);
    idleDisposeTimers.set(sessionId, timer);
  };

  const listSessionItems = async (requestedDirectory) => {
    const targetDir = requestedDirectory ? await resolveDirectory(requestedDirectory) : (activeDirectory || cwd);
    await validatePiSessionJsonlDirectory({ cwd: targetDir, agentDir });
    const sessions = await listSessions({ cwd: targetDir, agentDir });
    if (!Array.isArray(sessions)) {
      throw new SessionDaemonProtocolError('INVALID_SESSION', 'Pi returned an invalid session collection.');
    }

    const idByPath = new Map(sessions.map((session) => [session?.path, session?.id]));
    const uncorrupted = sessions.filter((session) => !session?.corrupted && typeof session?.id === 'string');
    const knownIds = new Set(uncorrupted.map((s) => s.id));
    const activeEntries = runtimeRegistry
      ? runtimeRegistry.listByDirectory(targetDir)
      : (runtime && typeof runtime.cwd === 'string' && (runtime.cwd === targetDir || resolve(runtime.cwd) === resolve(targetDir)) ? [runtime] : []);
    const extra = [];
    for (const entry of activeEntries) {
      if (entry?.session?.sessionId && !knownIds.has(entry.session.sessionId)) {
        extra.push({
          id: entry.session.sessionId,
          cwd: targetDir,
          name: entry.session.sessionManager?.getSessionName?.() || entry.session.title || undefined,
          messageCount: entry.session.messages?.length || 0,
          created: new Date(),
          modified: new Date(),
        });
      }
    }

    const allSessions = [...extra, ...uncorrupted];
    return allSessions.map((session) => {
      const createdAt = session?.created instanceof Date ? session.created.getTime() : (typeof session?.createdAt === 'number' ? session.createdAt : NaN);
      const updatedAt = session?.modified instanceof Date ? session.modified.getTime() : (typeof session?.updatedAt === 'number' ? session.updatedAt : NaN);
      if (typeof session?.id !== 'string' || session.id.length === 0 || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) {
        throw new SessionDaemonProtocolError('INVALID_SESSION', 'Pi returned an invalid session record.');
      }
      const safeFirstMessage = redactAttachmentPaths(session.firstMessage);
      const title = typeof session.name === 'string' && session.name.trim().length > 0
        ? redactAttachmentPaths(session.name.trim())
        : deriveSessionTitle(safeFirstMessage);
      return {
        session: {
          id: session.id,
          directory: targetDir,
          ...(title ? { title } : {}),
          ...(typeof session.parentSessionPath === 'string' && idByPath.get(session.parentSessionPath)
            ? { parentId: idByPath.get(session.parentSessionPath) }
            : {}),
          createdAt,
          updatedAt,
          ...(Number.isSafeInteger(session.messageCount) && session.messageCount >= 0 ? { messageCount: session.messageCount } : {}),
        },
        ...(safeFirstMessage ? { preview: safeFirstMessage } : {}),
        updatedAt,
      };
    });
  };

  const renameSession = async (payload) => {
    if (!payload || typeof payload !== 'object' || typeof payload.sessionId !== 'string' || payload.sessionId.length === 0
      || typeof payload.title !== 'string' || payload.title.trim().length === 0 || payload.title.length > 256) {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The requested session title is invalid.');
    }
    const sessionId = payload.sessionId;
    const title = payload.title.trim();
    const targetDir = payload.directory ? await resolveDirectory(payload.directory) : (activeDirectory || cwd);
    const activeRuntime = runtimeRegistry?.get({ cwd: targetDir, sessionId })
      || runtimeRegistry?.findBySessionId(sessionId)
      || (runtime?.session?.sessionId === sessionId ? runtime : undefined);
    if (activeRuntime?.session) {
      const manager = activeRuntime.session.sessionManager;
      if (typeof manager?.appendSessionInfo !== 'function') {
        throw new SessionDaemonProtocolError('INVALID_SESSION', 'Pi returned an invalid active session.');
      }
      manager.appendSessionInfo(title);
      publish('session.updated', { title }, sessionId, targetDir);
      return;
    }

    await validatePiSessionJsonlDirectory({ cwd: targetDir, agentDir });
    const sessions = await listSessions({ cwd: targetDir, agentDir });
    const target = Array.isArray(sessions) ? sessions.find((session) => session?.id === sessionId) : undefined;
    if (typeof target?.path !== 'string' || target.path.length === 0) {
      throw new SessionDaemonProtocolError('INVALID_SESSION', 'The Pi session does not exist.');
    }
    await validatePiSessionJsonlFile(target.path);
    renamePersistedSession({ sessionFile: target.path, title, cwd: targetDir });
    publish('session.updated', { title }, sessionId, targetDir);
  };

  const findPersistedSession = async (sessionId, requestedDirectory) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new SessionDaemonProtocolError('INVALID_SESSION', 'The Pi session does not exist.');
    }
    const candidateDirs = new Set();
    if (requestedDirectory) {
      try {
        candidateDirs.add(await resolveDirectory(requestedDirectory));
      } catch {}
    }
    if (activeDirectory) candidateDirs.add(activeDirectory);
    if (cwd) candidateDirs.add(cwd);
    for (const d of knownDirectories) candidateDirs.add(d);

    for (const dir of candidateDirs) {
      try {
        await validatePiSessionJsonlDirectory({ cwd: dir, agentDir });
        const sessions = await listSessions({ cwd: dir, agentDir });
        const target = Array.isArray(sessions) ? sessions.find((session) => session?.id === sessionId) : undefined;
        if (target && typeof target.path === 'string' && target.path.length > 0) {
          await validatePiSessionJsonlFile(target.path);
          return { target, directory: dir };
        }
      } catch (err) {
        // Continue searching other candidate directories
      }
    }

    // If not found in candidateDirs, scan all directory stores under agentDir/sessions
    try {
      const sessionsRoot = join(agentDir, 'sessions');
      const dirEntries = await readdir(sessionsRoot, { withFileTypes: true });
      for (const dirEntry of dirEntries) {
        if (!dirEntry.isDirectory()) continue;
        const dirPath = join(sessionsRoot, dirEntry.name);
        const files = await readdir(dirPath, { withFileTypes: true });
        for (const file of files) {
          if (!file.name.endsWith('.jsonl')) continue;
          const fullPath = join(dirPath, file.name);
          try {
            const input = createReadStream(fullPath, { encoding: 'utf8' });
            const lines = createInterface({ input, crlfDelay: Infinity });
            let sessionCwd = null;
            let fileId = null;
            for await (const line of lines) {
              if (!line.trim()) continue;
              const header = JSON.parse(line);
              if (header?.type === 'session' && typeof header.id === 'string') {
                fileId = header.id;
                sessionCwd = header.cwd;
              }
              break;
            }
            lines.close();
            if (fileId === sessionId && sessionCwd) {
              await validatePiSessionJsonlFile(fullPath);
              const validated = await resolveDirectory(sessionCwd);
              knownDirectories.add(validated);
              return { target: { id: sessionId, path: fullPath }, directory: validated };
            }
          } catch {}
        }
      }
    } catch {}

    throw new SessionDaemonProtocolError('INVALID_SESSION', 'The Pi session does not exist.');
  };

  const activateSession = async (sessionId, requestedDirectory) => {
    if (!runtimeRegistry) {
      runtimeRegistry = createSessionRuntimeRegistry({
        onSessionEvent: ({ cwd: eventCwd, sessionId: eventSessionId }, event) => publishSessionEvent(eventSessionId, event, eventCwd),
      });
    }
    if (requestedDirectory) {
      try {
        const targetDir = await resolveDirectory(requestedDirectory);
        const existing = runtimeRegistry.get({ cwd: targetDir, sessionId });
        if (existing) {
          runtime = existing;
          activeDirectory = targetDir;
          return existing;
        }
      } catch {}
    }
    const existingAnywhere = runtimeRegistry.findBySessionId(sessionId);
    if (existingAnywhere) {
      runtime = existingAnywhere;
      if (existingAnywhere.cwd) activeDirectory = existingAnywhere.cwd;
      return existingAnywhere;
    }
    const { target, directory } = await findPersistedSession(sessionId, requestedDirectory);
    const newRuntime = await createRuntime({ cwd: directory, agentDir, sessionFile: target.path });
    if (!newRuntime.cwd) newRuntime.cwd = directory;
    if (newRuntime.session?.sessionId !== sessionId && typeof newRuntime.switchSession === 'function') {
      await newRuntime.switchSession(target.path);
    }
    runtimeRegistry.register(newRuntime, { cwd: directory });
    runtime = newRuntime;
    activeDirectory = directory;
    rememberRuntimeSession();
    return newRuntime;
  };

  const projectMessageEntries = (session, targetDir = activeDirectory || cwd) => {
    const entries = session?.sessionManager?.getEntries?.();
    if (!Array.isArray(entries)) return [];
    const toolResults = new Map();
    for (const entry of entries) {
      if (entry?.type !== 'message' || !entry.message || entry.message.role !== 'toolResult' || typeof entry.message.toolCallId !== 'string') continue;
      toolResults.set(entry.message.toolCallId, {
        ...projectToolResult(entry.message, entry.message.isError === true),
        isError: entry.message.isError === true,
        endedAt: Date.parse(entry.timestamp),
      });
    }
    let latestUserMessageId;
    return entries.flatMap((entry) => {
      if (entry?.type !== 'message' || !entry.message || typeof entry.id !== 'string') return [];
      const timestamp = Date.parse(entry.timestamp);
      const createdAt = Number.isFinite(timestamp) ? timestamp : 0;
      if (entry.message.role === 'user') {
        const text = redactAttachmentPaths(typeof entry.message.content === 'string'
          ? entry.message.content
          : Array.isArray(entry.message.content)
            ? entry.message.content.filter((part) => part?.type === 'text').map((part) => part.text).join('')
            : '');
        latestUserMessageId = entry.id;
        return [{ message: { id: entry.id, sessionId: session.sessionId, directory: targetDir, role: 'user', text, createdAt }, parts: [] }];
      }
      if (entry.message.role !== 'assistant' || !Array.isArray(entry.message.content)) return [];
      const text = redactAttachmentPaths(entry.message.content.filter((part) => part?.type === 'text').map((part) => part.text).join(''));
      const thinking = redactAttachmentPaths(entry.message.content.filter((part) => part?.type === 'thinking').map((part) => part.thinking).join(''));
      const parts = entry.message.content.flatMap((part, index) => {
        if (part?.type === 'text') return [{ type: 'text', id: `${entry.id}:text:${index}`, index, text: redactAttachmentPaths(part.text) }];
        if (part?.type === 'thinking') return [{ type: 'thinking', id: `${entry.id}:thinking:${index}`, index, text: redactAttachmentPaths(part.thinking) }];
        if (part?.type === 'toolCall') {
          const result = toolResults.get(part.id);
          return [{
            type: 'tool',
            id: `${entry.id}:tool:${part.id}`,
            index,
            toolCallId: part.id,
            name: part.name,
            input: redactAttachmentValues(part.arguments),
            state: result?.isError ? 'error' : 'completed',
            ...(result?.output ? { output: result.output } : {}),
            ...(result?.error ? { error: result.error } : {}),
            ...(result?.isError ? { isError: true } : {}),
            ...(result?.metadata ? { metadata: result.metadata } : {}),
            ...(Number.isFinite(result?.endedAt) ? { endedAt: result.endedAt } : {}),
          }];
        }
        return [];
      });
      return [{
        message: {
          id: entry.id, sessionId: session.sessionId, directory: targetDir, role: 'assistant', text, thinking, createdAt,
          ...(latestUserMessageId ? { parentId: latestUserMessageId } : {}),
          model: { providerId: entry.message.provider, modelId: entry.message.model },
          ...(entry.message.errorMessage ? { error: { code: 'ASSISTANT_ERROR', message: redactAttachmentPaths(entry.message.errorMessage) } } : {}),
        },
        parts,
      }];
    });
  };

  const projectActiveSession = (activeRuntime = runtime, targetDir = activeRuntime?.cwd || activeDirectory || cwd) => {
    const session = activeRuntime?.session;
    const manager = session?.sessionManager;
    const header = manager?.getHeader?.();
    const createdAt = Date.parse(header?.timestamp);
    if (!session || !Number.isFinite(createdAt)) {
      throw new SessionDaemonProtocolError('INVALID_SESSION', 'Pi returned an invalid active session.');
    }
    const model = session.model;
    return {
      session: {
        id: session.sessionId, directory: targetDir, createdAt, updatedAt: createdAt,
        ...(session.sessionName ? { title: session.sessionName } : {}),
        ...(model?.provider && model?.id ? { model: { providerId: model.provider, modelId: model.id } } : {}),
        ...(session.thinkingLevel ? { thinking: session.thinkingLevel } : {}),
        messageCount: projectMessageEntries(session, targetDir).length,
      },
      messages: projectMessageEntries(session, targetDir),
      lastSequence: sequence,
    };
  };

  const createSession = async (payload) => {
    if (!payload || typeof payload !== 'object'
      || (payload.cwd !== undefined && (typeof payload.cwd !== 'string' || payload.cwd.length === 0))
      || (payload.title !== undefined && (typeof payload.title !== 'string' || payload.title.trim().length === 0 || payload.title.length > 256))
      || (payload.thinking !== undefined && !['off', 'low', 'medium', 'high', 'xhigh'].includes(payload.thinking))
      || (payload.model !== undefined && (!payload.model || typeof payload.model.providerId !== 'string' || typeof payload.model.modelId !== 'string'))) {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The requested session creation options are invalid.');
    }
    const targetCwd = await resolveDirectory(payload.cwd);
    await validatePiSessionJsonlDirectory({ cwd: targetCwd, agentDir });
    const parent = payload.parentId === undefined ? undefined : (await findPersistedSession(payload.parentId, targetCwd)).target;
    if (!runtimeRegistry) {
      runtimeRegistry = createSessionRuntimeRegistry({
        onSessionEvent: ({ cwd: eventCwd, sessionId: eventSessionId }, event) => publishSessionEvent(eventSessionId, event, eventCwd),
      });
    }
    const newRuntime = await createRuntime({
      cwd: targetCwd,
      agentDir,
      ...(parent ? { sessionFile: parent.path } : {}),
    });
    if (!newRuntime.cwd) newRuntime.cwd = targetCwd;
    let result = { cancelled: false };
    if (typeof newRuntime.newSession === 'function') {
      result = await newRuntime.newSession({
        ...(parent ? { parentSession: parent.path } : {}),
        ...(payload.title ? { setup: async (manager) => manager.appendSessionInfo(payload.title.trim()) } : {}),
      });
    } else if (payload.title && newRuntime.session?.sessionManager?.appendSessionInfo) {
      newRuntime.session.sessionManager.appendSessionInfo(payload.title.trim());
    }
    if (result?.cancelled) throw new SessionDaemonProtocolError('SESSION_CREATE_CANCELLED', 'Pi cancelled session creation.');
    if (payload.model) {
      await setSessionModel(newRuntime, payload.model);
      publishSessionModel(newRuntime.session, newRuntime.session.sessionId, targetCwd);
    }
    if (payload.thinking) {
      newRuntime.session.setThinkingLevel(payload.thinking);
      publish('session.thinking', { thinking: payload.thinking }, newRuntime.session.sessionId, targetCwd);
    }
    runtimeRegistry.register(newRuntime, { cwd: targetCwd });
    runtime = newRuntime;
    activeDirectory = targetCwd;
    rememberRuntimeSession();
    return projectActiveSession(newRuntime, targetCwd);
  };

  const listProviders = async (requestedDirectory) => {
    const targetDir = requestedDirectory ? await resolveDirectory(requestedDirectory) : (activeDirectory || cwd);
    const activeRuntime = await ensureRuntime(targetDir);
    const modelRuntime = activeRuntime.session?.modelRuntime;
    const models = modelRuntime?.getModels?.();
    if (!Array.isArray(models)) throw new SessionDaemonProtocolError('PROVIDER_UNAVAILABLE', 'Pi did not provide a model catalog.');
    const providers = new Map();
    for (const model of models) {
      if (!model || typeof model.provider !== 'string' || typeof model.id !== 'string') continue;
      const provider = modelRuntime.getProvider?.(model.provider);
      const auth = modelRuntime.getProviderAuthStatus?.(model.provider);
      const entry = providers.get(model.provider) ?? {
        id: model.provider,
        label: typeof provider?.name === 'string' ? provider.name : model.provider,
        authenticated: auth?.configured === true,
        models: [],
      };
      entry.models.push({
        id: model.id,
        providerId: model.provider,
        ...(typeof model.name === 'string' ? { label: model.name } : {}),
        ...(Number.isSafeInteger(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
        ...(model.reasoning === true ? { supportsThinking: true } : {}),
        ...(model.thinkingLevelMap && typeof model.thinkingLevelMap === 'object'
          ? { thinkingLevels: Object.entries(model.thinkingLevelMap).filter(([, value]) => value !== null).map(([level]) => level) }
          : {}),
      });
      providers.set(model.provider, entry);
    }
    return { providers: [...providers.values()] };
  };

  const getProviderConfiguration = async (providerId) => {
    if (typeof providerId !== 'string' || providerId.length === 0 || providerId.length > 256) {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The requested provider is invalid.');
    }
    return { config: await modelConfigStore.get(providerId) };
  };

  const setProviderModels = async (payload) => {
    if (!payload || typeof payload !== 'object') {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The provider configuration is invalid.');
    }
    const activeRuntime = await ensureRuntime();
    if (activeRuntime?.session?.isStreaming) {
      throw new SessionDaemonProtocolError('SESSION_BUSY', 'Provider configuration cannot change while a session is streaming.');
    }
    if (typeof activeRuntime?.session?.modelRuntime?.getError?.() === 'string') {
      throw new SessionDaemonProtocolError('PI_MODEL_CONFIG_INVALID', 'Pi models configuration is invalid.');
    }
    let config;
    try {
      config = await modelConfigStore.update(payload);
    } catch (error) {
      if (error?.code === 'PI_MODEL_CONFIG_INVALID') {
        throw new SessionDaemonProtocolError('PI_MODEL_CONFIG_INVALID', 'Pi models configuration is invalid.');
      }
      throw error;
    }
    // ModelRuntime snapshots models.json at construction. Rehydrate only while
    // idle so catalog changes are authoritative immediately and never race a turn.
    servicesCache.clear();
    if (activeRuntime) {
      rememberRuntimeSession();
      await disposeRuntime();
      await ensureRuntime();
    }
    return { config };
  };

  const providerStatus = async (providerId) => {
    if (typeof providerId !== 'string' || providerId.length === 0 || providerId.length > 256) {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The requested provider is invalid.');
    }
    const activeRuntime = await ensureRuntime();
    const modelRuntime = activeRuntime.session?.modelRuntime;
    if (!modelRuntime?.getProvider?.(providerId)) {
      throw new SessionDaemonProtocolError('PROVIDER_NOT_FOUND', 'The requested provider is unavailable.');
    }
    const auth = modelRuntime.getProviderAuthStatus?.(providerId);
    return { providerId, authenticated: auth?.configured === true };
  };

  const projectLoginAttempt = (attempt) => ({
    id: attempt.id,
    providerId: attempt.providerId,
    state: attempt.state,
    ...(attempt.prompt ? { prompt: attempt.prompt } : {}),
    ...(attempt.authUrl ? { authUrl: attempt.authUrl } : {}),
    ...(attempt.deviceCode ? { deviceCode: attempt.deviceCode } : {}),
    ...(attempt.errorCode ? { error: { code: attempt.errorCode } } : {}),
  });

  const getLoginAttempt = (providerId, attemptId) => {
    const attempt = loginAttempts.get(attemptId);
    if (!attempt || attempt.providerId !== providerId) {
      throw new SessionDaemonProtocolError('PROVIDER_AUTH_REQUIRED', 'The provider login attempt is unavailable.');
    }
    return attempt;
  };

  const expireLoginAttempt = (attempt) => {
    const timer = setTimeout(() => {
      if (loginAttempts.get(attempt.id) === attempt) {
        attempt.controller.abort();
        attempt.rejectPrompt?.(new Error('Provider login expired.'));
        loginAttempts.delete(attempt.id);
      }
    }, 10 * 60 * 1_000);
    timer.unref?.();
    return timer;
  };

  const startProviderLogin = async (payload) => {
    if (!payload || typeof payload !== 'object' || typeof payload.providerId !== 'string'
      || !['api_key', 'oauth'].includes(payload.type)
      || (payload.apiKey !== undefined && (typeof payload.apiKey !== 'string' || payload.apiKey.length === 0 || payload.apiKey.length > 16_384))) {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The provider login request is invalid.');
    }
    if (payload.type === 'api_key' && typeof payload.apiKey !== 'string') {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The provider API key is required.');
    }
    const activeRuntime = await ensureRuntime();
    const modelRuntime = activeRuntime.session?.modelRuntime;
    if (!modelRuntime?.getProvider?.(payload.providerId)) {
      throw new SessionDaemonProtocolError('PROVIDER_NOT_FOUND', 'The requested provider is unavailable.');
    }
    const controller = new AbortController();
    const attempt = {
      id: randomUUID(), providerId: payload.providerId, state: 'pending', controller,
      prompt: undefined, authUrl: undefined, deviceCode: undefined, errorCode: undefined,
      resolvePrompt: undefined, rejectPrompt: undefined,
    };
    attempt.expiry = expireLoginAttempt(attempt);
    loginAttempts.set(attempt.id, attempt);
    const apiKey = payload.apiKey;
    const interaction = {
      signal: controller.signal,
      prompt: async (prompt) => {
        if (payload.type === 'api_key') return apiKey;
        if (!prompt || !['text', 'secret', 'select', 'manual_code'].includes(prompt.type)) {
          throw new Error('Unsupported provider login prompt.');
        }
        attempt.prompt = {
          type: prompt.type,
          ...(typeof prompt.message === 'string' ? { message: prompt.message } : {}),
          ...(typeof prompt.placeholder === 'string' ? { placeholder: prompt.placeholder } : {}),
          ...(Array.isArray(prompt.options) ? { options: prompt.options
            .filter((option) => option && typeof option.id === 'string' && typeof option.label === 'string')
            .map((option) => ({ id: option.id, label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) })) } : {}),
        };
        return new Promise((resolve, reject) => {
          attempt.resolvePrompt = resolve;
          attempt.rejectPrompt = reject;
          controller.signal.addEventListener('abort', () => reject(new Error('Provider login cancelled.')), { once: true });
        });
      },
      notify: (event) => {
        if (!event || typeof event !== 'object') return;
        if (event.type === 'auth_url' && typeof event.url === 'string') {
          attempt.authUrl = { url: event.url, ...(typeof event.instructions === 'string' ? { instructions: event.instructions } : {}) };
        } else if (event.type === 'device_code' && typeof event.userCode === 'string' && typeof event.verificationUri === 'string') {
          attempt.deviceCode = {
            userCode: event.userCode, verificationUri: event.verificationUri,
            ...(Number.isFinite(event.intervalSeconds) ? { intervalSeconds: event.intervalSeconds } : {}),
            ...(Number.isFinite(event.expiresInSeconds) ? { expiresInSeconds: event.expiresInSeconds } : {}),
          };
        }
      },
    };
    void modelRuntime.login(payload.providerId, payload.type, interaction).then(
      () => { attempt.state = 'complete'; attempt.prompt = undefined; },
      () => { attempt.state = 'failed'; attempt.prompt = undefined; attempt.errorCode = 'PROVIDER_AUTH_REQUIRED'; },
    ).finally(() => {
      clearTimeout(attempt.expiry);
      const timer = setTimeout(() => loginAttempts.delete(attempt.id), 5 * 60 * 1_000);
      timer.unref?.();
    });
    return { login: projectLoginAttempt(attempt) };
  };

  const respondProviderLogin = (payload) => {
    if (!payload || typeof payload !== 'object' || typeof payload.providerId !== 'string' || typeof payload.loginId !== 'string'
      || typeof payload.value !== 'string' || payload.value.length > 16_384) {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The provider login response is invalid.');
    }
    const attempt = getLoginAttempt(payload.providerId, payload.loginId);
    if (attempt.state !== 'pending' || !attempt.resolvePrompt) {
      throw new SessionDaemonProtocolError('PROVIDER_AUTH_REQUIRED', 'The provider login is not awaiting input.');
    }
    const resolve = attempt.resolvePrompt;
    attempt.prompt = undefined;
    attempt.resolvePrompt = undefined;
    attempt.rejectPrompt = undefined;
    resolve(payload.value);
    return { login: projectLoginAttempt(attempt) };
  };

  const logoutProvider = async (providerId) => {
    const status = await providerStatus(providerId);
    const activeRuntime = await ensureRuntime();
    await activeRuntime.session?.modelRuntime?.logout?.(providerId);
    return { providerId: status.providerId, authenticated: false };
  };

  const readPiSettings = (requestedDirectory) => {
    const targetDir = requestedDirectory || activeDirectory || cwd;
    const trustStore = createTrustStore(agentDir);
    const trust = trustStore.get(targetDir);
    const manager = createSettingsManager({ cwd: targetDir, agentDir, projectTrusted: trust === true });
    const global = manager.getGlobalSettings();
    const project = manager.getProjectSettings();
    return {
      global: {
        ...(typeof global.defaultProvider === 'string' ? { defaultProvider: global.defaultProvider } : {}),
        ...(typeof global.defaultModel === 'string' ? { defaultModel: global.defaultModel } : {}),
        ...(typeof global.defaultThinkingLevel === 'string' ? { defaultThinking: global.defaultThinkingLevel } : {}),
        ...(typeof global.defaultProjectTrust === 'string' ? { defaultProjectTrust: global.defaultProjectTrust } : {}),
      },
      project: {
        trusted: trust === true,
        ...(trust === false ? { denied: true } : {}),
        ...(trust === null && hasTrustRequiringProjectResources(targetDir) ? { requiresTrust: true } : {}),
        ...(trust === true && typeof project.defaultProvider === 'string' ? { defaultProvider: project.defaultProvider } : {}),
        ...(trust === true && typeof project.defaultModel === 'string' ? { defaultModel: project.defaultModel } : {}),
        ...(trust === true && typeof project.defaultThinkingLevel === 'string' ? { defaultThinking: project.defaultThinkingLevel } : {}),
      },
    };
  };

  const setPiSettings = async (payload) => {
    if (!payload || typeof payload !== 'object' || !['global', 'project'].includes(payload.scope)) {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The Pi settings request is invalid.');
    }
    const targetDir = payload.directory ? await resolveDirectory(payload.directory) : (activeDirectory || cwd);
    const hasModel = Object.hasOwn(payload, 'defaultModel');
    const hasThinking = Object.hasOwn(payload, 'defaultThinking');
    const hasTrust = Object.hasOwn(payload, 'trust');
    if (!hasModel && !hasThinking && !hasTrust) throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The Pi settings request is empty.');
    if (hasModel && payload.defaultModel !== null && (!payload.defaultModel || typeof payload.defaultModel.providerId !== 'string'
      || typeof payload.defaultModel.modelId !== 'string' || payload.defaultModel.providerId.length === 0 || payload.defaultModel.modelId.length === 0)) {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The Pi default model is invalid.');
    }
    if (hasThinking && payload.defaultThinking !== null && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(payload.defaultThinking)) {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The Pi default thinking level is invalid.');
    }
    if (hasTrust && payload.trust !== null && typeof payload.trust !== 'boolean') {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The project trust decision is invalid.');
    }
    if (hasTrust && runtime?.session?.isStreaming) {
      throw new SessionDaemonProtocolError('SESSION_BUSY', 'Project trust cannot change during an active session.');
    }
    const trustStore = createTrustStore(agentDir);
    if (hasTrust) trustStore.set(targetDir, payload.trust);
    const trusted = trustStore.get(targetDir) === true;
    if (payload.scope === 'project' && !trusted && (hasModel || hasThinking)) {
      throw new SessionDaemonProtocolError('PROJECT_UNTRUSTED', 'The project is not trusted.');
    }
    if (hasModel || hasThinking) {
      const manager = createSettingsManager({ cwd: targetDir, agentDir, projectTrusted: trusted });
      if (payload.scope === 'global') {
        if (hasModel) manager.setDefaultModelAndProvider(payload.defaultModel?.providerId, payload.defaultModel?.modelId);
        if (hasThinking) manager.setDefaultThinkingLevel(payload.defaultThinking ?? undefined);
      } else {
        if (hasModel) {
          manager.updateProjectSettings('defaultProvider', (settings) => {
            if (payload.defaultModel === null) delete settings.defaultProvider;
            else settings.defaultProvider = payload.defaultModel.providerId;
          });
          manager.updateProjectSettings('defaultModel', (settings) => {
            if (payload.defaultModel === null) delete settings.defaultModel;
            else settings.defaultModel = payload.defaultModel.modelId;
          });
        }
        if (hasThinking) manager.updateProjectSettings('defaultThinkingLevel', (settings) => {
          if (payload.defaultThinking === null) delete settings.defaultThinkingLevel;
          else settings.defaultThinkingLevel = payload.defaultThinking;
        });
      }
      await manager.flush();
      if (manager.drainErrors().length > 0) throw new SessionDaemonProtocolError('PI_SETTINGS_INVALID', 'Pi settings could not be written.');
    }
    if (hasTrust && runtime) {
      await disposeRuntime();
      await ensureRuntime();
    }
    return readPiSettings(targetDir);
  };

  const resourceId = (kind, filePath) => `${kind}:${createHash('sha256').update(filePath).digest('base64url')}`;

  const resourceLocation = (sourceInfo) => {
    if (sourceInfo?.scope === 'project') return 'project';
    if (sourceInfo?.origin === 'package') return 'package';
    if (sourceInfo?.scope === 'user') return 'global';
    return 'path';
  };

  const resourceCatalog = async (requestedDirectory) => {
    const targetDir = requestedDirectory ? await resolveDirectory(requestedDirectory) : (activeDirectory || cwd);
    const activeRuntime = await ensureRuntime(targetDir);
    const loader = activeRuntime?.services?.resourceLoader;
    if (!loader || typeof loader.getSkills !== 'function' || typeof loader.getPrompts !== 'function' || typeof loader.getAgentsFiles !== 'function') {
      throw new SessionDaemonProtocolError('DAEMON_REQUEST_FAILED', 'Pi resource discovery is unavailable.');
    }
    const skills = loader.getSkills().skills.map((skill) => ({
      id: resourceId('skill', skill.filePath),
      kind: 'skill', name: skill.name, ...(skill.description ? { description: skill.description } : {}), location: resourceLocation(skill.sourceInfo), editable: false,
    }));
    const prompts = loader.getPrompts().prompts.map((prompt) => ({
      id: resourceId('prompt', prompt.filePath),
      kind: 'prompt', name: prompt.name, ...(prompt.description ? { description: prompt.description } : {}),
      location: resourceLocation(prompt.sourceInfo), content: prompt.content,
      editable: prompt.sourceInfo?.origin === 'top-level' && ['user', 'project'].includes(prompt.sourceInfo?.scope),
      filePath: prompt.filePath,
    }));
    const agents = loader.getAgentsFiles().agentsFiles.map((agent) => ({
      id: resourceId('agents', agent.path), kind: 'agents', name: basename(agent.path),
      location: agent.path.startsWith(agentDir) ? 'global' : 'project', content: agent.content, editable: true, filePath: agent.path,
    }));
    const globalAgentsPath = join(agentDir, 'AGENTS.md');
    const projectAgentsPath = join(targetDir, 'AGENTS.md');
    for (const [location, filePath] of [['global', globalAgentsPath], ['project', projectAgentsPath]]) {
      if (!agents.some((agent) => agent.filePath === filePath)) {
        agents.push({ id: resourceId('agents', filePath), kind: 'agents', name: 'AGENTS.md', location, content: '', editable: true, filePath });
      }
    }
    return { skills, prompts, agents };
  };

  const publicResources = (catalog) => ({
    skills: catalog.skills.map(({ filePath, ...resource }) => resource),
    prompts: catalog.prompts.map(({ filePath, ...resource }) => resource),
    agents: catalog.agents.map(({ filePath, ...resource }) => resource),
  });

  const requireIdleResourceMutation = () => {
    if (runtime?.session?.isStreaming) throw new SessionDaemonProtocolError('SESSION_BUSY', 'Resources cannot change during an active session.');
  };

  const writeResourceFile = async (filePath, content) => {
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  };

  const refreshResources = async (targetDir) => {
    servicesCache.delete(targetDir || activeDirectory || cwd);
    if (runtime) {
      await disposeRuntime();
      await ensureRuntime();
    }
    return publicResources(await resourceCatalog(targetDir));
  };

  const updateResource = async (payload) => {
    if (!payload || typeof payload.resourceId !== 'string' || typeof payload.content !== 'string' || payload.content.length > 200_000) {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The Pi resource update is invalid.');
    }
    requireIdleResourceMutation();
    const targetDir = payload.directory ? await resolveDirectory(payload.directory) : (activeDirectory || cwd);
    const catalog = await resourceCatalog(targetDir);
    const resource = [...catalog.prompts, ...catalog.agents].find((item) => item.id === payload.resourceId && item.editable === true);
    if (!resource?.filePath) throw new SessionDaemonProtocolError('RESOURCE_NOT_FOUND', 'The requested Pi resource is not editable.');
    let content = payload.content;
    if (resource.kind === 'prompt') {
      const previous = await readFile(resource.filePath, 'utf8').catch((error) => error?.code === 'ENOENT' ? '' : Promise.reject(error));
      const frontmatter = previous.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/)?.[1] ?? '';
      content = `${frontmatter}${content}`;
    }
    await writeResourceFile(resource.filePath, content);
    return refreshResources(targetDir);
  };

  const createPrompt = async (payload) => {
    if (!payload || !['global', 'project'].includes(payload.location) || typeof payload.name !== 'string' || typeof payload.content !== 'string'
      || typeof payload.description !== 'string' || payload.content.length > 200_000 || payload.description.length > 4_000
      || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(payload.name)) {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The Pi prompt template is invalid.');
    }
    requireIdleResourceMutation();
    const targetDir = payload.directory ? await resolveDirectory(payload.directory) : (activeDirectory || cwd);
    const trust = createTrustStore(agentDir).get(targetDir);
    if (payload.location === 'project' && trust !== true) throw new SessionDaemonProtocolError('PROJECT_UNTRUSTED', 'The project is not trusted.');
    const filePath = join(payload.location === 'global' ? agentDir : join(targetDir, '.pi'), 'prompts', `${payload.name}.md`);
    try {
      await readFile(filePath, 'utf8');
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The Pi prompt template already exists.');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await writeResourceFile(filePath, `---\ndescription: ${JSON.stringify(payload.description)}\n---\n${payload.content}`);
    return refreshResources(targetDir);
  };

  const deletePrompt = async (payload) => {
    if (!payload || typeof payload.resourceId !== 'string') throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The Pi prompt template is invalid.');
    requireIdleResourceMutation();
    const targetDir = payload.directory ? await resolveDirectory(payload.directory) : (activeDirectory || cwd);
    const catalog = await resourceCatalog(targetDir);
    const resource = catalog.prompts.find((item) => item.id === payload.resourceId && item.editable === true);
    if (!resource?.filePath) throw new SessionDaemonProtocolError('RESOURCE_NOT_FOUND', 'The requested Pi prompt template is not editable.');
    await rm(resource.filePath);
    return refreshResources(targetDir);
  };

  const setSessionModel = async (activeRuntime, model) => {
    if (!model || typeof model.providerId !== 'string' || typeof model.modelId !== 'string') {
      throw new SessionDaemonProtocolError('INVALID_MODEL', 'The requested Pi model is invalid.');
    }
    const selected = activeRuntime.session?.modelRuntime?.getModel?.(model.providerId, model.modelId);
    if (!selected) throw new SessionDaemonProtocolError('INVALID_MODEL', 'The requested Pi model is unavailable.');
    await activeRuntime.session.setModel(selected);
  };

  const publishSessionModel = (session, sessionId = session?.sessionId, directory) => {
    const model = session?.model;
    if (!model?.provider || !model?.id) {
      throw new SessionDaemonProtocolError('INVALID_MODEL', 'Pi did not select a valid model.');
    }
    publish('session.model', { model: { providerId: model.provider, modelId: model.id } }, sessionId, directory);
  };

  const validateThinking = (thinking) => {
    if (!['off', 'low', 'medium', 'high', 'xhigh'].includes(thinking)) {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The requested thinking level is invalid.');
    }
  };

  const redactAttachmentPaths = (text) => typeof text === 'string'
    ? text
      .replace(/\[Attachment[^\]\r\n]*pi-clipboard-[0-9a-f-]{36}[^\]\r\n]*\]/gi, '[attachment]')
      .replace(/(?:[A-Za-z]:)?[^\s[\](){}"'`]*pi-clipboard-[0-9a-f-]{36}(?:\.[^\s\])}\]"'`,;]+)?/gi, '[attachment]')
    : '';

  const redactAttachmentValues = (value) => {
    if (typeof value === 'string') return redactAttachmentPaths(value);
    if (Array.isArray(value)) return value.map(redactAttachmentValues);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactAttachmentValues(entry)]));
  };

  /**
   * Normalize a Pi `AgentToolResult`-shaped value into public tool-part
   * fields. Text content becomes `output`; `details` become renderer
   * `metadata` (edit diffs, truncation notes); the temporary-output path is
   * never exposed. An errored result surfaces its message as `error`.
   */
  const projectToolResult = (result, isError) => {
    const content = result && typeof result === 'object' && Array.isArray(result.content) ? result.content : [];
    const output = redactAttachmentPaths(content.filter((part) => part?.type === 'text').map((part) => part.text).join(''));
    let metadata;
    if (result && typeof result === 'object' && result.details && typeof result.details === 'object') {
      const details = redactAttachmentValues(result.details);
      if (details && typeof details === 'object') {
        metadata = { ...details };
        delete metadata.fullOutputPath;
      }
    }
    return {
      ...(output ? { output } : {}),
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
      ...(isError && output ? { error: output } : {}),
    };
  };

  // Deltas can split `pi-clipboard-` and its UUID across arbitrary frames.
  // Hold a small suffix, then hold the complete sensitive token once its marker
  // appears. This prevents the browser reducer from reconstructing a path that
  // no individual frame contained in full.
  const redactStreamingAttachmentDelta = (key, delta) => {
    const marker = 'pi-clipboard-';
    let pending = `${streamingRedactionBuffers.get(key) ?? ''}${typeof delta === 'string' ? delta : ''}`;
    let output = '';
    while (pending) {
      const markerIndex = pending.toLowerCase().indexOf(marker);
      if (markerIndex < 0) {
        const lowerPending = pending.toLowerCase();
        let partialLength = 0;
        for (let length = Math.min(marker.length - 1, pending.length); length > 0; length -= 1) {
          if (marker.startsWith(lowerPending.slice(-length))) {
            partialLength = length;
            break;
          }
        }
        if (partialLength === 0) {
          output += pending;
          pending = '';
          break;
        }
        let partialStart = pending.length - partialLength;
        while (partialStart > 0 && !/[\s[\](){}"'`,;]/.test(pending[partialStart - 1])) partialStart -= 1;
        output += pending.slice(0, partialStart);
        pending = pending.slice(partialStart);
        break;
      }
      let tokenStart = markerIndex;
      while (tokenStart > 0 && !/[\s[\](){}"'`,;]/.test(pending[tokenStart - 1])) tokenStart -= 1;
      output += redactAttachmentPaths(pending.slice(0, tokenStart));
      const tokenEndOffset = pending.slice(markerIndex).search(/[\s[\](){}"'`,;]/);
      if (tokenEndOffset < 0) {
        pending = pending.slice(tokenStart);
        break;
      }
      output += '[attachment]';
      pending = pending.slice(markerIndex + tokenEndOffset);
    }
    streamingRedactionBuffers.set(key, pending);
    return output;
  };

  const clearStreamingRedactionBuffers = (sessionId) => {
    const prefix = `${sessionId}:`;
    for (const key of streamingRedactionBuffers.keys()) {
      if (key.startsWith(prefix)) streamingRedactionBuffers.delete(key);
    }
  };

  const prepareAttachmentContent = async (attachments) => {
    if (attachments === undefined) return { text: '', images: [] };
    if (!Array.isArray(attachments) || attachments.length > 32) throw new SessionDaemonProtocolError('INVALID_PROMPT', 'The session attachments are invalid.');
    const text = [];
    const images = [];
    for (const attachment of attachments) {
      if (!attachment || typeof attachment.path !== 'string' || typeof attachment.name !== 'string'
        || typeof attachment.mime !== 'string' || !Number.isSafeInteger(attachment.size) || attachment.size <= 0) {
        throw new SessionDaemonProtocolError('INVALID_PROMPT', 'The session attachments are invalid.');
      }
      try {
        if (attachment.mime.startsWith('image/') && attachment.size <= 20 * 1024 * 1024) {
          const data = await readFile(attachment.path);
          images.push({ type: 'image', mimeType: attachment.mime, data: data.toString('base64') });
        } else {
          await stat(attachment.path);
          text.push(`[Attachment ${attachment.name} is available at ${attachment.path}]`);
        }
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          throw new SessionDaemonProtocolError('ATTACHMENT_MISSING', `The attached temporary file ${attachment.name} is no longer available.`);
        }
        throw err;
      }
    }
    return { text: text.join('\n'), images };
  };

  const sessionInput = async (payload, delivery) => {
    if (!payload || typeof payload !== 'object' || typeof payload.sessionId !== 'string'
      || typeof payload.text !== 'string' || payload.text.length === 0 || Buffer.byteLength(payload.text) > 64 * 1024) {
      throw new SessionDaemonProtocolError('INVALID_PROMPT', 'The session prompt is invalid.');
    }
    if (payload.thinking !== undefined) validateThinking(payload.thinking);
    const activeRuntime = await activateSession(payload.sessionId, payload.directory);
    if (!delivery && activeRuntime.session.isStreaming) {
      throw new SessionDaemonProtocolError('SESSION_BUSY', 'The Pi session already has an active run.');
    }
    if (delivery && !activeRuntime.session.isStreaming) {
      throw new SessionDaemonProtocolError('SESSION_NOT_RUNNING', 'The Pi session has no active run.');
    }
    if (payload.model !== undefined) {
      await setSessionModel(activeRuntime, payload.model);
      publishSessionModel(activeRuntime.session, payload.sessionId, activeRuntime.cwd);
    }
    if (payload.thinking !== undefined) {
      activeRuntime.session.setThinkingLevel(payload.thinking);
      publish('session.thinking', { thinking: payload.thinking }, payload.sessionId, activeRuntime.cwd);
    }

    // Auto-assign deterministic title on first prompt if session manager has no name yet
    const manager = activeRuntime.session?.sessionManager;
    if (typeof payload.text === 'string' && payload.text.trim().length > 0 && !manager?.getSessionName?.()) {
      const derived = deriveSessionTitle(payload.text);
      if (derived && typeof manager?.appendSessionInfo === 'function') {
        manager.appendSessionInfo(derived);
        publish('session.updated', { title: derived }, payload.sessionId, activeRuntime.cwd);
      }
    }

    const attachments = await prepareAttachmentContent(payload.attachments);
    const text = [payload.text, attachments.text].filter(Boolean).join('\n\n');
    const content = attachments.images.length > 0
      ? [{ type: 'text', text }, ...attachments.images]
      : text;
    await activeRuntime.session.sendUserMessage(content, delivery ? { deliverAs: delivery } : undefined);
    const messageId = typeof payload.messageId === 'string' && payload.messageId.length > 0
      ? payload.messageId
      : activeRuntime.session.sessionManager?.getLeafId?.();
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw new SessionDaemonProtocolError('INVALID_SESSION', 'Pi did not persist the prompt.');
    }
    return { accepted: true, messageId };
  };

  const treeForSession = async (sessionId, requestedDirectory) => {
    const activeRuntime = await activateSession(sessionId, requestedDirectory);
    const nodes = activeRuntime.session.sessionManager?.getTree?.();
    if (!Array.isArray(nodes)) throw new SessionDaemonProtocolError('SESSION_TREE_NOT_FOUND', 'Pi returned an invalid session tree.');
    const project = (node) => ({
      entryId: node.entry.id,
      parentId: node.entry.parentId,
      ...(node.entry.type === 'session_info' && typeof node.entry.name === 'string' ? { title: node.entry.name } : {}),
      updatedAt: Date.parse(node.entry.timestamp) || 0,
      children: node.children.map(project),
    });
    return { rootId: sessionId, nodes: nodes.map(project) };
  };

  const deleteSession = async (sessionId, requestedDirectory) => {
    const active = runtimeRegistry?.findBySessionId(sessionId);
    let targetDir = requestedDirectory ? await resolveDirectory(requestedDirectory) : active?.cwd || activeDirectory || cwd;
    if (active) {
      if (active.session?.isStreaming) await active.session.abort();
      await runtimeRegistry?.dispose(active);
      if (runtime === active) runtime = undefined;
    }
    try {
      const { target, directory } = await findPersistedSession(sessionId, targetDir);
      targetDir = directory;
      await rm(target.path, { force: false });
    } catch (error) {
      if (!active || error?.code !== 'INVALID_SESSION') throw error;
    }
    publish('session.lifecycle', { state: 'idle', deleted: true }, sessionId, targetDir);
  };

  const publishSessionEvent = (sessionId, event, directory = activeDirectory || cwd) => {
    switch (event.type) {
      case 'message_start': {
        if (event.message?.role === 'user') {
          const content = event.message.content;
          const text = redactAttachmentPaths(typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('')
              : '');
          const messageId = `user-${sessionId}-${sequence + 1}`;
          latestUserMessageIds.set(sessionId, messageId);
          publish('assistant.message.start', {
            messageId,
            role: 'user',
            text,
            startedAt: Number.isFinite(event.message.timestamp) ? event.message.timestamp : Date.now(),
          }, sessionId, directory);
        } else if (event.message?.role === 'assistant') {
          const messageId = `assistant-${sessionId}-${sequence + 1}`;
          clearStreamingRedactionBuffers(sessionId);
          streamingMessageIds.set(sessionId, messageId);
          latestAssistantMessageIds.set(sessionId, messageId);
          const startedAt = Number.isFinite(event.message.timestamp) ? event.message.timestamp : Date.now();
          messageStartedAt.set(messageId, startedAt);
          publish('assistant.message.start', {
            messageId,
            role: 'assistant',
            ...(latestUserMessageIds.get(sessionId) ? { parentId: latestUserMessageIds.get(sessionId) } : {}),
            startedAt,
            ...(event.message.provider && event.message.model ? { model: { providerId: event.message.provider, modelId: event.message.model } } : {}),
          }, sessionId, directory);
        }
        break;
      }
      case 'message_update': {
        const update = event.assistantMessageEvent;
        const messageId = streamingMessageIds.get(sessionId) ?? latestAssistantMessageIds.get(sessionId) ?? `assistant-${sessionId}`;
        if (update.type === 'text_delta') {
          const delta = redactStreamingAttachmentDelta(`${sessionId}:text:${update.contentIndex}`, update.delta);
          if (delta) publish('assistant.message.delta', { messageId, partId: `${messageId}:text:${update.contentIndex}`, contentIndex: update.contentIndex, delta }, sessionId, directory);
        } else if (update.type === 'thinking_delta') {
          const delta = redactStreamingAttachmentDelta(`${sessionId}:thinking:${update.contentIndex}`, update.delta);
          if (delta) publish('assistant.thinking.delta', { messageId, partId: `${messageId}:thinking:${update.contentIndex}`, contentIndex: update.contentIndex, delta }, sessionId, directory);
        }
        break;
      }
      case 'message_end': {
        if (event.message?.role === 'assistant') {
          const content = Array.isArray(event.message.content) ? event.message.content : [];
          const messageId = streamingMessageIds.get(sessionId) ?? latestAssistantMessageIds.get(sessionId) ?? `assistant-${sessionId}`;
          const startedAt = messageStartedAt.get(messageId) ?? Date.now();
          messageStartedAt.delete(messageId);
          const durationMs = Math.max(100, Date.now() - startedAt);
          publish('assistant.message.end', {
            messageId,
            text: redactAttachmentPaths(content.filter((part) => part?.type === 'text').map((part) => part.text).join('')),
            thinking: redactAttachmentPaths(content.filter((part) => part?.type === 'thinking').map((part) => part.thinking).join('')),
            durationMs,
            ...(event.message.errorMessage ? { error: { code: 'ASSISTANT_ERROR', message: redactAttachmentPaths(event.message.errorMessage) } } : {}),
          }, sessionId, directory);
          streamingMessageIds.delete(sessionId);
          clearStreamingRedactionBuffers(sessionId);
        }
        break;
      }
      case 'tool_execution_start': {
        const messageId = streamingMessageIds.get(sessionId) ?? latestAssistantMessageIds.get(sessionId) ?? `assistant-${sessionId}`;
        const startedAt = Date.now();
        toolStartedAt.set(event.toolCallId, startedAt);
        publish('session.tool.start', {
          toolCallId: event.toolCallId,
          partId: `${messageId}:tool:${event.toolCallId}`,
          messageId,
          name: event.toolName,
          toolName: event.toolName,
          state: 'running',
          ...(event.args !== undefined ? { input: redactAttachmentValues(event.args) } : {}),
          startedAt,
        }, sessionId, directory);
        break;
      }
      case 'tool_execution_update': {
        const messageId = streamingMessageIds.get(sessionId) ?? latestAssistantMessageIds.get(sessionId) ?? `assistant-${sessionId}`;
        const projected = projectToolResult(event.partialResult, false);
        publish('session.tool.update', {
          toolCallId: event.toolCallId,
          partId: `${messageId}:tool:${event.toolCallId}`,
          messageId,
          name: event.toolName,
          toolName: event.toolName,
          state: 'running',
          ...(event.args !== undefined ? { input: redactAttachmentValues(event.args) } : {}),
          ...projected,
        }, sessionId, directory);
        break;
      }
      case 'tool_execution_end': {
        const messageId = streamingMessageIds.get(sessionId) ?? latestAssistantMessageIds.get(sessionId) ?? `assistant-${sessionId}`;
        const startedAt = toolStartedAt.get(event.toolCallId);
        toolStartedAt.delete(event.toolCallId);
        const projected = projectToolResult(event.result, event.isError === true);
        publish('session.tool.end', {
          toolCallId: event.toolCallId,
          partId: `${messageId}:tool:${event.toolCallId}`,
          messageId,
          name: event.toolName,
          toolName: event.toolName,
          state: event.isError ? 'error' : 'completed',
          isError: event.isError === true,
          ...projected,
          ...(Number.isFinite(startedAt) ? { startedAt } : {}),
          endedAt: Date.now(),
        }, sessionId, directory);
        break;
      }
      case 'queue_update':
        publish('session.queue', { steering: event.steering.length, followUp: event.followUp.length }, sessionId, directory);
        break;
      case 'agent_start':
        clearIdleDisposal(sessionId);
        publish('session.lifecycle', { state: 'busy' }, sessionId, directory);
        break;
      case 'agent_end': {
        latestUserMessageIds.delete(sessionId);
        latestAssistantMessageIds.delete(sessionId);
        const finalMessage = event.messages?.at?.(-1);
        if (finalMessage?.role === 'assistant' && finalMessage.stopReason === 'aborted') {
          publish('session.interrupted', { reason: 'user-abort', streaming: false }, sessionId, directory);
        } else if (finalMessage?.role === 'assistant' && typeof finalMessage.errorMessage === 'string') {
          publish('session.error', { code: 'ASSISTANT_ERROR', message: redactAttachmentPaths(finalMessage.errorMessage) }, sessionId, directory);
        }
        break;
      }
      case 'agent_settled':
        publish('session.lifecycle', { state: 'idle' }, sessionId, directory);
        scheduleIdleDisposal(sessionId);
        break;
      case 'thinking_level_changed':
        publish('session.thinking', { thinking: event.level }, sessionId, directory);
        break;
      case 'compaction_start':
        publish('session.compaction', { running: true }, sessionId, directory);
        break;
      case 'compaction_end':
        publish('session.compaction', { running: false }, sessionId, directory);
        break;
      default:
        break;
    }
  };

  const handleRequest = async (socket, message) => {
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
            capabilities: [
              'projects.list', 'projects.select', 'sessions.list', 'sessions.create', 'sessions.open', 'sessions.rename', 'sessions.delete',
              'sessions.tree', 'sessions.navigate', 'sessions.fork', 'sessions.clone', 'sessions.prompt',
              'sessions.steer', 'sessions.followUp', 'sessions.abort', 'sessions.setModel',
              'sessions.setThinking', 'sessions.compact', 'providers.list', 'providers.config.get', 'providers.models.set', 'providers.status', 'providers.login',
              'providers.login.respond', 'providers.login.status', 'providers.logout', 'settings.get', 'settings.set',
              'resources.list', 'resources.update', 'resources.prompts.create', 'resources.prompts.delete',
            ],
            ...(Number.isInteger(healthMetadata.daemonPid) ? { daemonPid: healthMetadata.daemonPid } : {}),
          },
        });
        return;
      case 'projects.list':
        writeFrame(socket, {
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          requestId: message.requestId,
          result: {
            projects: Array.from(knownDirectories).map((dir) => ({
              directory: dir,
              selected: dir === activeDirectory,
            })),
          },
        });
        return;
      case 'projects.select': {
        const targetDir = await resolveDirectory(message.payload?.directory);
        activeDirectory = targetDir;
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result: { directory: targetDir } });
        return;
      }
      case 'providers.list': {
        const result = await listProviders(message.payload?.directory);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result });
        return;
      }
      case 'providers.config.get': {
        const result = await getProviderConfiguration(message.payload?.providerId);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result });
        return;
      }
      case 'providers.models.set': {
        const result = await setProviderModels(message.payload);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result });
        return;
      }
      case 'providers.status': {
        const result = await providerStatus(message.payload?.providerId);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result });
        return;
      }
      case 'providers.login': {
        const result = await startProviderLogin(message.payload);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result });
        return;
      }
      case 'providers.login.respond': {
        const result = respondProviderLogin(message.payload);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result });
        return;
      }
      case 'providers.login.status': {
        const providerId = message.payload?.providerId;
        const loginId = message.payload?.loginId;
        if (typeof providerId !== 'string' || typeof loginId !== 'string') {
          throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The provider login identifier is invalid.');
        }
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result: { login: projectLoginAttempt(getLoginAttempt(providerId, loginId)) } });
        return;
      }
      case 'providers.logout': {
        const result = await logoutProvider(message.payload?.providerId);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result });
        return;
      }
      case 'settings.get': {
        const result = readPiSettings(message.payload?.directory);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result });
        return;
      }
      case 'settings.set': {
        const result = await setPiSettings(message.payload);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result });
        return;
      }
      case 'resources.list': {
        const result = publicResources(await resourceCatalog(message.payload?.directory));
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result });
        return;
      }
      case 'resources.update': {
        const result = await updateResource(message.payload);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result });
        return;
      }
      case 'resources.prompts.create': {
        const result = await createPrompt(message.payload);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result });
        return;
      }
      case 'resources.prompts.delete': {
        const result = await deletePrompt(message.payload);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result });
        return;
      }
      case 'sessions.list': {
        const sessions = await listSessionItems(message.payload?.directory || message.payload?.cwd);
        writeFrame(socket, {
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          requestId: message.requestId,
          result: { sessions },
        });
        return;
      }
      case 'sessions.open': {
        const activeRuntime = await activateSession(message.payload?.sessionId, message.payload?.directory || message.payload?.cwd);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result: projectActiveSession(activeRuntime, activeRuntime.cwd) });
        return;
      }
      case 'sessions.rename': {
        await renameSession(message.payload);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result: {} });
        return;
      }
      case 'sessions.delete': {
        await deleteSession(message.payload?.sessionId, message.payload?.directory || message.payload?.cwd);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result: {} });
        return;
      }
      case 'sessions.tree': {
        const result = await treeForSession(message.payload?.sessionId, message.payload?.directory || message.payload?.cwd);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result });
        return;
      }
      case 'sessions.navigate': {
        const activeRuntime = await activateSession(message.payload?.sessionId, message.payload?.directory || message.payload?.cwd);
        const messageId = message.payload?.messageId;
        if (typeof messageId !== 'string' || messageId.length === 0) throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The requested tree entry is invalid.');
        const result = await activeRuntime.session.navigateTree(messageId);
        if (result.cancelled) throw new SessionDaemonProtocolError('SESSION_TREE_NOT_FOUND', 'Pi cancelled tree navigation.');
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result: projectActiveSession(activeRuntime, activeRuntime.cwd) });
        return;
      }
      case 'sessions.fork':
      case 'sessions.clone': {
        const activeRuntime = await activateSession(message.payload?.sessionId, message.payload?.directory || message.payload?.cwd);
        const entryId = message.command === 'sessions.fork' ? message.payload?.messageId : activeRuntime.session.sessionManager?.getLeafId?.();
        if (typeof entryId !== 'string' || entryId.length === 0) throw new SessionDaemonProtocolError('SESSION_TREE_NOT_FOUND', 'The Pi session has no fork point.');
        const result = await activeRuntime.fork(entryId, { position: 'at' });
        if (result.cancelled) throw new SessionDaemonProtocolError('SESSION_CREATE_CANCELLED', 'Pi cancelled session creation.');
        rememberRuntimeSession();
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result: projectActiveSession(activeRuntime, activeRuntime.cwd) });
        return;
      }
      case 'sessions.create': {
        const result = await createSession(message.payload);
        writeFrame(socket, {
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          requestId: message.requestId,
          result,
        });
        return;
      }
      case 'sessions.prompt':
      case 'sessions.steer':
      case 'sessions.followUp': {
        const payload = message.payload?.sessionId ? message.payload : { ...message.payload, sessionId: getSessionState().sessionId };
        const result = await sessionInput(payload, message.command === 'sessions.steer' ? 'steer' : message.command === 'sessions.followUp' ? 'followUp' : undefined);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result });
        return;
      }
      case 'sessions.abort': {
        const activeRuntime = await activateSession(message.payload?.sessionId, message.payload?.directory || message.payload?.cwd);
        const streaming = activeRuntime.session.isStreaming;
        await activeRuntime.session.abort();
        if (streaming) publish('session.interrupted', { reason: 'user-abort', streaming: true }, message.payload.sessionId, activeRuntime.cwd);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result: {} });
        return;
      }
      case 'sessions.setModel': {
        const activeRuntime = await activateSession(message.payload?.sessionId, message.payload?.directory || message.payload?.cwd);
        await setSessionModel(activeRuntime, message.payload?.model);
        publishSessionModel(activeRuntime.session, message.payload.sessionId, activeRuntime.cwd);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result: {} });
        return;
      }
      case 'sessions.setThinking': {
        const activeRuntime = await activateSession(message.payload?.sessionId, message.payload?.directory || message.payload?.cwd);
        const thinking = message.payload?.thinking;
        validateThinking(thinking);
        activeRuntime.session.setThinkingLevel(thinking);
        publish('session.thinking', { thinking }, message.payload.sessionId, activeRuntime.cwd);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result: {} });
        return;
      }
      case 'sessions.compact': {
        if (message.payload?.thinking !== undefined) validateThinking(message.payload.thinking);
        const activeRuntime = await activateSession(message.payload?.sessionId, message.payload?.directory || message.payload?.cwd);
        if (message.payload?.model !== undefined) {
          await setSessionModel(activeRuntime, message.payload.model);
          publishSessionModel(activeRuntime.session, message.payload.sessionId, activeRuntime.cwd);
        }
        if (message.payload?.thinking !== undefined) {
          activeRuntime.session.setThinkingLevel(message.payload.thinking);
          publish('session.thinking', { thinking: message.payload.thinking }, message.payload.sessionId, activeRuntime.cwd);
        }
        await activeRuntime.session.compact();
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result: {} });
        return;
      }
      default:
        throw new SessionDaemonProtocolError('UNKNOWN_COMMAND', 'The daemon command is not supported.');
    }
  };

  const onConnection = (socket) => {
    let authenticated = false;
    let requestChain = Promise.resolve();
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
            const requestedSessionId = typeof message.sessionId === 'string' && message.sessionId.length > 0 ? message.sessionId : undefined;
            const fromSequence = Number.isSafeInteger(message.fromSequence) && message.fromSequence >= 0 ? message.fromSequence : undefined;
            const oldestRetainedSequence = eventLog[0]?.sequence;
            const canReplay = fromSequence !== undefined && Number.isSafeInteger(oldestRetainedSequence)
              && fromSequence >= oldestRetainedSequence - 1;
            if (canReplay) {
              for (const event of eventLog) {
                if (event.sequence > fromSequence && (!requestedSessionId || event.payload.sessionId === requestedSessionId)) writeFrame(socket, event);
              }
            } else {
              publishSnapshot(socket, requestedSessionId);
            }
            continue;
          }
          requestChain = requestChain.then(() => handleRequest(socket, message)).catch((error) => reject(error));
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
      runtimeRegistry = createSessionRuntimeRegistry({
        onSessionEvent: ({ cwd: eventCwd, sessionId: eventSessionId }, event) => publishSessionEvent(eventSessionId, event, eventCwd),
      });

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
      for (const attempt of loginAttempts.values()) {
        attempt.controller.abort();
        attempt.rejectPrompt?.(new Error('Provider login cancelled.'));
        clearTimeout(attempt.expiry);
      }
      loginAttempts.clear();
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

