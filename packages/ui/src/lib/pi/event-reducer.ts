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
 * - Stream assembly: text and thinking deltas are merged per part with
 *   `applyAssistantTextDelta`. A thinking part stops streaming as soon as
 *   a later text or tool part on the same message starts, so the thinking
 *   UI can collapse at handoff rather than waiting for `assistant.message.end`.
 *   `assistant.message.end` writes canonical text/thinking onto those parts
 *   so the chat does not keep a corrupted live assembly after the daemon
 *   publishes the finished message.
 * - Lifecycle: the `session.lifecycle` event flips the running state.
 *   `session.interrupted` flips the streaming flag back off without
 *   marking the message completed; that is the visible "interrupted" UI
 *   state the plan requires.
 *
 * The reducer is intentionally a plain function so it can be reused by
 * bootstrap, reconnect, and live-stream code paths without coupling to any
 * store implementation. The store wrapper lives in `packages/ui/src/sync/`.
 */

import { CowMap } from './cow-map';
import type {
  PiAssistantMessageDeltaPayload,
  PiAssistantThinkingDeltaPayload,
  PiMessageStartPayload,
  PiMessageEndPayload,
  PiSessionEvent,
  PiToolUpdatePayload,
} from './protocol';
import { applyAssistantTextDelta } from './text-delta';
import { resolveExistingSessionComposerSelection } from './thinking';
import type {
  PiAssistantMessage,
  PiAttachment,
  PiModelRef,
  PiSessionLifecycleState,
  PiSessionId,
  PiThinkingLevel,
  PiUsage,
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
  /** Assistant-only: Pi usage for the producing turn. */
  usage?: PiUsage;
}

export type PiReducerPartMap = CowMap<PiReducerMessagePart>;
export type PiReducerMutationKind = 'part' | 'structure';

export const createReducerPartMap = (
  entries?: Iterable<readonly [string, PiReducerMessagePart]>,
): PiReducerPartMap => (entries ? CowMap.from(entries) : CowMap.empty());

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
  parts: PiReducerPartMap;
  /** Pending tool calls (toolCallId → messageId) so an end event can find its parent. */
  toolsByCallId: Map<string, string>;
  /** Assistant messages whose `streaming` flag is still true. */
  streamingMessages: Set<string>;
  /** Queue depths at the time of the last `session.queue` event. */
  queue: { steering: number; followUp: number };
  /**
   * Last message a part-level or structural write touched. Live-tail freeze
   * uses this instead of walking every historical part on each token.
   */
  lastMutatedMessageId?: string;
  lastMutationKind?: PiReducerMutationKind;
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

const emptySessionParts = (): PiReducerPartMap => createReducerPartMap();

const markMutation = (
  session: PiReducerSessionState,
  messageId: string | undefined,
  kind: PiReducerMutationKind,
): void => {
  if (!messageId) return;
  session.lastMutatedMessageId = messageId;
  session.lastMutationKind = kind;
};

const forkPartsForWrite = (session: PiReducerSessionState): void => {
  session.parts = session.parts.fork();
};

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
    parts: emptySessionParts(),
    toolsByCallId: new Map(),
    streamingMessages: new Set(),
    queue: { steering: 0, followUp: 0 },
  };
  state.bySession.set(sessionId, fresh);
  return fresh;
};

const isSyntheticUserMessageId = (messageId: string, sessionId: string): boolean => (
  messageId.startsWith(`user-${sessionId}-`)
);

const USER_MESSAGE_RECONCILE_WINDOW_MS = 250;

type OrderedMessagesCache = {
  size: number;
  list: PiReducerMessage[];
};

const orderedMessagesByMap = new WeakMap<Map<string, PiReducerMessage>, OrderedMessagesCache>();
const projectedPartsByReducerPart = new WeakMap<PiReducerMessagePart, PiProjectedMessagePart>();

