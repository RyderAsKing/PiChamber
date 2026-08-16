import React from 'react';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatErrorBoundary } from '@/components/chat/ChatErrorBoundary';
import { useSessionUIStore } from '@/sync/session-ui-store';

type ChatViewProps = {
    active?: boolean;
    readOnly?: boolean;
};

export const ChatView: React.FC<ChatViewProps> = ({ active = true, readOnly = false }) => {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);

    return (
        <ChatErrorBoundary sessionId={currentSessionId || undefined}>
            {/* Remount on session switch so composer drafts, viewport anchors,
                and the message timeline reset to the right session even when
                the cluster preserves resident transcripts during the switch. */}
            <ChatContainer key={currentSessionId ?? 'no-session'} active={active} readOnly={readOnly} />
        </ChatErrorBoundary>
    );
};
