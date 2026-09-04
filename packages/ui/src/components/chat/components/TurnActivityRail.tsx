import React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useDeviceInfo } from '@/lib/device';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { useUIStore } from '@/stores/useUIStore';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import type { ToolPart as ToolPartType } from '@/lib/chat/types';
import type { ToolPopupContent } from '../message/types';
import type { StreamPhase } from '../message/types';
import type { TurnActivityRecord, TurnRecord } from '../lib/turns/types';
import {
    ACTIVITY_LOAD_BATCH_SIZE,
    getVisibleTurnActivity,
    INITIAL_VISIBLE_TOOL_COUNT,
} from './turnActivityModel';
import AssistantTextPart from '../message/parts/AssistantTextPart';
import ReasoningPart from '../message/parts/ReasoningPart';
import { StaticToolRow } from '../message/parts/StaticToolRow';
import ToolPart from '../message/parts/ToolPart';
import { ToolRevealOnMount } from '../message/parts/ToolRevealOnMount';
import { FadeInOnReveal } from '../message/FadeInOnReveal';
import { isExpandableTool, normalizeToolName } from '../message/parts/toolRenderUtils';
import { useTurnToolsState } from '../message/useTurnToolsState';
import { areRenderRelevantPartsEqual } from '../message/renderCompare';

const ToolOutputDialog = lazyWithChunkRecovery(() => import('../message/ToolOutputDialog'));

const useActivityPanelPresence = (isExpanded: boolean) => {
    const hasMountedRef = React.useRef(isExpanded);
    const [isVisible, setIsVisible] = React.useState(isExpanded);
    if (isExpanded) {
        hasMountedRef.current = true;
    }

    React.useEffect(() => {
        const reduceMotion = typeof window !== 'undefined'
            && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        let animationFrame: number | undefined;

        if (isExpanded) {
            if (reduceMotion || typeof requestAnimationFrame !== 'function') {
                setIsVisible(true);
            } else {
                animationFrame = requestAnimationFrame(() => setIsVisible(true));
            }
        } else {
            // Keep a previously opened panel mounted after collapse. The grid
            // still animates closed, while reopening reuses settled tool rows
            // instead of remounting and replaying their arrival work.
            setIsVisible(false);
        }

        return () => {
            if (animationFrame !== undefined && typeof cancelAnimationFrame === 'function') {
                cancelAnimationFrame(animationFrame);
            }
        };
    }, [isExpanded]);

    return { isMounted: hasMountedRef.current, isVisible };
};

const resolveActivityStreamPhase = ({
    activity,
    isLiveTurn,
    activeStreamingMessageId,
    activeStreamingPhase,
}: {
    activity: TurnActivityRecord;
    isLiveTurn: boolean;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
}): StreamPhase => {
    if (
        isLiveTurn
        && activeStreamingMessageId
        && activity.messageId === activeStreamingMessageId
    ) {
        return activeStreamingPhase ?? 'streaming';
    }
    return 'completed';
};

type ToolActivityRecord = TurnActivityRecord & {
    kind: 'tool';
    part: ToolPartType;
};

interface TurnToolActivityRowProps {
    activity: ToolActivityRecord;
    animate: boolean;
    isExpanded: boolean;
    isMobile: boolean;
    onContentChange?: (reason?: ContentChangeReason) => void;
    onToggle: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
}

const TurnToolActivityRow = React.memo(({
    activity,
    animate,
    isExpanded,
    isMobile,
    onContentChange,
    onToggle,
    onShowPopup,
}: TurnToolActivityRowProps) => {
    const toolName = normalizeToolName(activity.part.tool);
    const row = isExpandableTool(toolName) ? (
        <ToolPart
            part={activity.part}
            isExpanded={isExpanded}
            onToggle={onToggle}
            isMobile={isMobile}
            alwaysShowActions={isMobile}
            onContentChange={onContentChange}
            onShowPopup={onShowPopup}
            animateTailText={animate}
        />
    ) : (
        <StaticToolRow
            toolName={toolName}
            activities={[activity]}
            animateTailText={animate}
        />
    );

    return (
        <FadeInOnReveal>
            <ToolRevealOnMount animate={animate}>
                {row}
            </ToolRevealOnMount>
        </FadeInOnReveal>
    );
}, (previous, next) => (
    previous.activity.id === next.activity.id
    && previous.activity.messageId === next.activity.messageId
    && previous.activity.endedAt === next.activity.endedAt
    && areRenderRelevantPartsEqual([previous.activity.part], [next.activity.part])
    && previous.animate === next.animate
    && previous.isExpanded === next.isExpanded
    && previous.isMobile === next.isMobile
    && previous.onContentChange === next.onContentChange
    && previous.onToggle === next.onToggle
    && previous.onShowPopup === next.onShowPopup
));

