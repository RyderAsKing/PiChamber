import type {
  PiMessageStartPayload,
} from '../protocol';
import type {
  PiReducerMessage,
  PiReducerMessagePart,
  PiReducerMutationKind,
  PiReducerPartMap,
  PiReducerSessionState,
  PiReducerState,
} from './reducerTypes';
import { createReducerPartMap } from './reducerTypes';
import type { PiSessionId } from '../types';

export const emptySessionParts = (): PiReducerPartMap => createReducerPartMap();

/** Upper bound for bounded extension feeds; oldest entries drop first. */
export const MAX_EXTENSION_FEED_ITEMS = 10;

let extensionFeedCounter = 0;
export const nextExtensionFeedId = (): string => `ext-${Date.now().toString(36)}-${(extensionFeedCounter += 1)}`;

export const appendBoundedFeed = <T>(feed: T[], item: T): T[] => {
  const next = [...feed, item];
  return next.length > MAX_EXTENSION_FEED_ITEMS ? next.slice(next.length - MAX_EXTENSION_FEED_ITEMS) : next;
};

export const markMutation = (
  session: PiReducerSessionState,
  messageId: string | undefined,
  kind: PiReducerMutationKind,
): void => {
  if (!messageId) return;
  session.lastMutatedMessageId = session.messages.get(messageId)?.id ?? messageId;
  session.lastMutationKind = kind;
};

export const forkPartsForWrite = (session: PiReducerSessionState): void => {
  session.parts = session.parts.fork();
};

export const getOrCreateSession = (
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
    extensionStatuses: new Map(),
    extensionWidgets: new Map(),
    extensionDialogs: [],
    extensionNotices: [],
    extensionErrors: [],
    extensionPanels: new Map(),
    extensionApps: new Map(),
  };
  state.bySession.set(sessionId, fresh);
  return fresh;
};

export const isSyntheticUserMessageId = (messageId: string, sessionId: string): boolean => (
  messageId.startsWith(`user-${sessionId}-`)
);

export const USER_MESSAGE_RECONCILE_WINDOW_MS = 250;

type OrderedMessagesCache = {
  size: number;
  list: PiReducerMessage[];
};

export const orderedMessagesByMap = new WeakMap<Map<string, PiReducerMessage>, OrderedMessagesCache>();

export const uniqueSessionMessages = (session: PiReducerSessionState): PiReducerMessage[] => {
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

export const findReusablePersistedUser = (
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

export const resolveParentId = (session: PiReducerSessionState, parentId?: string): string | undefined => {
  if (!parentId) return undefined;
  const direct = session.messages.get(parentId)?.id;
  if (direct) return direct;
  if (isSyntheticUserMessageId(parentId, session.sessionId)) {
    const messages = uniqueSessionMessages(session);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (candidate?.role === 'user') return candidate.id;
    }
  }
  return parentId;
};

export const ensureMessage = (
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
  if (payload.role === 'user' && payload.files?.length) {
    const order: string[] = [];
    for (const file of payload.files) {
      const part: PiReducerMessagePart = {
        id: file.id,
        index: file.index,
        type: 'file',
        text: '',
        streaming: false,
        file: {
          ...(file.mime ? { mime: file.mime } : {}),
          ...(file.filename ? { filename: file.filename } : {}),
          ...(file.url ? { url: file.url } : {}),
        },
      };
      session.parts.set(part.id, part);
      order.push(part.id);
    }
    session.partOrder.set(message.id, order);
  }
  return message;
};

export const ensureTextPart = (
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

export const assembleMessageText = (session: PiReducerSessionState, messageId: string): {
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

export const finalizeAssembledParts = (
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

export const resolveAssistantMessage = (
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

export const settleStreamingParts = (
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

export const settleThinkingParts = (session: PiReducerSessionState, messageId: string): void => {
  settleStreamingParts(session, messageId, (part) => part.type === 'thinking');
};
