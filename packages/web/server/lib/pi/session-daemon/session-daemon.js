import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { chmod, mkdir, lstat, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
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

import {
  MAX_EXTENSION_APP_HTML_CHARS,
  sanitizeExtensionFormFields,
  validateExtensionFormValues,
} from '../extension-protocol.js';
import { createPiModelConfigStore } from '../model-config-store.js';
import { clampThinkingLevel, getSupportedThinkingLevels, isPiThinkingLevel } from '../thinking-levels.js';
import { createExtensionBridge } from './extension-bridge.js';
import { createMessageEntryAliases } from './message-entry-aliases.js';
import { resolveEffectiveRetryLimitFromDataDir as resolveEffectiveRetryLimit } from './session-retry-limits.js';
import { createSkillReadClassifier } from './skill-read-classifier.js';
import { createSessionRuntimeRegistry } from './runtime-registry.js';
import {
  findPiSessionJsonlById,
  getPiSessionDirectory,
  listPiSessionJsonlDirectory,
  validatePiSessionJsonlDirectory,
  validatePiSessionJsonlFile,
} from './session-jsonl.js';
import { resolvePiChamberDataDir } from '../../pichamber-data-dir.js';

const PROTOCOL_VERSION = 1;

const textFromContent = (content) => (
  Array.isArray(content)
    ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('')
    : ''
);

// Marker so pi extensions can detect PiChamber without an extra dependency.
// Extensions should use optional detection, e.g.:
//   const chamber = (globalThis as any).__PICHAMBER__;
// or `process.env.PICHAMBER === "1"`. The object is frozen and versioned.
if (!globalThis.__PICHAMBER__) {
  try {
    globalThis.__PICHAMBER__ = Object.freeze({
      version: 1,
      protocol: 'pichamber-extension-ui',
      mode: 'rpc',
    });
  } catch {}
}
if (!process.env.PICHAMBER) {
  try { process.env.PICHAMBER = '1'; } catch {}
}

// Extensions that spawn the pi CLI as a child process (subagent runners,
// task delegators) locate it through `process.argv[1]`. Inside this detached
// daemon that path is daemon-process.js — a bare invocation exits 64 with no
// output, which the extension then reports as "failed (no output)". Re-point
// argv at the installed pi CLI entry before any extension loads so child
// spawns run the real CLI. Scoped to the detached entrypoint so tests and
// in-process hosts keep their own argv.
try {
  if (process.argv[1]?.endsWith('daemon-process.js')) {
    // The SDK is ESM-only, so resolve through import.meta rather than require.
    const mainEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const packageRoot = dirname(dirname(mainEntry));
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.pi;
    if (bin) {
      const cliEntry = join(packageRoot, bin);
      if (existsSync(cliEntry)) process.argv[1] = cliEntry;
    }
  }
} catch {}

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

// Hooks let the daemon thread extension bindings into every Pi runtime
// creation (initial, new/resume/fork replacement) without coupling this
// factory to daemon socket state.
export async function createPiSessionRuntime({ cwd, agentDir = getAgentDir(), sessionFile }, hooks) {
  const createRuntime = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      resourceLoaderOptions: {},
    });

    const result = {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
      })),
      services,
      diagnostics: services.diagnostics,
    };

    if (hooks?.createExtensionBindings && typeof result.session?.bindExtensions === 'function') {
      await result.session.bindExtensions(hooks.createExtensionBindings(result.session));
    }

    return result;
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
  createRuntime: injectCreateRuntime,
  healthMetadata = {},
  idleTimeoutMs = 5 * 60 * 1_000,
  listSessions = ({ cwd: sessionCwd, agentDir: sessionAgentDir = agentDir }) => listPiSessionJsonlDirectory({
    cwd: sessionCwd,
    agentDir: sessionAgentDir,
  }),
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
  const toolInputBySession = new Map();
  const latestUserMessageIds = new Map();
  const retryStateBySession = new Map();
  const compactionStateBySession = new Map();
  const activeRunStartedAt = new Map();
  const sendGenerationBySession = new Map();
  const settledSendGenerationBySession = new Map();
  const shutdownRequestedBySession = new Set();
  const disposingSessionIds = new Set();
  const streamingRedactionBuffers = new Map();
  const loginAttempts = new Map();
  // Server-side normalized extension live state: statuses, widgets, panels,
  // apps, and pending dialogs are kept per session so a reconnect can
  // reconstruct the current UI without requiring the extension to re-emit.
  const messageEntryAliases = createMessageEntryAliases();
  const skillReadClassifierByRuntime = new WeakMap();
  const MAX_REPLAY_EVENTS = 1_024;

  const skillReadClassifierFor = (activeRuntime, directory) => {
    if (!activeRuntime || typeof activeRuntime !== 'object') return undefined;
    const classifierCwd = activeRuntime.cwd || directory || activeDirectory || cwd;
    const cached = skillReadClassifierByRuntime.get(activeRuntime);
    if (cached?.cwd === classifierCwd) return cached.classifier;
    const loader = activeRuntime.services?.resourceLoader;
    const discovered = loader?.getSkills?.();
    const classifier = createSkillReadClassifier({
      cwd: classifierCwd,
      skills: discovered?.skills,
      platform,
    });
    skillReadClassifierByRuntime.set(activeRuntime, { cwd: classifierCwd, classifier });
    return classifier;
  };

  const rememberToolInput = (sessionId, toolCallId, args) => {
    const inputs = toolInputBySession.get(sessionId) ?? new Map();
    inputs.set(toolCallId, args);
    toolInputBySession.set(sessionId, inputs);
  };

  const getToolInput = (sessionId, toolCallId) => toolInputBySession.get(sessionId)?.get(toolCallId);

  const forgetToolInput = (sessionId, toolCallId) => {
    const inputs = toolInputBySession.get(sessionId);
    if (!inputs) return;
    inputs.delete(toolCallId);
    if (inputs.size === 0) toolInputBySession.delete(sessionId);
  };

  const mergeToolPresentationMetadata = (metadata, activeRuntime, directory, toolName, args) => {
    const skill = skillReadClassifierFor(activeRuntime, directory)?.(toolName, args);
    if (!skill) return metadata;
    const currentPiChamberMetadata = metadata?.pichamber && typeof metadata.pichamber === 'object'
      ? metadata.pichamber
      : {};
    return {
      ...(metadata ?? {}),
      pichamber: {
        ...currentPiChamberMetadata,
        skill,
      },
    };
  };

  const validateDirectoryPath = async (dir) => {
    if (typeof dir !== 'string' || dir.trim().length === 0) {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The directory path is required.');
    }
    const requested = dir.trim();
    const normalized = requested === '~' ? homedir() : requested;
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
      // PiChamber projects are trusted by default — auto-trust on explicit add/select
      // so skills (and other resources) never trigger the trust popup for known dirs.
      try {
        const trustStore = createTrustStore(agentDir);
        if (trustStore.get(validated) === null && hasTrustRequiringProjectResources(validated)) {
          trustStore.set(validated, true);
        }
      } catch {}
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
      resourceLoaderOptions: {},
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

  const extensionBridge = createExtensionBridge({
    publish,
    resolveDirectory,
    redactAttachmentPaths: (value) => redactAttachmentPaths(value),
    redactAttachmentValues: (value) => redactAttachmentValues(value),
    findRuntimeBySessionId: (sessionId) => runtimeRegistry?.findBySessionId(sessionId)
      || (runtime?.session?.sessionId === sessionId ? runtime : undefined),
    getDefaultDirectory: () => activeDirectory || cwd,
    getSequence: () => sequence,
    protocolError: (code, message) => new SessionDaemonProtocolError(code, message),
    requestSessionShutdown: (sessionId) => shutdownRequestedBySession.add(sessionId),
  });
  const {
    buildExtensionBindings,
    clearExtensionState,
    mirrorExtensionApp,
    mirrorExtensionPanel,
    publishExtensionCustomMessage,
    resolveExtensionDialog,
  } = extensionBridge;

  // Thread extension hooks through our own default factory. Injected test or
  // host factories keep their single-argument contract and ignore the hooks.
  const baseCreateRuntime = injectCreateRuntime
    ?? ((runtimeOptions, runtimeHooks) => createPiSessionRuntime(runtimeOptions, runtimeHooks));
  const createRuntime = (runtimeOptions) => baseCreateRuntime(runtimeOptions, {
    createExtensionBindings: buildExtensionBindings,
  });

  const getSessionState = () => runtime
    ? { sessionId: runtime.session.sessionId, isStreaming: runtime.session.isStreaming }
    : { sessionId: dormantSession?.sessionId, isStreaming: false };

  const persistedCompactionState = (session) => {
    const entries = session?.sessionManager?.getBranch?.() ?? session?.sessionManager?.getEntries?.();
    if (!Array.isArray(entries)) return undefined;
    const entry = [...entries].reverse().find((candidate) => candidate?.type === 'compaction');
    if (!entry) return undefined;
    const completedAt = typeof entry.timestamp === 'number' ? entry.timestamp : Date.parse(entry.timestamp);
    return {
      phase: 'completed',
      ...(Number.isFinite(completedAt) ? { completedAt } : {}),
      ...(Number.isFinite(entry.tokensBefore) && entry.tokensBefore >= 0 ? { tokensBefore: entry.tokensBefore } : {}),
    };
  };

  const compactionStateFor = (session) => {
    if (!session?.sessionId) return undefined;
    return compactionStateBySession.get(session.sessionId) ?? persistedCompactionState(session);
  };

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
    const retry = session.sessionId ? retryStateBySession.get(session.sessionId) : undefined;
    const compaction = compactionStateFor(activeSession);
    const targetDirectory = targetRuntime?.cwd || activeDirectory || cwd;
    const messages = activeSession ? projectMessageEntries(targetRuntime || runtime, targetDirectory) : [];
    const lastAssistant = [...messages].reverse().find((entry) => entry.message.role === 'assistant')?.message;
    const model = activeSession?.model;
    const snapshotSequence = ++sequence;
    // Snapshot must carry enough extension live state for a reconnect that
    // missed the gap: statuses, widgets, and pending blocking dialogs per
    // session. Without it, a phone that reconnects after the 1k replay
    // window would lose its sub-agent panel or approval prompt.
    const extensionSnapshot = extensionBridge.getSnapshotState(session.sessionId);
    writeFrame(socket, {
      protocolVersion: PROTOCOL_VERSION,
      kind: 'event',
      event: 'session.snapshot',
      sequence: snapshotSequence,
      payload: {
        ...(session.sessionId ? { sessionId: session.sessionId } : {}),
        directory: targetDirectory,
        isStreaming: session.isStreaming ?? false,
        lifecycle: retry ? 'retry' : session.isStreaming ? 'busy' : 'idle',
        ...(retry ? { retry } : {}),
        ...(compaction ? { compaction } : {}),
        queue: activeSession ? {
          steering: activeSession.getSteeringMessages?.().length ?? 0,
          followUp: activeSession.getFollowUpMessages?.().length ?? 0,
        } : { steering: 0, followUp: 0 },
        ...(model?.provider && model?.id ? { model: { providerId: model.provider, modelId: model.id } } : {}),
        ...(activeSession?.thinkingLevel ? { thinking: activeSession.thinkingLevel } : {}),
        ...(typeof lastAssistant?.text === 'string' ? { lastText: lastAssistant.text } : {}),
        ...(typeof lastAssistant?.thinking === 'string' ? { lastThinking: lastAssistant.thinking } : {}),
        ...(session.sessionId && activeRunStartedAt.has(session.sessionId) ? { runStartedAt: activeRunStartedAt.get(session.sessionId) } : {}),
        serverNow: Date.now(),
        lastSequence: snapshotSequence,
        ...(extensionSnapshot.statuses ? { extensionStatuses: extensionSnapshot.statuses } : {}),
        ...(extensionSnapshot.widgets ? { extensionWidgets: extensionSnapshot.widgets } : {}),
        ...(extensionSnapshot.dialogs ? { extensionDialogs: extensionSnapshot.dialogs } : {}),
        ...(extensionSnapshot.panels ? { extensionPanels: extensionSnapshot.panels } : {}),
        ...(extensionSnapshot.apps ? { extensionApps: extensionSnapshot.apps } : {}),
        ...(extensionSnapshot.title ? { extensionTitle: extensionSnapshot.title } : {}),
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
    clearExtensionState(undefined);
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

  const disposeIdleSessionRuntime = async (sessionId) => {
    if (disposingSessionIds.has(sessionId)) return;
    const targetRuntime = runtimeRegistry?.findBySessionId(sessionId);
    if (!targetRuntime) {
      shutdownRequestedBySession.delete(sessionId);
      return;
    }
    if (targetRuntime.session?.isStreaming || targetRuntime.session?.isCompacting) return;
    disposingSessionIds.add(sessionId);
    clearIdleDisposal(sessionId);
    try {
      if (targetRuntime === runtime) rememberRuntimeSession();
      clearExtensionState(sessionId);
      await runtimeRegistry.dispose(targetRuntime);
      shutdownRequestedBySession.delete(sessionId);
      compactionStateBySession.delete(sessionId);
      if (targetRuntime === runtime) runtime = undefined;
    } catch {
      publish('session.error', { code: 'RUNTIME_DISPOSAL_FAILED' }, sessionId, targetRuntime.cwd);
    } finally {
      disposingSessionIds.delete(sessionId);
    }
  };

  const completeRequestedShutdown = (sessionId) => {
    if (!shutdownRequestedBySession.has(sessionId)) return false;
    void disposeIdleSessionRuntime(sessionId);
    return true;
  };

  const scheduleIdleDisposal = (sessionId) => {
    clearIdleDisposal(sessionId);
    const timer = setTimeout(() => {
      idleDisposeTimers.delete(sessionId);
      void disposeIdleSessionRuntime(sessionId);
    }, idleTimeoutMs);
    idleDisposeTimers.set(sessionId, timer);
  };

  const listInflightByDirectory = new Map();
  const listSessionItemsUnshared = async (targetDir) => {
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

  const listSessionItems = async (requestedDirectory) => {
    const targetDir = requestedDirectory ? await resolveDirectory(requestedDirectory) : (activeDirectory || cwd);
    const inflight = listInflightByDirectory.get(targetDir);
    if (inflight) return inflight;
    const pending = listSessionItemsUnshared(targetDir).finally(() => {
      if (listInflightByDirectory.get(targetDir) === pending) listInflightByDirectory.delete(targetDir);
    });
    listInflightByDirectory.set(targetDir, pending);
    return pending;
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
      publish('session.updated', { title: redactAttachmentPaths(title) }, sessionId, targetDir);
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
    publish('session.updated', { title: redactAttachmentPaths(title) }, sessionId, targetDir);
  };

  const findPersistedSession = async (sessionId, requestedDirectory) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new SessionDaemonProtocolError('INVALID_SESSION', 'The Pi session does not exist.');
    }
    const candidateDirs = new Set();
    let requestedTargetDirectory;
    if (requestedDirectory) {
      try {
        requestedTargetDirectory = await resolveDirectory(requestedDirectory);
        candidateDirs.add(requestedTargetDirectory);
      } catch {}
    }
    if (activeDirectory) candidateDirs.add(activeDirectory);
    if (cwd) candidateDirs.add(cwd);
    for (const d of knownDirectories) candidateDirs.add(d);

    const findInDirectory = async (directory) => {
      try {
        const sessions = await listSessions({ cwd: directory, agentDir });
        const target = Array.isArray(sessions) ? sessions.find((session) => session?.id === sessionId) : undefined;
        if (target && typeof target.path === 'string' && target.path.length > 0) {
          await validatePiSessionJsonlFile(target.path);
          return { target, directory };
        }
      } catch {
        // Continue through the remaining authoritative lookup paths.
      }
      return undefined;
    };

    // A caller-supplied directory is the narrowest authoritative scope. Check
    // it before walking every directory in the agent store. This keeps an
    // ordinary session open proportional to that project's sessions and avoids
    // choosing a same-id record from another directory.
    if (requestedTargetDirectory) {
      const requestedTarget = await findInDirectory(requestedTargetDirectory);
      if (requestedTarget) return requestedTarget;
    }

    // Filename identity is enough to locate a session from a directory-less
    // deep link without fully reading every transcript. A stale link can still
    // fall through to the bounded header scans below.
    try {
      const named = await findPiSessionJsonlById({ sessionId, agentDir });
      if (named?.path && named.cwd) {
        await validatePiSessionJsonlFile(named.path);
        const directory = await resolveDirectory(named.cwd);
        knownDirectories.add(directory);
        return { target: { id: sessionId, path: named.path }, directory };
      }
    } catch {
      // Fall through to list / header scan for non-standard filenames.
    }

    for (const directory of candidateDirs) {
      if (directory === requestedTargetDirectory) continue;
      const target = await findInDirectory(directory);
      if (target) return target;
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

  const activateInflightBySessionId = new Map();
  const activateSessionUnshared = async (sessionId, requestedDirectory) => {
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
    const raced = runtimeRegistry.findBySessionId(sessionId);
    if (raced) {
      try { await newRuntime.dispose?.(); } catch { /* keep the winner */ }
      runtime = raced;
      if (raced.cwd) activeDirectory = raced.cwd;
      return raced;
    }
    try {
      runtimeRegistry.register(newRuntime, { cwd: directory });
    } catch (error) {
      if (error?.code === 'SESSION_RUNTIME_CONFLICT') {
        try { await newRuntime.dispose?.(); } catch { /* keep the winner */ }
        const winner = runtimeRegistry.findBySessionId(sessionId)
          || runtimeRegistry.get({ cwd: directory, sessionId });
        if (winner) {
          runtime = winner;
          if (winner.cwd) activeDirectory = winner.cwd;
          return winner;
        }
      }
      throw error;
    }
    runtime = newRuntime;
    activeDirectory = directory;
    rememberRuntimeSession();
    return newRuntime;
  };

  const activateSession = async (sessionId, requestedDirectory) => {
    const inflight = activateInflightBySessionId.get(sessionId);
    if (inflight) return inflight;
    const pending = activateSessionUnshared(sessionId, requestedDirectory).finally(() => {
      if (activateInflightBySessionId.get(sessionId) === pending) activateInflightBySessionId.delete(sessionId);
    });
    activateInflightBySessionId.set(sessionId, pending);
    return pending;
  };

  const liveProjectionEntries = (session, persisted) => {
    if (!session?.isStreaming) return persisted;
    const liveMessages = [];
    if (Array.isArray(session.messages)) liveMessages.push(...session.messages);
    const streamingMessage = session.state?.streamingMessage;
    if (streamingMessage && liveMessages[liveMessages.length - 1] !== streamingMessage) {
      liveMessages.push(streamingMessage);
    }
    if (liveMessages.length === 0) return persisted;

    const persistedKeys = new Set();
    for (const entry of persisted) {
      if (entry?.type !== 'message' || !entry.message) continue;
      const timestamp = typeof entry.message.timestamp === 'number' ? entry.message.timestamp : Date.parse(entry.timestamp);
      persistedKeys.add(`${entry.message.role}:${Number.isFinite(timestamp) ? timestamp : ''}`);
    }

    const entries = [...persisted];
    let liveIndex = 0;
    const liveAssistantId = streamingMessageIds.get(session.sessionId);
    for (const message of liveMessages) {
      if (!message || (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'toolResult')) continue;
      const timestamp = typeof message.timestamp === 'number' ? message.timestamp : undefined;
      const key = `${message.role}:${timestamp ?? ''}`;
      if (timestamp !== undefined && persistedKeys.has(key)) continue;
      persistedKeys.add(key);
      const id = message.role === 'assistant' && liveAssistantId
        ? liveAssistantId
        : `live-${session.sessionId}-${liveIndex}`;
      liveIndex += 1;
      entries.push({
        type: 'message',
        id,
        timestamp: new Date(timestamp || Date.now()).toISOString(),
        message,
      });
    }
    return entries;
  };

  const projectMessageEntries = (activeRuntime, targetDir = activeDirectory || cwd) => {
    const session = activeRuntime?.session;
    // Use the active branch, not the full file. `getEntries()` returns every
    // entry ever written, so a bare `branch()`/`resetLeaf()` would appear to
    // do nothing. `getBranch()` follows the current leaf and is what
    // `navigateTree` and `buildSessionContext` use for the model context.
    const persisted = session?.sessionManager?.getBranch?.() ?? session?.sessionManager?.getEntries?.();
    const entries = liveProjectionEntries(session, Array.isArray(persisted) ? persisted : []);
    if (entries.length === 0) return [];
    const streaming = session?.isStreaming === true;
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
      // Extension-authored content: custom entries (`appendEntry`) and custom
      // messages (`sendMessage`) both surface as extension-role items so the
      // UI can render them through its extension renderer registry.
      if (entry?.type === 'custom') {
        if (typeof entry.customType !== 'string' || entry.customType.length === 0 || typeof entry.id !== 'string') return [];
        const timestamp = Date.parse(entry.timestamp);
        return [{
          message: {
            id: entry.id, sessionId: session.sessionId, directory: targetDir, role: 'extension',
            customType: entry.customType,
            createdAt: Number.isFinite(timestamp) ? timestamp : 0,
            ...(entry.data !== undefined ? { data: redactAttachmentValues(entry.data) } : {}),
          },
          parts: [],
        }];
      }
      if (entry?.type === 'custom_message') {
        if (typeof entry.customType !== 'string' || entry.customType.length === 0 || typeof entry.id !== 'string') return [];
        if (entry.display === false) return [];
        const timestamp = Date.parse(entry.timestamp);
        const text = typeof entry.content === 'string'
          ? entry.content
          : Array.isArray(entry.content)
            ? textFromContent(entry.content)
            : '';
        return [{
          message: {
            id: entry.id, sessionId: session.sessionId, directory: targetDir, role: 'extension',
            customType: entry.customType,
            text: redactAttachmentPaths(text),
            createdAt: Number.isFinite(timestamp) ? timestamp : 0,
            ...(entry.details !== undefined ? { details: redactAttachmentValues(entry.details) } : {}),
          },
          parts: [],
        }];
      }
      if (entry?.type !== 'message' || !entry.message || typeof entry.id !== 'string') return [];
      const timestamp = Date.parse(entry.timestamp);
      const createdAt = Number.isFinite(timestamp) ? timestamp : 0;
      if (entry.message.role === 'user') {
        const text = redactAttachmentPaths(typeof entry.message.content === 'string'
          ? entry.message.content
          : Array.isArray(entry.message.content)
            ? textFromContent(entry.message.content)
            : '');
        latestUserMessageId = entry.id;
        return [{ message: { id: entry.id, sessionId: session.sessionId, directory: targetDir, role: 'user', text, createdAt }, parts: [] }];
      }
      if (entry.message.role !== 'assistant' || !Array.isArray(entry.message.content)) return [];
      const text = redactAttachmentPaths(textFromContent(entry.message.content));
      const thinking = redactAttachmentPaths(entry.message.content.filter((part) => part?.type === 'thinking').map((part) => part.thinking).join(''));
      const usage = projectUsage(entry.message.usage);
      const parts = entry.message.content.flatMap((part, index) => {
        if (part?.type === 'text') return [{ type: 'text', id: `${entry.id}:text:${index}`, index, text: redactAttachmentPaths(part.text) }];
        if (part?.type === 'thinking') return [{ type: 'thinking', id: `${entry.id}:thinking:${index}`, index, text: redactAttachmentPaths(part.thinking) }];
        if (part?.type === 'toolCall') {
          const result = toolResults.get(part.id);
          const running = streaming && !result;
          const interrupted = !running && !result;
          const metadata = mergeToolPresentationMetadata(result?.metadata, activeRuntime, targetDir, part.name, part.arguments);
          return [{
            type: 'tool',
            id: `${entry.id}:tool:${part.id}`,
            index,
            toolCallId: part.id,
            name: part.name,
            input: redactAttachmentValues(part.arguments),
            state: result?.isError || interrupted ? 'error' : running ? 'running' : 'completed',
            ...(result?.output ? { output: result.output } : {}),
            ...(result?.error
              ? { error: result.error }
              : interrupted
                ? { error: 'Tool was interrupted before completion.' }
                : {}),
            ...(result?.isError || interrupted ? { isError: true } : {}),
            ...(metadata ? { metadata } : {}),
            ...(Number.isFinite(result?.endedAt)
              ? { endedAt: result.endedAt }
              : interrupted
                ? { endedAt: createdAt }
                : {}),
          }];
        }
        return [];
      });
      return [{
        message: {
          id: entry.id, sessionId: session.sessionId, directory: targetDir, role: 'assistant', text, thinking, createdAt,
          ...(latestUserMessageId ? { parentId: latestUserMessageId } : {}),
          model: { providerId: entry.message.provider, modelId: entry.message.model },
          ...(isPiThinkingLevel(entry.message.thinkingLevel) ? { thinkingLevel: entry.message.thinkingLevel } : {}),
          ...(entry.message.errorMessage ? { error: { code: 'ASSISTANT_ERROR', message: redactAttachmentPaths(entry.message.errorMessage) } } : {}),
          ...(usage ? { usage } : {}),
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
    const messages = projectMessageEntries(activeRuntime, targetDir);
    const lastAssistant = [...messages].reverse().find((entry) => entry.message.role === 'assistant')?.message;
    const sessionModel = lastAssistant?.model
      ?? (model?.provider && model?.id ? { providerId: model.provider, modelId: model.id } : undefined);
    const sessionThinking = lastAssistant?.thinkingLevel || session.thinkingLevel;
    const isStreaming = session.isStreaming === true;
    const retry = retryStateBySession.get(session.sessionId);
    const compaction = compactionStateFor(session);
    const extensionSnapshot = extensionBridge.getSnapshotState(session.sessionId);
    return {
      session: {
        id: session.sessionId, directory: targetDir, createdAt, updatedAt: createdAt,
        ...(session.sessionName ? { title: session.sessionName } : {}),
        ...(sessionModel ? { model: sessionModel } : {}),
        ...(sessionThinking ? { thinking: sessionThinking } : {}),
        messageCount: messages.length,
      },
      messages,
      lastSequence: sequence,
      isStreaming,
      lifecycle: retry ? 'retry' : isStreaming ? 'busy' : 'idle',
      ...(retry ? { retry } : {}),
      ...(compaction ? { compaction } : {}),
      ...(activeRunStartedAt.has(session.sessionId) ? { runStartedAt: activeRunStartedAt.get(session.sessionId) } : {}),
      serverNow: Date.now(),
      ...(extensionSnapshot.statuses ? { extensionStatuses: extensionSnapshot.statuses } : {}),
      ...(extensionSnapshot.widgets ? { extensionWidgets: extensionSnapshot.widgets } : {}),
      ...(extensionSnapshot.dialogs ? { extensionDialogs: extensionSnapshot.dialogs } : {}),
      ...(extensionSnapshot.panels ? { extensionPanels: extensionSnapshot.panels } : {}),
      ...(extensionSnapshot.apps ? { extensionApps: extensionSnapshot.apps } : {}),
      ...(extensionSnapshot.title ? { extensionTitle: extensionSnapshot.title } : {}),
    };
  };

  const createSession = async (payload) => {
    const explicitRetryLimit = payload && typeof payload === 'object' ? (payload.maxRetries ?? payload.retryLimit ?? payload.defaultRetryLimit) : undefined;
    if (explicitRetryLimit !== undefined && (!Number.isInteger(explicitRetryLimit) || explicitRetryLimit < 0 || explicitRetryLimit > 10)) {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The retry limit must be an integer between 0 and 10.');
    }
    if (!payload || typeof payload !== 'object'
      || (payload.cwd !== undefined && (typeof payload.cwd !== 'string' || payload.cwd.length === 0))
      || (payload.title !== undefined && (typeof payload.title !== 'string' || payload.title.trim().length === 0 || payload.title.length > 256))
      || (payload.thinking !== undefined && !isPiThinkingLevel(payload.thinking))
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
    // Apply default retry limit for new sessions. Explicit per-run overrides win.
    // With no PiChamber override configured, Pi's own retry settings stay
    // authoritative — the runtime default (3) already matches, so nothing is
    // applied and a user's Pi-native maxRetries value is never stomped.
    try {
      const settingsManager = newRuntime.services?.settingsManager;
      if (settingsManager && typeof settingsManager.getRetrySettings === 'function') {
        const effective = await resolveEffectiveRetryLimit({ payloadRetryLimit: explicitRetryLimit, dataDir: resolvePiChamberDataDir() });
        if (effective !== undefined) {
          const current = settingsManager.getRetrySettings().maxRetries;
          if (current !== effective) {
            if (typeof settingsManager.applyOverrides === 'function') {
              // In-memory only: applyOverrides never queues a write, so this
              // scopes the limit to sessions created on this runtime without
              // touching Pi's own settings files.
              settingsManager.applyOverrides({ retry: { maxRetries: effective } });
            } else if (settingsManager.globalSettings) {
              settingsManager.globalSettings.retry = { ...(settingsManager.globalSettings.retry ?? {}), maxRetries: effective };
            }
          }
        }
      }
    } catch {}
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
    if (payload.thinking !== undefined) {
      applyThinking(newRuntime, payload.thinking, newRuntime.session.sessionId, targetCwd);
    }
    runtimeRegistry.register(newRuntime, { cwd: targetCwd });
    runtime = newRuntime;
    activeDirectory = targetCwd;
    rememberRuntimeSession();
    const created = projectActiveSession(newRuntime, targetCwd);
    const createdTitle = created.session.title
      || (typeof payload.title === 'string' ? payload.title.trim() : '')
      || newRuntime.session?.sessionManager?.getSessionName?.();
    if (createdTitle) {
      publish('session.updated', { title: redactAttachmentPaths(createdTitle) }, created.session.id, targetCwd);
    }
    return created;
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
        ...(model.reasoning === true ? { supportsThinking: true, thinkingLevels: getSupportedThinkingLevels(model) } : {}),
      });
      providers.set(model.provider, entry);
    }
    return { providers: [...providers.values()] };
  };

  let refreshProvidersInflight = null;
  const refreshProviders = async (requestedDirectory) => {
    if (refreshProvidersInflight) return refreshProvidersInflight;
    const task = (async () => {
      const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15_000) : undefined;
      const runtimes = new Set();
      for (const services of servicesCache.values()) {
        const mr = services?.modelRuntime;
        if (mr) runtimes.add(mr);
      }
      if (runtime?.session?.modelRuntime) runtimes.add(runtime.session.modelRuntime);
      if (runtime?.services?.modelRuntime) runtimes.add(runtime.services.modelRuntime);
      if (runtimeRegistry?.listAll) {
        try {
          for (const tracked of runtimeRegistry.listAll()) {
            const mr = tracked?.session?.modelRuntime ?? tracked?.services?.modelRuntime;
            if (mr) runtimes.add(mr);
          }
        } catch {}
      }
      if (runtimes.size === 0) {
        const active = await ensureRuntime(requestedDirectory ? await resolveDirectory(requestedDirectory) : undefined);
        const mr = active?.session?.modelRuntime ?? active?.services?.modelRuntime;
        if (mr) runtimes.add(mr);
      }
      const dummyMap = new Map();
      for (const mr of runtimes) {
        try {
          const providers = typeof mr.getProviders === 'function' ? mr.getProviders() : [];
          for (const provider of providers) {
            const auth = mr.getProviderAuthStatus?.(provider.id);
            if (auth?.configured === true) continue;
            try {
              await mr.setRuntimeApiKey(provider.id, 'pichamber-catalog-refresh');
              let list = dummyMap.get(mr);
              if (!list) { list = []; dummyMap.set(mr, list); }
              list.push(provider.id);
            } catch {}
          }
        } catch {}
      }
      const errors = new Map();
      let aborted = false;
      try {
        await Promise.all([...runtimes].map(async (mr) => {
          try {
            const result = await mr.refresh({ allowNetwork: true, force: true, ...(signal ? { signal } : {}) });
            if (result?.aborted) aborted = true;
            if (result?.errors) {
              for (const [providerId, err] of result.errors) errors.set(providerId, err);
            }
          } catch (error) {
            if (error?.code === 'PI_MODEL_CONFIG_INVALID') throw error;
            errors.set('_global', error);
          }
        }));
      } finally {
        for (const [mr, ids] of dummyMap.entries()) {
          for (const id of ids) {
            try { await mr.removeRuntimeApiKey(id); } catch {}
          }
        }
      }
      if (errors.has('_global') && runtimes.size > 0) {
        const globalError = errors.get('_global');
        if (globalError?.code === 'PI_MODEL_CONFIG_INVALID') {
          throw new SessionDaemonProtocolError('PI_MODEL_CONFIG_INVALID', 'Pi models configuration is invalid.');
        }
      }
      const catalog = await listProviders(requestedDirectory);
      return catalog;
    })().finally(() => {
      refreshProvidersInflight = null;
    });
    refreshProvidersInflight = task;
    return task;
  };

  const getProviderConfiguration = async (providerId) => {
    if (typeof providerId !== 'string' || providerId.length === 0 || providerId.length > 256) {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The requested provider is invalid.');
    }
    try {
      const config = await modelConfigStore.get(providerId);
      return { config: config ?? null };
    } catch (error) {
      if (error?.code === 'PI_MODEL_CONFIG_INVALID') {
        throw new SessionDaemonProtocolError('PI_MODEL_CONFIG_INVALID', 'Pi models configuration is invalid.');
      }
      throw error;
    }
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
    let trust = trustStore.get(targetDir);
    // Auto-trust known PiChamber projects so the skills popup never appears.
    // `knownDirectories` tracks every dir the user explicitly added/selected.
    if (trust === null && knownDirectories.has(targetDir) && hasTrustRequiringProjectResources(targetDir)) {
      try {
        trustStore.set(targetDir, true);
        trust = true;
      } catch {}
    }
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
    if (hasTrust) {
      const targetRuntimes = runtimeRegistry?.listByDirectory?.(targetDir) ?? [];
      const inheritsActive = runtime && runtime.cwd === targetDir ? [runtime] : [];
      const allTarget = targetRuntimes.length > 0 ? targetRuntimes : inheritsActive;
      const isTargetStreaming = allTarget.some((r) => r.session?.isStreaming);
      if (isTargetStreaming) {
        throw new SessionDaemonProtocolError('SESSION_BUSY', 'Project trust cannot change during an active session.');
      }
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
    const skills = await Promise.all(loader.getSkills().skills.map(async (skill) => {
      let content = '';
      try {
        content = await readFile(skill.filePath, 'utf8');
      } catch {}
      return {
        id: resourceId('skill', skill.filePath),
        kind: 'skill',
        name: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
        location: resourceLocation(skill.sourceInfo),
        editable: false,
        ...(content ? { content } : {}),
        filePath: skill.filePath,
      };
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

  const resolveLiveModel = (runtime) => {
    const current = runtime?.session?.model;
    if (!current?.provider || !current?.id) return null;
    const modelRuntime = runtime.session.modelRuntime;
    const fromGet = modelRuntime?.getModel?.(current.provider, current.id);
    if (fromGet && (fromGet.reasoning === true || fromGet.thinkingLevelMap)) return fromGet;
    const models = modelRuntime?.getModels?.();
    if (Array.isArray(models)) {
      const listed = models.find((model) => model?.provider === current.provider && model?.id === current.id);
      if (listed) return listed;
    }
    return fromGet ?? current;
  };

  const applyThinking = (runtime, thinking, sessionId, directory) => {
    validateThinking(thinking);
    const model = resolveLiveModel(runtime);
    const next = model && (model.reasoning === true || model.thinkingLevelMap)
      ? clampThinkingLevel(getSupportedThinkingLevels(model), thinking)
      : thinking;
    runtime.session.setThinkingLevel(next);
    publish('session.thinking', { thinking: next }, sessionId, directory);
  };

  const validateThinking = (thinking) => {
    if (!isPiThinkingLevel(thinking)) {
      throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The requested thinking level is invalid.');
    }
  };

  const attachmentMarkerPattern = /pi-clipboard-/i;
  const attachmentMarkerSearchPattern = /pi-clipboard-/gi;
  const attachmentIdPattern = /^[0-9a-f-]{36}$/i;
  const attachmentBracketStartPattern = /\[Attachment/gi;
  const attachmentTokenPattern = /pi-clipboard-[0-9a-f-]{36}/i;
  const isAttachmentPathDelimiter = (character) => /[\s[\](){}"'`,;]/u.test(character);

  const redactAttachmentBrackets = (text) => {
    let cursor = 0;
    let output = '';
    while (cursor < text.length) {
      attachmentBracketStartPattern.lastIndex = cursor;
      const bracketStart = attachmentBracketStartPattern.exec(text);
      if (!bracketStart) {
        output += text.slice(cursor);
        break;
      }

      output += text.slice(cursor, bracketStart.index);
      let bracketEnd = bracketStart.index + bracketStart[0].length;
      while (bracketEnd < text.length && text[bracketEnd] !== ']' && text[bracketEnd] !== '\r' && text[bracketEnd] !== '\n') bracketEnd += 1;
      if (text[bracketEnd] === ']') {
        const candidate = text.slice(bracketStart.index, bracketEnd + 1);
        output += attachmentTokenPattern.test(candidate) ? '[attachment]' : candidate;
        cursor = bracketEnd + 1;
      } else {
        output += text.slice(bracketStart.index, bracketEnd);
        cursor = bracketEnd;
      }
    }
    return output;
  };

  const redactAttachmentPaths = (text) => {
    if (typeof text !== 'string') return '';

    if (!attachmentMarkerPattern.test(text)) return text;
    const bracketRedacted = redactAttachmentBrackets(text);
    let cursor = 0;
    let output = '';
    while (cursor < bracketRedacted.length) {
      attachmentMarkerSearchPattern.lastIndex = cursor;
      const markerMatch = attachmentMarkerSearchPattern.exec(bracketRedacted);
      if (!markerMatch) {
        output += bracketRedacted.slice(cursor);
        break;
      }

      const markerIndex = markerMatch.index;
      const idStart = markerIndex + markerMatch[0].length;
      const idEnd = idStart + 36;
      if (!attachmentIdPattern.test(bracketRedacted.slice(idStart, idEnd))) {
        output += bracketRedacted.slice(cursor, idStart);
        cursor = idStart;
        continue;
      }

      let tokenStart = markerIndex;
      while (tokenStart > cursor && !isAttachmentPathDelimiter(bracketRedacted[tokenStart - 1])) tokenStart -= 1;
      let tokenEnd = idEnd;
      while (tokenEnd < bracketRedacted.length && !isAttachmentPathDelimiter(bracketRedacted[tokenEnd])) tokenEnd += 1;
      output += `${bracketRedacted.slice(cursor, tokenStart)}[attachment]`;
      cursor = tokenEnd;
    }
    return output;
  };

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
    const output = redactAttachmentPaths(textFromContent(content));
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

  /**
   * Sanitize Pi's `Usage` object into the public PiChamber `PiUsage` shape.
   * All numeric fields must be finite and non-negative; the object is
   * omitted entirely if any field is missing or wrong type. Unknown keys are
   * never passed through. Costs are normalized the same way as token counts
   * — Pi treats decimal cents as float, so the renderer is responsible for
   * rounding to a money locale.
   */
  const projectUsage = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const safeNonNegativeNumber = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0) ? value : null;
    const input = safeNonNegativeNumber(raw.input);
    const output = safeNonNegativeNumber(raw.output);
    const cacheRead = safeNonNegativeNumber(raw.cacheRead);
    const cacheWrite = safeNonNegativeNumber(raw.cacheWrite);
    const totalTokens = safeNonNegativeNumber(raw.totalTokens);
    const rawCost = raw.cost && typeof raw.cost === 'object' ? raw.cost : null;
    if (!rawCost) return null;
    const costInput = safeNonNegativeNumber(rawCost.input);
    const costOutput = safeNonNegativeNumber(rawCost.output);
    const costCacheRead = safeNonNegativeNumber(rawCost.cacheRead);
    const costCacheWrite = safeNonNegativeNumber(rawCost.cacheWrite);
    const costTotal = safeNonNegativeNumber(rawCost.total);
    if (
      input === null || output === null || cacheRead === null || cacheWrite === null || totalTokens === null
      || costInput === null || costOutput === null || costCacheRead === null || costCacheWrite === null || costTotal === null
    ) {
      return null;
    }
    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens,
      cost: {
        input: costInput,
        output: costOutput,
        cacheRead: costCacheRead,
        cacheWrite: costCacheWrite,
        total: costTotal,
      },
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
    // After a provider stream dies, Pi can report idle while the UI still
    // retries as steer/follow-up. Start a new turn instead of rejecting.
    const deliverAs = delivery && activeRuntime.session.isStreaming ? delivery : undefined;
    if (!deliverAs && activeRuntime.session.isStreaming) {
      throw new SessionDaemonProtocolError('SESSION_BUSY', 'The Pi session already has an active run.');
    }
    if (payload.model !== undefined) {
      await setSessionModel(activeRuntime, payload.model);
      publishSessionModel(activeRuntime.session, payload.sessionId, activeRuntime.cwd);
    }
    if (payload.thinking !== undefined) {
      applyThinking(activeRuntime, payload.thinking, payload.sessionId, activeRuntime.cwd);
    }

    // Auto-assign deterministic title on first prompt if session manager has no name yet
    const manager = activeRuntime.session?.sessionManager;
    if (typeof payload.text === 'string' && payload.text.trim().length > 0 && !manager?.getSessionName?.()) {
      const derived = deriveSessionTitle(payload.text);
      if (derived && typeof manager?.appendSessionInfo === 'function') {
        manager.appendSessionInfo(derived);
        publish('session.updated', { title: redactAttachmentPaths(derived) }, payload.sessionId, activeRuntime.cwd);
      }
    }

    const attachments = await prepareAttachmentContent(payload.attachments);
    const text = [payload.text, attachments.text].filter(Boolean).join('\n\n');
    const content = attachments.images.length > 0
      ? [{ type: 'text', text }, ...attachments.images]
      : text;
    const messageId = typeof payload.messageId === 'string' && payload.messageId.length > 0
      ? payload.messageId
      : activeRuntime.session.sessionManager?.getLeafId?.() ?? `msg_${randomUUID()}`;
    // Prompt acceptance is not turn completion. Pi's send promise remains
    // pending for the whole agent loop, which can legitimately exceed the
    // 30-second HTTP/private-IPC request budget. Own it in the daemon and
    // report asynchronous failure through the existing session event channel.
    const generation = (sendGenerationBySession.get(payload.sessionId) ?? 0) + 1;
    sendGenerationBySession.set(payload.sessionId, generation);
    // Slash-prefixed input dispatches extension commands and skill/template
    // expansion exactly like the pi CLI and RPC modes; plain text keeps the
    // sendUserMessage path so it is never expanded.
    const sendCall = content.startsWith('/')
      ? activeRuntime.session.prompt(content, {
          source: 'rpc',
          ...(deliverAs ? { streamingBehavior: deliverAs } : {}),
        })
      : activeRuntime.session.sendUserMessage(content, deliverAs ? { deliverAs } : undefined);
    Promise.resolve(sendCall).then(() => {
      if (sendGenerationBySession.get(payload.sessionId) !== generation) return;
      if (settledSendGenerationBySession.get(payload.sessionId) === generation) return;
      if (activeRuntime.session?.isStreaming) return;
      settledSendGenerationBySession.set(payload.sessionId, generation);
      // Extension commands can complete without starting an agent turn, so Pi
      // emits no agent_settled event. Close the optimistic browser lifecycle
      // when the command promise itself is the authoritative completion edge.
      publish('session.lifecycle', { state: 'idle', serverNow: Date.now() }, payload.sessionId, activeRuntime.cwd);
      completeRequestedShutdown(payload.sessionId);
    }).catch((error) => {
      if (sendGenerationBySession.get(payload.sessionId) !== generation) return;
      publish('session.error', {
        code: 'ASSISTANT_ERROR',
        ...(error instanceof Error && error.message
          ? { message: redactAttachmentPaths(error.message) }
          : {}),
      }, payload.sessionId, activeRuntime.cwd);
      if (!activeRuntime.session?.isStreaming) {
        completeRequestedShutdown(payload.sessionId);
        return;
      }
      Promise.resolve(activeRuntime.session.abort()).catch(() => {});
    });
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
      ...(typeof node.label === 'string' && node.label.length > 0 ? { label: node.label.slice(0, 256) } : {}),
      ...(typeof node.labelTimestamp === 'string' ? { labelTimestamp: node.labelTimestamp } : {}),
      updatedAt: Date.parse(node.entry.timestamp) || 0,
      children: node.children.map(project),
    });
    return { rootId: sessionId, nodes: nodes.map(project) };
  };

  const deleteSession = async (sessionId, requestedDirectory) => {
    const active = runtimeRegistry?.findBySessionId(sessionId);
    let targetDir = requestedDirectory ? await resolveDirectory(requestedDirectory) : active?.cwd || activeDirectory || cwd;
    const activeSessionFile = active?.session?.sessionManager?.getSessionFile?.();
    if (active) {
      if (active.session?.isStreaming) await active.session.abort();
      await runtimeRegistry?.dispose(active);
      if (runtime === active) runtime = undefined;
    }
    if (active && typeof activeSessionFile === 'string' && activeSessionFile.length > 0) {
      await rm(activeSessionFile, { force: true });
    } else if (!active) {
      const { target, directory } = await findPersistedSession(sessionId, targetDir);
      targetDir = directory;
      await rm(target.path, { force: false });
    }
    messageEntryAliases.clearSession({ cwd: active?.cwd || targetDir, sessionId });
    retryStateBySession.delete(sessionId);
    compactionStateBySession.delete(sessionId);
    activeRunStartedAt.delete(sessionId);
    shutdownRequestedBySession.delete(sessionId);
    sendGenerationBySession.delete(sessionId);
    settledSendGenerationBySession.delete(sessionId);
    latestUserMessageIds.delete(sessionId);
    latestAssistantMessageIds.delete(sessionId);
    toolInputBySession.delete(sessionId);
    publish('session.lifecycle', { state: 'idle', deleted: true, serverNow: Date.now() }, sessionId, targetDir);
  };

  const publishSessionEvent = (sessionId, event, directory = activeDirectory || cwd) => {
    switch (event.type) {
      case 'message_start': {
        if (event.message?.role === 'user') {
          const content = event.message.content;
          const text = redactAttachmentPaths(typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? textFromContent(content)
              : '');
          const messageId = `user-${sessionId}-${sequence + 1}`;
          messageEntryAliases.retain({ cwd: directory, sessionId, syntheticMessageId: messageId, message: event.message });
          latestUserMessageIds.set(sessionId, messageId);
          publish('assistant.message.start', {
            messageId,
            role: 'user',
            text,
            startedAt: Number.isFinite(event.message.timestamp) ? event.message.timestamp : Date.now(),
          }, sessionId, directory);
        } else if (event.message?.role === 'assistant') {
          const messageId = `assistant-${sessionId}-${sequence + 1}`;
          messageEntryAliases.retain({ cwd: directory, sessionId, syntheticMessageId: messageId, message: event.message });
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
        const eventRuntime = runtimeRegistry?.get({ cwd: directory, sessionId });
        const syntheticMessageId = event.message?.role === 'assistant'
          ? streamingMessageIds.get(sessionId) ?? latestAssistantMessageIds.get(sessionId)
          : event.message?.role === 'user'
            ? latestUserMessageIds.get(sessionId)
            : undefined;
        messageEntryAliases.observeMessageEnd({
          cwd: directory,
          sessionId,
          syntheticMessageId,
          message: event.message,
          sessionManager: eventRuntime?.session?.sessionManager,
        });
        if (event.message?.role === 'assistant') {
          const content = Array.isArray(event.message.content) ? event.message.content : [];
          const messageId = streamingMessageIds.get(sessionId) ?? latestAssistantMessageIds.get(sessionId) ?? `assistant-${sessionId}`;
          const startedAt = messageStartedAt.get(messageId) ?? Date.now();
          messageStartedAt.delete(messageId);
          const durationMs = Math.max(100, Date.now() - startedAt);
          const usage = projectUsage(event.message.usage);
          publish('assistant.message.end', {
            messageId,
            text: redactAttachmentPaths(textFromContent(content)),
            thinking: redactAttachmentPaths(content.filter((part) => part?.type === 'thinking').map((part) => part.thinking).join('')),
            durationMs,
            ...(content.some((part) => part?.type === 'toolCall') ? { continuing: true } : {}),
            ...(event.message.errorMessage ? { error: { code: 'ASSISTANT_ERROR', message: redactAttachmentPaths(event.message.errorMessage) } } : {}),
            ...(usage ? { usage } : {}),
          }, sessionId, directory);
          streamingMessageIds.delete(sessionId);
          clearStreamingRedactionBuffers(sessionId);
        } else if (event.message?.role === 'custom') {
          publishExtensionCustomMessage(sessionId, event.message, directory);
        }
        break;
      }
      case 'entry_appended': {
        const entry = event.entry;
        if (entry?.type !== 'custom' || typeof entry.customType !== 'string') break;
        const timestamp = Date.parse(entry.timestamp);
        publish('extension.entry', {
          id: typeof entry.id === 'string' ? entry.id : `ext-${sessionId}-${sequence + 1}`,
          customType: entry.customType,
          ...(entry.data !== undefined ? { data: redactAttachmentValues(entry.data) } : {}),
          createdAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
        }, sessionId, directory);
        // Declarative GUI payloads are additionally mirrored into normalized
        // live state so panels/apps update in place and survive reconnects.
        if (entry.customType === 'pichamber.ui' || entry.customType.startsWith('pichamber.')) {
          const descriptor = entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)
            ? (entry.data.ui && typeof entry.data.ui === 'object' && !Array.isArray(entry.data.ui) ? entry.data.ui : entry.data)
            : undefined;
          if (descriptor) {
            if (entry.customType === 'pichamber.app') {
              mirrorExtensionApp(sessionId, descriptor, directory);
            } else {
              mirrorExtensionPanel(sessionId, descriptor, directory);
            }
          }
        }
        break;
      }
      case 'tool_execution_start': {
        const messageId = streamingMessageIds.get(sessionId) ?? latestAssistantMessageIds.get(sessionId) ?? `assistant-${sessionId}`;
        const startedAt = Date.now();
        const activeRuntime = runtimeRegistry?.get({ cwd: directory, sessionId }) || runtime;
        const metadata = mergeToolPresentationMetadata(undefined, activeRuntime, directory, event.toolName, event.args);
        toolStartedAt.set(event.toolCallId, startedAt);
        rememberToolInput(sessionId, event.toolCallId, event.args);
        publish('session.tool.start', {
          toolCallId: event.toolCallId,
          partId: `${messageId}:tool:${event.toolCallId}`,
          messageId,
          name: event.toolName,
          toolName: event.toolName,
          state: 'running',
          ...(event.args !== undefined ? { input: redactAttachmentValues(event.args) } : {}),
          ...(metadata ? { metadata } : {}),
          startedAt,
        }, sessionId, directory);
        break;
      }
      case 'tool_execution_update': {
        const messageId = streamingMessageIds.get(sessionId) ?? latestAssistantMessageIds.get(sessionId) ?? `assistant-${sessionId}`;
        const activeRuntime = runtimeRegistry?.get({ cwd: directory, sessionId }) || runtime;
        const toolArgs = event.args ?? getToolInput(sessionId, event.toolCallId);
        const projected = projectToolResult(event.partialResult, false);
        const metadata = mergeToolPresentationMetadata(projected.metadata, activeRuntime, directory, event.toolName, toolArgs);
        publish('session.tool.update', {
          toolCallId: event.toolCallId,
          partId: `${messageId}:tool:${event.toolCallId}`,
          messageId,
          name: event.toolName,
          toolName: event.toolName,
          state: 'running',
          ...(event.args !== undefined ? { input: redactAttachmentValues(event.args) } : {}),
          ...projected,
          ...(metadata ? { metadata } : {}),
        }, sessionId, directory);
        break;
      }
      case 'tool_execution_end': {
        const messageId = streamingMessageIds.get(sessionId) ?? latestAssistantMessageIds.get(sessionId) ?? `assistant-${sessionId}`;
        const startedAt = toolStartedAt.get(event.toolCallId);
        const toolArgs = event.args ?? getToolInput(sessionId, event.toolCallId);
        toolStartedAt.delete(event.toolCallId);
        forgetToolInput(sessionId, event.toolCallId);
        const activeRuntime = runtimeRegistry?.get({ cwd: directory, sessionId }) || runtime;
        const projected = projectToolResult(event.result, event.isError === true);
        const metadata = mergeToolPresentationMetadata(projected.metadata, activeRuntime, directory, event.toolName, toolArgs);
        publish('session.tool.end', {
          toolCallId: event.toolCallId,
          partId: `${messageId}:tool:${event.toolCallId}`,
          messageId,
          name: event.toolName,
          toolName: event.toolName,
          state: event.isError ? 'error' : 'completed',
          isError: event.isError === true,
          ...projected,
          ...(metadata ? { metadata } : {}),
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
        retryStateBySession.delete(sessionId);
        if (!activeRunStartedAt.has(sessionId)) activeRunStartedAt.set(sessionId, Date.now());
        publish('session.lifecycle', { state: 'busy', runStartedAt: activeRunStartedAt.get(sessionId), serverNow: Date.now() }, sessionId, directory);
        break;
      case 'agent_end': {
        const finalMessage = event.messages?.at?.(-1);
        if (finalMessage?.role === 'assistant' && finalMessage.stopReason === 'aborted') {
          publish('session.interrupted', { reason: 'user-abort', streaming: false }, sessionId, directory);
        } else if (finalMessage?.role === 'assistant' && typeof finalMessage.errorMessage === 'string' && event.willRetry !== true) {
          publish('session.error', { code: 'ASSISTANT_ERROR', message: redactAttachmentPaths(finalMessage.errorMessage) }, sessionId, directory);
        }
        break;
      }
      case 'auto_retry_start': {
        const retry = {
          attempt: event.attempt,
          next: Date.now() + event.delayMs,
          message: redactAttachmentPaths(event.errorMessage),
        };
        retryStateBySession.set(sessionId, retry);
        if (!activeRunStartedAt.has(sessionId)) activeRunStartedAt.set(sessionId, Date.now());
        publish('session.lifecycle', { state: 'retry', ...retry, runStartedAt: activeRunStartedAt.get(sessionId), serverNow: Date.now() }, sessionId, directory);
        break;
      }
      case 'auto_retry_end':
        retryStateBySession.delete(sessionId);
        break;
      case 'agent_settled':
        retryStateBySession.delete(sessionId);
        activeRunStartedAt.delete(sessionId);
        settledSendGenerationBySession.set(sessionId, sendGenerationBySession.get(sessionId) ?? 0);
        latestUserMessageIds.delete(sessionId);
        latestAssistantMessageIds.delete(sessionId);
        toolInputBySession.delete(sessionId);
        publish('session.lifecycle', { state: 'idle', serverNow: Date.now() }, sessionId, directory);
        if (!completeRequestedShutdown(sessionId)) scheduleIdleDisposal(sessionId);
        break;
      case 'session_info_changed': {
        const title = typeof event.name === 'string' ? event.name.trim() : '';
        if (title) publish('session.updated', { title: redactAttachmentPaths(title).slice(0, 256) }, sessionId, directory);
        break;
      }
      case 'model_select':
        if (event.model?.provider && event.model?.id) {
          publish('session.model', {
            model: { providerId: event.model.provider, modelId: event.model.id },
          }, sessionId, directory);
        }
        break;
      case 'thinking_level_changed':
        publish('session.thinking', { thinking: event.level }, sessionId, directory);
        break;
      case 'compaction_start': {
        clearIdleDisposal(sessionId);
        const compaction = { phase: 'running', reason: event.reason, startedAt: Date.now() };
        compactionStateBySession.set(sessionId, compaction);
        publish('session.compaction', compaction, sessionId, directory);
        break;
      }
      case 'summarization_retry_scheduled': {
        const current = compactionStateBySession.get(sessionId);
        if (!current || (current.phase !== 'running' && current.phase !== 'retrying')) break;
        const compaction = {
          ...current,
          phase: 'retrying',
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          next: Date.now() + event.delayMs,
          message: redactAttachmentPaths(event.errorMessage),
        };
        compactionStateBySession.set(sessionId, compaction);
        publish('session.compaction', compaction, sessionId, directory);
        break;
      }
      case 'summarization_retry_attempt_start': {
        if (event.source !== 'compaction') break;
        const current = compactionStateBySession.get(sessionId);
        if (!current) break;
        const compaction = { ...current, phase: 'running' };
        compactionStateBySession.set(sessionId, compaction);
        publish('session.compaction', compaction, sessionId, directory);
        break;
      }
      case 'compaction_end': {
        const current = compactionStateBySession.get(sessionId);
        const phase = event.aborted ? 'aborted' : event.result ? 'completed' : 'failed';
        const compaction = {
          phase,
          ...(event.reason ? { reason: event.reason } : {}),
          ...(current?.startedAt ? { startedAt: current.startedAt } : {}),
          completedAt: Date.now(),
          ...(event.result && Number.isFinite(event.result.tokensBefore) && event.result.tokensBefore >= 0
            ? { tokensBefore: event.result.tokensBefore }
            : {}),
          ...(event.result && Number.isFinite(event.result.estimatedTokensAfter) && event.result.estimatedTokensAfter >= 0
            ? { estimatedTokensAfter: event.result.estimatedTokensAfter }
            : {}),
          willRetry: event.willRetry === true,
          ...(typeof event.errorMessage === 'string' ? { message: redactAttachmentPaths(event.errorMessage) } : {}),
        };
        compactionStateBySession.set(sessionId, compaction);
        publish('session.compaction', compaction, sessionId, directory);
        if (!event.willRetry) scheduleIdleDisposal(sessionId);
        break;
      }
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
              'sessions.setThinking', 'sessions.compact', 'providers.list', 'providers.refresh', 'providers.config.get', 'providers.models.set', 'providers.status', 'providers.login',
              'providers.login.respond', 'providers.login.status', 'providers.logout', 'settings.get', 'settings.set',
              'resources.list', 'resources.update', 'resources.prompts.create', 'resources.prompts.delete',
              'extensions.list', 'extensions.respond',
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
      case 'providers.refresh': {
        const result = await refreshProviders(message.payload?.directory);
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
      case 'extensions.respond': {
        const resolution = await resolveExtensionDialog(message.payload);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result: resolution });
        return;
      }
      case 'extensions.list': {
        const requestedExtensionsDir = message.payload?.directory || message.payload?.cwd;
        const activeRuntime = await ensureRuntime(requestedExtensionsDir ? await resolveDirectory(requestedExtensionsDir) : undefined);
        const extensionSession = activeRuntime.session;
        const extensionPaths = typeof extensionSession?.extensionRunner?.getExtensionPaths === 'function'
          ? extensionSession.extensionRunner.getExtensionPaths()
          : [];
        const registeredCommands = typeof extensionSession?.extensionRunner?.getRegisteredCommands === 'function'
          ? extensionSession.extensionRunner.getRegisteredCommands()
          : [];
        writeFrame(socket, {
          protocolVersion: PROTOCOL_VERSION,
          kind: 'response',
          requestId: message.requestId,
          result: {
            directory: activeRuntime.cwd,
            extensions: (Array.isArray(extensionPaths) ? extensionPaths : [])
              .filter((extensionPath) => typeof extensionPath === 'string' && extensionPath.length > 0)
              // Opaque id only: server filesystem paths must never reach the
              // browser (see DOCUMENTATION.md route invariants).
              .map((extensionPath) => ({
                id: createHash('sha256').update(extensionPath).digest('hex').slice(0, 16),
                name: basename(extensionPath).replace(/\.(ts|js)$/, ''),
              })),
            commands: (Array.isArray(registeredCommands) ? registeredCommands : [])
              .filter((command) => command && typeof command.invocationName === 'string')
              .map((command) => ({
                name: command.invocationName,
                ...(typeof command.description === 'string' ? { description: command.description } : {}),
                source: 'extension',
                ...(typeof command.sourceInfo?.scope === 'string' ? { scope: command.sourceInfo.scope } : {}),
              })),
          },
        });
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
        const requestedId = message.payload?.messageId;
        if (typeof requestedId !== 'string' || requestedId.length === 0) throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'The requested tree entry is invalid.');
        const messageId = messageEntryAliases.resolve({
          cwd: activeRuntime.cwd,
          sessionId: message.payload.sessionId,
          requestedId,
          sessionManager: activeRuntime.session.sessionManager,
        });
        const previousLeafId = activeRuntime.session.sessionManager?.getLeafId?.() ?? null;
        const result = await activeRuntime.session.navigateTree(messageId);
        if (result?.cancelled) throw new SessionDaemonProtocolError('SESSION_TREE_NOT_FOUND', 'Pi cancelled tree navigation.');
        const newLeafId = activeRuntime.session.sessionManager?.getLeafId?.() ?? null;
        const navigation = {
          targetEntryId: messageId,
          previousLeafId: typeof previousLeafId === 'string' ? previousLeafId : null,
          newLeafId: typeof newLeafId === 'string' ? newLeafId : null,
          ...(typeof result?.editorText === 'string' && result.editorText.length > 0 ? { editorText: result.editorText } : {}),
        };
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result: { ...projectActiveSession(activeRuntime, activeRuntime.cwd), navigation } });
        return;
      }
      case 'sessions.fork':
      case 'sessions.clone': {
        const activeRuntime = await activateSession(message.payload?.sessionId, message.payload?.directory || message.payload?.cwd);
        const requestedId = message.command === 'sessions.fork' ? message.payload?.messageId : activeRuntime.session.sessionManager?.getLeafId?.();
        if (typeof requestedId !== 'string' || requestedId.length === 0) throw new SessionDaemonProtocolError('SESSION_TREE_NOT_FOUND', 'The Pi session has no fork point.');
        const entryId = message.command === 'sessions.fork'
          ? messageEntryAliases.resolve({
            cwd: activeRuntime.cwd,
            sessionId: message.payload.sessionId,
            requestedId,
            sessionManager: activeRuntime.session.sessionManager,
          })
          : requestedId;
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
        applyThinking(activeRuntime, message.payload?.thinking, message.payload.sessionId, activeRuntime.cwd);
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result: {} });
        return;
      }
      case 'sessions.compact': {
        if (message.payload?.thinking !== undefined) validateThinking(message.payload.thinking);
        if (message.payload?.customInstructions !== undefined
          && (typeof message.payload.customInstructions !== 'string' || message.payload.customInstructions.length > 20_000)) {
          throw new SessionDaemonProtocolError('INVALID_ARGUMENT', 'Compaction instructions must be a string no longer than 20,000 characters.');
        }
        const activeRuntime = await activateSession(message.payload?.sessionId, message.payload?.directory || message.payload?.cwd);
        const currentCompaction = compactionStateBySession.get(message.payload.sessionId);
        if (activeRuntime.session.isCompacting || currentCompaction?.phase === 'running' || currentCompaction?.phase === 'retrying') {
          throw new SessionDaemonProtocolError('SESSION_BUSY', 'This session is already compacting.');
        }
        if (message.payload?.model !== undefined) {
          await setSessionModel(activeRuntime, message.payload.model);
          publishSessionModel(activeRuntime.session, message.payload.sessionId, activeRuntime.cwd);
        }
        if (message.payload?.thinking !== undefined) {
          applyThinking(activeRuntime, message.payload.thinking, message.payload.sessionId, activeRuntime.cwd);
        }
        Promise.resolve(activeRuntime.session.compact(message.payload?.customInstructions)).catch((error) => {
          const current = compactionStateBySession.get(message.payload.sessionId);
          if (current?.phase === 'completed' || current?.phase === 'failed' || current?.phase === 'aborted') return;
          const compaction = {
            phase: 'failed',
            reason: 'manual',
            ...(current?.startedAt ? { startedAt: current.startedAt } : {}),
            completedAt: Date.now(),
            message: redactAttachmentPaths(error instanceof Error ? error.message : 'Compaction failed.'),
            willRetry: false,
          };
          compactionStateBySession.set(message.payload.sessionId, compaction);
          publish('session.compaction', compaction, message.payload.sessionId, activeRuntime.cwd);
          scheduleIdleDisposal(message.payload.sessionId);
        });
        writeFrame(socket, { protocolVersion: PROTOCOL_VERSION, kind: 'response', requestId: message.requestId, result: { accepted: true } });
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
          server.listen({ path: endpoint }, () => {
            server.off('error', reject);
            resolve();
          });
        });
        if (platform !== 'win32') await chmod(endpoint, 0o600);
        started = true;
      } catch (error) {
        messageEntryAliases.clear();
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
      retryStateBySession.clear();
      compactionStateBySession.clear();
      activeRunStartedAt.clear();
      shutdownRequestedBySession.clear();
      disposingSessionIds.clear();
      sendGenerationBySession.clear();
      settledSendGenerationBySession.clear();
      latestUserMessageIds.clear();
      latestAssistantMessageIds.clear();
      for (const client of clients) client.destroy();
      clients.clear();
      messageEntryAliases.clear();
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

