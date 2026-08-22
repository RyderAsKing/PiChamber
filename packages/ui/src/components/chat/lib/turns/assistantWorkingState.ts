import type { ChatMessageEntry } from './types';

export const isAssistantMessageCompleted = (message: ChatMessageEntry): boolean => {
    const info = message.info as { time?: { completed?: unknown }; status?: unknown; finish?: unknown };
    if (info.finish === 'stop' || info.finish === 'error') {
        return true;
    }
    const completed = info.time?.completed;
    const status = info.status;
    if (typeof completed !== 'number' || completed <= 0) {
        return false;
    }
    if (typeof status === 'string') {
        return status === 'completed';
    }
    return true;
};

export const resolveTurnStreamingAssistantId = (options: {
    activeStreamingMessageId: string | null | undefined;
    assistantMessages: ChatMessageEntry[];
}): string | null => {
    const { activeStreamingMessageId, assistantMessages } = options;
    if (
        activeStreamingMessageId &&
        assistantMessages.some((assistant) => assistant.info.id === activeStreamingMessageId)
    ) {
        return activeStreamingMessageId;
    }

    for (let index = assistantMessages.length - 1; index >= 0; index--) {
        if (!isAssistantMessageCompleted(assistantMessages[index])) {
            return assistantMessages[index].info.id;
        }
    }

    return null;
};

export const isTurnAssistantWorking = (options: {
    messageId: string;
    activeStreamingMessageId: string | null | undefined;
    isRetrying?: boolean;
}): boolean =>
    options.isRetrying === true
    || (Boolean(options.activeStreamingMessageId) && options.messageId === options.activeStreamingMessageId);