const uniqueSessionMessages = (session: PiReducerSessionState): PiReducerMessage[] => {
  // Membership changes clone `session.messages` first, so this WeakMap
  // misses. Part-only live-tail updates keep the same Map and reuse the list.
  const cached = orderedMessagesByMap.get(session.messages);
  if (cached && cached.size === session.messages.size) return cached.list;

  const seen = new Set<string>();
  const messages: PiReducerMessage[] = [];
  for (const message of session.messages.values()) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    messages.push(message);
  }
  for (let index = 1; index < messages.length; index += 1) {
    const previous = messages[index - 1];
    const current = messages[index];
    if (!previous || !current || current.createdAt >= previous.createdAt) continue;
    messages.sort((left, right) => left.createdAt - right.createdAt);
    break;
  }
  orderedMessagesByMap.set(session.messages, { size: session.messages.size, list: messages });
  return messages;
};

const findReusablePersistedUser = (
  session: PiReducerSessionState,
  text: string,
  createdAt: number,
): PiReducerMessage | undefined => {
  if (!text) return undefined;
  let closest: PiReducerMessage | undefined;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of uniqueSessionMessages(session)) {
    if (
      candidate.role !== 'user'
      || candidate.text !== text
      || isSyntheticUserMessageId(candidate.id, session.sessionId)
    ) {
      continue;
    }
    const distance = Math.abs(candidate.createdAt - createdAt);
    if (distance <= USER_MESSAGE_RECONCILE_WINDOW_MS && distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }
  return closest;
};

export const aliasSyntheticUserIfPersisted = (
  session: PiReducerSessionState,
  key: string,
  message: PiReducerMessage,
): void => {
  if (
    message.role === 'user'
    && isSyntheticUserMessageId(key, session.sessionId)
  ) {
    const persisted = findReusablePersistedUser(session, message.text, message.createdAt);
    if (persisted) {
      session.messages.set(key, persisted);
      return;
    }
  }
  session.messages.set(key, message);
};

const resolveParentId = (session: PiReducerSessionState, parentId?: string): string | undefined => {
  if (!parentId) return undefined;
  return session.messages.get(parentId)?.id ?? parentId;
};

const ensureMessage = (
  session: PiReducerSessionState,
  payload: PiMessageStartPayload,
  directory: string,
): PiReducerMessage => {
  const existing = session.messages.get(payload.messageId);
  if (existing) return existing;
  if (
    payload.role === 'user'
    && isSyntheticUserMessageId(payload.messageId, session.sessionId)
  ) {
    const persisted = findReusablePersistedUser(session, payload.text ?? '', payload.startedAt);
    if (persisted) {
      session.messages.set(payload.messageId, persisted);
      return persisted;
    }
  }
  const parentId = resolveParentId(session, payload.parentId);
  const message: PiReducerMessage = {
    id: payload.messageId,
    sessionId: session.sessionId,
    directory,
    role: payload.role,
    ...(parentId ? { parentId } : {}),
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

const finalizeAssembledParts = (
  session: PiReducerSessionState,
  messageId: string,
  type: 'text' | 'thinking',
  canonical: string,
): void => {
  const order = session.partOrder.get(messageId) ?? [];
  const parts = order
    .map((partId) => session.parts.get(partId))
    .filter((part): part is PiReducerMessagePart => part?.type === type);
  if (parts.length === 0) {
    if (!canonical) return;
    const message = session.messages.get(messageId);
    if (!message) return;
    const part = ensureTextPart(session, message, type);
    session.parts.set(part.id, { ...part, text: canonical, streaming: false });
    return;
  }
  const [primary, ...extras] = parts;
  if (!primary) return;
  session.parts.set(primary.id, { ...primary, text: canonical, streaming: false });
  for (const extra of extras) {
    session.parts.set(extra.id, { ...extra, text: '', streaming: false });
  }
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
  if (state === 'busy' || state === 'retry') return;
  session.streamingMessages = new Set();
  session.messages = new Map(session.messages);
  for (const [messageId, message] of session.messages) {
    if (message.streaming) session.messages.set(messageId, { ...message, streaming: false });
  }
};

const reduceMessageStart = (
  session: PiReducerSessionState,
  directory: string,
  payload: PiMessageStartPayload,
): void => {
  ensureMessage(session, payload, directory);
};

const resolveAssistantMessage = (
  session: PiReducerSessionState,
  messageId: string,
): PiReducerMessage | undefined => {
  const direct = session.messages.get(messageId);
  if (direct && direct.role === 'assistant') return direct;
  const messages = uniqueSessionMessages(session);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate.role === 'assistant' && (candidate.streaming || candidate.durationMs === undefined)) {
      session.messages.set(messageId, candidate);
      if (!session.partOrder.has(messageId) && session.partOrder.has(candidate.id)) {
        session.partOrder.set(messageId, session.partOrder.get(candidate.id)!);
      }
      return candidate;
    }
  }
  const trailing = messages[messages.length - 1];
  if (trailing && trailing.role === 'assistant') {
    session.messages.set(messageId, trailing);
    if (!session.partOrder.has(messageId) && session.partOrder.has(trailing.id)) {
      session.partOrder.set(messageId, session.partOrder.get(trailing.id)!);
    }
    return trailing;
  }
  return undefined;
};

