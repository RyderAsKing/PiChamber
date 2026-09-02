import type {
  PiAssistantMessageDeltaPayload,
  PiAssistantThinkingDeltaPayload,
  PiMessageEndPayload,
  PiMessageStartPayload,
  PiToolUpdatePayload,
} from '../protocol';
import { applyAssistantTextDelta } from '../text-delta';
import type { PiRetryInfo, PiSessionLifecycleState } from '../types';
import type { PiReducerSessionState } from './reducerTypes';
import {
  assembleMessageText,
  ensureMessage,
  ensureTextPart,
  finalizeAssembledParts,
  resolveAssistantMessage,
  settleThinkingParts,
} from './reducerHelpers';

export const reduceLifecycle = (
  session: PiReducerSessionState,
  payload: { state: PiSessionLifecycleState } & PiRetryInfo,
): void => {
  if (payload.state === 'retry') {
    session.lifecycle = 'retry';
    session.retry = {
      ...(payload.attempt !== undefined ? { attempt: payload.attempt } : {}),
      ...(payload.next !== undefined ? { next: payload.next } : {}),
      ...(payload.message !== undefined ? { message: payload.message } : {}),
    };
    return;
  }
  if (payload.state === 'busy' && session.retry) {
    session.lifecycle = 'retry';
    return;
  }
  session.lifecycle = payload.state;
  session.retry = undefined;
  if (payload.state === 'busy') return;
  session.streamingMessages = new Set();
  session.messages = new Map(session.messages);
  for (const [messageId, message] of session.messages) {
    if (message.streaming) session.messages.set(messageId, { ...message, streaming: false });
  }
};

export const reduceMessageStart = (
  session: PiReducerSessionState,
  directory: string,
  payload: PiMessageStartPayload,
): void => {
  ensureMessage(session, payload, directory);
};

export const reduceAssistantDelta = (
  session: PiReducerSessionState,
  payload: PiAssistantMessageDeltaPayload | PiAssistantThinkingDeltaPayload,
  type: 'text' | 'thinking',
): boolean => {
  const message = resolveAssistantMessage(session, payload.messageId);
  if (!message) return false;
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
    if (existing.type !== type) return false;
    const updated = {
      ...existing,
      text: applyAssistantTextDelta(existing.text, payload.delta),
      streaming: true,
    };
    session.parts.set(existing.id, updated);
    if (partId !== existing.id) {
      session.parts.set(partId, updated);
    }
    return true;
  }
  const part = ensureTextPart(session, message, type, partId);
  session.parts.set(part.id, { ...part, text: payload.delta, streaming: true });
  return true;
};

export const reduceMessageEnd = (
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
  if (payload.continuing !== true && !payload.error) {
    session.streamingMessages.delete(message.id);
    session.streamingMessages.delete(payload.messageId);
  }
};

export const reduceTool = (
  session: PiReducerSessionState,
  phase: 'start' | 'update' | 'end',
  payload: PiToolUpdatePayload,
): boolean => {
  const rawMessageId = session.toolsByCallId.get(payload.toolCallId) ?? payload.messageId;
  const message = resolveAssistantMessage(session, rawMessageId);
  if (!message) return false;
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
    return true;
  }
  if (!part || part.type !== 'tool') return false;
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
  return true;
};

export const reduceInterrupted = (session: PiReducerSessionState, streaming: boolean): void => {
  session.lifecycle = 'interrupted';
  session.retry = undefined;
  if (!streaming) return;
  for (const messageId of session.streamingMessages) {
    const message = session.messages.get(messageId);
    if (!message) continue;
    message.streaming = false;
    message.error = { code: 'SESSION_INTERRUPTED' };
  }
  session.streamingMessages.clear();
};

export const reduceError = (session: PiReducerSessionState, code: string, message?: string): void => {
  session.lifecycle = 'error';
  session.retry = undefined;
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
