import type { Session, Message, Part, SessionMessageRecord } from '@/lib/chat/types';
import type { PiProjectedMessage, PiProjectedMessagePart, PiProjectedSession } from '@/lib/pi/event-reducer';
import type { PiSession } from '@/lib/pi/types';
import type { PiSessionListItem } from '@/lib/pi/protocol';

export const SETTLED_TOOL_RECORD_BUDGET_CHARS = 2048;

const recordsByProjectedMessage = new WeakMap<PiProjectedMessage, SessionMessageRecord>();

const isRunningToolState = (state: string | undefined): boolean => (
  state === 'running' || state === 'pending'
);

const measureUnknown = (value: unknown): number => {
  if (value == null) return 0;
  if (typeof value === 'string') return value.length;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return SETTLED_TOOL_RECORD_BUDGET_CHARS + 1;
  }
};

const stubSettledToolMetadata = (
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!metadata) return metadata;
  const heavy = metadata.patch ?? metadata.diff ?? (metadata.filediff as { patch?: unknown; diff?: unknown } | undefined)?.patch
    ?? (metadata.filediff as { patch?: unknown; diff?: unknown } | undefined)?.diff;
  if (measureUnknown(heavy) <= SETTLED_TOOL_RECORD_BUDGET_CHARS) return metadata;
  const next = { ...metadata };
  delete next.patch;
  delete next.diff;
  if (next.filediff && typeof next.filediff === 'object') {
    const rest = { ...(next.filediff as Record<string, unknown>) };
    delete rest.patch;
    delete rest.diff;
    next.filediff = rest;
  }
  next.deferredBody = true;
  return next;
};

export const mapPart = (
  part: PiProjectedMessagePart,
  options?: { full?: boolean },
): Part => {
  if (part.type === 'thinking') {
    return { id: part.id, type: 'reasoning', text: part.text, streaming: part.streaming };
  }
  if (part.type === 'attachment') {
    return {
      id: part.id,
      type: 'file',
      filename: part.attachment?.name,
      mime: part.attachment?.mime,
    };
  }
  if (part.type === 'tool') {
    const running = isRunningToolState(part.tool?.state);
    const keepFull = options?.full === true || running;
    const outputOverBudget = !keepFull && measureUnknown(part.tool?.output) > SETTLED_TOOL_RECORD_BUDGET_CHARS;
    const metadata = keepFull ? part.tool?.metadata : stubSettledToolMetadata(part.tool?.metadata);
    const deferredBody = Boolean(!keepFull && (outputOverBudget || metadata?.deferredBody));
    return {
      id: part.id,
      type: 'tool',
      tool: part.tool?.name,
      callID: part.tool?.toolCallId,
      state: {
        status: part.tool?.state === 'running' || part.tool?.state === 'pending' ? 'running'
          : part.tool?.state === 'error' ? 'error'
            : part.tool?.state === 'cancelled' ? 'cancelled'
              : 'completed',
        input: part.tool?.input,
        ...(outputOverBudget ? {} : { output: part.tool?.output }),
        error: part.tool?.error,
        time: { start: part.tool?.startedAt, end: part.tool?.endedAt },
        metadata,
        ...(deferredBody ? { deferredBody: true } : {}),
      },
    };
  }
  return { id: part.id, type: 'text', text: part.text };
};

export const piSessionToUiSession = (session: PiSession): Session => ({
  id: session.id,
  directory: session.directory,
  parentID: session.parentId ?? null,
  title: session.title,
  time: {
    created: session.createdAt,
    updated: session.updatedAt,
    ...(session.archived ? { archived: session.timeArchived ?? session.updatedAt } : {}),
  },
});

export const piListItemToUiSession = (item: PiSessionListItem): Session => piSessionToUiSession(item.session);

export const piMessageToRecord = (message: PiProjectedMessage, sessionId: string): SessionMessageRecord => {
  const parts: Part[] = [];
  if (message.parts.length > 0) {
    const hasThinking = message.parts.some((p) => p.type === 'thinking');
    const hasText = message.parts.some((p) => p.type === 'text');
    if (!hasThinking && message.thinking) {
      parts.push({ id: `${message.id}:thinking`, type: 'reasoning', text: message.thinking, streaming: false });
    }
    parts.push(...message.parts.map((part) => mapPart(part)));
    if (!hasText && message.text) {
      parts.push({ id: `${message.id}:text`, type: 'text', text: message.text });
    }
  } else {
    if (message.thinking) {
      parts.push({ id: `${message.id}:thinking`, type: 'reasoning', text: message.thinking, streaming: false });
    }
    if (message.text) {
      parts.push({ id: `${message.id}:text`, type: 'text', text: message.text });
    }
  }
  const isCompletedAssistant = message.role === 'assistant' && !message.streaming;
  const finish = isCompletedAssistant ? (message.error ? 'error' : 'stop') : undefined;
  const info: Message = {
    id: message.id,
    sessionID: sessionId,
    role: message.role,
    ...(message.role === 'extension'
      ? { customType: message.customType, data: message.data, details: message.details, ...(message.text ? { text: message.text } : {}) }
      : {}),
    ...(message.parentId ? { parentID: message.parentId } : {}),
    time: {
      created: message.createdAt,
      ...(message.streaming
        ? {}
        : typeof message.durationMs === 'number' && message.durationMs > 0
          ? { completed: message.createdAt + message.durationMs }
          : { completed: message.createdAt }),
    },
    ...(message.durationMs !== undefined ? { durationMs: message.durationMs } : {}),
    ...(message.error ? { error: { name: message.error.code, message: message.error.message } } : {}),
    ...(message.model ? {
      model: { providerID: message.model.providerId, modelID: message.model.modelId },
      providerID: message.model.providerId,
      modelID: message.model.modelId,
    } : {}),
    ...(message.thinkingLevel ? { variant: message.thinkingLevel } : {}),
    ...(message.role === 'assistant' && message.usage
      ? {
          usage: {
            input: message.usage.input,
            output: message.usage.output,
            cacheRead: message.usage.cacheRead,
            cacheWrite: message.usage.cacheWrite,
            totalTokens: message.usage.totalTokens,
            cost: message.usage.cost,
          },
          cost: message.usage.cost.total,
        }
      : {}),
    ...(finish ? { finish } : {}),
  } as Message;
  return { info, parts };
};

export const piProjectedToRecords = (session: PiProjectedSession | null): SessionMessageRecord[] => {
  if (!session) return [];
  return session.messages.map((message) => {
    const cached = recordsByProjectedMessage.get(message);
    if (cached && cached.info.sessionID === session.sessionId) return cached;
    const record = piMessageToRecord(message, session.sessionId);
    recordsByProjectedMessage.set(message, record);
    return record;
  });
};