const settleStreamingParts = (
  session: PiReducerSessionState,
  messageId: string,
  match: (part: PiReducerMessagePart) => boolean,
): void => {
  const order = new Set(session.partOrder.get(messageId) ?? []);
  if (order.size === 0) return;
  for (const [id, part] of session.parts) {
    if (!part.streaming || !match(part)) continue;
    if (!order.has(part.id) && !order.has(id)) continue;
    session.parts.set(id, { ...part, streaming: false });
  }
};

const settleThinkingParts = (session: PiReducerSessionState, messageId: string): void => {
  settleStreamingParts(session, messageId, (part) => part.type === 'thinking');
};

const reduceAssistantDelta = (
  session: PiReducerSessionState,
  payload: PiAssistantMessageDeltaPayload | PiAssistantThinkingDeltaPayload,
  type: 'text' | 'thinking',
): void => {
  const message = resolveAssistantMessage(session, payload.messageId);
  if (!message) return;
  message.streaming = true;
  session.streamingMessages.add(message.id);
  session.streamingMessages.add(payload.messageId);
  if (type === 'text') {
    settleThinkingParts(session, message.id);
  }
  const partId = payload.partId ?? `${message.id}:${type}`;
  let existing = session.parts.get(partId);
  if (!existing) {
    const contentIndex = (payload as { contentIndex?: number }).contentIndex;
    if (typeof contentIndex === 'number') {
      const candidateIds = [
        `${message.id}:${type}:${contentIndex}`,
        `${message.id}:${contentIndex}`,
        `${message.id}:${type}`,
      ];
      for (const candidateId of candidateIds) {
        const candidate = session.parts.get(candidateId);
        if (candidate && candidate.type === type) {
          existing = candidate;
          break;
        }
      }
      if (!existing) {
        const order = session.partOrder.get(message.id) ?? [];
        for (const id of order) {
          const candidate = session.parts.get(id);
          if (candidate && candidate.type === type && candidate.index === contentIndex) {
            existing = candidate;
            break;
          }
        }
      }
    }
  }
  if (existing) {
    if (existing.type !== type) return;
    const updated = {
      ...existing,
      text: applyAssistantTextDelta(existing.text, payload.delta),
      streaming: true,
    };
    session.parts.set(existing.id, updated);
    if (partId !== existing.id) {
      session.parts.set(partId, updated);
    }
    return;
  }
  const part = ensureTextPart(session, message, type, partId);
  session.parts.set(part.id, { ...part, text: payload.delta, streaming: true });
};

const reduceMessageEnd = (
  session: PiReducerSessionState,
  payload: PiMessageEndPayload,
): void => {
  const message = resolveAssistantMessage(session, payload.messageId);
  if (!message) return;
  const { text, thinking } = assembleMessageText(session, message.id);
  message.text = typeof payload.text === 'string' ? payload.text : text;
  message.thinking = typeof payload.thinking === 'string' ? payload.thinking : thinking;
  finalizeAssembledParts(session, message.id, 'text', message.text);
  finalizeAssembledParts(session, message.id, 'thinking', message.thinking);
  message.streaming = false;
  if (typeof payload.durationMs === 'number') {
    message.durationMs = payload.durationMs;
  } else if (typeof message.createdAt === 'number' && message.createdAt > 0) {
    message.durationMs = Math.max(100, Date.now() - message.createdAt);
  }
  if (payload.thinkingLevel) message.thinkingLevel = payload.thinkingLevel;
  if (payload.error) message.error = payload.error;
  if (payload.usage) message.usage = payload.usage;
  session.streamingMessages.delete(message.id);
  session.streamingMessages.delete(payload.messageId);
};

