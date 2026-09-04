import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { subscribeToTurnAssistantRevealRequests } from '../lib/turns/turnAssistantReveal';
import type { ChatMessageEntry } from '../lib/turns/types';
import { getAssistantError } from '../message/chatMessageTextContent';
import {
    filterAssistantFinalParts,
    filterRenderableAssistantParts,
    filterVisibleParts,
} from '../message/partUtils';

interface TurnAssistantBlockProps {
    turnId: string;
    assistantMessages: ChatMessageEntry[];
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
    deferEarlierMessages: boolean;
    /** Activity part ids projected to the turn rail. The response block mounts
     * only records with final response content; activity records are owned by
     * TurnActivityRail. */
    activityPartIds: ReadonlySet<string>;
}

const hasFinalResponseContent = (
    message: ChatMessageEntry,
    activityPartIds: ReadonlySet<string>,
): boolean => {
    const errorText = getAssistantError(message.info)?.text;
    if (typeof errorText === 'string' && errorText.trim().length > 0) {
        return true;
    }
    const visibleParts = filterVisibleParts(message.parts);
    const finalParts = filterAssistantFinalParts(visibleParts, activityPartIds, message.info.id);
    return filterRenderableAssistantParts(finalParts).length > 0;
};

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
    activityPartIds,
}) => {
    const [revealedCount, setRevealedCount] = React.useState(INITIAL_ASSISTANT_MESSAGE_COUNT);
    const firstMessage = assistantMessages[0];
    const finalResponseMessages = React.useMemo(
        () => assistantMessages.filter((message) => hasFinalResponseContent(message, activityPartIds)),
        [activityPartIds, assistantMessages],
    );
    const finalTailMessages = React.useMemo(
        () => finalResponseMessages.filter((message) => message !== firstMessage),
        [finalResponseMessages, firstMessage],
    );
    const shouldDefer = deferEarlierMessages
        && finalResponseMessages.length > INITIAL_ASSISTANT_MESSAGE_COUNT;
    const visibleTailCount = shouldDefer
        ? Math.max(0, revealedCount - 1)
        : finalTailMessages.length;
    const visibleTail = visibleTailCount >= finalTailMessages.length
        ? finalTailMessages
        : finalTailMessages.slice(-visibleTailCount);
    const hiddenFinalCount = finalTailMessages.length - visibleTail.length;

    React.useEffect(() => {
        setRevealedCount(INITIAL_ASSISTANT_MESSAGE_COUNT);
    }, [turnId]);

    // Timeline and search navigation use MessageList's imperative handle. Keep
    // that behavior working even when their target is behind this local gate.
    React.useEffect(() => subscribeToTurnAssistantRevealRequests(turnId, (messageId) => {
        if (firstMessage?.info.id === messageId) return true;
        const finalIndex = finalTailMessages.findIndex((message) => message.info.id === messageId);
        if (finalIndex < 0) return false;
        const visibleStart = finalTailMessages.length - visibleTail.length;
        if (!shouldDefer || finalIndex >= visibleStart) return true;

        setRevealedCount((current) => Math.max(
            current,
            finalTailMessages.length - finalIndex + 1,
        ));
        return true;
    }), [finalTailMessages, firstMessage, shouldDefer, turnId, visibleTail.length]);

    const loadEarlier = React.useCallback(() => {
        setRevealedCount((current) => Math.min(
            finalTailMessages.length + 1,
            current + ASSISTANT_MESSAGE_REVEAL_BATCH,
        ));
    }, [finalTailMessages.length]);

    const loadAll = React.useCallback(() => {
        setRevealedCount(finalTailMessages.length + 1);
    }, [finalTailMessages.length]);

    const renderSlot = React.useCallback((message: ChatMessageEntry) => (
        <AssistantSlot
            key={message.info.id}
            message={message}
            renderMessage={renderMessage}
        />
    ), [renderMessage]);

    if (!shouldDefer || hiddenFinalCount === 0) {
        return (
            <div className="relative z-0">
                {firstMessage ? renderSlot(firstMessage) : null}
                {finalTailMessages.map(renderSlot)}
            </div>
        );
    }

    const showLoadAll = hiddenFinalCount > ASSISTANT_MESSAGE_REVEAL_BATCH;

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
