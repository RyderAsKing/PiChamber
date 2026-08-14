/**
 * Pi event reducer helpers — apply sequenced events from the public stream
 * to running per-session state.
 *
 * The reducer is the small, pure function at the center of the PiChamber UI
 * migration. It is responsible for:
 *
 * - Sequencing: events with a `sequence` <= the last accepted sequence are
 *   ignored. This is what makes reconnect safe: a client can resume from
 *   `snapshot.lastSequence` and the reducer will discard anything it has
 *   already applied.
 * - Stream assembly: text and thinking deltas are accumulated per part
 *   until the daemon publishes `part.end` with the final content. The
 *   reducer produces finalized text/thinking the moment the daemon says
 *   the message is done.
 * - Lifecycle: the `session.lifecycle` event flips the running state.
 *   `session.interrupted` flips the streaming flag back off without
 *   marking the message completed; that is the visible "interrupted" UI
 *   state the plan requires.
 *
 * The reducer is intentionally a plain function so it can be reused by
 * bootstrap, reconnect, and live-stream code paths without coupling to any
 * store implementation. The store wrapper lives in `packages/ui/src/sync/`.
 */

import type {
  PiAssistantMessageDeltaPayload,
  PiAssistantThinkingDeltaPayload,
  PiMessageStartPayload,
  PiMessageEndPayload,
  PiSessionEvent,
  PiToolUpdatePayload,
} from './protocol';
import type {
  PiAssistantMessage,
  PiAttachment,
  PiModelRef,
  PiSessionLifecycleState,
  PiSessionId,
  PiThinkingLevel,
  PiUserMessage,
} from './types';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface PiReducerMessagePart {
  id: string;
  index: number;
  type: 'text' | 'thinking' | 'tool' | 'attachment';
  /** Text content for text/thinking parts (assembled from deltas). */
  text: string;
  /** Set while the part is still accepting deltas. */
  streaming: boolean;
  /** For tool parts. */
  tool?: {
    toolCallId: string;
    name: string;
    input?: unknown;
    output?: unknown;
    /** Error message when the tool ended in an error state. */
    error?: string;
    /** Renderer metadata (edit diffs, truncation notes). */
    metadata?: Record<string, unknown>;
    isError?: boolean;
    state: 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
    startedAt?: number;
    endedAt?: number;
  };
  /** For attachment parts. */
  attachment?: PiAttachment;
}

export interface PiReducerMessage {
  id: string;
  sessionId: PiSessionId;
  directory: string;
  role: 'user' | 'assistant';
  /** User message that owns this assistant turn. */
  parentId?: string;
  /** Created-at (ms epoch) the reducer keeps for ordering. */
  createdAt: number;
  /** Assistant-only: model & thinking captured at creation time. */
  model?: PiModelRef;
  thinkingLevel?: PiThinkingLevel;
  /** Final assembled text/thinking for assistant messages. */
  text: string;
  thinking: string;
  durationMs?: number;
  /** True while the assistant message is still streaming. */
  streaming: boolean;
  /** Set when the assistant message ended in an interrupted/error state. */
  error?: { code: string; message?: string };
}

export interface PiReducerSessionState {
  sessionId: PiSessionId;
  directory: string;
  /** Last sequence the reducer has accepted for this session. */
  lastSequence: number;
  /** Authoritative lifecycle phase. */
  lifecycle: PiSessionLifecycleState;
  /** Active model/thinking the session is using. */
  model?: PiModelRef;
  thinking?: PiThinkingLevel;
  /** Messages keyed by message id, ordered by `createdAt`. */
  messages: Map<string, PiReducerMessage>;
  /** Part order per message id. */
  partOrder: Map<string, string[]>;
  parts: Map<string, PiReducerMessagePart>;
  /** Pending tool calls (toolCallId → messageId) so an end event can find its parent. */
  toolsByCallId: Map<string, string>;
  /** Assistant messages whose `streaming` flag is still true. */
  streamingMessages: Set<string>;
  /** Queue depths at the time of the last `session.queue` event. */
  queue: { steering: number; followUp: number };
}

export interface PiReducerState {
  bySession: Map<PiSessionId, PiReducerSessionState>;
  /** Last sequence per session id; `-1` means "no events yet". */
  lastSequence: Map<PiSessionId, number>;
}

