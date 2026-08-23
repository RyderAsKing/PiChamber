import type { Message } from '@/lib/chat/types';
import type { PiCompactionInfo } from '@/lib/pi/types';

import type { ChatMessageEntry } from './types';

const resolveMessageRole = (message: ChatMessageEntry): string | null => {
    const info = message.info as { clientRole?: string | null; role?: string | null };
    return (typeof info.clientRole === 'string' ? info.clientRole : null)
        ?? (typeof info.role === 'string' ? info.role : null)
        ?? null;
};

const messageCreatedAt = (message: ChatMessageEntry): number | undefined => {
    const created = (message.info as { time?: { created?: unknown } }).time?.created;
    return typeof created === 'number' ? created : undefined;
};

export const applyCompactionOverlay = (
    messages: ChatMessageEntry[],
    sessionId: string | null,
    compaction: PiCompactionInfo | null,
): ChatMessageEntry[] => {
    if (!sessionId || !compaction) return messages;

    const notice = {
        name: 'SessionCompaction',
        message: compaction.message,
        data: { ...compaction },
    };

    const eventTime = compaction.completedAt ?? compaction.startedAt;
    let lastUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const createdAt = messageCreatedAt(messages[index]);
        if (eventTime !== undefined && createdAt !== undefined && createdAt > eventTime) continue;
        if (resolveMessageRole(messages[index]) === 'user') {
            lastUserIndex = index;
            break;
        }
    }
    if (lastUserIndex < 0) return messages;

    let targetAssistantIndex = -1;
    for (let index = lastUserIndex + 1; index < messages.length; index += 1) {
        const createdAt = messageCreatedAt(messages[index]);
        if (eventTime !== undefined && createdAt !== undefined && createdAt > eventTime) break;
        if (resolveMessageRole(messages[index]) === 'assistant') targetAssistantIndex = index;
    }
    if (targetAssistantIndex >= 0) {
        return messages.map((message, index) => index === targetAssistantIndex
            ? {
                ...message,
                info: {
                    ...(message.info as Record<string, unknown>),
                    error: notice,
                } as unknown as Message,
            }
            : message);
    }

    const timestamp = eventTime ?? 0;
    const synthetic: ChatMessageEntry = {
        info: {
            id: `synthetic_compaction_notice_${sessionId}`,
            sessionID: sessionId,
            role: 'assistant',
            parentID: messages[lastUserIndex].info.id,
            time: { created: timestamp, completed: timestamp },
            finish: 'stop',
            error: notice,
        } as unknown as Message,
        parts: [],
    };
    const next = messages.slice();
    next.splice(lastUserIndex + 1, 0, synthetic);
    return next;
};
