/**
 * Browser-visible Pi routes deliberately translate the authenticated server
 * boundary to private daemon requests. They never expose local daemon details.
 */

import { createPiArchiveStore } from './archive-store.js';
import { createPiAttachmentStore } from './attachment-store.js';
import {
  checkForUpdates,
  getCurrentVersion,
  getUpdateCapability,
  launchUpdateCommand,
  normalizeServerUpdateChannel,
} from '../package-manager.js';
import { listPiCustomThemes } from './custom-themes.js';
import { readUpdateJob } from '../update-job-store.js';
import { createPiSettingsStore } from './settings-store.js';
import { isPiThinkingLevel } from './thinking-levels.js';
import { createPiSessionFoldersStore } from './session-folders-store.js';
import { createPiSessionShelfStore } from './session-shelf-store.js';
import {
  MAX_EXTENSION_APP_HTML_CHARS,
  isValidCustomInputItems,
  projectCustomDismiss,
  projectCustomFrame,
  projectCustomSurface,
  projectCustomSurfaces,
  sanitizeExtensionFormFields,
} from './extension-protocol.js';
import { createPiUiSettingsStore } from './ui-settings-store.js';
import { createPiSnippetsStore } from './snippets-store.js';
import { isValidSendOperationId, isValidStreamEpoch } from './session-daemon/send-operation-registry.js';
import { ENGINE_HANDLER_COMMANDS, ENGINE_UNSUPPORTED_OPERATION, isValidEngineId } from './session-daemon/session-engines.js';
import { normalizeOpenRequestUrl } from './session-daemon/open-request.js';
import { createPiDaemonPool, MAIN_DAEMON_KEY, publicDaemonStreamId } from './session-daemon/daemon-pool.js';
import { decodePiEventCursor, subscribeMergedPiEvents } from './merged-event-stream.js';
import { registerPiSandboxRoutes } from './sandbox/sandbox-routes.js';
import {
  DEFAULT_EVENT_STREAM_MAX_BUFFERED_BYTES,
  createPiEventStreamRegistry,
  openPiEventStream,
} from './event-stream.js';

const UNAVAILABLE_CODES = new Set([
  'DAEMON_UNAVAILABLE',
  'SANDBOX_UNAVAILABLE',
  'DAEMON_AUTH_FAILED',
  'DAEMON_REQUEST_FAILED',
  'DAEMON_TIMEOUT',
  'DAEMON_START_TIMEOUT',
  'DAEMON_SPAWN_FAILED',
  'DAEMON_IDENTITY_MISMATCH',
  'DAEMON_STOP_FAILED',
  'DAEMON_PROTOCOL_MISMATCH',
  'DAEMON_ENDPOINT_UNVERIFIED',
  'DAEMON_ENDPOINT_UNREADABLE',
  'DAEMON_CREDENTIAL_UNAVAILABLE',
  'DAEMON_LOCK_UNAVAILABLE',
  'DAEMON_LOCK_TIMEOUT',
  'DAEMON_OWNERSHIP_MISMATCH',
  'DAEMON_PROFILE_IN_USE',
  'SESSION_LEASE_UNAVAILABLE',
  'INVALID_DAEMON_ENDPOINT',
  'PROVIDER_UNAVAILABLE',
  'MALFORMED_SESSION_JSONL',
  'SESSION_JSONL_UNREADABLE',
  'ARCHIVE_METADATA_INVALID',
  'SESSION_SHELF_INVALID',
]);

const BAD_GATEWAY_CODES = new Set([
  'MALFORMED_DAEMON_RESPONSE',
  'DAEMON_RESPONSE_TOO_LARGE',
]);

const writeDaemonError = (res, error) => {
  const code = typeof error?.code === 'string' ? error.code : 'DAEMON_REQUEST_FAILED';
  const status = UNAVAILABLE_CODES.has(code)
    ? 503
    : BAD_GATEWAY_CODES.has(code)
      ? 502
    : code === 'INVALID_SESSION'
      ? 404
      : code === 'SESSION_IN_USE' || code === 'OPERATION_PAYLOAD_MISMATCH' || code === 'STALE_STREAM_EPOCH'
        || code === ENGINE_UNSUPPORTED_OPERATION
        ? 409
        : code === 'OPERATION_EXPIRED'
          ? 410
          : code === 'ATTACHMENT_TOO_LARGE'
        ? 413
        : code === 'ATTACHMENT_LIMIT_REACHED'
          ? 429
          : code === 'ATTACHMENT_MISSING'
            ? 410
            : 400;
  // A sandbox failure carries the launcher's stable reason code (for
  // example NO_LANDLOCK); never a path or raw launcher output.
  const reason = code === 'SANDBOX_UNAVAILABLE' && typeof error?.reason === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.reason)
    ? error.reason
    : undefined;
  res.status(status).json({ error: { code, ...(reason ? { reason } : {}) } });
};

const requireDaemon = (runtime) => {
  if (!runtime) {
    const error = new Error('The Pi session daemon is unavailable.');
    error.code = 'DAEMON_UNAVAILABLE';
    throw error;
  }
  return runtime;
};

const protocolMismatch = () => {
  const error = new Error('The Pi session daemon returned an invalid response.');
  error.code = 'DAEMON_PROTOCOL_MISMATCH';
  return error;
};

const projectSession = (value) => {
  if (!value || typeof value !== 'object'
    || typeof value.id !== 'string' || value.id.length === 0
    || typeof value.directory !== 'string' || value.directory.length === 0
    || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)) {
    throw protocolMismatch();
  }
  return {
    id: value.id,
    directory: value.directory,
    ...(isValidEngineId(value.engine) ? { engine: value.engine } : {}),
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.parentId === 'string' || value.parentId === null ? { parentId: value.parentId } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(Number.isSafeInteger(value.messageCount) && value.messageCount >= 0 ? { messageCount: value.messageCount } : {}),
    ...(value.model && typeof value.model.providerId === 'string' && typeof value.model.modelId === 'string' ? { model: { providerId: value.model.providerId, modelId: value.model.modelId } } : {}),
    ...(typeof value.thinking === 'string' ? { thinking: value.thinking } : {}),
    ...(value.archived === true ? { archived: true } : {}),
    ...(Number.isFinite(value.timeArchived) ? { timeArchived: value.timeArchived } : {}),
  };
};

// The extension command a busy session is running without an agent turn
// (`/name`). Clients queue new messages instead of steering while it runs.
const projectRunningCommand = (lifecycle, value) => (
  lifecycle === 'busy' && typeof value === 'string' && /^\/\S{1,127}$/.test(value)
    ? { command: value }
    : {}
);

// Resident-runtime lifecycle sampled by the daemon list. Optional: a
// malformed value is dropped (unknown) rather than failing the row or the
// directory, and only whitelisted fields cross the public boundary.
const projectListLiveStatus = (value) => {
  if (!value || typeof value !== 'object'
    || !['idle', 'busy', 'retry'].includes(value.lifecycle)
    || !Number.isSafeInteger(value.sequence) || value.sequence < 0) return null;
  const retry = value.lifecycle === 'retry' ? projectRetryInfo(value.retry) : null;
  return {
    lifecycle: value.lifecycle,
    sequence: value.sequence,
    ...(retry ? { retry } : {}),
    ...projectRunningCommand(value.lifecycle, value.command),
    ...(value.lifecycle !== 'idle' && Number.isFinite(value.runStartedAt) && value.runStartedAt >= 0 ? { runStartedAt: value.runStartedAt } : {}),
    ...(Number.isFinite(value.serverNow) && value.serverNow >= 0 ? { serverNow: value.serverNow } : {}),
  };
};

// Fill in live state the owning daemon lacks from daemons still draining
// sessions for the same folder, matched by session id. Membership and every
// other field stay the owner's.
// Live state (`live`, `inputState`) another daemon samples for rows the
// list's own daemon lacks, merged by session id. Its sequences belong to
// that daemon's stream, so a merged row says which: `stream` (`main` for
// the main daemon) and that daemon's `streamEpoch`. `others` is a list of
// `{ stream, streamEpoch, items }`.
const mergeOtherDaemonsLiveState = (items, others) => {
  if (others.length === 0) return items;
  const byId = new Map();
  for (const other of others) {
    for (const item of other.items) {
      if (!item.live && !item.inputState) continue;
      if (!byId.get(item.session.id)?.item.live) byId.set(item.session.id, { other, item });
    }
  }
  return items.map((item) => {
    const found = byId.get(item.session.id);
    if (!found || item.live || item.inputState) return item;
    return {
      ...item,
      ...(found.item.live ? { live: found.item.live } : {}),
      ...(found.item.inputState ? { inputState: found.item.inputState } : {}),
      stream: found.other.stream,
      ...(found.other.streamEpoch ? { streamEpoch: found.other.streamEpoch } : {}),
    };
  });
};

const projectSessionList = (sessions) => {
  if (!Array.isArray(sessions)) throw protocolMismatch();
  return sessions.map((item) => {
    if (!item || typeof item !== 'object' || !Number.isFinite(item.updatedAt)) throw protocolMismatch();
    const live = projectListLiveStatus(item.live);
    const inputState = projectInputState(item.inputState, { withSequence: true });
    return {
      session: projectSession(item.session),
      ...(typeof item.preview === 'string' ? { preview: item.preview } : {}),
      updatedAt: item.updatedAt,
      ...(live ? { live } : {}),
      ...(inputState ? { inputState } : {}),
    };
  });
};

// Daemon-level pending input: whether a session is blocked waiting for the
// user. `null` means authoritatively nothing pending; `undefined` means
// unknown (older daemon) or malformed. Unknown kind strings normalize to
// 'input'; a zero count normalizes to null. Only the three wire keys cross
// the public boundary.
const projectPendingInputSummary = (value) => {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (typeof value.count !== 'number' || !Number.isSafeInteger(value.count)) return undefined;
  if (value.count === 0) return null;
  if (value.count < 0) return undefined;
  if (typeof value.since !== 'number' || !Number.isFinite(value.since) || value.since <= 0) return undefined;
  return {
    count: Math.min(value.count, 99),
    kind: typeof value.kind === 'string' && ['input', 'approval'].includes(value.kind) ? value.kind : 'input',
    since: value.since,
  };
};

// Projects `inputState` like `projectListLiveStatus` projects `live`: a
// malformed value is omitted (unknown) rather than failing the row, and
// only whitelisted fields cross the public boundary. List rows carry
// `{ pending, sequence }`; snapshots and details carry `{ pending }`.
const projectInputState = (value, { withSequence = false } = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const pending = projectPendingInputSummary(value.pending);
  if (pending === undefined) return undefined;
  if (withSequence) {
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) return undefined;
    return { pending, sequence: value.sequence };
  }
  return { pending };
};

const projectPendingInputList = (value) => {
  if (!value || typeof value !== 'object' || !Array.isArray(value.sessions)) throw protocolMismatch();
  const sessions = [];
  for (const item of value.sessions) {
    if (!item || typeof item !== 'object'
      || typeof item.sessionId !== 'string' || item.sessionId.length === 0
      || typeof item.directory !== 'string' || item.directory.length === 0) continue;
    const pending = projectPendingInputSummary(item.pending);
    if (!pending) continue;
    sessions.push({ sessionId: item.sessionId, directory: item.directory, pending });
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) throw protocolMismatch();
  return {
    sessions,
    sequence: value.sequence,
    ...(typeof value.streamEpoch === 'string' && value.streamEpoch ? { streamEpoch: value.streamEpoch } : {}),
  };
};

