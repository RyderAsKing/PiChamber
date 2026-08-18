import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';

interface TurnAssistantBlockProps {
    assistantMessages: ChatMessageEntry[];
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

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

const TurnAssistantBlock: React.FC<TurnAssistantBlockProps> = ({ assistantMessages, renderMessage }) => {
    return (
        <div className="relative z-0">
            {assistantMessages.map((message) => (
                <AssistantSlot
                    key={message.info.id}
                    message={message}
                    renderMessage={renderMessage}
                />
            ))}
        </div>
    );
};

export default React.memo(TurnAssistantBlock);
