import React from 'react';

import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import type { StreamPhase } from '../message/types';
import type { ChatMessageEntry, TurnRecord } from '../lib/turns/types';
import TurnActivityRail from './TurnActivityRail';
import TurnAssistantBlock from './TurnAssistantBlock';
import TurnWorkingHeader from './TurnWorkingHeader';
import { resolveTurnActivityDisclosure } from './turnActivityDisclosure';

interface TurnItemProps {
    turn: TurnRecord;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
    deferEarlierAssistantMessages: boolean;
    /** True while this turn is the authoritative live turn. */
    showWorkingStatus?: boolean;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    onActivityContentChange?: (reason?: ContentChangeReason) => void;
}

/**
 * Keep the user header off the token path. `renderMessage` is recreated
 * whenever the live assistant patches, but the user record identity is
 * stable for text-only deltas — calling it again remounts ChatMessage.
 */
const TurnUserSlot = React.memo(function TurnUserSlot({
    userMessage,
    renderMessage,
}: {
    userMessage: ChatMessageEntry;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}) {
    return renderMessage(userMessage);
}, (previous, next) => (
    previous.userMessage === next.userMessage
));

const hasFinalAnswerText = (turn: TurnRecord): boolean => {
    const sourcePartId = turn.summary.sourcePartId;
    if (!sourcePartId || !turn.summary.text || turn.summary.text.trim().length === 0) {
        return false;
    }

    // A text part that is currently classified as a justification is progress,
    // not the final answer. This distinction matters when a response begins
    // with prose and only later emits its first tool call.
    return !turn.activityParts.some(
        (activity) => activity.id === sourcePartId && activity.kind === 'justification',
    );
};

const TurnItem: React.FC<TurnItemProps> = ({
    turn,
    renderMessage,
    deferEarlierAssistantMessages,
    showWorkingStatus = false,
    activeStreamingMessageId = null,
    activeStreamingPhase = null,
    onActivityContentChange,
}) => {
    const hasActivity = React.useMemo(
        () => turn.activityParts.length > 0,
        [turn.activityParts],
    );
    const hasFinalText = React.useMemo(() => hasFinalAnswerText(turn), [turn]);
    const [isActivityExpanded, setIsActivityExpanded] = React.useState(
        () => showWorkingStatus && hasActivity && !hasFinalText,
    );
    const userToggledActivityRef = React.useRef(false);
    const autoCollapsedActivityRef = React.useRef(false);
    const previousActivityCountRef = React.useRef(turn.activityParts.length);
    const previousHadFinalTextRef = React.useRef(hasFinalText);

    // The first final-answer delta collapses the process rail without an
    // effect-delayed blank frame. If more activity arrives afterwards, the
    // earlier text is progress and the rail reopens unless the user chose a
    // disclosure state themselves.
    React.useLayoutEffect(() => {
        const previousCount = previousActivityCountRef.current;
        const previousHadFinalText = previousHadFinalTextRef.current;
        const hasNewActivity = turn.activityParts.length > previousCount;
        previousActivityCountRef.current = turn.activityParts.length;
        previousHadFinalTextRef.current = hasFinalText;

        const next = resolveTurnActivityDisclosure({
            isExpanded: isActivityExpanded,
            userToggled: userToggledActivityRef.current,
            wasAutoCollapsed: autoCollapsedActivityRef.current,
            hasActivity,
            showWorkingStatus,
            hasFinalText,
            previousHadFinalText,
            hasNewActivity,
        });

        autoCollapsedActivityRef.current = next.wasAutoCollapsed;
        if (next.resetUserToggle) {
            userToggledActivityRef.current = false;
        }
        if (next.isExpanded !== isActivityExpanded) {
            setIsActivityExpanded(next.isExpanded);
        }
    }, [hasActivity, hasFinalText, isActivityExpanded, showWorkingStatus, turn.activityParts.length]);

    const handleToggleActivity = React.useCallback(() => {
        userToggledActivityRef.current = true;
        setIsActivityExpanded((current) => !current);
        onActivityContentChange?.('structural');
    }, [onActivityContentChange]);

    const shouldShowWorkingHeader = turn.assistantMessages.length > 0 || showWorkingStatus;
    const activityPartIds = React.useMemo(
        () => new Set(turn.activityParts.map((activity) => activity.id)),
        [turn.activityParts],
    );

    return (
        <section
            className="relative w-full"
            id={`turn-${turn.turnId}`}
            data-turn-id={turn.turnId}
            data-scroll-spy-id={turn.turnId}
        >
            <TurnUserSlot
                userMessage={turn.userMessage}
                renderMessage={renderMessage}
            />

            {shouldShowWorkingHeader ? (
                <TurnWorkingHeader
                    turnId={turn.turnId}
                    isLiveTurn={showWorkingStatus}
                    isWorking={showWorkingStatus}
                    hasActivity={hasActivity}
                    isActivityExpanded={isActivityExpanded}
                    onToggleActivity={handleToggleActivity}
                    startedAt={turn.startedAt}
                    completedAt={turn.completedAt}
                    durationMs={turn.durationMs}
                    liveStatusText={turn.isSteering ? 'Steering agent' : undefined}
                    wasSteered={turn.stream.settledReason === 'steered'}
                />
            ) : null}

            {hasActivity ? (
                <TurnActivityRail
                    key={turn.turnId}
                    turn={turn}
                    isExpanded={isActivityExpanded}
                    isLiveTurn={showWorkingStatus}
                    activeStreamingMessageId={activeStreamingMessageId}
                    activeStreamingPhase={activeStreamingPhase}
                    onContentChange={onActivityContentChange}
                />
            ) : null}

            <TurnAssistantBlock
                turnId={turn.turnId}
                assistantMessages={turn.assistantMessages}
                renderMessage={renderMessage}
                deferEarlierMessages={deferEarlierAssistantMessages}
                activityPartIds={activityPartIds}
            />
        </section>
    );
};

export default React.memo(TurnItem);