/**
 * Public-protocol sanitizer for Pi `Usage`. The server already coerces each
 * numeric field to a finite, non-negative value before the message leaves
 * the daemon, but the public projection re-validates so a malformed payload
 * (e.g. a stale cache from a different daemon version) cannot surface as
 * `Infinity` or `NaN` in the reducer. The whole object is omitted if any
 * field is missing or wrong type; unknown keys are never passed through.
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

const projectRetryInfo = (value) => {
  if (!value || typeof value !== 'object') return null;
  return {
    ...(Number.isSafeInteger(value.attempt) && value.attempt > 0 ? { attempt: value.attempt } : {}),
    ...(Number.isFinite(value.next) && value.next >= 0 ? { next: value.next } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
  };
};

const projectCompactionInfo = (value) => {
  if (!value || typeof value !== 'object' || !['running', 'retrying', 'completed', 'failed', 'aborted'].includes(value.phase)) return null;
  return {
    phase: value.phase,
    ...(['manual', 'threshold', 'overflow'].includes(value.reason) ? { reason: value.reason } : {}),
    ...(Number.isFinite(value.startedAt) && value.startedAt >= 0 ? { startedAt: Math.floor(value.startedAt) } : {}),
    ...(Number.isFinite(value.completedAt) && value.completedAt >= 0 ? { completedAt: Math.floor(value.completedAt) } : {}),
    ...(Number.isSafeInteger(value.attempt) && value.attempt > 0 ? { attempt: value.attempt } : {}),
    ...(Number.isSafeInteger(value.maxAttempts) && value.maxAttempts > 0 ? { maxAttempts: value.maxAttempts } : {}),
    ...(Number.isFinite(value.next) && value.next >= 0 ? { next: Math.floor(value.next) } : {}),
    ...(Number.isFinite(value.tokensBefore) && value.tokensBefore >= 0 ? { tokensBefore: Math.floor(value.tokensBefore) } : {}),
    ...(Number.isFinite(value.estimatedTokensAfter) && value.estimatedTokensAfter >= 0 ? { estimatedTokensAfter: Math.floor(value.estimatedTokensAfter) } : {}),
    ...(typeof value.willRetry === 'boolean' ? { willRetry: value.willRetry } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
  };
};

const sanitizeNavigation = (value) => {
  if (!value || typeof value !== 'object' || typeof value.targetEntryId !== 'string' || value.targetEntryId.length === 0) return null;
  const previousLeafId = value.previousLeafId === null ? null : (typeof value.previousLeafId === 'string' ? value.previousLeafId : null);
  const newLeafId = value.newLeafId === null ? null : (typeof value.newLeafId === 'string' ? value.newLeafId : null);
  if (previousLeafId !== null && typeof previousLeafId !== 'string') return null;
  if (newLeafId !== null && typeof newLeafId !== 'string') return null;
  const editorText = typeof value.editorText === 'string' ? value.editorText : undefined;
  // Limit editorText defensively; Pi prompts are bounded and we never persist this.
  if (editorText !== undefined && editorText.length > 200_000) return null;
  return {
    targetEntryId: value.targetEntryId,
    previousLeafId,
    newLeafId,
    ...(editorText !== undefined ? { editorText } : {}),
  };
};

const projectRenderLines = (render, keys) => {
  if (!render || typeof render !== 'object' || Array.isArray(render)) return undefined;
  const projected = {};
  for (const key of keys) {
    const lines = render[key];
    if (Array.isArray(lines)) {
      const sanitized = [];
      for (const line of lines) {
        if (typeof line === 'string') {
          sanitized.push(line.slice(0, 2000));
          if (sanitized.length >= 200) break;
        }
      }
      if (sanitized.length > 0) {
        projected[key] = sanitized;
      }
    }
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
};

export const projectToolRender = (render) => projectRenderLines(render, ['call', 'result', 'resultExpanded']);

// Extension message renders share the tool-render line bounds. An expanded
// slot without a collapsed slot is dropped; malformed shapes degrade to
// undefined instead of failing the frame or message.
export const projectMessageRender = (render) => {
  const projected = projectRenderLines(render, ['message', 'messageExpanded']);
  if (!projected || !projected.message) return undefined;
  return projected.messageExpanded ? projected : { message: projected.message };
};

const projectFilePart = (part) => {
  // Optional fields degrade instead of failing the whole message. The daemon
  // only emits inline data URLs; never pass a filesystem or remote URL on.
  const file = {};
  if (typeof part.mime === 'string' && part.mime.length > 0 && part.mime.length <= 200) file.mime = part.mime.slice(0, 200);
  if (typeof part.filename === 'string' && part.filename.length > 0 && part.filename.length <= 2048) file.filename = part.filename.slice(0, 2048);
  if (typeof part.url === 'string' && part.url.length > 0 && part.url.length <= 8000000 && part.url.startsWith('data:')) file.url = part.url;
  return { type: 'file', id: part.id, index: part.index, ...file };
};

const projectSessionDetail = (value) => {
  if (!value || typeof value !== 'object' || !Array.isArray(value.messages) || !Number.isSafeInteger(value.lastSequence)
    || (value.hasMoreBefore === true && (typeof value.beforeCursor !== 'string' || value.beforeCursor.length === 0))) throw protocolMismatch();
  const messages = value.messages.map((item) => {
    if (!item || typeof item !== 'object' || !item.message || !Array.isArray(item.parts)) throw protocolMismatch();
    const message = item.message;
    if (typeof message.id !== 'string' || typeof message.sessionId !== 'string' || typeof message.directory !== 'string'
      || !Number.isFinite(message.createdAt) || (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'extension')) throw protocolMismatch();
    const messageRender = message.role === 'extension' ? projectMessageRender(message.render) : undefined;
    const projected = {
      id: message.id, sessionId: message.sessionId, directory: message.directory, role: message.role, createdAt: message.createdAt,
      ...(typeof message.parentId === 'string' ? { parentId: message.parentId } : {}),
      ...(typeof message.text === 'string' ? { text: message.text } : {}),
      ...(message.role === 'assistant' && typeof message.thinking === 'string' ? { thinking: message.thinking } : {}),
      ...(message.model && typeof message.model.providerId === 'string' && typeof message.model.modelId === 'string' ? { model: { providerId: message.model.providerId, modelId: message.model.modelId } } : {}),
      ...(message.error && typeof message.error.code === 'string'
        ? {
            error: {
              code: message.error.code,
              ...(typeof message.error.message === 'string' ? { message: message.error.message } : {}),
            },
          }
        : {}),
      ...(message.role === 'assistant' && message.usage && projectUsage(message.usage) ? { usage: projectUsage(message.usage) } : {}),
      ...(message.role === 'extension' && typeof message.customType === 'string' ? { customType: message.customType } : {}),
      ...(message.role === 'extension' && message.data !== undefined ? { data: message.data } : {}),
      ...(message.role === 'extension' && message.details !== undefined ? { details: message.details } : {}),
      ...(messageRender ? { render: messageRender } : {}),
    };
    const parts = item.parts.map((part) => {
      if (!part || typeof part !== 'object' || typeof part.type !== 'string' || typeof part.id !== 'string' || !Number.isSafeInteger(part.index)) throw protocolMismatch();
      if (part.type === 'text' || part.type === 'thinking') {
        if (typeof part.text !== 'string') throw protocolMismatch();
        return { type: part.type, id: part.id, index: part.index, text: part.text };
      }
      if (part.type === 'tool' && typeof part.toolCallId === 'string' && typeof part.name === 'string') {
        const render = projectToolRender(part.render);
        return {
          type: 'tool', id: part.id, index: part.index, toolCallId: part.toolCallId, name: part.name,
          ...(part.input !== undefined ? { input: part.input } : {}),
          ...(part.output !== undefined ? { output: part.output } : {}),
          ...(typeof part.error === 'string' ? { error: part.error } : {}),
          ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
          ...(render ? { render } : {}),
          ...(part.isError === true ? { isError: true } : {}),
          ...(Number.isFinite(part.startedAt) ? { startedAt: part.startedAt } : {}),
          ...(Number.isFinite(part.endedAt) ? { endedAt: part.endedAt } : {}),
          state: ['pending', 'running', 'completed', 'error', 'cancelled'].includes(part.state) ? part.state : 'completed',
        };
      }
      if (part.type === 'file') return projectFilePart(part);
      throw protocolMismatch();
    });
    return { message: projected, parts };
  });
  const isStreaming = value.isStreaming === true;
  const lifecycle = ['idle', 'busy', 'retry', 'error', 'interrupted'].includes(value.lifecycle)
    ? value.lifecycle
    : (isStreaming ? 'busy' : 'idle');
  const retry = lifecycle === 'retry' ? projectRetryInfo(value.retry) : null;
  const compaction = projectCompactionInfo(value.compaction);
  const inputState = projectInputState(value.inputState);
  return {
    session: projectSession(value.session),
    messages,
    ...(value.hasMoreBefore === true && typeof value.beforeCursor === 'string' && value.beforeCursor.length > 0
      ? { hasMoreBefore: true, beforeCursor: value.beforeCursor }
      : value.hasMoreBefore === false
        ? { hasMoreBefore: false }
        : {}),
    lastSequence: value.lastSequence,
    isStreaming,
    lifecycle,
    // Read from the transcript on disk while the session's sandbox cannot
    // run: history only, no live state (see the project sandbox manager).
    ...(value.readOnly === true ? { readOnly: true } : {}),
    ...projectRunningCommand(lifecycle, value.command),
    ...(retry ? { retry } : {}),
    ...(compaction ? { compaction } : {}),
    ...(Number.isFinite(value.runStartedAt) ? { runStartedAt: Math.floor(value.runStartedAt) } : {}),
    ...(Number.isFinite(value.serverNow) ? { serverNow: Math.floor(value.serverNow) } : {}),
    ...(typeof value.streamEpoch === 'string' && value.streamEpoch.length > 0 && value.streamEpoch.length <= 128
      ? { streamEpoch: value.streamEpoch }
      : {}),
    ...projectExtensionSnapshotState(value),
    ...(inputState ? { inputState } : {}),
    ...(projectBashExecutions(value.bashExecutions) ? { bashExecutions: projectBashExecutions(value.bashExecutions) } : {}),
  };
};

const projectProviders = (value) => {
  if (!value || typeof value !== 'object' || !Array.isArray(value.providers)) throw protocolMismatch();
  return {
    providers: value.providers.map((provider) => {
      if (!provider || typeof provider !== 'object' || typeof provider.id !== 'string'
        || typeof provider.label !== 'string' || typeof provider.authenticated !== 'boolean' || !Array.isArray(provider.models)) throw protocolMismatch();
      return {
        id: provider.id,
        label: provider.label,
        authenticated: provider.authenticated,
        models: provider.models.map((model) => {
          if (!model || typeof model !== 'object' || typeof model.id !== 'string' || typeof model.providerId !== 'string') throw protocolMismatch();
          return {
            id: model.id,
            providerId: model.providerId,
            ...(typeof model.label === 'string' ? { label: model.label } : {}),
            ...(Number.isSafeInteger(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
            ...(model.supportsThinking === true ? { supportsThinking: true } : {}),
            ...(Array.isArray(model.thinkingLevels) ? { thinkingLevels: model.thinkingLevels.filter((level) => isPiThinkingLevel(level)) } : {}),
          };
        }),
      };
    }),
  };
};

const projectEngines = (value) => {
  if (!value || typeof value !== 'object' || !Array.isArray(value.engines)) throw protocolMismatch();
  return {
    engines: value.engines.map((engine) => {
      if (!engine || typeof engine !== 'object' || !isValidEngineId(engine.id)
        || typeof engine.label !== 'string' || !Array.isArray(engine.commands)) throw protocolMismatch();
      return {
        id: engine.id,
        label: engine.label,
        commands: engine.commands.filter((command) => ENGINE_HANDLER_COMMANDS.has(command)),
      };
    }),
  };
};

const projectProviderConfig = (value) => {
  const config = value?.config;
  if (config === null) return { config: null, ...(value?.deferred === true ? { deferred: true } : {}) };
  if (!config || typeof config !== 'object' || typeof config.providerId !== 'string' || typeof config.label !== 'string'
    || typeof config.baseUrl !== 'string' || typeof config.api !== 'string' || !Array.isArray(config.models)) throw protocolMismatch();
  return {
    config: {
      providerId: config.providerId,
      label: config.label,
      baseUrl: config.baseUrl,
      api: config.api,
      models: config.models.map((model) => {
        if (!model || typeof model !== 'object' || typeof model.id !== 'string' || typeof model.providerId !== 'string') throw protocolMismatch();
        return {
          id: model.id,
          providerId: model.providerId,
          ...(typeof model.label === 'string' ? { label: model.label } : {}),
          ...(model.supportsThinking === true ? { supportsThinking: true } : {}),
          ...(model.thinkingLevelMap && typeof model.thinkingLevelMap === 'object' && !Array.isArray(model.thinkingLevelMap) ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
          ...(Array.isArray(model.input) ? { input: model.input } : {}),
          ...(Number.isSafeInteger(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
          ...(Number.isSafeInteger(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
        };
      }),
    },
    ...(value?.deferred === true ? { deferred: true } : {}),
  };
};

const projectProviderStatus = (value) => {
  if (!value || typeof value !== 'object' || typeof value.providerId !== 'string' || typeof value.authenticated !== 'boolean') throw protocolMismatch();
  return { providerId: value.providerId, authenticated: value.authenticated };
};

const projectProviderLogin = (value) => {
  const login = value?.login;
  if (!login || typeof login !== 'object' || typeof login.id !== 'string' || typeof login.providerId !== 'string'
    || !['pending', 'complete', 'failed'].includes(login.state)) throw protocolMismatch();
  const projected = { id: login.id, providerId: login.providerId, state: login.state };
  if (login.prompt && typeof login.prompt === 'object' && ['text', 'secret', 'select', 'manual_code'].includes(login.prompt.type)) {
    projected.prompt = {
      type: login.prompt.type,
      ...(typeof login.prompt.message === 'string' ? { message: login.prompt.message } : {}),
      ...(typeof login.prompt.placeholder === 'string' ? { placeholder: login.prompt.placeholder } : {}),
      ...(Array.isArray(login.prompt.options) ? { options: login.prompt.options
        .filter((option) => option && typeof option.id === 'string' && typeof option.label === 'string')
        .map((option) => ({ id: option.id, label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) })) } : {}),
    };
  }
  if (login.authUrl && typeof login.authUrl.url === 'string' && login.authUrl.url.length <= 8_192) {
    projected.authUrl = { url: login.authUrl.url, ...(typeof login.authUrl.instructions === 'string' ? { instructions: login.authUrl.instructions } : {}) };
  }
  if (login.deviceCode && typeof login.deviceCode.userCode === 'string' && typeof login.deviceCode.verificationUri === 'string') {
    projected.deviceCode = {
      userCode: login.deviceCode.userCode,
      verificationUri: login.deviceCode.verificationUri,
      ...(Number.isFinite(login.deviceCode.intervalSeconds) ? { intervalSeconds: login.deviceCode.intervalSeconds } : {}),
      ...(Number.isFinite(login.deviceCode.expiresInSeconds) ? { expiresInSeconds: login.deviceCode.expiresInSeconds } : {}),
    };
  }
  if (login.error && typeof login.error.code === 'string') {
    projected.error = {
      code: login.error.code,
      ...(typeof login.error.message === 'string' && login.error.message.length <= 1_000 ? { message: login.error.message } : {}),
    };
  }
  return { login: projected };
};

const projectPiSettings = (value) => {
  if (!value || typeof value !== 'object' || !value.global || !value.project) throw protocolMismatch();
  const project = value.project;
  if (typeof project.trusted !== 'boolean') throw protocolMismatch();
  const copy = (settings) => ({
    ...(typeof settings.defaultProvider === 'string' ? { defaultProvider: settings.defaultProvider } : {}),
    ...(typeof settings.defaultModel === 'string' ? { defaultModel: settings.defaultModel } : {}),
    ...(typeof settings.defaultThinking === 'string' ? { defaultThinking: settings.defaultThinking } : {}),
    ...(typeof settings.defaultProjectTrust === 'string' ? { defaultProjectTrust: settings.defaultProjectTrust } : {}),
  });
  return {
    pi: { global: copy(value.global), project: { trusted: project.trusted, ...(project.denied === true ? { denied: true } : {}), ...(project.requiresTrust === true ? { requiresTrust: true } : {}), ...copy(project) } },
    ...(value.deferred === true ? { deferred: true } : {}),
  };
};

const projectResources = (value) => {
  if (!value || typeof value !== 'object') throw protocolMismatch();
  const project = (resources, kind) => {
    if (!Array.isArray(resources)) throw protocolMismatch();
    return resources.map((resource) => {
      if (!resource || typeof resource !== 'object' || resource.kind !== kind || typeof resource.id !== 'string' || resource.id.length === 0
        || typeof resource.name !== 'string' || !['global', 'project', 'package', 'path'].includes(resource.location)) throw protocolMismatch();
      return {
        id: resource.id,
        kind,
        name: resource.name,
        location: resource.location,
        ...(typeof resource.description === 'string' ? { description: resource.description } : {}),
        ...(typeof resource.content === 'string' ? { content: resource.content } : {}),
        ...(resource.editable === true ? { editable: true } : {}),
      };
    });
  };
  return {
    skills: project(value.skills, 'skill'),
    prompts: project(value.prompts, 'prompt'),
    agents: project(value.agents, 'agents'),
    ...(value.deferred === true ? { deferred: true } : {}),
  };
};

const projectSessionTree = (value) => {
  if (!value || typeof value !== 'object' || typeof value.rootId !== 'string' || !Array.isArray(value.nodes)) throw protocolMismatch();
  const projectNode = (node) => {
    if (!node || typeof node !== 'object' || typeof node.entryId !== 'string'
      || (node.parentId !== undefined && node.parentId !== null && typeof node.parentId !== 'string')
      || !Number.isFinite(node.updatedAt) || !Array.isArray(node.children)) throw protocolMismatch();
    return {
      entryId: node.entryId,
      ...(typeof node.parentId === 'string' ? { parentId: node.parentId } : {}),
      ...(typeof node.title === 'string' ? { title: node.title.slice(0, 256) } : {}),
      ...(typeof node.label === 'string' && node.label.length > 0 ? { label: node.label.slice(0, 256) } : {}),
      ...(typeof node.labelTimestamp === 'string' ? { labelTimestamp: node.labelTimestamp.slice(0, 64) } : {}),
      updatedAt: node.updatedAt,
      children: node.children.map(projectNode),
    };
  };
  return { rootId: value.rootId, nodes: value.nodes.map(projectNode) };
};

const sessionIdFrom = (req) => typeof req.params.sessionId === 'string' && req.params.sessionId.length > 0 ? req.params.sessionId : undefined;


const projectExtensionPanelActions = (actions) => (
  Array.isArray(actions)
    ? actions.filter((action) => action && typeof action === 'object' && typeof action.command === 'string').slice(0, 8)
    : undefined
);

const projectExtensionPanelPayload = (panel) => ({
  id: panel.id.slice(0, 128),
  ...(typeof panel.title === 'string' ? { title: panel.title.slice(0, 256) } : {}),
  ...(typeof panel.component === 'string' ? { component: panel.component.slice(0, 64) } : {}),
  ...(panel.props && typeof panel.props === 'object' && !Array.isArray(panel.props) ? { props: panel.props } : {}),
  ...(projectExtensionPanelActions(panel.actions) ? { actions: panel.actions } : {}),
});

const projectExtensionAppPayload = (app) => ({
  appId: app.appId.slice(0, 128),
  ...(typeof app.title === 'string' ? { title: app.title.slice(0, 256) } : {}),
  html: typeof app.html === 'string' ? app.html.slice(0, MAX_EXTENSION_APP_HTML_CHARS) : '',
});

const EXTENSION_COMMAND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const OPAQUE_EXTENSION_ID_PATTERN = /^[a-f0-9]{16}$/;

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const PALETTE_TOKEN_PATTERN = /^[A-Za-z]{1,40}$/;

/** `{ background, foreground, palette[16] }` of `#rrggbb` colours, or null. */
const projectTerminalColors = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { background, foreground, palette } = value;
  if (typeof background !== 'string' || !HEX_COLOR_PATTERN.test(background)) return null;
  if (typeof foreground !== 'string' || !HEX_COLOR_PATTERN.test(foreground)) return null;
  if (!Array.isArray(palette) || palette.length !== 16) return null;
  if (!palette.every((color) => typeof color === 'string' && HEX_COLOR_PATTERN.test(color))) return null;
  return { background, foreground, palette: [...palette] };
};

