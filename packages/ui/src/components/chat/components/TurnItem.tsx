import React from 'react';

import type { ChatMessageEntry, Turn } from '../lib/turns/types';
import TurnAssistantBlock from './TurnAssistantBlock';

interface TurnItemProps {
    turn: Turn;
    stickyUserHeader?: boolean;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

/**
 * Keep the user header off the token path. `renderMessage` is recreated
 * whenever the live assistant patches, but the user record identity is
 * stable for text-only deltas — calling it again remounts ChatMessage.
 */
const TurnUserSlot = React.memo(function TurnUserSlot({
    userMessage,
    stickyUserHeader,
    renderMessage,
}: {
    userMessage: ChatMessageEntry;
    stickyUserHeader: boolean;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}) {
    const body = renderMessage(userMessage);
    if (!stickyUserHeader) {
        return body;
    }

    return (
        <div className="sticky top-0 z-20 relative bg-[var(--surface-background)] [overflow-anchor:none]">
            <div className="relative z-10">
                {body}
            </div>
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-full z-0 h-4 bg-gradient-to-b from-[var(--surface-background)] to-transparent sm:h-8"
            />
        </div>
    );
}, (previous, next) => (
    previous.userMessage === next.userMessage
    && previous.stickyUserHeader === next.stickyUserHeader
));

const TurnItem: React.FC<TurnItemProps> = ({ turn, stickyUserHeader = true, renderMessage }) => {
    return (
        <section
            className="relative w-full"
            id={`turn-${turn.turnId}`}
            data-turn-id={turn.turnId}
            data-scroll-spy-id={turn.turnId}
        >
            <TurnUserSlot
                userMessage={turn.userMessage}
                stickyUserHeader={stickyUserHeader}
                renderMessage={renderMessage}
            />

            <TurnAssistantBlock assistantMessages={turn.assistantMessages} renderMessage={renderMessage} />
        </section>
    );
};

export default React.memo(TurnItem);
