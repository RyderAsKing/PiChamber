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

export const isSessionAssistantWorking = (options: {
    connection: 'loading' | 'ready' | 'unavailable' | 'error';
    authoritativeWorking: boolean;
    hasPendingAssistant: boolean;
}): boolean =>
    options.connection === 'ready'
    && (options.authoritativeWorking || options.hasPendingAssistant);

/**
 * Chat working presentation for the selected session. Retained reducer and
 * catalog state is only *verified* while the transport is ready and not in a
 * native resume probe. Otherwise work it last observed (busy/retry, an
 * unfinished assistant, or a retained stream id) is `isAwaitingRecovery`:
 * shown as reconnecting, never as current work with a running timer, and
 * never settled into a completed turn until authoritative state returns.
 */
export const resolveSessionWorkingPresentation = (options: {
    connection: 'loading' | 'ready' | 'unavailable' | 'error';
    transportUncertain: boolean;
    authoritativeWorking: boolean;
    hasPendingAssistant: boolean;
    hasRetainedStream: boolean;
}): { isWorking: boolean; isAwaitingRecovery: boolean } => {
    const verified = options.connection === 'ready' && !options.transportUncertain;
    const lastObservedWorking = options.authoritativeWorking || options.hasPendingAssistant;
    return {
        isWorking: verified && lastObservedWorking,
        isAwaitingRecovery: !verified && (lastObservedWorking || options.hasRetainedStream),
    };
};

export const shouldShowTurnWorkingStatus = (options: {
    isLastTurn: boolean;
    sessionIsWorking: boolean;
    turnIsInActiveStream: boolean;
    activeStreamingMessageId: string | null | undefined;
    isSteering?: boolean;
}): boolean =>
    options.turnIsInActiveStream
    || (options.isLastTurn
        && options.sessionIsWorking
        && (options.isSteering === true || !options.activeStreamingMessageId));

export const isTurnAssistantWorking = (options: {
    messageId: string;
    activeStreamingMessageId: string | null | undefined;
    isRetrying?: boolean;
    /** Latest assistant of the latest turn while the session is awaiting
     *  recovery: its completion footer waits for authoritative state. */
    isAwaitingRecovery?: boolean;
}): boolean =>
    options.isRetrying === true
    || options.isAwaitingRecovery === true
    || (Boolean(options.activeStreamingMessageId) && options.messageId === options.activeStreamingMessageId);