/** Pi's theme name, appearance, optional page background and token colours, or null. */
const projectExtensionPalette = (result) => {
  if (!result || typeof result !== 'object') return null;
  if (typeof result.theme !== 'string' || result.theme.length === 0 || result.theme.length > 128) return null;
  if (result.appearance !== 'light' && result.appearance !== 'dark') return null;
  if (result.background !== undefined && (typeof result.background !== 'string' || !HEX_COLOR_PATTERN.test(result.background))) return null;
  if (!result.colors || typeof result.colors !== 'object' || Array.isArray(result.colors)) return null;
  const colors = {};
  for (const [token, color] of Object.entries(result.colors)) {
    if (!PALETTE_TOKEN_PATTERN.test(token) || typeof color !== 'string' || !HEX_COLOR_PATTERN.test(color)) continue;
    colors[token] = color;
  }
  return {
    theme: result.theme,
    appearance: result.appearance,
    ...(result.background !== undefined ? { background: result.background } : {}),
    colors,
  };
};

export const projectExtensionList = (result) => {
  if (!result || typeof result !== 'object' || typeof result.directory !== 'string'
    || !Array.isArray(result.extensions) || !Array.isArray(result.commands)) throw protocolMismatch();
  const extensions = result.extensions.map((extension) => {
    if (!extension || typeof extension !== 'object'
      || typeof extension.id !== 'string' || !OPAQUE_EXTENSION_ID_PATTERN.test(extension.id)
      || typeof extension.name !== 'string' || extension.name.length === 0 || extension.name.length > 256
      || extension.name.includes('/') || extension.name.includes('\\')) throw protocolMismatch();
    return { id: extension.id, name: extension.name };
  });
  const commands = result.commands.map((command) => {
    if (!command || typeof command !== 'object'
      || typeof command.name !== 'string' || !EXTENSION_COMMAND_PATTERN.test(command.name)
      || (command.description !== undefined && typeof command.description !== 'string')
      || (command.scope !== undefined && typeof command.scope !== 'string')) throw protocolMismatch();
    return {
      name: command.name,
      ...(typeof command.description === 'string' ? { description: command.description.slice(0, 500) } : {}),
      source: 'extension',
      ...(typeof command.scope === 'string' ? { scope: command.scope.slice(0, 64) } : {}),
    };
  });
  return { directory: result.directory, extensions, commands };
};

// User shell commands (`!cmd`). Command text is user-authored; output is a
// bounded tail. Field caps mirror the daemon's live/recorded limits.
const BASH_COMMAND_MAX_CHARS = 100_000;
const BASH_OUTPUT_MAX_CHARS = 64 * 1024;
const BASH_PHASES = ['running', 'completed', 'cancelled', 'failed'];

const projectBashExecution = (value) => {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 128) return null;
  if (typeof value.command !== 'string' || !BASH_PHASES.includes(value.phase) || !Number.isFinite(value.startedAt)) return null;
  return {
    id: value.id,
    command: value.command.slice(0, BASH_COMMAND_MAX_CHARS),
    phase: value.phase,
    startedAt: Math.floor(value.startedAt),
    ...(value.excludeFromContext === true ? { excludeFromContext: true } : {}),
    ...(Number.isFinite(value.completedAt) ? { completedAt: Math.floor(value.completedAt) } : {}),
    ...(Number.isSafeInteger(value.exitCode) ? { exitCode: value.exitCode } : {}),
    ...(value.truncated === true ? { truncated: true } : {}),
    ...(typeof value.fullOutputPath === 'string' && value.fullOutputPath.length > 0 ? { fullOutputPath: value.fullOutputPath.slice(0, 4096) } : {}),
    ...(typeof value.output === 'string' && value.output.length > 0 ? { output: value.output.slice(-BASH_OUTPUT_MAX_CHARS) } : {}),
    ...(typeof value.error === 'string' && value.error.length > 0 ? { error: value.error.slice(0, 2000) } : {}),
  };
};

const projectBashExecutions = (value) => (Array.isArray(value)
  ? value.slice(0, 8).map(projectBashExecution).filter(Boolean)
  : undefined);

function projectExtensionSnapshotState(snapshot) {
  const extensionStatuses = Array.isArray(snapshot.extensionStatuses)
    ? snapshot.extensionStatuses.filter((entry) => entry && typeof entry.key === 'string' && typeof entry.text === 'string' && entry.key.length > 0 && entry.key.length <= 128 && entry.text.length <= 1000).slice(0, 50).map((entry) => ({ key: entry.key.slice(0, 128), text: entry.text.slice(0, 1000) }))
    : undefined;
  const extensionWidgets = Array.isArray(snapshot.extensionWidgets)
    ? snapshot.extensionWidgets.filter((entry) => entry && typeof entry.key === 'string' && Array.isArray(entry.lines) && entry.key.length > 0 && entry.key.length <= 128 && entry.lines.length <= 100).slice(0, 50).map((entry) => ({
        key: entry.key.slice(0, 128),
        lines: entry.lines.filter((line) => typeof line === 'string').map((line) => line.slice(0, 2000)).slice(0, 100),
        ...(entry.placement === 'belowEditor' ? { placement: 'belowEditor' } : { placement: 'aboveEditor' }),
      }))
    : undefined;
  const extensionDialogs = Array.isArray(snapshot.extensionDialogs)
    ? snapshot.extensionDialogs.filter((entry) => entry && typeof entry.requestId === 'string' && typeof entry.method === 'string' && typeof entry.title === 'string').slice(0, 20).map((entry) => ({
        requestId: entry.requestId.slice(0, 512),
        method: ['select', 'confirm', 'input', 'editor', 'form'].includes(entry.method) ? entry.method : 'confirm',
        title: entry.title.slice(0, 512),
        ...(typeof entry.message === 'string' ? { message: entry.message.slice(0, 2000) } : {}),
        ...(Array.isArray(entry.options) ? { options: entry.options.filter((option) => typeof option === 'string').map((option) => option.slice(0, 256)).slice(0, 20) } : {}),
        ...(typeof entry.placeholder === 'string' ? { placeholder: entry.placeholder.slice(0, 512) } : {}),
        ...(typeof entry.prefill === 'string' ? { prefill: entry.prefill.slice(0, 10000) } : {}),
        ...(Array.isArray(entry.fields) ? { fields: sanitizeExtensionFormFields(entry.fields) } : {}),
        ...(Number.isFinite(entry.timeoutMs) ? { timeoutMs: Math.floor(entry.timeoutMs) } : {}),
      }))
    : undefined;

  const extensionPanels = Array.isArray(snapshot.extensionPanels)
    ? snapshot.extensionPanels.filter((entry) => entry && typeof entry.id === 'string' && entry.id.length > 0).slice(0, 24).map(projectExtensionPanelPayload)
    : undefined;
  const extensionApps = Array.isArray(snapshot.extensionApps)
    ? snapshot.extensionApps.filter((entry) => entry && typeof entry.appId === 'string' && entry.appId.length > 0 && typeof entry.html === 'string' && entry.html.length > 0).slice(0, 8).map(projectExtensionAppPayload)
    : undefined;
  const extensionWorking = snapshot.extensionWorking && typeof snapshot.extensionWorking === 'object'
    ? {
        ...(typeof snapshot.extensionWorking.message === 'string'
          ? { message: snapshot.extensionWorking.message.replace(/[\u0000-\u001a\u001c-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 200) }
          : {}),
        ...(typeof snapshot.extensionWorking.visible === 'boolean' ? { visible: snapshot.extensionWorking.visible } : {}),
      }
    : undefined;
  return {
    ...(extensionStatuses ? { extensionStatuses } : {}),
    ...(extensionWidgets ? { extensionWidgets } : {}),
    ...(extensionDialogs ? { extensionDialogs } : {}),
    ...(extensionPanels ? { extensionPanels } : {}),
    ...(extensionApps ? { extensionApps } : {}),
    ...(typeof snapshot.extensionTitle === 'string' && snapshot.extensionTitle.length > 0
      ? { extensionTitle: snapshot.extensionTitle.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 256) }
      : {}),
    ...(extensionWorking && (extensionWorking.message !== undefined || extensionWorking.visible !== undefined) ? { extensionWorking } : {}),
    ...(snapshot.extensionDraftTracked === true ? { extensionDraftTracked: true } : {}),
    ...(Array.isArray(snapshot.extensionSurfaces) ? { extensionSurfaces: projectCustomSurfaces(snapshot.extensionSurfaces) } : {}),
  };
}

