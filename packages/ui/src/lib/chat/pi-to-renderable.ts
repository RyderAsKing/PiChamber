import type { Session, Message, Part, SessionMessageRecord } from '@/lib/chat/types';
import type { PiProjectedMessage, PiProjectedMessagePart, PiProjectedSession } from '@/lib/pi/event-reducer';
import type { PiSession } from '@/lib/pi/types';
import type { PiSessionListItem } from '@/lib/pi/protocol';

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

export const mapPart = (part: PiProjectedMessagePart): Part => {
  if (part.type === 'thinking') {
    return { id: part.id, type: 'reasoning', text: part.text };
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
        output: part.tool?.output,
        error: part.tool?.error,
        time: { start: part.tool?.startedAt, end: part.tool?.endedAt },
        metadata: part.tool?.metadata,
      },
    };
  }
  return { id: part.id, type: 'text', text: part.text };
};

export const piMessageToRecord = (message: PiProjectedMessage, sessionId: string): SessionMessageRecord => {
  const parts: Part[] = [];
  if (message.parts.length > 0) {
    const hasThinking = message.parts.some((p) => p.type === 'thinking');
    const hasText = message.parts.some((p) => p.type === 'text');
    if (!hasThinking && message.thinking) {
      parts.push({ id: `${message.id}:thinking`, type: 'reasoning', text: message.thinking });
    }
    parts.push(...message.parts.map(mapPart));
    if (!hasText && message.text) {
      parts.push({ id: `${message.id}:text`, type: 'text', text: message.text });
    }
  } else {
    if (message.thinking) {
      parts.push({ id: `${message.id}:thinking`, type: 'reasoning', text: message.thinking });
    }
    if (message.text) {
      parts.push({ id: `${message.id}:text`, type: 'text', text: message.text });
    }
  }
  const info: Message = {
    id: message.id,
    sessionID: sessionId,
    role: message.role,
    ...(message.parentId ? { parentID: message.parentId } : {}),
    time: { created: message.createdAt, ...(message.streaming ? {} : { completed: message.createdAt + (message.durationMs ?? 0) }) },
    ...(message.error ? { error: { name: message.error.code, message: message.error.message } } : {}),
    ...(message.model ? { model: { providerID: message.model.providerId, modelID: message.model.modelId } } : {}),
  };
  return { info, parts };
};

export const piProjectedToRecords = (session: PiProjectedSession | null): SessionMessageRecord[] => {
  if (!session) return [];
  return session.messages.map((message) => piMessageToRecord(message, session.sessionId));
};
