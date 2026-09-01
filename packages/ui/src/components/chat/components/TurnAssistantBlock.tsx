import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { subscribeToTurnAssistantRevealRequests } from '../lib/turns/turnAssistantReveal';
import type { ChatMessageEntry } from '../lib/turns/types';

interface TurnAssistantBlockProps {
    turnId: string;
    assistantMessages: ChatMessageEntry[];
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
    deferEarlierMessages: boolean;
}

const INITIAL_ASSISTANT_MESSAGE_COUNT = 32;
const ASSISTANT_MESSAGE_REVEAL_BATCH = 32;

/**
 * Keep settled giant turns off the initial interaction path. The first
 * assistant record preserves the response header; the newest records preserve
 * the session tail. Earlier records mount only when requested.
 */
const TurnAssistantBlock: React.FC<TurnAssistantBlockProps> = ({
    turnId,
    assistantMessages,
    renderMessage,
    deferEarlierMessages,
}) => {
    const [revealedCount, setRevealedCount] = React.useState(INITIAL_ASSISTANT_MESSAGE_COUNT);
    const shouldDefer = deferEarlierMessages
        && assistantMessages.length > INITIAL_ASSISTANT_MESSAGE_COUNT;
    const effectiveRevealedCount = shouldDefer
        ? Math.min(revealedCount, assistantMessages.length)
        : assistantMessages.length;
    const visibleTailCount = Math.max(0, effectiveRevealedCount - 1);
    const visibleStart = shouldDefer
        ? Math.max(1, assistantMessages.length - visibleTailCount)
        : 0;
    const hiddenCount = visibleStart > 0 ? visibleStart - 1 : 0;

    React.useEffect(() => {
        setRevealedCount(INITIAL_ASSISTANT_MESSAGE_COUNT);
    }, [turnId]);

    // Timeline and search navigation use MessageList's imperative handle. Keep
    // that behavior working even when their target is behind this local gate.
    React.useEffect(() => subscribeToTurnAssistantRevealRequests(turnId, (messageId) => {
        const messageIndex = assistantMessages.findIndex((message) => message.info.id === messageId);
        if (messageIndex < 0) return false;
        if (!shouldDefer || messageIndex === 0 || messageIndex >= visibleStart) return true;

        setRevealedCount((current) => Math.max(
            current,
            assistantMessages.length - messageIndex + 1,
        ));
        return true;
    }), [assistantMessages, shouldDefer, turnId, visibleStart]);

    const loadEarlier = React.useCallback(() => {
        setRevealedCount((current) => Math.min(
            assistantMessages.length,
            current + ASSISTANT_MESSAGE_REVEAL_BATCH,
        ));
    }, [assistantMessages.length]);

    const loadAll = React.useCallback(() => {
        setRevealedCount(assistantMessages.length);
    }, [assistantMessages.length]);

    const renderSlot = React.useCallback((message: ChatMessageEntry) => (
        <AssistantSlot
            key={message.info.id}
            message={message}
            renderMessage={renderMessage}
        />
    ), [renderMessage]);

    if (!shouldDefer || hiddenCount === 0) {
        return (
            <div className="relative z-0">
                {assistantMessages.map(renderSlot)}
            </div>
        );
    }

    const firstMessage = assistantMessages[0];
    const visibleTail = assistantMessages.slice(visibleStart);
    const showLoadAll = hiddenCount > ASSISTANT_MESSAGE_REVEAL_BATCH;

    return (
        <div className="relative z-0">
            {firstMessage ? renderSlot(firstMessage) : null}
            <div className="chat-message-column flex flex-wrap items-center justify-center gap-2 py-3">
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={loadEarlier}
                    aria-label="Load earlier response"
                    className="gap-1.5 rounded-full px-3.5"
                >
                    <Icon name="history" className="size-3.5" />
                    Load earlier response
                </Button>
                {showLoadAll ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={loadAll}
                        aria-label="Load full response"
                        className="rounded-full px-3.5 text-[var(--surface-mutedForeground)]"
                    >
                        Load full response
                    </Button>
                ) : null}
            </div>
            {visibleTail.map(renderSlot)}
        </div>
    );
};

/**
 * Skip settled sibling assistants while the live tail patches. The streaming
 * assistant is a new record object each token, so it still re-renders.
 * `renderMessage` identity is ignored for the same reason as TurnUserSlot.
 */
const AssistantSlot = React.memo(function AssistantSlot({
    message,
    renderMessage,
}: {
    message: ChatMessageEntry;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}) {
    return renderMessage(message);
}, (previous, next) => previous.message === next.message);

export default React.memo(TurnAssistantBlock);