export const projectEventFrame = (frame) => {
  if (!frame || frame.kind !== 'event' || typeof frame.event !== 'string' || !Number.isSafeInteger(frame.sequence)
    || !frame.payload || typeof frame.payload.sessionId !== 'string' || typeof frame.payload.directory !== 'string') return null;
  const { sessionId, directory } = frame.payload;
  // The daemon's opaque stream-lifetime id. Passed through verbatim so clients
  // can detect a daemon restart (sequence space reset) and reject stale-epoch
  // events; old daemons omit it and the field stays undefined.
  const streamEpoch = typeof frame.streamEpoch === 'string' && frame.streamEpoch.length > 0 && frame.streamEpoch.length <= 128
    ? frame.streamEpoch
    : undefined;
  const common = { protocolVersion: 1, kind: 'event', name: frame.event, sequence: frame.sequence, sessionId, directory, ...(streamEpoch ? { streamEpoch } : {}) };
  switch (frame.event) {
    case 'session.input': {
      const pending = projectPendingInputSummary(frame.payload.pending);
      if (pending === undefined) return null;
      return {
        ...common,
        payload: {
          pending,
          ...(Number.isFinite(frame.payload.serverNow) ? { serverNow: frame.payload.serverNow } : {}),
        },
      };
    }
    case 'session.snapshot': {
      const snapshot = frame.payload;
      const extensionSnapshot = projectExtensionSnapshotState(snapshot);
      const lifecycle = ['idle', 'busy', 'retry', 'error', 'interrupted'].includes(snapshot.lifecycle) ? snapshot.lifecycle : 'idle';
      const retry = lifecycle === 'retry' ? projectRetryInfo(snapshot.retry) : null;
      const compaction = projectCompactionInfo(snapshot.compaction);
      const inputState = projectInputState(snapshot.inputState);
      return { ...common, payload: { snapshot: {
        sessionId, directory, isStreaming: snapshot.isStreaming === true,
        lifecycle,
        ...projectRunningCommand(lifecycle, snapshot.command),
        ...(retry ? { retry } : {}),
        ...(compaction ? { compaction } : {}),
        queue: { steering: Number.isSafeInteger(snapshot.queue?.steering) ? snapshot.queue.steering : 0, followUp: Number.isSafeInteger(snapshot.queue?.followUp) ? snapshot.queue.followUp : 0 },
        ...(snapshot.model && typeof snapshot.model.providerId === 'string' && typeof snapshot.model.modelId === 'string' ? { model: { providerId: snapshot.model.providerId, modelId: snapshot.model.modelId } } : {}),
        ...(typeof snapshot.thinking === 'string' ? { thinking: snapshot.thinking } : {}),
        ...(typeof snapshot.lastText === 'string' ? { lastText: snapshot.lastText } : {}),
        ...(typeof snapshot.lastThinking === 'string' ? { lastThinking: snapshot.lastThinking } : {}),
        ...(Number.isFinite(snapshot.runStartedAt) ? { runStartedAt: Math.floor(snapshot.runStartedAt) } : {}),
        ...(Number.isFinite(snapshot.serverNow) ? { serverNow: Math.floor(snapshot.serverNow) } : {}),
        lastSequence: Number.isSafeInteger(snapshot.lastSequence) ? snapshot.lastSequence : frame.sequence,
        ...(snapshot.resync === true ? { resync: true } : {}),
        ...extensionSnapshot,
        ...(inputState ? { inputState } : {}),
        ...(projectBashExecutions(snapshot.bashExecutions) ? { bashExecutions: projectBashExecutions(snapshot.bashExecutions) } : {}),
      } } };
    }
    case 'session.lifecycle': {
      // Legacy daemons published deletion as `lifecycle idle + deleted:true`.
      // Project it as the explicit typed deletion so old hosts still clean
      // every client. Current daemons publish `session.deleted` directly.
      if (frame.payload && frame.payload.deleted === true) {
        return { ...common, name: 'session.deleted', payload: {} };
      }
      const retry = frame.payload.state === 'retry' ? projectRetryInfo(frame.payload) : null;
      return { ...common, payload: { state: frame.payload.state, ...(retry ?? {}), ...projectRunningCommand(frame.payload.state, frame.payload.command), ...(Number.isFinite(frame.payload.runStartedAt) ? { runStartedAt: Math.floor(frame.payload.runStartedAt) } : {}), ...(Number.isFinite(frame.payload.serverNow) ? { serverNow: Math.floor(frame.payload.serverNow) } : {}) } };
    }
    case 'session.deleted': return { ...common, payload: {} };
    case 'session.updated': {
      if (typeof frame.payload.title !== 'string') return null;
      const title = frame.payload.title.trim();
      if (title.length === 0 || title.length > 256) return null;
      return { ...common, payload: { title } };
    }
    case 'session.tree.updated': return { ...common, payload: {} };
    case 'session.bash': {
      const bash = projectBashExecution(frame.payload.bash);
      return bash ? { ...common, payload: { bash } } : null;
    }
    case 'session.bash.output': {
      if (typeof frame.payload.id !== 'string' || frame.payload.id.length === 0 || frame.payload.id.length > 128) return null;
      if (frame.payload.reset === true) {
        if (typeof frame.payload.output !== 'string') return null;
        return { ...common, payload: { id: frame.payload.id, output: frame.payload.output.slice(-BASH_OUTPUT_MAX_CHARS), reset: true } };
      }
      if (typeof frame.payload.delta !== 'string' || frame.payload.delta.length === 0) return null;
      return { ...common, payload: { id: frame.payload.id, delta: frame.payload.delta.slice(-BASH_OUTPUT_MAX_CHARS) } };
    }
    case 'session.bash.recorded': {
      const message = frame.payload.message;
      if (!message || typeof message.id !== 'string' || message.id.length === 0 || message.id.length > 512) return null;
      if (!Number.isFinite(message.createdAt) || message.customType !== 'pichamber.bash') return null;
      const details = message.details;
      if (!details || typeof details !== 'object' || typeof details.command !== 'string' || typeof details.output !== 'string') return null;
      return {
        ...common,
        payload: {
          ...(typeof frame.payload.id === 'string' && frame.payload.id.length > 0 && frame.payload.id.length <= 128 ? { id: frame.payload.id } : {}),
          message: {
            id: message.id,
            createdAt: message.createdAt,
            customType: 'pichamber.bash',
            details: {
              command: details.command.slice(0, BASH_COMMAND_MAX_CHARS),
              output: details.output.slice(-BASH_OUTPUT_MAX_CHARS),
              ...(Number.isSafeInteger(details.exitCode) ? { exitCode: details.exitCode } : {}),
              ...(details.cancelled === true ? { cancelled: true } : {}),
              ...(details.truncated === true ? { truncated: true } : {}),
              ...(details.excludeFromContext === true ? { excludeFromContext: true } : {}),
              ...(typeof details.fullOutputPath === 'string' && details.fullOutputPath.length > 0 ? { fullOutputPath: details.fullOutputPath.slice(0, 4096) } : {}),
            },
          },
        },
      };
    }
    case 'assistant.message.start': {
      const files = frame.payload.role === 'user' && Array.isArray(frame.payload.files)
        ? frame.payload.files
          .filter((part) => part && part.type === 'file' && typeof part.id === 'string' && Number.isSafeInteger(part.index))
          .slice(0, 32)
          .map(projectFilePart)
        : [];
      return { ...common, payload: { messageId: frame.payload.messageId, role: frame.payload.role, startedAt: frame.payload.startedAt, ...(typeof frame.payload.parentId === 'string' ? { parentId: frame.payload.parentId } : {}), ...(typeof frame.payload.text === 'string' ? { text: frame.payload.text } : {}), ...(files.length > 0 ? { files } : {}), ...(frame.payload.model ? { model: frame.payload.model } : {}) } };
    }
    case 'assistant.message.delta':
    case 'assistant.thinking.delta': return { ...common, payload: { messageId: frame.payload.messageId, contentIndex: frame.payload.contentIndex, delta: frame.payload.delta, ...(typeof frame.payload.partId === 'string' ? { partId: frame.payload.partId } : {}) } };
    case 'assistant.message.end': return {
      ...common,
      payload: {
        messageId: frame.payload.messageId,
        ...(typeof frame.payload.text === 'string' ? { text: frame.payload.text } : {}),
        ...(typeof frame.payload.thinking === 'string' ? { thinking: frame.payload.thinking } : {}),
        ...(Number.isFinite(frame.payload.durationMs) ? { durationMs: frame.payload.durationMs } : {}),
        ...(frame.payload.continuing === true ? { continuing: true } : {}),
        ...(frame.payload.error && typeof frame.payload.error.code === 'string'
          ? {
              error: {
                code: frame.payload.error.code,
                ...(typeof frame.payload.error.message === 'string' ? { message: frame.payload.error.message } : {}),
              },
            }
          : {}),
        ...(projectUsage(frame.payload.usage) ? { usage: projectUsage(frame.payload.usage) } : {}),
      },
    };
    case 'session.queue': return { ...common, payload: { steering: frame.payload.steering, followUp: frame.payload.followUp } };
    case 'session.model': return { ...common, payload: { model: frame.payload.model } };
    case 'session.thinking': return { ...common, payload: { thinking: frame.payload.thinking } };
    case 'session.compaction': {
      const compaction = projectCompactionInfo(frame.payload);
      return compaction ? { ...common, payload: compaction } : null;
    }
    case 'session.error': return {
      ...common,
      payload: {
        code: frame.payload.code,
        ...(typeof frame.payload.message === 'string' ? { message: frame.payload.message } : {}),
      },
    };
    case 'session.interrupted': return { ...common, payload: { reason: frame.payload.reason, streaming: frame.payload.streaming === true } };
    case 'session.tool.start':
    case 'session.tool.update':
    case 'session.tool.end': {
      const render = projectToolRender(frame.payload.render);
      return {
        ...common,
        payload: {
          toolCallId: frame.payload.toolCallId, partId: frame.payload.partId, messageId: frame.payload.messageId, name: frame.payload.name, state: frame.payload.state,
          ...(frame.payload.input !== undefined ? { input: frame.payload.input } : {}),
          ...(frame.payload.output !== undefined ? { output: frame.payload.output } : {}),
          ...(typeof frame.payload.error === 'string' ? { error: frame.payload.error } : {}),
          ...(frame.payload.metadata !== undefined ? { metadata: frame.payload.metadata } : {}),
          ...(render ? { render } : {}),
          ...(frame.payload.isError === true ? { isError: true } : {}),
          ...(Number.isFinite(frame.payload.startedAt) ? { startedAt: frame.payload.startedAt } : {}),
          ...(Number.isFinite(frame.payload.endedAt) ? { endedAt: frame.payload.endedAt } : {}),
          ...(Number.isFinite(frame.payload.serverNow) ? { serverNow: frame.payload.serverNow } : {}),
        },
      };
    }
    case 'extension.entry': {
      if (typeof frame.payload.id !== 'string' || frame.payload.id.length === 0 || frame.payload.id.length > 512) return null;
      if (typeof frame.payload.customType !== 'string' || frame.payload.customType.length === 0 || frame.payload.customType.length > 256) return null;
      if (!Number.isFinite(frame.payload.createdAt)) return null;
      return { ...common, payload: { id: frame.payload.id.slice(0, 512), customType: frame.payload.customType.slice(0, 256), ...(frame.payload.data !== undefined ? { data: frame.payload.data } : {}), createdAt: frame.payload.createdAt } };
    }
    case 'extension.message': {
      if (typeof frame.payload.id !== 'string' || frame.payload.id.length === 0 || frame.payload.id.length > 512) return null;
      if (typeof frame.payload.customType !== 'string' || frame.payload.customType.length === 0 || frame.payload.customType.length > 256) return null;
      if (typeof frame.payload.text !== 'string') return null;
      if (!Number.isFinite(frame.payload.createdAt)) return null;
      const render = projectMessageRender(frame.payload.render);
      return { ...common, payload: { id: frame.payload.id.slice(0, 512), customType: frame.payload.customType.slice(0, 256), text: frame.payload.text.slice(0, 50000), ...(frame.payload.details !== undefined ? { details: frame.payload.details } : {}), ...(render ? { render } : {}), createdAt: frame.payload.createdAt } };
    }
    case 'extension.notify': {
      if (typeof frame.payload.message !== 'string' || frame.payload.message.length === 0) return null;
      const level = ['info', 'warning', 'error'].includes(frame.payload.level) ? frame.payload.level : 'info';
      return { ...common, payload: { message: frame.payload.message.slice(0, 2000), level } };
    }
    case 'session.archive': {
      // An archive mark changed on the server; devices re-list the folder.
      if (typeof frame.payload.archived !== 'boolean') return null;
      return { ...common, payload: { archived: frame.payload.archived } };
    }
    case 'session.openUrl': {
      // An Open request (lib/open-url). `serverNow` is stamped at delivery so
      // a device can tell a live request from a replayed one using only the
      // server's clock.
      const { id, url, attributed, createdAt } = frame.payload;
      if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
      const normalizedUrl = normalizeOpenRequestUrl(url);
      if (!normalizedUrl || typeof attributed !== 'boolean' || !Number.isFinite(createdAt)) return null;
      return { ...common, payload: { id, url: normalizedUrl, attributed, createdAt, serverNow: Date.now() } };
    }
    case 'extension.catalog': {
      const providers = frame.payload.providers === true;
      const resources = frame.payload.resources === true;
      const commands = frame.payload.commands === true;
      if (!providers && !resources && !commands) return null;
      return { ...common, payload: { ...(providers ? { providers: true } : {}), ...(resources ? { resources: true } : {}), ...(commands ? { commands: true } : {}) } };
    }
    case 'extension.editor': {
      if (typeof frame.payload.text !== 'string' || frame.payload.text.length > 100_000) return null;
      const mode = frame.payload.mode === 'paste' ? 'paste' : 'set';
      return { ...common, payload: { text: frame.payload.text, mode } };
    }
    case 'extension.editor.track': {
      if (typeof frame.payload.enabled !== 'boolean') return null;
      return { ...common, payload: { enabled: frame.payload.enabled } };
    }
    case 'extension.title': {
      if (frame.payload.title !== undefined && typeof frame.payload.title !== 'string') return null;
      const title = typeof frame.payload.title === 'string'
        ? frame.payload.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 256)
        : '';
      return { ...common, payload: title ? { title } : {} };
    }
    case 'extension.status': {
      if (typeof frame.payload.key !== 'string' || frame.payload.key.length === 0 || frame.payload.key.length > 128) return null;
      if (frame.payload.text !== undefined && typeof frame.payload.text !== 'string') return null;
      return { ...common, payload: { key: frame.payload.key.slice(0, 128), ...(typeof frame.payload.text === 'string' ? { text: frame.payload.text.slice(0, 1000) } : {}) } };
    }
    case 'extension.widget': {
      if (typeof frame.payload.key !== 'string' || frame.payload.key.length === 0 || frame.payload.key.length > 128) return null;
      if (frame.payload.lines !== undefined) {
        if (!Array.isArray(frame.payload.lines)) return null;
        if (frame.payload.lines.length > 100) return null;
        for (const line of frame.payload.lines) if (typeof line !== 'string' || line.length > 2000) return null;
      }
      if (frame.payload.placement !== undefined && frame.payload.placement !== 'aboveEditor' && frame.payload.placement !== 'belowEditor') return null;
      return {
        ...common,
        payload: {
          key: frame.payload.key.slice(0, 128),
          ...(Array.isArray(frame.payload.lines) ? { lines: frame.payload.lines.map((line) => String(line).slice(0, 2000)).slice(0, 100) } : {}),
          ...(frame.payload.placement === 'belowEditor' ? { placement: 'belowEditor' } : frame.payload.placement === 'aboveEditor' ? { placement: 'aboveEditor' } : {}),
        },
      };
    }
    case 'extension.dialog': {
      if (typeof frame.payload.requestId !== 'string' || frame.payload.requestId.length === 0 || frame.payload.requestId.length > 512) return null;
      if (!['select', 'confirm', 'input', 'editor', 'form'].includes(frame.payload.method)) return null;
      if (typeof frame.payload.title !== 'string' || frame.payload.title.length === 0 || frame.payload.title.length > 512) return null;
      return {
        ...common,
        payload: {
          requestId: frame.payload.requestId.slice(0, 512),
          method: frame.payload.method,
          title: frame.payload.title.slice(0, 512),
          ...(typeof frame.payload.message === 'string' ? { message: frame.payload.message.slice(0, 2000) } : {}),
          ...(Array.isArray(frame.payload.options) ? { options: frame.payload.options.filter((option) => typeof option === 'string').map((option) => option.slice(0, 256)).slice(0, 20) } : {}),
          ...(typeof frame.payload.placeholder === 'string' ? { placeholder: frame.payload.placeholder.slice(0, 512) } : {}),
          ...(typeof frame.payload.prefill === 'string' ? { prefill: frame.payload.prefill.slice(0, 10000) } : {}),
          ...(Array.isArray(frame.payload.fields) ? { fields: sanitizeExtensionFormFields(frame.payload.fields) } : {}),
          ...(Number.isFinite(frame.payload.timeoutMs) && frame.payload.timeoutMs >= 0 && frame.payload.timeoutMs <= 600000 ? { timeoutMs: Math.floor(frame.payload.timeoutMs) } : {}),
        },
      };
    }
    case 'extension.dialog.dismiss': {
      if (typeof frame.payload.requestId !== 'string' || frame.payload.requestId.length === 0 || frame.payload.requestId.length > 512) return null;
      if (!['answered', 'cancelled', 'timeout', 'aborted', 'session-closed', 'daemon-stopped'].includes(frame.payload.reason)) return null;
      return {
        ...common,
        payload: {
          requestId: frame.payload.requestId.slice(0, 512),
          reason: frame.payload.reason,
        },
      };
    }
    case 'extension.ui': {
      if (typeof frame.payload.id !== 'string' || frame.payload.id.length === 0 || frame.payload.id.length > 128) return null;
      const hasBody = typeof frame.payload.component === 'string'
        || typeof frame.payload.title === 'string'
        || Array.isArray(frame.payload.actions);
      const removed = frame.payload.removed === true || !hasBody;
      return {
        ...common,
        payload: removed
          ? { id: frame.payload.id.slice(0, 128), removed: true }
          : projectExtensionPanelPayload(frame.payload),
      };
    }
    case 'extension.app': {
      if (typeof frame.payload.appId !== 'string' || frame.payload.appId.length === 0 || frame.payload.appId.length > 128) return null;
      const html = typeof frame.payload.html === 'string' ? frame.payload.html : '';
      if (html.length === 0) return { ...common, payload: { appId: frame.payload.appId.slice(0, 128), removed: true } };
      if (html.length > MAX_EXTENSION_APP_HTML_CHARS) return null;
      return { ...common, payload: projectExtensionAppPayload({ ...frame.payload, html }) };
    }
    case 'extension.working': {
      if (frame.payload.message !== undefined && typeof frame.payload.message !== 'string') return null;
      if (frame.payload.visible !== undefined && typeof frame.payload.visible !== 'boolean') return null;
      const message = typeof frame.payload.message === 'string'
        ? frame.payload.message.replace(/[\u0000-\u001a\u001c-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 200)
        : undefined;
      return {
        ...common,
        payload: {
          ...(message !== undefined ? { message } : {}),
          ...(typeof frame.payload.visible === 'boolean' ? { visible: frame.payload.visible } : {}),
        },
      };
    }
    case 'extension.custom': {
      const payload = projectCustomSurface(frame.payload);
      return payload ? { ...common, payload } : null;
    }
    case 'extension.custom.frame': {
      const payload = projectCustomFrame(frame.payload);
      return payload ? { ...common, payload } : null;
    }
    case 'extension.custom.dismiss': {
      const payload = projectCustomDismiss(frame.payload);
      return payload ? { ...common, payload } : null;
    }
    case 'extension.error': {
      if (typeof frame.payload.source !== 'string' || frame.payload.source.length === 0 || frame.payload.source.length > 512) return null;
      if (typeof frame.payload.message !== 'string' || frame.payload.message.length === 0) return null;
      return {
        ...common,
        payload: {
          source: frame.payload.source.slice(0, 512),
          ...(typeof frame.payload.event === 'string' ? { event: frame.payload.event.slice(0, 128) } : {}),
          message: frame.payload.message.slice(0, 5000),
        },
      };
    }
    default: return null;
  }
};