TurnToolActivityRow.displayName = 'TurnToolActivityRow';

const TurnActivityRail: React.FC<{
    turn: TurnRecord;
    isExpanded: boolean;
    isLiveTurn: boolean;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    onContentChange?: (reason?: ContentChangeReason) => void;
}> = ({
    turn,
    isExpanded,
    isLiveTurn,
    activeStreamingMessageId,
    activeStreamingPhase,
    onContentChange,
}) => {
    const { isMobile } = useDeviceInfo();
    const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
    const collapsibleThinkingBlocks = useUIStore((state) => state.collapsibleThinkingBlocks);
    const collapseThinkingByDefault = useUIStore((state) => state.collapseThinkingByDefault);
    const showExpandedBashTools = useUIStore((state) => state.showExpandedBashTools);
    const showExpandedEditTools = useUIStore((state) => state.showExpandedEditTools);
    const [visibleToolCount, setVisibleToolCount] = React.useState(INITIAL_VISIBLE_TOOL_COUNT);
    const activityPanel = useActivityPanelPresence(isExpanded);
    const onContentChangeRef = React.useRef(onContentChange);
    onContentChangeRef.current = onContentChange;
    const notifyContentChange = React.useCallback((reason?: ContentChangeReason) => {
        onContentChangeRef.current?.(reason);
    }, []);

    const activityParts = turn.activityParts;
    const toolCount = React.useMemo(
        () => activityParts.reduce(
            (count, activity) => count + (activity.kind === 'tool' ? 1 : 0),
            0,
        ),
        [activityParts],
    );
    const visibleActivity = React.useMemo(
        () => getVisibleTurnActivity(activityParts, visibleToolCount),
        [activityParts, visibleToolCount],
    );

    const {
        effectiveExpandedTools,
        popupContent,
        handleToggleTool,
        handleShowPopup,
        handlePopupChange,
    } = useTurnToolsState({
        activities: activityParts,
        showExpandedBashTools,
        showExpandedEditTools,
    });

    const toolIds = React.useMemo(
        () => activityParts
            .filter((activity) => activity.kind === 'tool')
            .map((activity) => activity.id),
        [activityParts],
    );
    const arrivalStateRef = React.useRef<{
        turnId: string;
        committed: boolean;
        knownToolIds: Set<string>;
        animatedToolIds: Set<string>;
    }>({
        turnId: turn.turnId,
        committed: false,
        knownToolIds: new Set<string>(),
        animatedToolIds: new Set<string>(),
    });

    if (arrivalStateRef.current.turnId !== turn.turnId) {
        arrivalStateRef.current = {
            turnId: turn.turnId,
            committed: false,
            knownToolIds: new Set<string>(),
            animatedToolIds: new Set<string>(),
        };
    }

    if (isLiveTurn && arrivalStateRef.current.committed) {
        for (const toolId of toolIds) {
            if (!arrivalStateRef.current.knownToolIds.has(toolId)) {
                arrivalStateRef.current.animatedToolIds.add(toolId);
            }
        }
    }

    React.useEffect(() => {
        const state = arrivalStateRef.current;
        for (const toolId of toolIds) {
            state.knownToolIds.add(toolId);
        }
        state.committed = true;
    }, [toolIds]);

    const handleLoadEarlier = React.useCallback(() => {
        setVisibleToolCount((current) => Math.min(toolCount, current + ACTIVITY_LOAD_BATCH_SIZE));
        notifyContentChange('structural');
    }, [notifyContentChange, toolCount]);

    const renderActivity = React.useCallback((activity: TurnActivityRecord): React.ReactNode => {
        const streamPhase = resolveActivityStreamPhase({
            activity,
            isLiveTurn,
            activeStreamingMessageId,
            activeStreamingPhase,
        });
        const animate = arrivalStateRef.current.animatedToolIds.has(activity.id);

        if (activity.kind === 'reasoning') {
            if (!showReasoningTraces) {
                return null;
            }

            if (!collapsibleThinkingBlocks) {
                return (
                    <AssistantTextPart
                        key={activity.id}
                        part={activity.part}
                        messageId={activity.messageId}
                        streamPhase={streamPhase}
                        onContentChange={notifyContentChange}
                        withinActivityRail
                    />
                );
            }

            return (
                <ReasoningPart
                    key={activity.id}
                    part={activity.part}
                    messageId={activity.messageId}
                    streamPhase={streamPhase}
                    onContentChange={notifyContentChange}
                    collapseByDefault={collapseThinkingByDefault}
                    withinActivityRail
                />
            );
        }

        if (activity.kind === 'justification') {
            return (
                <AssistantTextPart
                    key={activity.id}
                    part={activity.part}
                    messageId={activity.messageId}
                    streamPhase={streamPhase}
                    onContentChange={notifyContentChange}
                    withinActivityRail
                />
            );
        }

        if (activity.part.type !== 'tool') {
            return null;
        }

        return (
            <TurnToolActivityRow
                key={activity.id}
                activity={activity as ToolActivityRecord}
                animate={animate}
                isExpanded={effectiveExpandedTools.has(activity.id)}
                isMobile={isMobile}
                onContentChange={notifyContentChange}
                onToggle={handleToggleTool}
                onShowPopup={handleShowPopup}
            />
        );
    }, [
        activeStreamingMessageId,
        activeStreamingPhase,
        collapseThinkingByDefault,
        collapsibleThinkingBlocks,
        effectiveExpandedTools,
        handleShowPopup,
        handleToggleTool,
        isLiveTurn,
        isMobile,
        notifyContentChange,
        showReasoningTraces,
    ]);

    return (
        <>
            <div className="chat-message-column">
                <div
                    id={`turn-${turn.turnId}-activity`}
                    className="relative min-w-0 pl-[18px]"
                    data-turn-activity-rail="true"
                    data-turn-activity-expanded={isExpanded ? 'true' : 'false'}
                    aria-hidden={!isExpanded}
                >
                    {activityPanel.isMounted ? (
                        <div
                            className={cn(
                                'relative grid origin-top transition-[grid-template-rows,opacity,transform] duration-200 ease-out motion-reduce:transition-none motion-reduce:transform-none',
                                activityPanel.isVisible
                                    ? 'grid-rows-[1fr] translate-y-0 opacity-100'
                                    : 'grid-rows-[0fr] -translate-y-1 opacity-0',
                            )}
                            data-turn-activity-panel="true"
                            data-turn-activity-visible={activityPanel.isVisible ? 'true' : 'false'}
                        >
                            <span
                                aria-hidden="true"
                                className="pointer-events-none absolute bottom-0 -left-[18px] top-0 w-px"
                                style={{ backgroundColor: 'var(--tools-border)' }}
                            />
                            <div className="relative min-h-0 overflow-hidden">
                                {visibleActivity.hiddenToolCount > 0 ? (
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="xs"
                                        className="-ml-1.5 mb-0.5 justify-start px-1.5 text-muted-foreground"
                                        aria-label="Load earlier activity"
                                        onClick={handleLoadEarlier}
                                    >
                                        Load earlier activity
                                    </Button>
                                ) : null}
                                <div className="min-w-0 space-y-1">
                                    {visibleActivity.activities.map(renderActivity)}
                                </div>
                            </div>
                        </div>
                    ) : null}
                </div>
            </div>
            {popupContent.open ? (
                <React.Suspense fallback={null}>
                    <ToolOutputDialog
                        popup={popupContent}
                        onOpenChange={handlePopupChange}
                        isMobile={isMobile}
                    />
                </React.Suspense>
            ) : null}
        </>
    );
};

export default React.memo(TurnActivityRail);