const reduceTool = (
  session: PiReducerSessionState,
  phase: 'start' | 'update' | 'end',
  payload: PiToolUpdatePayload,
): void => {
  // Look up the existing part by toolCallId when the start event already
  // produced it.
  const rawMessageId = session.toolsByCallId.get(payload.toolCallId) ?? payload.messageId;
  const message = resolveAssistantMessage(session, rawMessageId);
  if (!message) return;
  settleThinkingParts(session, message.id);
  if (phase !== 'end') {
    message.streaming = true;
    session.streamingMessages.add(message.id);
  }
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
  const now = Date.now();
  session.parts = session.parts.fork();
  session.partOrder = new Map(session.partOrder);
  for (const messageId of session.streamingMessages) {
    const entry = session.messages.get(messageId);
    if (!entry) continue;
    entry.streaming = false;
    entry.error = { code, ...(message ? { message } : {}) };
    if (entry.durationMs === undefined && entry.createdAt > 0) {
      entry.durationMs = Math.max(100, now - entry.createdAt);
    }
    for (const partId of session.partOrder.get(messageId) ?? []) {
      const part = session.parts.get(partId);
      if (!part) continue;
      const toolRunning = part.tool?.state === 'running' || part.tool?.state === 'pending';
      if (!part.streaming && !toolRunning) continue;
      const next = { ...part, streaming: false };
      if (toolRunning && next.tool) {
        next.tool = {
          ...next.tool,
          state: 'error',
          ...(message ? { error: message } : {}),
          endedAt: next.tool.endedAt ?? now,
        };
      }
      session.parts.set(partId, next);
    }
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
        parts: emptySessionParts(),
        toolsByCallId: new Map(),
        streamingMessages: new Set(),
        queue: { steering: 0, followUp: 0 },
      };

  switch (event.name) {
    case 'session.snapshot':
      if (event.payload?.snapshot) {
        session.lifecycle = event.payload.snapshot.lifecycle ?? (event.payload.snapshot.isStreaming ? 'busy' : 'idle');
        if (event.payload.snapshot.model) session.model = event.payload.snapshot.model;
        if (event.payload.snapshot.thinking) session.thinking = event.payload.snapshot.thinking;
        if (event.payload.snapshot.queue) session.queue = { ...event.payload.snapshot.queue };
        markHydratedLiveActivity(session, {
          isStreaming: event.payload.snapshot.isStreaming,
          lifecycle: session.lifecycle,
          settleWhenIdle: true,
        });
      }
      break;
    case 'session.lifecycle':
      reduceLifecycle(session, event.payload.state, event.payload.attempt);
      break;
    case 'assistant.message.start':
      // A message start is live turn evidence even when the lifecycle frame
      // was missed or has not arrived yet. This also protects that event from
      // a same-cursor history restore whose transcript projection lagged it.
      session.lifecycle = 'busy';
      session.messages = new Map(session.messages);
      session.streamingMessages = new Set(session.streamingMessages);
      reduceMessageStart(session, event.directory, event.payload);
      if (event.payload.role === 'assistant') session.streamingMessages.add(event.payload.messageId);
      markMutation(session, event.payload.messageId, 'structure');
      break;
    case 'assistant.message.delta':
      forkPartsForWrite(session);
      reduceAssistantDelta(session, event.payload, 'text');
      markMutation(session, event.payload.messageId, 'part');
      break;
    case 'assistant.message.end':
      session.messages = new Map(session.messages);
      forkPartsForWrite(session);
      session.partOrder = new Map(session.partOrder);
      session.streamingMessages = new Set(session.streamingMessages);
      reduceMessageEnd(session, event.payload);
      markMutation(session, event.payload.messageId, 'structure');
      break;
    case 'assistant.thinking.delta':
      forkPartsForWrite(session);
      reduceAssistantDelta(session, event.payload, 'thinking');
      markMutation(session, event.payload.messageId, 'part');
      break;
    case 'session.tool.start':
      forkPartsForWrite(session);
      session.partOrder = new Map(session.partOrder);
      session.toolsByCallId = new Map(session.toolsByCallId);
      reduceTool(session, 'start', event.payload);
      markMutation(session, event.payload.messageId, 'part');
      break;
    case 'session.tool.update':
      forkPartsForWrite(session);
      reduceTool(session, 'update', event.payload);
      markMutation(session, event.payload.messageId, 'part');
      break;
    case 'session.tool.end':
      forkPartsForWrite(session);
      reduceTool(session, 'end', event.payload);
      markMutation(session, event.payload.messageId, 'part');
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
    case 'session.updated':
      // Title/metadata lives in the live catalog, not the transcript reducer.
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
  usage?: PiUsage;
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

export interface ProjectSessionPrevious {
  session: PiReducerSessionState;
  projection: PiProjectedSession;
}

const projectReducerPart = (part: PiReducerMessagePart): PiProjectedMessagePart => {
  const cached = projectedPartsByReducerPart.get(part);
  if (cached) return cached;
  const projected: PiProjectedMessagePart = {
    id: part.id,
    type: part.type,
    text: part.text,
    streaming: part.streaming,
    ...(part.tool ? { tool: part.tool } : {}),
    ...(part.attachment ? { attachment: part.attachment } : {}),
  };
  projectedPartsByReducerPart.set(part, projected);
  return projected;
};

const recoveredErrorIdsFor = (session: PiReducerSessionState, sourceMessages: PiReducerMessage[]): Set<string> => {
  const recoveredParents = new Set<string>();
  const recoveredErrorIds = new Set<string>();
  for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
    const message = sourceMessages[index];
    if (!message || message.role !== 'assistant') continue;
    const parentId = resolveParentId(session, message.parentId);
    if (!parentId) continue;
    const hasVisibleContent = Boolean(
      message.text
      || message.thinking
      || (session.partOrder.get(message.id)?.length ?? 0) > 0,
    );
    if (message.error && !hasVisibleContent && recoveredParents.has(parentId)) {
      recoveredErrorIds.add(message.id);
      continue;
    }
    if (!message.error) recoveredParents.add(parentId);
  }
  return recoveredErrorIds;
};

const canReuseProjectedMessage = (
  session: PiReducerSessionState,
  message: PiReducerMessage,
  previous: PiProjectedMessage,
  parts: PiProjectedMessagePart[],
): boolean => (
  previous.id === message.id
  && previous.role === message.role
  && previous.parentId === resolveParentId(session, message.parentId)
  && previous.text === message.text
  && previous.thinking === message.thinking
  && previous.streaming === message.streaming
  && previous.createdAt === message.createdAt
  && previous.durationMs === message.durationMs
  && previous.error === message.error
  && previous.model === message.model
  && previous.thinkingLevel === message.thinkingLevel
  && previous.usage === message.usage
  && previous.parts.length === parts.length
  && previous.parts.every((part, index) => part === parts[index])
);

const projectReducerMessage = (
  session: PiReducerSessionState,
  message: PiReducerMessage,
  previousProjected?: PiProjectedMessage,
): PiProjectedMessage => {
  const order = session.partOrder.get(message.id) ?? [];
  const parts: PiProjectedMessagePart[] = [];
  for (const partId of order) {
    const part = session.parts.get(partId);
    if (part) parts.push(projectReducerPart(part));
  }
  if (previousProjected && canReuseProjectedMessage(session, message, previousProjected, parts)) {
    return previousProjected;
  }
  const parentId = resolveParentId(session, message.parentId);
  return {
    id: message.id,
    role: message.role,
    ...(parentId ? { parentId } : {}),
    text: message.text,
    thinking: message.thinking,
    streaming: message.streaming,
    createdAt: message.createdAt,
    ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
    ...(message.error ? { error: message.error } : {}),
    ...(message.model ? { model: message.model } : {}),
    ...(message.thinkingLevel ? { thinkingLevel: message.thinkingLevel } : {}),
    ...(message.usage ? { usage: message.usage } : {}),
    parts,
  };
};

/**
 * Build an immutable projection of a session. Pass the previous projection
 * so unchanged historical messages and parts keep their object identity.
 * The projection does not include sequence bookkeeping so the UI cannot
 * accidentally leak it.
 */
export const projectSession = (
  session: PiReducerSessionState,
  previous?: ProjectSessionPrevious | null,
): PiProjectedSession => {
  const sourceMessages = uniqueSessionMessages(session);
  const recoveredErrorIds = recoveredErrorIdsFor(session, sourceMessages);
  const previousById = previous
    ? new Map(previous.projection.messages.map((message) => [message.id, message]))
    : null;

  const messages: PiProjectedMessage[] = [];
  for (const message of sourceMessages) {
    if (recoveredErrorIds.has(message.id)) continue;
    messages.push(projectReducerMessage(session, message, previousById?.get(message.id)));
  }

  if (
    previous
    && previous.projection.sessionId === session.sessionId
    && previous.projection.directory === session.directory
    && previous.projection.lifecycle === session.lifecycle
    && previous.projection.model === session.model
    && previous.projection.thinking === session.thinking
    && previous.projection.queue.steering === session.queue.steering
    && previous.projection.queue.followUp === session.queue.followUp
    && previous.projection.messages.length === messages.length
    && previous.projection.messages.every((message, index) => message === messages[index])
  ) {
    return previous.projection;
  }

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

const markHydratedLiveActivity = (
  session: PiReducerSessionState,
  options?: {
    isStreaming?: boolean;
    lifecycle?: PiSessionLifecycleState;
    inferFromRunningTools?: boolean;
    settleWhenIdle?: boolean;
  },
): void => {
  const runningMessageIds: string[] = [];
  const runningPartIds: string[] = [];
  for (const [partId, part] of session.parts) {
    const toolState = part.tool?.state;
    if (part.type !== 'tool' || (toolState !== 'running' && toolState !== 'pending')) continue;
    runningPartIds.push(partId);
    const messageId = part.tool?.toolCallId ? session.toolsByCallId.get(part.tool.toolCallId) : undefined;
    if (messageId) runningMessageIds.push(messageId);
  }

  const live = options?.isStreaming === true
    || options?.lifecycle === 'busy'
    || options?.lifecycle === 'retry'
    || (options?.inferFromRunningTools === true && runningMessageIds.length > 0);
  if (!live) {
    if (options?.settleWhenIdle) {
      session.streamingMessages = new Set();
      session.messages = new Map(session.messages);
      for (const [messageId, message] of session.messages) {
        if (message.streaming) session.messages.set(messageId, { ...message, streaming: false });
      }
    }
    return;
  }

  session.lifecycle = options?.lifecycle === 'retry' ? 'retry' : 'busy';
  session.streamingMessages = new Set(session.streamingMessages);
  for (const partId of runningPartIds) {
    const part = session.parts.get(partId);
    if (part) session.parts.set(partId, { ...part, streaming: true });
  }
  let targetId = runningMessageIds[runningMessageIds.length - 1];
  if (!targetId) {
    const messages = uniqueSessionMessages(session);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (candidate?.role === 'assistant') {
        targetId = candidate.id;
        break;
      }
    }
  }
  if (!targetId) return;
  const message = session.messages.get(targetId);
  if (!message || message.role !== 'assistant') return;
  session.messages.set(targetId, { ...message, streaming: true });
  session.streamingMessages.add(targetId);
};

/**
 * Hydrate a session state from a `PiSessionDetailResponse`. The result is
 * ready to receive delta events with `fromSequence` strictly greater than
 * the last sequence returned by the response.
 */
export const hydrateSessionFromDetail = (
  detail: {
    session: {
      id: string;
      directory: string;
      model?: PiModelRef;
      thinking?: PiThinkingLevel;
    };
    lastSequence: number;
    isStreaming?: boolean;
    lifecycle?: PiSessionLifecycleState;
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
      ...(message.role === 'assistant' && message.usage ? { usage: message.usage } : {}),
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

  const resolved = resolveExistingSessionComposerSelection({
    model: detail.session.model,
    thinking: detail.session.thinking,
    messages: session.messages.values(),
  });
  if (resolved.model) session.model = resolved.model;
  if (resolved.thinking) session.thinking = resolved.thinking;
  markHydratedLiveActivity(session, {
    ...(detail.isStreaming !== undefined ? { isStreaming: detail.isStreaming } : {}),
    ...(detail.lifecycle ? { lifecycle: detail.lifecycle } : {}),
    inferFromRunningTools: true,
  });

  state.lastSequence.set(detail.session.id, detail.lastSequence);
  return { state, session };
};