const sessionOperationDirectory = (req) => (typeof req.query?.directory === 'string' && req.query.directory.length > 0
  ? req.query.directory
  : (typeof req.body?.directory === 'string' && req.body.directory.length > 0
    ? req.body.directory
    : (typeof req.body?.cwd === 'string' && req.body.cwd.length > 0 ? req.body.cwd : undefined)));

// The folder a session operation was routed by: the request's own, or the
// transcript's when `requestSessionOperation` looked it up. Stream stamps
// use it so a response names the daemon that actually served it.
const sessionRouteDirectory = (req, res) => res.locals?.piRouteDirectory ?? sessionOperationDirectory(req);

// Commands that let a session waiting to switch daemons finish its turn
// (or be read) where it runs now. Anything else would start new work in the
// old daemon, so it is refused until the session has moved.
const DRAINING_SESSION_COMMANDS = new Set([
  'sessions.open', 'sessions.messages', 'sessions.tree', 'sessions.abort', 'sessions.abortBash', 'sessions.steer',
  'sessions.sendReceipt', 'extensions.draft',
  'extensions.custom.input', 'extensions.custom.viewport', 'extensions.custom.close', 'extensions.custom.focus', 'extensions.custom.refresh',
]);

const sessionInUse = () => Object.assign(new Error('The session is finishing a turn before it switches.'), { code: 'SESSION_IN_USE' });

// The daemon still running a session that waits to switch, or undefined.
// Marks the response so its stream stamp names that daemon.
const drainingSessionRuntime = (res, sandboxManager, sessionId, command) => {
  const draining = sandboxManager?.drainingSession?.(sessionId);
  if (!draining) return undefined;
  if (!DRAINING_SESSION_COMMANDS.has(command)) throw sessionInUse();
  if (res.locals) res.locals.piDrainingStream = { stream: draining.stream };
  return draining.runtime;
};

const requestSessionOperation = async (req, res, daemonPool, command, payload = {}, sandboxManager) => {
  const sessionId = sessionIdFrom(req);
  if (!sessionId) {
    res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
    return undefined;
  }
  const directory = sessionOperationDirectory(req);
  try {
    const draining = drainingSessionRuntime(res, sandboxManager, sessionId, command);
    if (draining) {
      return await draining.request(command, { ...payload, sessionId, ...(directory ? { directory } : {}) });
    }
    // Without a directory the main daemon would look the session up itself
    // and could run a sandboxed project's session outside its sandbox. When
    // any project is sandboxed, route by the folder in the session's
    // transcript instead; the daemon payload stays as the client sent it.
    let routeDirectory = directory;
    if (!routeDirectory && sandboxManager?.hasSandboxedProjects()) {
      routeDirectory = await sandboxManager.directoryForSession(sessionId) ?? undefined;
      if (routeDirectory && res.locals) res.locals.piRouteDirectory = routeDirectory;
    }
    const runtime = requireDaemon(daemonPool.forDirectory(routeDirectory));
    // A send made with the old daemon's epoch right after the session moved.
    const sendPayload = typeof payload.streamEpoch === 'string' && sandboxManager?.sendEpochFor
      ? { ...payload, streamEpoch: await sandboxManager.sendEpochFor(sessionId, payload.streamEpoch, runtime) }
      : payload;
    return await runtime.request(command, {
      ...sendPayload,
      sessionId,
      ...(directory ? { directory } : {}),
    });
  } catch (error) {
    writeDaemonError(res, error);
    return undefined;
  }
};

/**
 * Browser-visible Pi runtime and session-collection routes. The authenticated
 * /api middleware is registered by the server composition root before these
 * adapters.
 */