export const createReducerState = (): PiReducerState => ({
  bySession: new Map(),
  lastSequence: new Map(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getOrCreateSession = (
  state: PiReducerState,
  sessionId: PiSessionId,
  directory: string,
): PiReducerSessionState => {
  const existing = state.bySession.get(sessionId);
  if (existing) return existing;
  const fresh: PiReducerSessionState = {
    sessionId,
    directory,
    lastSequence: -1,
    lifecycle: 'idle',
    messages: new Map(),
    partOrder: new Map(),
    parts: new Map(),
    toolsByCallId: new Map(),
    streamingMessages: new Set(),
    queue: { steering: 0, followUp: 0 },
  };
  state.bySession.set(sessionId, fresh);
  return fresh;
};

const ensureMessage = (
  session: PiReducerSessionState,
  payload: PiMessageStartPayload,
  directory: string,
): PiReducerMessage => {
  const existing = session.messages.get(payload.messageId);
  if (existing) return existing;
  const message: PiReducerMessage = {
    id: payload.messageId,
    sessionId: session.sessionId,
    directory,
    role: payload.role,
    ...(payload.parentId ? { parentId: payload.parentId } : {}),
    createdAt: payload.startedAt,
    text: payload.role === 'user' ? payload.text ?? '' : '',
    thinking: '',
    streaming: payload.role === 'assistant',
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.thinkingLevel ? { thinkingLevel: payload.thinkingLevel } : {}),
  };
  session.messages.set(payload.messageId, message);
  return message;
};

const ensureTextPart = (
  session: PiReducerSessionState,
  message: PiReducerMessage,
  type: 'text' | 'thinking',
  partId?: string,
): PiReducerMessagePart => {
  const id = partId ?? `${message.id}:${type}`;
  const existing = session.parts.get(id);
  if (existing) return existing;
  const part: PiReducerMessagePart = {
    id,
    index: (session.partOrder.get(message.id) ?? []).length,
    type,
    text: '',
    streaming: true,
  };
  session.parts.set(id, part);
  const order = [...(session.partOrder.get(message.id) ?? [])];
  if (!order.includes(part.id)) order.push(part.id);
  session.partOrder.set(message.id, order);
  return part;
};

const assembleMessageText = (session: PiReducerSessionState, messageId: string): {
  text: string;
  thinking: string;
} => {
  const message = session.messages.get(messageId);
  if (!message) return { text: '', thinking: '' };
  const order = session.partOrder.get(messageId) ?? [];
  let text = '';
  let thinking = '';
  for (const partId of order) {
    const part = session.parts.get(partId);
    if (!part) continue;
    if (part.type === 'text') text += part.text;
    else if (part.type === 'thinking') thinking += part.text;
  }
  return { text, thinking };
};

// ---------------------------------------------------------------------------
// Event reducers
// ---------------------------------------------------------------------------

const reduceLifecycle = (
  session: PiReducerSessionState,
  state: PiSessionLifecycleState,
  attempt?: number,
): void => {
  session.lifecycle = state;
  if (attempt !== undefined) {
    // Retry metadata is surfaced to consumers through `lifecycle: 'retry'`.
  }
};

const reduceMessageStart = (
  session: PiReducerSessionState,
  directory: string,
  payload: PiMessageStartPayload,
): void => {
  ensureMessage(session, payload, directory);
};

const reduceAssistantDelta = (
  session: PiReducerSessionState,
  payload: PiAssistantMessageDeltaPayload | PiAssistantThinkingDeltaPayload,
  type: 'text' | 'thinking',
): void => {
  const message = session.messages.get(payload.messageId);
  if (!message || message.role !== 'assistant') return;
  const partId = payload.partId ?? `${message.id}:${type}`;
  const existing = session.parts.get(partId);
  if (existing) {
    if (existing.type !== type) return;
    // Pi's contentIndex identifies the content block; it is intentionally
    // identical for every delta appended to that block. Event sequence owns
    // replay and out-of-order rejection at the session boundary.
    session.parts.set(partId, { ...existing, text: existing.text + payload.delta });
    return;
  }
  const part = ensureTextPart(session, message, type, partId);
  session.parts.set(part.id, { ...part, text: payload.delta });
};

const reduceMessageEnd = (
  session: PiReducerSessionState,
  payload: PiMessageEndPayload,
): void => {
  const current = session.messages.get(payload.messageId);
  if (!current) return;
  const message = { ...current };
  session.messages.set(payload.messageId, message);
  const { text, thinking } = assembleMessageText(session, payload.messageId);
  message.text = typeof payload.text === 'string' ? payload.text : text;
  message.thinking = typeof payload.thinking === 'string' ? payload.thinking : thinking;
  message.streaming = false;
  if (typeof payload.durationMs === 'number') {
    message.durationMs = payload.durationMs;
  }
  if (payload.thinkingLevel) message.thinkingLevel = payload.thinkingLevel;
  if (payload.error) message.error = payload.error;
  session.streamingMessages.delete(payload.messageId);
};

const reduceTool = (
  session: PiReducerSessionState,
  phase: 'start' | 'update' | 'end',
  payload: PiToolUpdatePayload,
): void => {
  // Look up the existing part by toolCallId when the start event already
  // produced it.
  const messageId = session.toolsByCallId.get(payload.toolCallId) ?? payload.messageId;
  const message = session.messages.get(messageId);
  if (!message) return;
  const part =
    session.parts.get(payload.partId) ??
    Array.from(session.parts.values()).find(
      (candidate) => candidate.type === 'tool' && candidate.tool?.toolCallId === payload.toolCallId,
    );

  if (phase === 'start' && !part) {
    // Direct tool start without a preceding part.start event.
    const synthetic = {
      id: payload.partId,
      index: (session.partOrder.get(message.id) ?? []).length,
      type: 'tool' as const,
        text: '',
        streaming: false,
      tool: {
        toolCallId: payload.toolCallId,
        name: payload.name,
        ...(payload.input !== undefined ? { input: payload.input } : {}),
        state: payload.state,
        ...(payload.startedAt !== undefined ? { startedAt: payload.startedAt } : {}),
      },
    };
    session.parts.set(synthetic.id, synthetic);
    const order = [...(session.partOrder.get(message.id) ?? [])];
    order.push(synthetic.id);
    session.partOrder.set(message.id, order);
    session.toolsByCallId.set(payload.toolCallId, message.id);
    return;
  }
  if (!part || part.type !== 'tool') return;
  const nextPart = { ...part };
  const previous = part.tool;
  nextPart.tool = {
    toolCallId: payload.toolCallId,
    name: payload.name,
    ...(payload.input !== undefined
      ? { input: payload.input }
      : previous?.input !== undefined
        ? { input: previous.input }
        : {}),
    ...(payload.output !== undefined
      ? { output: payload.output }
      : previous?.output !== undefined
        ? { output: previous.output }
        : {}),
    ...(payload.error !== undefined
      ? { error: payload.error }
      : previous?.error !== undefined
        ? { error: previous.error }
        : {}),
    ...(payload.metadata !== undefined
      ? { metadata: payload.metadata }
      : previous?.metadata !== undefined
        ? { metadata: previous.metadata }
        : {}),
    ...(payload.isError !== undefined
      ? { isError: payload.isError }
      : previous?.isError !== undefined
        ? { isError: previous.isError }
        : {}),
    state: payload.state,
    ...(payload.startedAt !== undefined
      ? { startedAt: payload.startedAt }
      : previous?.startedAt !== undefined
        ? { startedAt: previous.startedAt }
        : {}),
    ...(payload.endedAt !== undefined
      ? { endedAt: payload.endedAt }
      : previous?.endedAt !== undefined
        ? { endedAt: previous.endedAt }
        : {}),
  };
  if (phase === 'end') nextPart.streaming = false;
  session.parts.set(nextPart.id, nextPart);
};

const reduceInterrupted = (session: PiReducerSessionState, streaming: boolean): void => {
  session.lifecycle = 'interrupted';
  if (!streaming) return;
  for (const messageId of session.streamingMessages) {
    const message = session.messages.get(messageId);
    if (!message) continue;
    message.streaming = false;
    message.error = { code: 'SESSION_INTERRUPTED' };
  }
  session.streamingMessages.clear();
};

const reduceError = (session: PiReducerSessionState, code: string, message?: string): void => {
  session.lifecycle = 'error';
  for (const messageId of session.streamingMessages) {
    const entry = session.messages.get(messageId);
    if (!entry) continue;
    entry.streaming = false;
    entry.error = { code, ...(message ? { message } : {}) };
  }
  session.streamingMessages.clear();
};

// ---------------------------------------------------------------------------
// Public reducer
// ---------------------------------------------------------------------------

export interface ApplyEventResult {
  state: PiReducerState;
  /** True when the event was accepted (sequence advanced). */
  didApply: boolean;
  /** The session id the event applied to, when it applied. */
  sessionId?: PiSessionId;
}

/**
 * Apply a single event. Returns a new state plus a `didApply` flag.
 * `didApply` is `false` when the event was rejected for sequencing, so
 * callers must not mutate downstream views in that case.
 */
export const applyPiEvent = (
  state: PiReducerState,
  event: PiSessionEvent,
): ApplyEventResult => {
  const last = state.lastSequence.get(event.sessionId) ?? -1;
  if (event.sequence <= last) {
    return { state, didApply: false };
  }

  const current = state.bySession.get(event.sessionId);
  const session: PiReducerSessionState = current
    ? {
        ...current,
        lastSequence: event.sequence,
        ...(event.name === 'session.lifecycle' ? { lifecycle: event.payload.state } : {}),
        ...(event.name === 'session.queue' ? { queue: { ...event.payload } } : {}),
        ...(event.name === 'session.model' ? { model: event.payload.model } : {}),
        ...(event.name === 'session.thinking' ? { thinking: event.payload.thinking } : {}),
      }
    : {
        sessionId: event.sessionId,
        directory: event.directory,
        lastSequence: event.sequence,
        lifecycle: 'idle',
        messages: new Map(),
        partOrder: new Map(),
        parts: new Map(),
        toolsByCallId: new Map(),
        streamingMessages: new Set(),
        queue: { steering: 0, followUp: 0 },
      };

  switch (event.name) {
    case 'session.snapshot':
      // Snapshots are handled by the snapshot reducer; we only track the
      // sequence so the next deltas reject anything the snapshot covered.
      break;
    case 'session.lifecycle':
      reduceLifecycle(session, event.payload.state, event.payload.attempt);
      break;
    case 'assistant.message.start':
      session.messages = new Map(session.messages);
      session.streamingMessages = new Set(session.streamingMessages);
      reduceMessageStart(session, event.directory, event.payload);
      if (event.payload.role === 'assistant') session.streamingMessages.add(event.payload.messageId);
      break;
    case 'assistant.message.delta':
      session.parts = new Map(session.parts);
      if (event.payload.partId) {
        const part = session.parts.get(event.payload.partId);
        if (part) session.parts.set(event.payload.partId, { ...part });
      }
      reduceAssistantDelta(session, event.payload, 'text');
      break;
    case 'assistant.message.end':
      session.messages = new Map(session.messages);
      session.streamingMessages = new Set(session.streamingMessages);
      reduceMessageEnd(session, event.payload);
      break;
    case 'assistant.thinking.delta':
      session.parts = new Map(session.parts);
      if (event.payload.partId) {
        const part = session.parts.get(event.payload.partId);
        if (part) session.parts.set(event.payload.partId, { ...part });
      }
      reduceAssistantDelta(session, event.payload, 'thinking');
      break;
    case 'session.tool.start':
      session.parts = new Map(session.parts);
      session.partOrder = new Map(session.partOrder);
      session.toolsByCallId = new Map(session.toolsByCallId);
      reduceTool(session, 'start', event.payload);
      break;
    case 'session.tool.update':
      session.parts = new Map(session.parts);
      if (session.parts.has(event.payload.partId)) {
        const part = session.parts.get(event.payload.partId);
        if (part) session.parts.set(event.payload.partId, { ...part });
      }
      reduceTool(session, 'update', event.payload);
      break;
    case 'session.tool.end':
      session.parts = new Map(session.parts);
      if (session.parts.has(event.payload.partId)) {
        const part = session.parts.get(event.payload.partId);
        if (part) session.parts.set(event.payload.partId, { ...part });
      }
      reduceTool(session, 'end', event.payload);
      break;
    case 'session.queue':
      session.queue = {
        steering: event.payload.steering,
        followUp: event.payload.followUp,
      };
      break;
    case 'session.model':
      session.model = event.payload.model;
      break;
    case 'session.thinking':
      session.thinking = event.payload.thinking;
      break;
    case 'session.compaction':
      // Compaction does not change the reducer state directly; consumers
      // observe the event name through their own subscription.
      break;
    case 'session.error':
      session.messages = new Map(session.messages);
      session.streamingMessages = new Set(session.streamingMessages);
      for (const messageId of session.streamingMessages) {
        const message = session.messages.get(messageId);
        if (message) session.messages.set(messageId, { ...message });
      }
      reduceError(session, event.payload.code, event.payload.message);
      break;
    case 'session.interrupted':
      session.messages = new Map(session.messages);
      session.streamingMessages = new Set(session.streamingMessages);
      for (const messageId of session.streamingMessages) {
        const message = session.messages.get(messageId);
        if (message) session.messages.set(messageId, { ...message });
      }
      reduceInterrupted(session, event.payload.streaming);
      break;
    default: {
      // Exhaustiveness check: unknown event names are silently ignored
      // (they would have failed `isPiEvent` upstream anyway).
      const exhaustive: never = event;
      void exhaustive;
    }
  }

  const next: PiReducerState = {
    bySession: new Map(state.bySession),
    lastSequence: new Map(state.lastSequence),
  };
  next.bySession.set(event.sessionId, session);
  next.lastSequence.set(event.sessionId, event.sequence);
  return { state: next, didApply: true, sessionId: event.sessionId };
};

/**
 * Apply a list of events in order. Returns the final state, the total
 * number of applied events, and the number of skipped (out-of-order)
 * events.
 */
export const applyPiEvents = (
  state: PiReducerState,
  events: readonly PiSessionEvent[],
): { state: PiReducerState; applied: number; skipped: number } => {
  let applied = 0;
  let skipped = 0;
  let working = state;
  for (const event of events) {
    const result = applyPiEvent(working, event);
    working = result.state;
    if (result.didApply) applied += 1;
    else skipped += 1;
  }
  return { state: working, applied, skipped };
};

// ---------------------------------------------------------------------------
// Projections (read-only views for React subscribers)
// ---------------------------------------------------------------------------

export interface PiProjectedMessagePart {
  id: string;
  type: PiReducerMessagePart['type'];
  text: string;
  streaming: boolean;
  tool?: PiReducerMessagePart['tool'];
  attachment?: PiAttachment;
}

export interface PiProjectedMessage {
  id: string;
  role: 'user' | 'assistant';
  parentId?: string;
  text: string;
  thinking: string;
  streaming: boolean;
  createdAt: number;
  durationMs?: number;
  error?: { code: string; message?: string };
  model?: PiModelRef;
  thinkingLevel?: PiThinkingLevel;
  parts: PiProjectedMessagePart[];
}

export interface PiProjectedSession {
  sessionId: PiSessionId;
  directory: string;
  lifecycle: PiSessionLifecycleState;
  model?: PiModelRef;
  thinking?: PiThinkingLevel;
  queue: { steering: number; followUp: number };
  messages: PiProjectedMessage[];
}

/**
 * Build an immutable projection of a session. The returned object is a
 * new reference every time, so React selectors can rely on referential
 * equality. The projection does not include sequence bookkeeping so the
 * UI cannot accidentally leak it.
 */
export const projectSession = (session: PiReducerSessionState): PiProjectedSession => {
  const messages = Array.from(session.messages.values())
    .sort((a, b) => a.createdAt - b.createdAt)
    .map<PiProjectedMessage>((message) => {
      const order = session.partOrder.get(message.id) ?? [];
      const parts: PiProjectedMessagePart[] = order
        .map((partId) => session.parts.get(partId))
        .filter((part): part is PiReducerMessagePart => Boolean(part))
        .map<PiProjectedMessagePart>((part) => ({
          id: part.id,
          type: part.type,
          text: part.text,
          streaming: part.streaming,
          ...(part.tool ? { tool: part.tool } : {}),
          ...(part.attachment ? { attachment: part.attachment } : {}),
        }));
      return {
        id: message.id,
        role: message.role,
        ...(message.parentId ? { parentId: message.parentId } : {}),
        text: message.text,
        thinking: message.thinking,
        streaming: message.streaming,
        createdAt: message.createdAt,
        ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
        ...(message.error ? { error: message.error } : {}),
        ...(message.model ? { model: message.model } : {}),
        ...(message.thinkingLevel ? { thinkingLevel: message.thinkingLevel } : {}),
        parts,
      };
    });

  return {
    sessionId: session.sessionId,
    directory: session.directory,
    lifecycle: session.lifecycle,
    ...(session.model ? { model: session.model } : {}),
    ...(session.thinking ? { thinking: session.thinking } : {}),
    queue: { ...session.queue },
    messages,
  };
};

/**
 * Hydrate a session state from a `PiSessionDetailResponse`. The result is
 * ready to receive delta events with `fromSequence` strictly greater than
 * the last sequence returned by the response.
 */
export const hydrateSessionFromDetail = (
  detail: {
    session: { id: string; directory: string };
    lastSequence: number;
    messages: Array<{
      message: PiUserMessage | PiAssistantMessage;
      parts: Array<{
        id: string;
        index: number;
        type: 'text' | 'thinking' | 'tool' | 'attachment';
        text?: string;
        toolCallId?: string;
        name?: string;
        input?: unknown;
        output?: unknown;
        error?: string;
        metadata?: Record<string, unknown>;
        isError?: boolean;
        state?: 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
        startedAt?: number;
        endedAt?: number;
        attachment?: PiAttachment;
      }>;
    }>;
  },
): { state: PiReducerState; session: PiReducerSessionState } => {
  const state = createReducerState();
  const session = getOrCreateSession(state, detail.session.id, detail.session.directory);
  session.lastSequence = detail.lastSequence;

  for (const { message, parts } of detail.messages) {
    const reducerMessage: PiReducerMessage = {
      id: message.id,
      sessionId: detail.session.id,
      directory: detail.session.directory,
      role: message.role,
      ...(message.parentId ? { parentId: message.parentId } : {}),
      createdAt: message.createdAt,
      text: message.text ?? '',
      thinking: message.role === 'assistant' ? message.thinking ?? '' : '',
      streaming: false,
      ...(message.role === 'assistant' && message.durationMs !== undefined
        ? { durationMs: message.durationMs }
        : {}),
      ...(message.role === 'assistant' && message.error ? { error: message.error } : {}),
      ...(message.role === 'assistant' && message.model ? { model: message.model } : {}),
      ...(message.role === 'assistant' && message.thinkingLevel
        ? { thinkingLevel: message.thinkingLevel }
        : {}),
    };
    session.messages.set(message.id, reducerMessage);
    const partOrder: string[] = [];
    for (const part of parts) {
      const reducerPart: PiReducerMessagePart = {
        id: part.id,
        index: part.index,
        type: part.type,
        text: part.text ?? '',
        streaming: false,
        ...(part.type === 'tool'
          ? {
              tool: {
                toolCallId: part.toolCallId ?? part.id,
                name: part.name ?? 'unknown',
                ...(part.input !== undefined ? { input: part.input } : {}),
                ...(part.output !== undefined ? { output: part.output } : {}),
                ...(typeof part.error === 'string' ? { error: part.error } : {}),
                ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
                ...(part.isError !== undefined ? { isError: part.isError } : {}),
                state: part.state ?? 'completed',
                ...(part.startedAt !== undefined ? { startedAt: part.startedAt } : {}),
                ...(part.endedAt !== undefined ? { endedAt: part.endedAt } : {}),
              },
            }
          : {}),
        ...(part.type === 'attachment' && part.attachment ? { attachment: part.attachment } : {}),
      };
      session.parts.set(part.id, reducerPart);
      partOrder.push(part.id);
      if (part.type === 'tool' && part.toolCallId) {
        session.toolsByCallId.set(part.toolCallId, message.id);
      }
    }
    session.partOrder.set(message.id, partOrder);
  }

  state.lastSequence.set(detail.session.id, detail.lastSequence);
  return { state, session };
};