export const registerPiRuntimeRoutes = (app, {
  getPiSessionDaemonRuntime,
  // Which daemon serves a request (session-daemon/daemon-pool.js). Without
  // one, the single runtime from `getPiSessionDaemonRuntime` is the main
  // daemon and owns every directory.
  daemonPool = createPiDaemonPool({ getMainRuntime: getPiSessionDaemonRuntime }),
  // Sandboxed projects (sandbox/project-sandbox-manager.js). Without one no
  // project is sandboxed and no sandbox route exists.
  sandboxManager,
  // Folders whose trust must stay "ask" after a sandbox was turned off
  // (sandbox/trust-ask.js); an explicit trust decision clears one.
  trustAsk,
  archiveStore = createPiArchiveStore(),
  attachmentStore = createPiAttachmentStore(),
  settingsStore = createPiSettingsStore(),
  sessionFoldersStore = createPiSessionFoldersStore(),
  sessionShelfStore = createPiSessionShelfStore({ archiveStore }),
  uiSettingsStore = createPiUiSettingsStore(),
  snippetsStore = createPiSnippetsStore(),
  listCustomThemes = listPiCustomThemes,
  updateChecker = checkForUpdates,
  updateLauncher = launchUpdateCommand,
  currentVersionReader = getCurrentVersion,
  updateJobReader = readUpdateJob,
  updateCapabilityResolver = getUpdateCapability,
  smallModelGenerator = async (input) => (await import('./small-model-generation.js')).generateWithSmallModel(input),
  eventHeartbeatMs = 15_000,
  eventStreamMaxBufferedBytes = DEFAULT_EVENT_STREAM_MAX_BUFFERED_BYTES,
  eventStreamRetryBaseMs,
}) => {
  const eventStreamRegistry = createPiEventStreamRegistry();
  // Directory-less commands (providers, settings, projects, engines,
  // provider login, the extension palette) and resource writes always run on
  // the main daemon: they write Pi's own config and credentials, which a
  // project daemon may only read. Everything scoped to a directory runs on
  // the daemon that owns it.
  const mainDaemon = () => requireDaemon(daemonPool.main());
  // Sessions run by a sandbox daemon say so, and a session waiting to
  // switch modes after its turn says where to; other rows are unchanged.
  const withSandbox = (item) => {
    if (!sandboxManager || !item?.session) return item;
    const state = sandboxManager.sessionState(item.session.id, item.session.directory);
    if (!state.sandboxed && !state.pendingSwitch) return item;
    return {
      ...item,
      session: {
        ...item.session,
        ...(state.sandboxed ? { sandboxed: true } : {}),
        ...(state.pendingSwitch ? { pendingSwitch: state.pendingSwitch } : {}),
      },
    };
  };
  // PiChamber changed Pi's config files: running sandbox daemons are
  // replaced at their next idle edge. Never fails the write.
  const piConfigChanged = () => {
    sandboxManager?.configChanged().catch((error) => console.warn('[pi-sandbox] config change handling failed', error?.code ?? error));
  };
  if (sandboxManager) registerPiSandboxRoutes(app, { sandboxManager });
  const daemonFor = (directory) => requireDaemon(daemonPool.forDirectory(directory));
  // A stamped response (`streamEpoch`, sequences) from a project daemon says
  // which daemon stream its sequences belong to; main responses are
  // unchanged.
  // A response served by a daemon draining the session (see
  // `drainingSessionRuntime`) names that daemon instead of the owner.
  const withStream = (body, directory, res) => {
    const draining = res?.locals?.piDrainingStream;
    const stream = draining ? draining.stream : daemonPool.streamFor(directory);
    return stream ? { ...body, stream } : body;
  };
  // Tell every device an archive mark changed (a `session.archive` event on
  // the session's stream) so other clients re-list that folder. The change is
  // already saved, so this never delays or fails the request: an older
  // daemon without `archive.publish` only logs, and devices catch up on
  // their next list.
  const publishArchiveChange = (sessionId, archived, directory) => {
    void (async () => {
      try {
        await daemonFor(directory).request('archive.publish', {
          sessionId,
          archived,
          ...(typeof directory === 'string' && directory.length > 0 ? { directory } : {}),
        });
      } catch (error) {
        console.warn('[pi] could not tell other devices about an archive change', error?.code ?? error);
      }
    })();
  };
  // A message or command the user sends ends a snooze and unarchives the
  // session. The send already succeeded, so a failed write only logs.
  const bringBackForActivity = async (sessionId) => {
    try {
      await sessionShelfStore.clearForActivity(sessionId);
    } catch (error) {
      console.warn('[pi] could not clear the session shelf after a send', error?.code ?? error);
    }
    try {
      const archived = await archiveStore.read();
      if (Object.hasOwn(archived, sessionId)) {
        await archiveStore.set(sessionId, false);
        publishArchiveChange(sessionId, false);
      }
    } catch (error) {
      console.warn('[pi] could not unarchive a session after a send', error?.code ?? error);
    }
  };
  app.get('/api/pi/ui-settings', async (_req, res) => {
    try {
      res.json(await uiSettingsStore.read());
    } catch {
      res.status(500).json({ error: 'UI settings are unreadable' });
    }
  });

  app.put('/api/pi/ui-settings', async (req, res) => {
    try {
      const saved = await uiSettingsStore.write(req.body);
      // A removed sandboxed project releases its daemon.
      await sandboxManager?.reconcile().catch((error) => console.warn('[pi-sandbox] reconcile failed', error?.code ?? error));
      res.json(saved);
    } catch {
      res.status(400).json({ error: 'Invalid UI settings' });
    }
  });

  app.get('/api/pi/session-folders', async (_req, res) => {
    try {
      res.json(await sessionFoldersStore.read());
    } catch {
      res.status(500).json({ error: 'Session folders are unreadable' });
    }
  });

  app.put('/api/pi/session-folders', async (req, res) => {
    try {
      res.json(await sessionFoldersStore.write(req.body));
    } catch (error) {
      if (error?.code === 'SESSION_FOLDERS_STALE') {
        res.status(409).json({ error: 'Session folders changed on another instance; reload and retry' });
        return;
      }
      res.status(400).json({ error: 'Invalid session folders' });
    }
  });

  app.get('/api/pi/themes', async (_req, res) => {
    try {
      res.json({ themes: await listCustomThemes() });
    } catch {
      res.status(500).json({ error: 'Custom themes are unavailable' });
    }
  });

  const readServerUpdateChannel = async () => {
    const settings = await uiSettingsStore.read();
    return normalizeServerUpdateChannel(settings.serverUpdateChannel);
  };

  app.get('/api/pi/update-check', async (req, res) => {
    try {
      const appType = typeof req.query.appType === 'string' ? req.query.appType : undefined;
      // Web checks follow the server's channel. The mobile app keeps its own
      // channel on the device and sends it; older apps send none and get stable.
      const channel = appType === undefined || appType === 'web'
        ? await readServerUpdateChannel()
        : appType === 'mobile-capacitor'
          ? normalizeServerUpdateChannel(req.query.channel)
          : 'stable';
      res.json(await updateChecker({
        currentVersion: typeof req.query.currentVersion === 'string' ? req.query.currentVersion : undefined,
        appType,
        deviceClass: typeof req.query.deviceClass === 'string' ? req.query.deviceClass : undefined,
        arch: typeof req.query.arch === 'string' ? req.query.arch : undefined,
        platform: typeof req.query.platform === 'string' ? req.query.platform : undefined,
        instanceMode: typeof req.query.instanceMode === 'string' ? req.query.instanceMode : undefined,
        channel,
      }));
    } catch {
      res.status(503).json({ error: 'Update check unavailable' });
    }
  });

  app.post('/api/pi/update-install', async (_req, res) => {
    const capability = updateCapabilityResolver({ serverProcess: true });
    if (!capability.supported) {
      res.status(409).json({
        success: false,
        code: capability.code,
        error: capability.error,
        commands: capability.commands || [],
      });
      return;
    }

    try {
      const previousVersion = currentVersionReader();
      const channel = await readServerUpdateChannel();
      const updateInfo = await updateChecker({
        currentVersion: previousVersion,
        appType: 'web',
        instanceMode: 'server',
        channel,
      });
      if (updateInfo.error) {
        res.status(503).json({ success: false, error: updateInfo.error });
        return;
      }
      if (!updateInfo.available || typeof updateInfo.version !== 'string') {
        res.status(409).json({ success: false, code: 'UP_TO_DATE', error: 'This PiChamber server is already up to date.', commands: [] });
        return;
      }
      const result = await updateLauncher({
        packageManager: capability.packageManager,
        previousVersion,
        targetVersion: updateInfo.version,
        channel,
      });
      if (!result.success) {
        res.status(409).json({ success: false, jobId: result.jobId, error: result.error });
        return;
      }
      res.status(result.existing ? 200 : 202).json({
        success: true,
        autoRestart: true,
        jobId: result.jobId,
        state: result.state,
        channel: result.channel || channel,
        targetVersion: result.targetVersion || updateInfo.version,
      });
    } catch {
      res.status(500).json({ success: false, error: 'Could not start the updater. Run: pichamber update' });
    }
  });

  app.get('/api/pi/update-install/:jobId', async (req, res) => {
    try {
      const job = await updateJobReader(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: 'Update job was not found' });
        return;
      }
      res.json(job);
    } catch {
      res.status(503).json({ error: 'Update status is unavailable' });
    }
  });

  app.get('/api/pi/runtime', async (_req, res) => {
    const runtime = daemonPool.main();
    if (!runtime) {
      res.status(503).json({
        protocolVersion: 1,
        state: 'unavailable',
        error: { code: 'DAEMON_UNAVAILABLE' },
      });
      return;
    }

    try {
      const health = await runtime.health();
      if (health.state !== 'ready') {
        res.status(503).json({
          protocolVersion: health.protocolVersion,
          state: 'unavailable',
          error: { code: health.error?.code ?? 'DAEMON_UNAVAILABLE' },
        });
        return;
      }
      res.json({
        protocolVersion: health.protocolVersion,
        state: 'ready',
        capabilities: Array.isArray(health.capabilities) ? health.capabilities : [],
        ...(typeof health.streamEpoch === 'string' && health.streamEpoch ? { streamEpoch: health.streamEpoch } : {}),
      });
    } catch {
      res.status(503).json({ protocolVersion: 1, state: 'unavailable', error: { code: 'DAEMON_UNAVAILABLE' } });
    }
  });

  app.get('/api/pi/projects', async (_req, res) => {
    try {
      const result = await mainDaemon().request('projects.list');
      if (!Array.isArray(result?.projects) || result.projects.some((project) => !project || typeof project.directory !== 'string' || typeof project.selected !== 'boolean')) throw protocolMismatch();
      res.json({ projects: result.projects.map((project) => ({ directory: project.directory, selected: project.selected })) });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/projects/select', async (req, res) => {
    const directory = req.body?.directory;
    if (typeof directory !== 'string' || directory.length === 0) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await mainDaemon().request('projects.select', { directory });
      if (typeof result?.directory !== 'string') throw protocolMismatch();
      res.json({ directory: result.directory });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.get('/api/pi/providers', async (_req, res) => {
    try {
      const result = await mainDaemon().request('providers.list');
      res.json(projectProviders(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.get('/api/pi/engines', async (_req, res) => {
    try {
      const result = await mainDaemon().request('engines.list');
      res.json(projectEngines(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/providers/refresh', async (req, res) => {
    const directory = typeof req.body?.directory === 'string' && req.body.directory.length > 0 ? req.body.directory : undefined;
    try {
      const result = await mainDaemon().request('providers.refresh', directory ? { directory } : undefined);
      res.json(projectProviders(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.get('/api/pi/providers/:providerId/config', async (req, res) => {
    const providerId = req.params.providerId;
    if (typeof providerId !== 'string' || providerId.length === 0) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await mainDaemon().request('providers.config.get', { providerId });
      res.json(projectProviderConfig(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.put('/api/pi/providers/:providerId/models', async (req, res) => {
    const providerId = req.params.providerId;
    const payload = req.body;
    if (typeof providerId !== 'string' || providerId.length === 0 || !payload || typeof payload !== 'object') {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await mainDaemon().request('providers.models.set', { ...payload, providerId });
      piConfigChanged();
      res.json(projectProviderConfig(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/providers/:providerId/models', async (req, res) => {
    const providerId = req.params.providerId;
    const body = req.body;
    if (typeof providerId !== 'string' || providerId.length === 0 || !body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    const { id, name, reasoning, thinkingLevelMap, input, contextWindow, maxTokens } = body;
    const isPlainBag = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    if (typeof id !== 'string'
      || (name !== undefined && typeof name !== 'string')
      || (reasoning !== undefined && typeof reasoning !== 'boolean')
      || (thinkingLevelMap !== undefined && !isPlainBag(thinkingLevelMap))
      || (input !== undefined && !Array.isArray(input))
      || (contextWindow !== undefined && !Number.isSafeInteger(contextWindow))
      || (maxTokens !== undefined && !Number.isSafeInteger(maxTokens))) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await mainDaemon().request('providers.models.add', {
        providerId,
        model: {
          id,
          ...(name !== undefined ? { name } : {}),
          ...(reasoning !== undefined ? { reasoning } : {}),
          ...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
          ...(input !== undefined ? { input } : {}),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(maxTokens !== undefined ? { maxTokens } : {}),
        },
      });
      piConfigChanged();
      res.status(201).json(projectProviderConfig(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.get('/api/pi/providers/:providerId/status', async (req, res) => {
    const providerId = req.params.providerId;
    if (typeof providerId !== 'string' || providerId.length === 0) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await mainDaemon().request('providers.status', { providerId });
      res.json(projectProviderStatus(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/providers/:providerId/login', async (req, res) => {
    const providerId = req.params.providerId;
    const type = req.body?.type;
    const apiKey = req.body?.apiKey;
    if (typeof providerId !== 'string' || providerId.length === 0 || !['api_key', 'oauth'].includes(type)
      || (apiKey !== undefined && typeof apiKey !== 'string')) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await mainDaemon().request('providers.login', {
        providerId, type, ...(typeof apiKey === 'string' ? { apiKey } : {}),
      });
      const login = projectProviderLogin(result);
      if (login.state === 'complete') piConfigChanged();
      res.status(202).json(login);
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.get('/api/pi/providers/:providerId/login/:loginId', async (req, res) => {
    const providerId = req.params.providerId;
    const loginId = req.params.loginId;
    if (typeof providerId !== 'string' || typeof loginId !== 'string') {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await mainDaemon().request('providers.login.status', { providerId, loginId });
      const login = projectProviderLogin(result);
      if (login.state === 'complete') piConfigChanged();
      res.json(login);
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/providers/:providerId/login/:loginId/respond', async (req, res) => {
    const providerId = req.params.providerId;
    const loginId = req.params.loginId;
    const value = req.body?.value;
    if (typeof providerId !== 'string' || typeof loginId !== 'string' || typeof value !== 'string') {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await mainDaemon().request('providers.login.respond', { providerId, loginId, value });
      const login = projectProviderLogin(result);
      if (login.state === 'complete') piConfigChanged();
      res.json(login);
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/providers/:providerId/logout', async (req, res) => {
    const providerId = req.params.providerId;
    if (typeof providerId !== 'string' || providerId.length === 0) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await mainDaemon().request('providers.logout', { providerId });
      piConfigChanged();
      res.json(projectProviderStatus(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/small-model/generate', async (req, res) => {
    const source = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const directory = typeof req.body?.directory === 'string' ? req.body.directory.trim() : '';
    if (!source || source.length > 20_000 || !directory) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const settings = await settingsStore.read();
      const model = settings.smallModel ?? settings.defaultModel;
      const result = await smallModelGenerator({
        directory,
        model,
        prompt: [
          'Create a short task name for a Git worktree and branch.',
          'Return only lowercase ASCII words separated by hyphens.',
          'Use at most 48 characters. Do not include quotes, punctuation, a prefix, or explanation.',
          '',
          source,
        ].join('\n'),
      });
      if (!result || typeof result.text !== 'string' || result.text.trim().length === 0) throw protocolMismatch();
      res.json({ text: result.text.trim() });
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'SMALL_MODEL_FAILED';
      const status = code === 'SMALL_MODEL_UNCONFIGURED' ? 409 : 503;
      res.status(status).json({ error: { code } });
    }
  });

  app.get('/api/pi/settings', async (_req, res) => {
    try {
      const pi = projectPiSettings(await mainDaemon().request('settings.get'));
      const pichamber = await settingsStore.read();
      res.json({ ...pi, pichamber });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.put('/api/pi/settings/pi', async (req, res) => {
    const payload = req.body;
    try {
      const result = await mainDaemon().request('settings.set', payload);
      if (typeof payload?.trust === 'boolean' && typeof payload.directory === 'string') {
        await trustAsk?.remove(payload.directory).catch((error) => console.warn('[pi-sandbox] could not clear a trust reset', error?.code ?? error));
      }
      piConfigChanged();
      res.json(projectPiSettings(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.put('/api/pi/settings/defaults', async (req, res) => {
    try {
      const pichamber = await settingsStore.update(req.body ?? {});
      res.json({ pichamber });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.get('/api/pi/resources', async (req, res) => {
    const directory = typeof req.query?.directory === 'string' && req.query.directory.length > 0
      ? req.query.directory
      : undefined;
    try {
      res.json(projectResources(await daemonFor(directory).request(
        'resources.list',
        directory ? { directory } : undefined,
      )));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.get('/api/pi/commands', async (req, res) => {
    const directory = typeof req.query?.directory === 'string' && req.query.directory.length > 0
      ? req.query.directory
      : undefined;
    try {
      const runtime = daemonFor(directory);
      const [resources, extensionList] = await Promise.all([
        runtime.request('resources.list', { ...(directory ? { directory } : {}) }),
        runtime.request('extensions.list', { ...(directory ? { directory } : {}) }),
      ]);
      const projectedResources = projectResources(resources);
      const projectedExtensions = projectExtensionList(extensionList);
      // Pi SDK 0.84.1 `getCommands()` exposes skills as `skill:name`, prompts
      // as `name`, and extensions under their registered invocation name
      // (including Pi-generated `:suffix` disambiguation). Mirror that
      // executable identity here so `/` autocomplete inserts what Pi executes.
      // Precedence at execution time is extension > skill/prompt expansion,
      // with PiChamber-local system commands intercepting before Pi.
      const commands = [
        ...projectedExtensions.commands,
        ...projectedResources.prompts.map((prompt) => ({
          name: prompt.name,
          ...(typeof prompt.description === 'string' ? { description: prompt.description } : {}),
          source: 'prompt',
          ...(typeof prompt.location === 'string' ? { scope: prompt.location } : {}),
        })),
        ...projectedResources.skills.map((skill) => ({
          name: `skill:${skill.name}`,
          ...(typeof skill.description === 'string' ? { description: skill.description } : {}),
          source: 'skill',
          ...(typeof skill.location === 'string' ? { scope: skill.location } : {}),
        })),
      ];
      res.json({ directory: projectedExtensions.directory, commands });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  const SNIPPET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
  const validSnippetAliases = (aliases) => aliases === undefined
    || (Array.isArray(aliases)
      && aliases.length <= 10
      && aliases.every((alias) => typeof alias === 'string' && SNIPPET_NAME_PATTERN.test(alias.trim())));

  const projectSnippets = (snippets) => {
    if (!Array.isArray(snippets)) throw protocolMismatch();
    return {
      snippets: snippets.map((snippet) => {
        if (!snippet || typeof snippet !== 'object'
          || typeof snippet.id !== 'string' || snippet.id.length === 0
          || typeof snippet.name !== 'string' || snippet.name.length === 0
          || typeof snippet.content !== 'string'
          || (snippet.description !== undefined && typeof snippet.description !== 'string')
          || !Array.isArray(snippet.aliases)
          || (snippet.scope !== 'global' && snippet.scope !== 'project')) throw protocolMismatch();
        return {
          id: snippet.id,
          name: snippet.name,
          content: snippet.content,
          ...(typeof snippet.description === 'string' && snippet.description.length > 0 ? { description: snippet.description } : {}),
          aliases: snippet.aliases.filter((alias) => typeof alias === 'string'),
          scope: snippet.scope,
          ...(snippet.scope === 'project' && typeof snippet.directory === 'string' ? { directory: snippet.directory } : {}),
          ...(Number.isSafeInteger(snippet.createdAt) ? { createdAt: snippet.createdAt } : {}),
          ...(Number.isSafeInteger(snippet.updatedAt) ? { updatedAt: snippet.updatedAt } : {}),
        };
      }),
    };
  };

  const snippetDirectoryFrom = (req) => {
    const queryDirectory = typeof req.query?.directory === 'string' && req.query.directory.length > 0
      ? req.query.directory
      : undefined;
    const bodyDirectory = typeof req.body?.directory === 'string' && req.body.directory.length > 0
      ? req.body.directory
      : undefined;
    return queryDirectory ?? bodyDirectory;
  };

  const writeSnippetError = (res, error) => {
    const code = typeof error?.code === 'string' ? error.code : 'SNIPPETS_INVALID';
    if (code === 'SNIPPET_NOT_FOUND') {
      res.status(404).json({ error: { code } });
      return;
    }
    if (code === 'SNIPPETS_INVALID') {
      res.status(500).json({ error: { code } });
      return;
    }
    res.status(400).json({ error: { code } });
  };

  app.get('/api/pi/snippets', async (req, res) => {
    try {
      res.json(projectSnippets(await snippetsStore.list(snippetDirectoryFrom(req))));
    } catch {
      res.status(500).json({ error: { code: 'SNIPPETS_INVALID' } });
    }
  });

  app.post('/api/pi/snippets', async (req, res) => {
    const { name, content, description, aliases, scope, directory } = req.body ?? {};
    if (typeof name !== 'string' || typeof content !== 'string'
      || !SNIPPET_NAME_PATTERN.test(name.trim())
      || content.length === 0 || content.length > 200_000
      || (description !== undefined && (typeof description !== 'string' || description.length > 4_000))
      || !validSnippetAliases(aliases)
      || (scope !== undefined && scope !== 'global' && scope !== 'project')
      || (directory !== undefined && typeof directory !== 'string')) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const snippets = await snippetsStore.create({
        name,
        content,
        ...(description !== undefined ? { description } : {}),
        ...(aliases !== undefined ? { aliases } : {}),
        scope: scope ?? 'global',
        ...(directory !== undefined ? { directory } : {}),
      });
      res.status(201).json(projectSnippets(snippets));
    } catch (error) {
      writeSnippetError(res, error);
    }
  });

  app.put('/api/pi/snippets/:snippetId', async (req, res) => {
    const snippetId = req.params.snippetId;
    if (typeof snippetId !== 'string' || snippetId.length === 0 || snippetId.length > 128) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    const { content, description, aliases, name, scope, directory } = req.body ?? {};
    if ((content !== undefined && (typeof content !== 'string' || content.length === 0 || content.length > 200_000))
      || (description !== undefined && (typeof description !== 'string' || description.length > 4_000))
      || !validSnippetAliases(aliases)
      || (name !== undefined && typeof name !== 'string')
      || (scope !== undefined && scope !== 'global' && scope !== 'project')
      || (directory !== undefined && typeof directory !== 'string')) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    if (name !== undefined && !SNIPPET_NAME_PATTERN.test(name.trim())) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      res.json(projectSnippets(await snippetsStore.update(snippetId, {
        ...(name !== undefined ? { name } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(aliases !== undefined ? { aliases } : {}),
        ...(scope !== undefined ? { scope } : {}),
        ...(directory !== undefined ? { directory } : {}),
      }, snippetDirectoryFrom(req))));
    } catch (error) {
      writeSnippetError(res, error);
    }
  });

  app.delete('/api/pi/snippets/:snippetId', async (req, res) => {
    const snippetId = req.params.snippetId;
    if (typeof snippetId !== 'string' || snippetId.length === 0) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      res.json(projectSnippets(await snippetsStore.remove(snippetId, snippetDirectoryFrom(req))));
    } catch (error) {
      writeSnippetError(res, error);
    }
  });

  const resourceDirectoryFrom = (req) => {
    const queryDirectory = typeof req.query?.directory === 'string' && req.query.directory.length > 0
      ? req.query.directory
      : undefined;
    const bodyDirectory = typeof req.body?.directory === 'string' && req.body.directory.length > 0
      ? req.body.directory
      : undefined;
    return queryDirectory ?? bodyDirectory;
  };

  app.put('/api/pi/resources/:resourceId', async (req, res) => {
    const resourceId = req.params.resourceId;
    const content = req.body?.content;
    if (typeof resourceId !== 'string' || resourceId.length === 0 || typeof content !== 'string') {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    const directory = resourceDirectoryFrom(req);
    try {
      res.json(projectResources(await mainDaemon().request('resources.update', { resourceId, content, ...(directory ? { directory } : {}) })));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/resources/prompts', async (req, res) => {
    const { name, description, content, location } = req.body ?? {};
    if (typeof name !== 'string' || typeof description !== 'string' || typeof content !== 'string' || !['global', 'project'].includes(location)) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    const directory = resourceDirectoryFrom(req);
    try {
      res.status(201).json(projectResources(await mainDaemon().request('resources.prompts.create', { name, description, content, location, ...(directory ? { directory } : {}) })));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.put('/api/pi/resources/prompts/:resourceId', async (req, res) => {
    const resourceId = req.params.resourceId;
    if (typeof resourceId !== 'string' || resourceId.length === 0) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    const { name, description, content, location } = req.body ?? {};
    if ((name !== undefined && typeof name !== 'string')
      || (description !== undefined && typeof description !== 'string')
      || (content !== undefined && typeof content !== 'string')
      || (location !== undefined && location !== 'global' && location !== 'project')) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    if (name !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    if (name === undefined && description === undefined && content === undefined && location === undefined) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    const directory = resourceDirectoryFrom(req);
    try {
      res.json(projectResources(await mainDaemon().request('resources.prompts.update', {
        resourceId,
        ...(directory ? { directory } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(location !== undefined ? { location } : {}),
      })));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.delete('/api/pi/resources/prompts/:resourceId', async (req, res) => {
    const resourceId = req.params.resourceId;
    if (typeof resourceId !== 'string' || resourceId.length === 0) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    const directory = resourceDirectoryFrom(req);
    try {
      res.json(projectResources(await mainDaemon().request('resources.prompts.delete', { resourceId, ...(directory ? { directory } : {}) })));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.get('/api/pi/events', (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId.length > 0 ? req.query.sessionId : undefined;
    const directory = typeof req.query.directory === 'string' && req.query.directory.length > 0 ? req.query.directory : undefined;
    const rawCursor = req.query.fromSequence;
    const fromSequence = rawCursor === undefined ? undefined : Number(rawCursor);
    if (rawCursor !== undefined && (!Number.isSafeInteger(fromSequence) || fromSequence < 0)) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    // Stream-lifetime identity of the replay cursor (capability negotiation).
    // Epoch-aware clients stamp their subscribe with the epoch the cursor was
    // established under; the daemon refuses to replay a cursor from a retired
    // epoch even when its own sequence numerically overtook it. A marker-less
    // legacy client without a cursor gets the snapshot baseline (initial
    // attach with no replay to verify). A legacy client that supplies a
    // cursor cannot be epoch-verified, so its cursor is rejected fail-visible
    // instead of claiming a snapshot fallback is safe.
    const rawStreamEpoch = req.query.streamEpoch;
    const streamEpoch = typeof rawStreamEpoch === 'string' && rawStreamEpoch.length > 0 && rawStreamEpoch.length <= 128
      ? rawStreamEpoch
      : undefined;
    if (rawStreamEpoch !== undefined && streamEpoch === undefined) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    const rawCapabilities = req.query.capabilities;
    const capabilities = typeof rawCapabilities === 'string' ? rawCapabilities.split(',').map((s) => s.trim()).filter(Boolean)
      : Array.isArray(rawCapabilities) ? rawCapabilities.flatMap((v) => String(v).split(',').map((s) => s.trim())).filter(Boolean)
      : [];
    const hasEpochCapability = capabilities.includes('events.streamEpoch');
    if (fromSequence !== undefined && (!hasEpochCapability || streamEpoch === undefined)) {
      res.status(400).json({ error: { code: 'DAEMON_PROTOCOL_MISMATCH' } });
      return;
    }
    // Opaque resume position of every project daemon (merged-event-stream.js).
    // Only epoch-aware clients receive one, so it requires the same marker.
    const rawEventCursor = req.query.cursor;
    const eventCursor = rawEventCursor === undefined ? undefined : decodePiEventCursor(rawEventCursor);
    if (eventCursor === null) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    if (eventCursor !== undefined && !hasEpochCapability) {
      res.status(400).json({ error: { code: 'DAEMON_PROTOCOL_MISMATCH' } });
      return;
    }
    try {
      const runtime = mainDaemon();
      if (typeof runtime.subscribe !== 'function') throw protocolMismatch();
      res.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.flushHeaders?.();
      // event-stream.js owns the connection lifecycle: cleanup installed before
      // subscribe opens, idempotent close on disconnect/error/shutdown, bounded
      // socket buffering with a recoverable disconnect, and heartbeat
      // suppression on dead responses.
      openPiEventStream({
        req,
        res,
        // Every live daemon's stream, merged. Frames arrive projected.
        subscribe: (handlers) => subscribeMergedPiEvents({
          pool: daemonPool,
          projectFrame: projectEventFrame,
          sessionId,
          directory,
          fromSequence,
          streamEpoch,
          cursor: eventCursor,
          ...(eventStreamRetryBaseMs !== undefined ? { retryBaseMs: eventStreamRetryBaseMs } : {}),
          ...handlers,
        }),
        projectFrame: (event) => event,
        heartbeatMs: eventHeartbeatMs,
        maxBufferedBytes: eventStreamMaxBufferedBytes,
        registry: eventStreamRegistry,
        respondWithError: (error) => {
          if (!res.headersSent) writeDaemonError(res, error);
          else if (!res.writableEnded && !res.destroyed) res.end();
        },
      });
    } catch (error) {
      if (!res.headersSent) writeDaemonError(res, error);
      else if (!res.writableEnded && !res.destroyed) res.end();
    }
  });

  app.get('/api/pi/sessions', async (req, res) => {
    const directory = req.query.directory;
    if (directory !== undefined && (typeof directory !== 'string' || directory.length === 0)) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }

    try {
      const payload = typeof directory === 'string' ? { directory } : {};
      // The owner's rows are the list (JSONL is the authority). Other
      // daemons only fill in `live`/`inputState` the owner lacks: daemons
      // still draining this folder after a switch, or, for the all-sessions
      // list, every project daemon (the main daemon lists every folder but
      // only knows its own residents). A failed other daemon leaves those
      // rows unknown.
      const others = typeof directory === 'string'
        ? daemonPool.drainingFor(directory)
        : daemonPool.live().filter((item) => item.key !== MAIN_DAEMON_KEY);
      const [result, ...otherLists] = await Promise.all([
        daemonFor(directory).request('sessions.list', payload),
        ...others.map(({ key, runtime }) => runtime.request('sessions.list', payload)
          .then((value) => ({
            stream: publicDaemonStreamId(key),
            ...(isValidStreamEpoch(value?.streamEpoch) ? { streamEpoch: value.streamEpoch } : {}),
            items: projectSessionList(value?.sessions),
          }))
          .catch(() => ({ stream: publicDaemonStreamId(key), items: [] }))),
      ]);
      const archived = await archiveStore.read();
      const incompleteEngines = Array.isArray(result?.incompleteEngines)
        ? result.incompleteEngines.filter((engineId) => isValidEngineId(engineId))
        : [];
      res.json(withStream({
        ...(typeof result?.streamEpoch === 'string' && result.streamEpoch ? { streamEpoch: result.streamEpoch } : {}),
        ...(incompleteEngines.length > 0 ? { incompleteEngines } : {}),
        sessions: mergeOtherDaemonsLiveState(projectSessionList(result?.sessions), otherLists).map(withSandbox).map((item) => archived[item.session.id]
          ? { ...item, session: { ...item.session, archived: true, timeArchived: archived[item.session.id] } }
          : item),
      }, directory));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  // Registered before any `/api/pi/sessions/:id` route so `pending-input`
  // is not captured as a session id.
  app.get('/api/pi/sessions/pending-input', async (_req, res) => {
    try {
      // Fan out to every live daemon. One failed (or malformed) daemon
      // must not empty the others' lists; the response then says
      // `incomplete` so clients do not treat its absent rows as cleared.
      // Each daemon numbers its own stream: the top-level cursor is the
      // main daemon's (absent when it failed), and a project daemon's
      // entries carry `stream`, with its cursor under `streams[stream]`.
      const daemons = daemonPool.live();
      if (daemons.length === 0) requireDaemon(null);
      const settled = await Promise.allSettled(daemons.map(async ({ runtime }) => (
        projectPendingInputList(await runtime.request('sessions.pendingInput'))
      )));
      if (!settled.some((item) => item.status === 'fulfilled')) throw settled[0].reason;
      let mainList = null;
      const sessions = [];
      const streams = {};
      settled.forEach((item, index) => {
        if (item.status !== 'fulfilled') return;
        const { key } = daemons[index];
        if (key === MAIN_DAEMON_KEY) {
          mainList = item.value;
          sessions.push(...item.value.sessions);
          return;
        }
        const stream = publicDaemonStreamId(key);
        streams[stream] = {
          sequence: item.value.sequence,
          ...(item.value.streamEpoch ? { streamEpoch: item.value.streamEpoch } : {}),
        };
        for (const entry of item.value.sessions) sessions.push({ ...entry, stream });
      });
      res.json({
        sessions,
        ...(mainList ? { sequence: mainList.sequence } : {}),
        ...(mainList?.streamEpoch ? { streamEpoch: mainList.streamEpoch } : {}),
        ...(Object.keys(streams).length > 0 ? { streams } : {}),
        ...(settled.some((item) => item.status !== 'fulfilled') ? { incomplete: true } : {}),
      });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.patch('/api/pi/sessions/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const title = req.body?.title;
    const directory = typeof req.body?.directory === 'string' && req.body.directory.length > 0
      ? req.body.directory
      : (typeof req.query?.directory === 'string' && req.query.directory.length > 0 ? req.query.directory : undefined);
    if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof title !== 'string') {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }

    try {
      await daemonFor(directory).request('sessions.rename', {
        sessionId,
        title,
        ...(directory ? { directory } : {}),
      });
      res.status(204).end();
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  const sendSessionDetail = async (req, res) => {
    const result = await requestSessionOperation(req, res, daemonPool, 'sessions.open', {}, sandboxManager);
    if (result === undefined) return;
    try {
      const detail = withSandbox(projectSessionDetail(result));
      const archived = await archiveStore.read();
      res.json(withStream(archived[detail.session.id]
        ? { ...detail, session: { ...detail.session, archived: true, timeArchived: archived[detail.session.id] } }
        : detail, sessionRouteDirectory(req, res), res));
    } catch (error) {
      writeDaemonError(res, error);
    }
  };

  app.get('/api/pi/sessions/:sessionId', sendSessionDetail);
  app.get('/api/pi/sessions/:sessionId/snapshot', sendSessionDetail);

  app.get('/api/pi/sessions/:sessionId/messages', async (req, res) => {
    const before = req.query?.before;
    const rawLimit = req.query?.limit;
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if ((before !== undefined && (typeof before !== 'string' || before.length === 0))
      || (rawLimit !== undefined && (typeof rawLimit !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100))) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    const result = await requestSessionOperation(req, res, daemonPool, 'sessions.messages', {
      ...(typeof before === 'string' ? { before } : {}),
      ...(limit !== undefined ? { limit } : {}),
    }, sandboxManager);
    if (result === undefined) return;
    try {
      res.json(withStream(projectSessionDetail(result), sessionRouteDirectory(req, res), res));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.delete('/api/pi/sessions/:sessionId', async (req, res) => {
    const result = await requestSessionOperation(req, res, daemonPool, 'sessions.delete', {}, sandboxManager);
    if (result === undefined) return;
    try {
      await sessionShelfStore.remove(req.params.sessionId);
    } catch (error) {
      console.warn('[pi] could not remove a deleted session from the shelf', error?.code ?? error);
    }
    res.status(204).end();
  });

  app.get('/api/pi/session-shelf', async (_req, res) => {
    try {
      res.json({ sessions: await sessionShelfStore.read() });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/sessions/:sessionId/shelf', async (req, res) => {
    const { sessionId } = req.params;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const directory = typeof body.directory === 'string' && body.directory.length > 0 ? body.directory : undefined;
    // Older clients (the Settle release candidate) may still send `settled`:
    // 'settled' archives the session; 'active' and null do nothing. Remove
    // this mapping one release after Archive replaced Settle.
    const hasSettled = Object.hasOwn(body, 'settled');
    const hasSnooze = Object.hasOwn(body, 'snoozedUntil');
    const settledValid = !hasSettled || body.settled === null || body.settled === 'settled' || body.settled === 'active';
    const snoozeValid = !hasSnooze || body.snoozedUntil === null
      || (Number.isSafeInteger(body.snoozedUntil) && body.snoozedUntil > 0);
    if (!sessionId || (!hasSettled && !hasSnooze) || !settledValid || !snoozeValid) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      // Same membership check as archive: shelf state is PiChamber metadata
      // for a session that exists, not a Pi session mutation.
      const result = await daemonFor(directory).request(
        'sessions.list',
        directory ? { directory } : undefined,
      );
      const items = projectSessionList(result?.sessions);
      const item = items.find((candidate) => candidate.session.id === sessionId);
      if (!item) {
        const error = new Error('The Pi session does not exist.');
        error.code = 'INVALID_SESSION';
        throw error;
      }
      if (hasSettled && body.settled === 'settled') {
        await archiveStore.set(sessionId, true);
        publishArchiveChange(sessionId, true, item.session.directory || directory);
      }
      const entry = hasSnooze
        ? await sessionShelfStore.update(sessionId, { snoozedUntil: body.snoozedUntil })
        : (await sessionShelfStore.read())[sessionId] ?? null;
      res.json({ entry });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/sessions/:sessionId/archive', async (req, res) => {
    const { sessionId } = req.params;
    const { archived } = req.body || {};
    const directory = req.body?.directory || req.query?.directory;
    if (!sessionId || typeof archived !== 'boolean') {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      // Confirm membership without selecting/replacing the daemon's active
      // runtime: archive is PiChamber metadata, not a Pi session mutation.
      const result = await daemonFor(directory).request(
        'sessions.list',
        directory ? { directory } : undefined,
      );
      const items = projectSessionList(result?.sessions);
      const item = items.find((candidate) => candidate.session.id === sessionId);
      if (!item) {
        const error = new Error('The Pi session does not exist.');
        error.code = 'INVALID_SESSION';
        throw error;
      }
      await archiveStore.set(sessionId, archived);
      publishArchiveChange(sessionId, archived, item.session.directory || directory);
      res.status(204).end();
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/sessions/:sessionId/editor-draft', async (req, res) => {
    const text = req.body?.text;
    const revision = req.body?.revision;
    const directory = req.body?.directory;
    if (typeof text !== 'string' || text.length > 100_000 || !Number.isSafeInteger(revision) || revision < 0 || (directory !== undefined && typeof directory !== 'string')) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    const result = await requestSessionOperation(req, res, daemonPool, 'extensions.draft', { text, revision }, sandboxManager);
    if (result !== undefined) {
      res.status(204).end();
    }
  });

  app.get('/api/pi/extensions', async (req, res) => {
    const directory = req.query?.directory;
    if (directory !== undefined && typeof directory !== 'string') {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await daemonFor(directory).request('extensions.list', {
        ...(typeof directory === 'string' && directory.length > 0 ? { directory } : {}),
      });
      res.json(projectExtensionList(result));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  // Pi's colours for extension surfaces drawn with the given terminal
  // colours (session-daemon/extension-palette.js).
  app.post('/api/pi/extensions/palette', async (req, res) => {
    const terminal = projectTerminalColors(req.body?.terminal);
    if (!terminal) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const result = await mainDaemon().request('extensions.palette', { terminal });
      const palette = projectExtensionPalette(result);
      if (!palette) {
        res.status(502).json({ error: { code: 'MALFORMED_DAEMON_RESPONSE' } });
        return;
      }
      res.json(palette);
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/extensions/respond', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || typeof body.requestId !== 'string' || body.requestId.length === 0
      || (body.directory !== undefined && typeof body.directory !== 'string')) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    let values;
    if (body.values !== undefined) {
      if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
        res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
        return;
      }
      values = {};
      for (const [key, entry] of Object.entries(body.values)) {
        if (typeof key !== 'string' || key.length === 0 || key.length > 128 || typeof entry !== 'string' || entry.length > 8_000) {
          res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
          return;
        }
        values[key] = entry;
      }
    }
    try {
      const respondPayload = {
        requestId: body.requestId,
        ...(typeof body.directory === 'string' && body.directory.length > 0 ? { directory: body.directory } : {}),
        ...(body.cancelled === true ? { cancelled: true } : {}),
        ...(body.confirmed === true ? { confirmed: true } : {}),
        ...(typeof body.value === 'string' ? { value: body.value } : {}),
        ...(values ? { values } : {}),
      };
      let result = await daemonFor(body.directory).request('extensions.respond', respondPayload);
      // A dialog from a session still finishing its turn in a daemon that
      // drains this folder is answered there. Request ids are unique, so
      // asking each in turn cannot answer the wrong dialog.
      if (result?.resolved !== true && typeof body.directory === 'string') {
        for (const { runtime } of daemonPool.drainingFor(body.directory)) {
          result = await runtime.request('extensions.respond', respondPayload).catch(() => null);
          if (result?.resolved === true) break;
        }
      }
      if (!result || typeof result !== 'object' || result.resolved !== true) {
        res.status(404).json({ error: { code: 'EXTENSION_DIALOG_NOT_PENDING' } });
        return;
      }
      res.status(204).end();
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  // `ctx.ui.custom()` surfaces: keys, the sender's viewport, Close, picking a
  // panel in a tab stack, and a full-frame refresh after a missed patch. A surface that already closed
  // answers 404 so the browser drops it without retrying.
  const CUSTOM_SURFACE_ACTIONS = new Map([
    ['input', 'extensions.custom.input'],
    ['viewport', 'extensions.custom.viewport'],
    ['close', 'extensions.custom.close'],
    ['focus', 'extensions.custom.focus'],
    ['refresh', 'extensions.custom.refresh'],
  ]);
  app.post('/api/pi/sessions/:sessionId/extensions/custom/:action', async (req, res) => {
    const command = CUSTOM_SURFACE_ACTIONS.get(req.params.action);
    const body = req.body;
    if (!command || !body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    const surfaceId = typeof body.surfaceId === 'string' && body.surfaceId.length > 0 && body.surfaceId.length <= 128 ? body.surfaceId : undefined;
    const clientId = typeof body.clientId === 'string' && body.clientId.length > 0 && body.clientId.length <= 128 ? body.clientId : undefined;
    const viewport = body.viewport && typeof body.viewport === 'object' && !Array.isArray(body.viewport)
      && Number.isFinite(body.viewport.columns) && Number.isFinite(body.viewport.rows)
      ? {
        columns: body.viewport.columns,
        rows: body.viewport.rows,
        ...(Number.isFinite(body.viewport.screenColumns) ? { screenColumns: body.viewport.screenColumns } : {}),
      }
      : undefined;
    let items;
    if (command === 'extensions.custom.input') {
      if (!surfaceId || !isValidCustomInputItems(body.items)) {
        res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
        return;
      }
      items = body.items;
    }
    if ((command === 'extensions.custom.close' || command === 'extensions.custom.focus') && !surfaceId) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    const result = await requestSessionOperation(req, res, daemonPool, command, {
      ...(surfaceId ? { surfaceId } : {}),
      ...(clientId ? { clientId } : {}),
      ...(viewport ? { viewport } : {}),
      ...(items ? { items } : {}),
      ...(body.claim === true ? { claim: true } : {}),
    }, sandboxManager);
    if (result === undefined) return;
    const ok = result && typeof result === 'object'
      && (result.accepted === true || result.closed === true || result.focused === true || result.refreshed === true);
    if (!ok) {
      res.status(404).json({ error: { code: 'EXTENSION_SURFACE_NOT_OPEN' } });
      return;
    }
    res.status(204).end();
  });

  app.get('/api/pi/sessions/:sessionId/tree', async (req, res) => {
    const result = await requestSessionOperation(req, res, daemonPool, 'sessions.tree', {}, sandboxManager);
    if (result !== undefined) res.json(projectSessionTree(result));
  });

  app.post('/api/pi/sessions/:sessionId/navigate', async (req, res) => {
    const result = await requestSessionOperation(req, res, daemonPool, 'sessions.navigate', { messageId: req.body?.messageId }, sandboxManager);
    if (result === undefined) return;
    const detail = projectSessionDetail(result);
    const navigation = sanitizeNavigation(result.navigation);
    if (navigation) detail.navigation = navigation;
    res.json(withStream(detail, sessionRouteDirectory(req, res), res));
  });

  for (const [suffix, command] of [['fork', 'sessions.fork'], ['clone', 'sessions.clone']]) {
    app.post(`/api/pi/sessions/:sessionId/${suffix}`, async (req, res) => {
      const result = await requestSessionOperation(req, res, daemonPool, command, req.body && typeof req.body === 'object' ? req.body : {}, sandboxManager);
      if (result !== undefined) res.status(201).json(withStream(withSandbox(projectSessionDetail(result)), sessionRouteDirectory(req, res), res));
    });
  }

  for (const [suffix, command] of [['prompt', 'sessions.prompt'], ['steer', 'sessions.steer'], ['follow-up', 'sessions.followUp']]) {
    app.post(`/api/pi/sessions/:sessionId/${suffix}`, async (req, res) => {
      let payload = req.body && typeof req.body === 'object' ? req.body : {};
      if (!isValidStreamEpoch(payload.streamEpoch)
        || (payload.operationId !== undefined && !isValidSendOperationId(payload.operationId))) {
        res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
        return;
      }
      if (payload.messageId !== undefined && (typeof payload.messageId !== 'string' || payload.messageId.length === 0 || payload.messageId.length > 512)) {
        res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
        return;
      }
      let attachmentIds = [];
      try {
        if (payload.attachments !== undefined) {
          if (!Array.isArray(payload.attachments) || payload.attachments.some((attachment) => !attachment || typeof attachment.id !== 'string')) throw protocolMismatch();
          attachmentIds = payload.attachments.map((attachment) => attachment.id);
          // Resolve happens before the daemon call; consume below is
          // idempotent (retired entries resolve), so a deduplicated replay
          // of an already-consumed attachment still returns the receipt.
          const attachments = await attachmentStore.resolve(attachmentIds);
          payload = { ...payload, attachments };
        }
      } catch (error) {
        writeDaemonError(res, error);
        return;
      }
      const result = await requestSessionOperation(req, res, daemonPool, command, payload, sandboxManager);
      if (result !== undefined) {
        if (!result || result.accepted !== true || typeof result.messageId !== 'string') {
          writeDaemonError(res, protocolMismatch());
          return;
        }
        await attachmentStore.consume?.(attachmentIds);
        await bringBackForActivity(req.params.sessionId);
        res.status(202).json({
          accepted: true,
          messageId: result.messageId,
          ...(result.deduplicated === true ? { deduplicated: true } : {}),
        });
      }
    });
  }

  // Exact read-only receipt lookup for an uncertain send. The client passes
  // the full `kind + sessionId + operationId + streamEpoch` identity; the daemon never
  // invokes Pi and never mutates the registry except bounded expiry
  // eviction. Missing epoch deliberately returns unknown: it cannot identify
  // a daemon lifetime and therefore cannot prove acceptance.
  app.post('/api/pi/sessions/:sessionId/send-receipt', async (req, res) => {
    const sessionId = sessionIdFrom(req);
    if (!sessionId) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const kind = body.kind;
    const operationId = body.operationId;
    const streamEpoch = body.streamEpoch;
    if ((kind !== 'prompt' && kind !== 'steer' && kind !== 'followUp')
      || !isValidSendOperationId(operationId)
      || (streamEpoch !== undefined && !isValidStreamEpoch(streamEpoch))) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    try {
      const directory = typeof req.query?.directory === 'string' && req.query.directory.length > 0
        ? req.query.directory
        : (typeof body.directory === 'string' && body.directory.length > 0 ? body.directory : undefined);
      // A session still finishing its turn in a draining daemon has its
      // receipts there; one that just moved may still name the old epoch.
      const runtime = drainingSessionRuntime(res, sandboxManager, sessionId, 'sessions.sendReceipt') ?? daemonFor(directory);
      const receiptEpoch = streamEpoch !== undefined && !res.locals?.piDrainingStream && sandboxManager?.sendEpochFor
        ? await sandboxManager.sendEpochFor(sessionId, streamEpoch, runtime)
        : streamEpoch;
      const result = await runtime.request('sessions.sendReceipt', {
        kind,
        sessionId,
        operationId,
        ...(receiptEpoch !== undefined ? { streamEpoch: receiptEpoch } : {}),
      });
      if (!result || typeof result !== 'object' || !['accepted', 'pending', 'expired', 'unknown'].includes(result.status)) {
        throw protocolMismatch();
      }
      res.json({
        status: result.status,
        ...(result.status === 'accepted' && result.receipt && typeof result.receipt === 'object' ? { receipt: result.receipt } : {}),
      });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  for (const [suffix, command] of [['abort', 'sessions.abort'], ['model', 'sessions.setModel'], ['thinking', 'sessions.setThinking']]) {
    app.post(`/api/pi/sessions/:sessionId/${suffix}`, async (req, res) => {
      const result = await requestSessionOperation(req, res, daemonPool, command, req.body && typeof req.body === 'object' ? req.body : {}, sandboxManager);
      if (result !== undefined) res.status(204).end();
    });
  }

  // User shell commands (`!cmd` / `!!cmd`). Acceptance is not completion:
  // output and the recorded result arrive as `session.bash*` events.
  app.post('/api/pi/sessions/:sessionId/bash', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (typeof body.command !== 'string' || body.command.trim().length === 0 || body.command.length > BASH_COMMAND_MAX_CHARS
      || (body.excludeFromContext !== undefined && typeof body.excludeFromContext !== 'boolean')) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }
    const clientId = typeof body.clientId === 'string' && body.clientId.length > 0 && body.clientId.length <= 128 ? body.clientId : undefined;
    const result = await requestSessionOperation(req, res, daemonPool, 'sessions.bash', {
      command: body.command,
      ...(body.excludeFromContext === true ? { excludeFromContext: true } : {}),
      ...(clientId ? { clientId } : {}),
    }, sandboxManager);
    if (result === undefined) return;
    if (!result || result.accepted !== true || typeof result.id !== 'string') {
      writeDaemonError(res, protocolMismatch());
      return;
    }
    await bringBackForActivity(req.params.sessionId);
    res.status(202).json({ accepted: true, id: result.id });
  });

  app.post('/api/pi/sessions/:sessionId/bash/abort', async (req, res) => {
    const result = await requestSessionOperation(req, res, daemonPool, 'sessions.abortBash', {}, sandboxManager);
    if (result !== undefined) res.status(204).end();
  });

  app.post('/api/pi/sessions/:sessionId/compact', async (req, res) => {
    const result = await requestSessionOperation(req, res, daemonPool, 'sessions.compact', req.body && typeof req.body === 'object' ? req.body : {}, sandboxManager);
    if (result === undefined) return;
    if (!result || result.accepted !== true) {
      writeDaemonError(res, protocolMismatch());
      return;
    }
    res.status(202).json({ accepted: true });
  });

  app.post('/api/pi/attachments', async (req, res) => {
    try {
      const isBinary = req.is('application/octet-stream');
      let attachment;
      if (isBinary) {
        const encodedFilename = req.get('x-pichamber-filename');
        const mime = req.get('x-pichamber-mime');
        if (!encodedFilename || encodedFilename.length > 2_048 || !mime || mime.length > 200) throw Object.assign(new Error('Invalid attachment metadata'), { code: 'ATTACHMENT_FAILED' });
        let filename;
        try {
          filename = decodeURIComponent(encodedFilename);
        } catch {
          throw Object.assign(new Error('Invalid attachment metadata'), { code: 'ATTACHMENT_FAILED' });
        }
        attachment = await attachmentStore.createFromStream({ filename, mime, stream: req });
      } else {
        attachment = await attachmentStore.create(req.body ?? {});
      }
      if (!attachment || typeof attachment.id !== 'string' || typeof attachment.name !== 'string'
        || typeof attachment.mime !== 'string' || !Number.isSafeInteger(attachment.size)
        || !Number.isFinite(attachment.expiresAt)) throw protocolMismatch();
      res.status(201).json({ attachment: {
        id: attachment.id,
        name: attachment.name,
        mime: attachment.mime,
        size: attachment.size,
        expiresAt: attachment.expiresAt,
      } });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.delete('/api/pi/attachments/:attachmentId', async (req, res) => {
    try {
      await attachmentStore.remove(req.params.attachmentId);
      res.status(204).end();
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/sessions', async (req, res) => {
    const input = req.body;
    const cwd = typeof input?.cwd === 'string' && input.cwd.length > 0
      ? input.cwd
      : (typeof input?.directory === 'string' && input.directory.length > 0 ? input.directory : undefined);
    if (!input || typeof input !== 'object' || Array.isArray(input) || !cwd) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }

    try {
      const result = await daemonFor(cwd).request('sessions.create', { ...input, cwd });
      // A fresh session is not necessarily empty: extensions may append
      // entries or messages from `session_start`. Project it exactly like a
      // session read so those items, the stream epoch, and extension UI state
      // reach the client instead of failing creation.
      res.status(201).json(withStream(withSandbox(projectSessionDetail(result)), cwd));
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  return {
    dispose: () => attachmentStore.dispose?.(),
    /** End every live event stream (active or still opening) during shutdown. */
    closeEventStreams: () => eventStreamRegistry.closeAll(),
    // Whether any device holds a live `/api/pi/events` stream (Open request delivery).
    hasLiveEventStreams: () => eventStreamRegistry.size > 0,
  };
};
