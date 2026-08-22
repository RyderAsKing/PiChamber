import React from 'react';
import type { Part } from '@/lib/chat/types';
import { elementScroll, useVirtualizer as useTanstackVirtualizer, type ReactVirtualizer, type VirtualItem } from '@tanstack/react-virtual';

import ChatMessage from './ChatMessage';
import ExtensionMessageCard from './message/parts/extension/ExtensionMessageCard';
import { areOptionalNeighborMessagesEqual, areRelevantTurnGroupingContextsEqual, areRenderRelevantMessagesEqual } from './message/renderCompare';
import TurnItem from './components/TurnItem';
import FoldedHistoryGate from './components/FoldedHistoryGate';
import { HISTORY_GATE_ESTIMATED_SIZE, nextRevealedOlderCount, revealedCountForTurn, shouldFoldHistoryTurn } from './lib/turns/foldHistoryTurns';
import type { AnimationHandlers, ContentChangeReason } from '@/hooks/useChatAutoFollow';
import type { ChatMessageEntry, TurnRecord, TurnGroupingContext } from './lib/turns/types';
import { useTurnRecords } from './hooks/useTurnRecords';
import { applyRetryOverlay } from './lib/turns/applyRetryOverlay';
import { isTurnAssistantWorking, resolveTurnStreamingAssistantId } from './lib/turns/assistantWorkingState';
import { buildLiveStreamingEntry, type StreamingTailEntry } from './lib/turns/streamingTailEntry';
import { getNormalizedMessageForDisplay, hasCompactionPart } from './lib/messageDisplayNormalization';
import { useUIStore } from '@/stores/useUIStore';
import { isHiddenUserMessage } from './message/hiddenUserMessage';
import { FadeInDisabledProvider } from './message/FadeInOnReveal';
import { hasPendingUserSendAnimation, consumePendingUserSendAnimation } from '@/lib/userSendAnimation';
import { streamPerfCount, streamPerfMark, streamPerfMeasure } from '@/stores/utils/streamDebug';
import type { StreamPhase } from './message/types';
import { useSessionParts } from '@/sync/sync-context';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import {
    USER_SHELL_MARKER,
    isUserShellMarkerMessage,
    getShellBridgeAssistantDetails,
    type ShellBridgeDetails,
} from './lib/shellBridge';
import { isMeasurableScrollElement } from './lib/scroll/readyScrollElement';

const MESSAGE_LIST_VIRTUALIZE_THRESHOLD = 5;
const EMPTY_STATIC_ENTRY_MESSAGES: ChatMessageEntry[] = [];
const EMPTY_UNGROUPED_MESSAGE_IDS = new Set<string>();
const TIMELINE_CACHE_LIMIT = 16;

const sameKeys = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    return a.every((key, index) => key === b[index]);
};

// --- History virtualization (@tanstack/react-virtual) ----------------------
// The history list virtualizes with @tanstack/react-virtual on all surfaces:
// its core has bottom anchoring (anchorTo: 'end'), key-stable prepend
// preservation, and native iOS touch/momentum deferral for scroll
// adjustments — the failure modes that historically forced virtua off on
// mobile and required manual prepend compensation on desktop.
// Enable the virtualizer only after the forwarded ScrollShadow node has a
// non-zero clientHeight. A 0×0 first rect leaves getVirtualItems() empty
// while the estimated spacer still occupies the history height, so older
// turns vanish and only the non-virtualized live tail remains visible.
type TanstackVirtualizerInstance = ReactVirtualizer<HTMLDivElement, HTMLDivElement>;
type HistoryEngine = 'none' | 'tanstack';

const TANSTACK_ESTIMATED_ENTRY_SIZE = 320;
const TANSTACK_OVERSCAN = 8;
// Touch flings cover more distance between paints than desktop wheels; a
// larger window keeps fast mobile scrolling over mounted rows.
const TANSTACK_MOBILE_OVERSCAN = 16;
const resolveTanstackOverscan = (): number => (
    isMobileSurfaceRuntime() ? TANSTACK_MOBILE_OVERSCAN : TANSTACK_OVERSCAN
);
// Post-prepend anchor hold: measurements of freshly
// prepended rows settle over multiple frames, so a single restore can be
// invalidated by the next measurement pass. Re-assert the anchor until it
// holds still for STABLE_FRAMES consecutive frames, giving up at MAX_FRAMES.
const ANCHOR_HOLD_STABLE_FRAMES = 30;
const ANCHOR_HOLD_MAX_FRAMES = 180;
// Adaptive estimate bounds: only trust the session average once a few rows
// are measured, and keep it inside sane turn-height bounds.
const TANSTACK_ESTIMATE_MIN_SAMPLES = 5;
const TANSTACK_ESTIMATE_MIN = 120;
const TANSTACK_ESTIMATE_MAX = 1200;
// "At bottom" tolerance for resize-adjustment decisions.
const TANSTACK_AT_END_THRESHOLD_PX = 80;

// Quiet-window prepend on mobile: while a touch drag or momentum scroll is
// active, iOS owns the scroll position and ANY geometry change above the
// viewport races against the native animation — a race that compensation
// logic can only lose sometimes. So freshly loaded older history is held
// (data already fetched, store already updated) and inserted into the
// rendered list only once the gesture goes quiet. Safety valves: flush when
// the user gets close to the top (a blank top is worse than a small hop) or
// after MAX_HOLD_MS.
const HISTORY_PREPEND_QUIET_MS = 160;
const HISTORY_PREPEND_MAX_HOLD_MS = 1500;
const HISTORY_PREPEND_NEAR_TOP_VIEWPORTS = 1.5;
const HISTORY_PREPEND_MONITOR_INTERVAL_MS = 90;

// A commit is a deferable prepend when older entries were inserted strictly
// above the known content: the previous first key still exists deeper in the
// list and the tail is unchanged. Anything else renders immediately.
const isPrependAboveCommit = (previous: RenderEntry[], next: RenderEntry[]): boolean => {
    if (previous.length === 0 || next.length <= previous.length) return false;
    if (previous[previous.length - 1]?.key !== next[next.length - 1]?.key) return false;
    const previousFirstKey = previous[0]?.key;
    const insertedIndex = next.findIndex((entry) => entry.key === previousFirstKey);
    return insertedIndex > 0;
};

const tanstackTimelineCache = new Map<string, { keys: readonly string[]; items: VirtualItem[] }>();
const REVEALED_OLDER_TURNS_CACHE_MAX = 32;
const revealedOlderTurnsCache = new Map<string, number>();

const readRevealedOlderTurns = (sessionKey: string): number => {
    return revealedOlderTurnsCache.get(sessionKey) ?? 0;
};

const writeRevealedOlderTurns = (sessionKey: string, value: number): void => {
    if (revealedOlderTurnsCache.size >= REVEALED_OLDER_TURNS_CACHE_MAX && !revealedOlderTurnsCache.has(sessionKey)) {
        const oldest = revealedOlderTurnsCache.keys().next().value;
        if (typeof oldest === 'string') {
            revealedOlderTurnsCache.delete(oldest);
        }
    }
    revealedOlderTurnsCache.set(sessionKey, value);
};

const readTanstackTimelineCache = (sessionKey: string, keys: readonly string[]): VirtualItem[] | undefined => {
    const entry = tanstackTimelineCache.get(sessionKey);
    if (!entry) return undefined;
    if (sameKeys(entry.keys, keys)) return entry.items;
    tanstackTimelineCache.delete(sessionKey);
    return undefined;
};

const writeTanstackTimelineCache = (
    sessionKey: string,
    keys: readonly string[],
    virtualizer: TanstackVirtualizerInstance | null | undefined,
): void => {
    if (!virtualizer || keys.length === 0) return;
    tanstackTimelineCache.delete(sessionKey);
    tanstackTimelineCache.set(sessionKey, { keys: keys.slice(), items: virtualizer.takeSnapshot() });
    while (tanstackTimelineCache.size > TIMELINE_CACHE_LIMIT) {
        const oldest = tanstackTimelineCache.keys().next().value;
        if (typeof oldest !== 'string') break;
        tanstackTimelineCache.delete(oldest);
    }
};

const useStableEvent = <TArgs extends unknown[], TResult>(handler: (...args: TArgs) => TResult) => {
    const handlerRef = React.useRef(handler);
    React.useEffect(() => {
        handlerRef.current = handler;
    }, [handler]);

    return React.useCallback((...args: TArgs) => handlerRef.current(...args), []);
};

const resolveMessageRole = (message: ChatMessageEntry): string | null => {
    const info = message.info as unknown as { clientRole?: string | null | undefined; role?: string | null | undefined };
    return (typeof info.clientRole === 'string' ? info.clientRole : null)
        ?? (typeof info.role === 'string' ? info.role : null)
        ?? null;
};

const getPartText = (part: Part): string => {
    const text = (part as { text?: unknown }).text;
    if (typeof text === 'string') {
        return text;
    }
    const content = (part as { content?: unknown }).content;
    if (typeof content === 'string') {
        return content;
    }
    return '';
};

const normalizeCompactionSummaryMessage = (
    message: ChatMessageEntry,
    compactionCommandIds: Set<string>,
): ChatMessageEntry => {
    const role = resolveMessageRole(message);
    if (role !== 'system') {
        return message;
    }

    const parentID = getMessageParentId(message);
    if (!parentID || !compactionCommandIds.has(parentID)) {
        return message;
    }

    const info = message.info as unknown as { clientRole?: string | null | undefined };
    if (info.clientRole === 'assistant') {
        return message;
    }

    return {
        ...message,
        info: ({
            ...(message.info as unknown as Record<string, unknown>),
            clientRole: 'assistant',
        } as unknown as typeof message.info),
    };
};

const isUserSubtaskMessage = (message: ChatMessageEntry | undefined): boolean => {
    if (!message) return false;
    if (resolveMessageRole(message) !== 'user') return false;
    return message.parts.some((part) => part?.type === 'subtask');
};

const getMessageId = (message: ChatMessageEntry | undefined): string | null => {
    if (!message) return null;
    const id = (message.info as unknown as { id?: unknown }).id;
    return typeof id === 'string' && id.trim().length > 0 ? id : null;
};

const getMessageParentId = (message: ChatMessageEntry): string | null => {
    const parentID = (message.info as unknown as { parentID?: unknown }).parentID;
    return typeof parentID === 'string' && parentID.trim().length > 0 ? parentID : null;
};

const isInsideStuckSticky = (node: HTMLElement, container: HTMLElement, containerTop: number): boolean => {
    if (typeof window === 'undefined') return false;

    let current: HTMLElement | null = node;
    while (current && current !== container) {
        const computed = window.getComputedStyle(current);
        if (computed.position === 'sticky' && current.getBoundingClientRect().top <= containerTop + 1) {
            return true;
        }
        current = current.parentElement;
    }

    return false;
};


const readTaskSessionId = (toolPart: Part): string | null => {
    const partRecord = toolPart as unknown as {
        state?: {
            metadata?: {
                sessionId?: unknown;
                sessionID?: unknown;
            };
            output?: unknown;
        };
    };
    const metadata = partRecord.state?.metadata;
    const fromMetadata =
        (typeof metadata?.sessionID === 'string' && metadata.sessionID.trim().length > 0
            ? metadata.sessionID.trim()
            : null)
        ?? (typeof metadata?.sessionId === 'string' && metadata.sessionId.trim().length > 0
            ? metadata.sessionId.trim()
            : null);
    if (fromMetadata) return fromMetadata;

    const output = partRecord.state?.output;
    if (typeof output === 'string') {
        const match = output.match(/task_id\s*:\s*([^\s<"']+)/i);
        if (match?.[1]) {
            return match[1];
        }
    }

    return null;
};

const isSyntheticSubtaskBridgeAssistant = (message: ChatMessageEntry): { hide: boolean; taskSessionId: string | null } => {
    if (resolveMessageRole(message) !== 'assistant') {
        return { hide: false, taskSessionId: null };
    }

    if (message.parts.length !== 1) {
        return { hide: false, taskSessionId: null };
    }

    const onlyPart = message.parts[0] as unknown as {
        type?: unknown;
        tool?: unknown;
    } | null | undefined;

    if (onlyPart?.type !== 'tool') {
        return { hide: false, taskSessionId: null };
    }

    const toolName = typeof onlyPart.tool === 'string' ? onlyPart.tool.toLowerCase() : '';
    if (toolName !== 'task') {
        return { hide: false, taskSessionId: null };
    }

    return {
        hide: true,
        taskSessionId: readTaskSessionId(message.parts[0]),
    };
};

const withSubtaskSessionId = (message: ChatMessageEntry, taskSessionId: string | null): ChatMessageEntry => {
    if (!taskSessionId) return message;
    const nextParts = message.parts.map((part) => {
        if (part?.type !== 'subtask') return part;
        const existing = (part as unknown as { taskSessionID?: unknown }).taskSessionID;
        if (typeof existing === 'string' && existing.trim().length > 0) return part;
        return {
            ...part,
            taskSessionID: taskSessionId,
        } as Part;
    });

    return {
        ...message,
        parts: nextParts,
    };
};

const withShellBridgeDetails = (message: ChatMessageEntry, details: ShellBridgeDetails | null): ChatMessageEntry => {
    const command = typeof details?.command === 'string' ? details.command.trim() : '';
    const output = typeof details?.output === 'string' ? details.output : '';
    const status = typeof details?.status === 'string' ? details.status.trim() : '';

    const nextParts: Part[] = [];
    let injected = false;

    for (const part of message.parts) {
        if (!injected && part?.type === 'text') {
            const text = (part as unknown as { text?: unknown }).text;
            const synthetic = (part as unknown as { synthetic?: unknown }).synthetic;
            if (synthetic === true && typeof text === 'string' && text.trim().startsWith(USER_SHELL_MARKER)) {
                nextParts.push({
                    type: 'text',
                    text: '/shell',
                    shellAction: {
                        ...(command ? { command } : {}),
                        ...(output ? { output } : {}),
                        ...(status ? { status } : {}),
                    },
                } as unknown as Part);
                injected = true;
                continue;
            }
        }
        nextParts.push(part);
    }

    if (!injected) {
        nextParts.push({
            type: 'text',
            text: '/shell',
            shellAction: {
                ...(command ? { command } : {}),
                ...(output ? { output } : {}),
                ...(status ? { status } : {}),
            },
        } as unknown as Part);
    }

    return {
        ...message,
        parts: nextParts,
    };
};

interface MessageListProps {
    sessionKey: string;
    disableStaging?: boolean;
    messages: ChatMessageEntry[];
    sessionIsWorking?: boolean;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    retryOverlay?: {
        sessionId: string;
        message: string;
        confirmedAt?: number;
        fallbackTimestamp?: number;
    } | null;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    isLoadingOlder: boolean;
    scrollToBottom?: () => void;
    scrollRef?: React.RefObject<HTMLDivElement | null>;
    directory?: string;
}

export interface MessageListHandle {
    scrollToTurnId: (turnId: string, options?: { behavior?: ScrollBehavior }) => boolean;
    scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior }) => boolean;
    captureViewportAnchor: () => { messageId: string; offsetTop: number } | null;
    restoreViewportAnchor: (anchor: { messageId: string; offsetTop: number }) => boolean;
    holdViewportAnchor: (anchor: { messageId: string; offsetTop: number }) => void;
    isHistoryVirtualized: () => boolean;
    scrollToBottom: () => void;
}

type RenderEntry =
    | {
        kind: 'ungrouped';
        key: string;
        message: ChatMessageEntry;
        previousMessage?: ChatMessageEntry;
        nextMessage?: ChatMessageEntry;
    }
    | { kind: 'history-gate'; key: string; turns: TurnRecord[] }
    | { kind: 'turn'; key: string; turn: TurnRecord; isLastTurn: boolean; nextEntryFirstMessage?: ChatMessageEntry };

interface MessageRowProps {
    message: ChatMessageEntry;
    previousMessage?: ChatMessageEntry;
    nextMessage?: ChatMessageEntry;
    turnGroupingContext?: TurnGroupingContext;
    assistantHeaderMessageId?: string;
    isInActiveTurn?: boolean;
    activeStreamingPhase?: StreamPhase | null;
    animateUserOnMount?: boolean;
    onUserAnimationConsumed?: (messageId: string) => void;
    onContentChange: (reason?: ContentChangeReason) => void;
    animationHandlers: AnimationHandlers;
    scrollToBottom?: () => void;
}

const MessageRow = React.memo<MessageRowProps>(({ 
    message,
    previousMessage,
    nextMessage,
    turnGroupingContext,
    assistantHeaderMessageId,
    isInActiveTurn,
    activeStreamingPhase,
    animateUserOnMount,
    onUserAnimationConsumed,
    onContentChange,
    animationHandlers,
    scrollToBottom,
}) => {
    const info = message.info as { role?: string; sessionID?: string; customType?: string; data?: unknown; details?: unknown; text?: string };

    // Extension-authored content renders through the extension card instead of
    // the user/assistant turn pipeline.
    if (info.role === 'extension') {
        return (
            <ExtensionMessageCard
                sessionId={info.sessionID}
                messageId={message.info.id}
                customType={info.customType}
                text={typeof info.text === 'string' ? info.text : undefined}
                data={info.data}
                details={info.details}
            />
        );
    }

    return (
        <ChatMessage
            message={message}
            previousMessage={previousMessage}
            nextMessage={nextMessage}
            animateUserOnMount={animateUserOnMount}
            onUserAnimationConsumed={onUserAnimationConsumed}
            onContentChange={onContentChange}
            animationHandlers={animationHandlers}
            scrollToBottom={scrollToBottom}
            turnGroupingContext={turnGroupingContext}
            assistantHeaderMessageId={assistantHeaderMessageId}
            isInActiveTurn={isInActiveTurn}
            activeStreamingPhase={activeStreamingPhase}
        />
    );
}, (prev, next) => {
    const prevTurn = prev.turnGroupingContext;
    const nextTurn = next.turnGroupingContext;

    return areRenderRelevantMessagesEqual(prev.message, next.message)
        && areOptionalNeighborMessagesEqual(prev.previousMessage, next.previousMessage)
        && areOptionalNeighborMessagesEqual(prev.nextMessage, next.nextMessage)
        && prev.animateUserOnMount === next.animateUserOnMount
        && prev.onUserAnimationConsumed === next.onUserAnimationConsumed
        && prev.onContentChange === next.onContentChange
        && prev.scrollToBottom === next.scrollToBottom
        && areRelevantTurnGroupingContextsEqual(prevTurn, nextTurn, prev.message.info.id, resolveMessageRole(prev.message) === 'user')
        && prev.assistantHeaderMessageId === next.assistantHeaderMessageId
        && prev.isInActiveTurn === next.isInActiveTurn
        && prev.activeStreamingPhase === next.activeStreamingPhase
        && prev.animationHandlers?.onChunk === next.animationHandlers?.onChunk
        && prev.animationHandlers?.onComplete === next.animationHandlers?.onComplete
        && prev.animationHandlers?.onStreamingCandidate === next.animationHandlers?.onStreamingCandidate
        && prev.animationHandlers?.onAnimationStart === next.animationHandlers?.onAnimationStart
        && prev.animationHandlers?.onReservationCancelled === next.animationHandlers?.onReservationCancelled
        && prev.animationHandlers?.onReasoningBlock === next.animationHandlers?.onReasoningBlock
        && prev.animationHandlers?.onAnimatedHeightChange === next.animationHandlers?.onAnimatedHeightChange;
});

MessageRow.displayName = 'MessageRow';

interface TurnBlockProps {
    turn: TurnRecord;
    isLastTurn: boolean;
    nextEntryFirstMessage?: ChatMessageEntry;
    /** Catalog busy is still passed through, but last-turn `isWorking` follows the live stream id. */
    sessionIsWorking: boolean;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: () => void;
    stickyUserHeader?: boolean;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
}

const TurnBlock = React.memo(({
    turn,
    isLastTurn,
    nextEntryFirstMessage,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    stickyUserHeader = true,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
}: TurnBlockProps) => {
    const userMessageHidden = React.useMemo(
        () => isHiddenUserMessage(turn.userMessage),
        [turn.userMessage]
    );

    const messageOrder = React.useMemo(() => {
        const ordered = [turn.userMessage, ...turn.assistantMessages];
        const lookup = new Map<string, number>();
        ordered.forEach((message, index) => {
            lookup.set(message.info.id, index);
        });
        return { ordered, lookup };
    }, [turn.assistantMessages, turn.userMessage]);

    const streamingAssistantMessageId = React.useMemo(
        () => resolveTurnStreamingAssistantId({
            activeStreamingMessageId,
            assistantMessages: turn.assistantMessages,
        }),
        [activeStreamingMessageId, turn.assistantMessages],
    );

    const visibleAssistantMessages = turn.assistantMessages;

    const visibleAssistantIds = React.useMemo(() => {
        const ids = new Map<string, number>();
        visibleAssistantMessages.forEach((assistant, index) => {
            ids.set(assistant.info.id, index);
        });
        return ids;
    }, [visibleAssistantMessages]);

    const turnIsInActiveStream = React.useMemo(() => {
        return turnContainsMessageId(turn, streamingAssistantMessageId);
    }, [turn, streamingAssistantMessageId]);

    const activityOwnerMessageId = React.useMemo(() => {
        if (turnIsInActiveStream && streamingAssistantMessageId) {
            return streamingAssistantMessageId;
        }
        return visibleAssistantMessages[0]?.info.id;
    }, [streamingAssistantMessageId, turnIsInActiveStream, visibleAssistantMessages]);

    const visibleActivityParts = turn.activityParts;
    const visibleActivitySegments = turn.activitySegments;

    const turnGroupingContextBase = React.useMemo(() => {
        const userCreatedAt = (turn.userMessage.info.time as { created?: number } | undefined)?.created;
        // OpenCode 1.4.0 moved variant from top-level to model.variant on UserMessage.
        // Prefer the new location, fall back to the legacy one for older servers.
        const info = turn.userMessage.info as { variant?: unknown; model?: { variant?: unknown } } | undefined;
        const rawVariant = info?.model?.variant ?? info?.variant;
        const userMessageVariant = typeof rawVariant === 'string' && rawVariant.trim().length > 0
            ? rawVariant
            : undefined;
        return {
            turnId: turn.turnId,
            summaryBody: turn.summaryText,
            activityParts: visibleActivityParts,
            activityGroupSegments: visibleActivitySegments,
            headerMessageId: turn.headerMessageId,
            hasTools: turn.hasTools,
            hasReasoning: turn.hasReasoning,
            diffStats: turn.diffStats,
            changedFiles: turn.changedFiles,
            userMessageCreatedAt: typeof userCreatedAt === 'number' ? userCreatedAt : undefined,
            userMessageVariant,
        };
    }, [turn.changedFiles, turn.diffStats, turn.hasReasoning, turn.hasTools, turn.headerMessageId, turn.summaryText, turn.turnId, turn.userMessage.info, visibleActivityParts, visibleActivitySegments]);

    const renderMessage = React.useCallback(
        (message: ChatMessageEntry) => {
            const messageRole = resolveMessageRole(message);
            const isUserMessage = messageRole === 'user';
            const messageIndex = messageOrder.lookup.get(message.info.id);
            const assistantIndex = visibleAssistantIds.get(message.info.id) ?? -1;
            const isAssistantMessage = assistantIndex >= 0;
            const isFirstAssistant = assistantIndex === 0;
            const isLastAssistant = assistantIndex === visibleAssistantMessages.length - 1;
            const isActivityOwner = Boolean(activityOwnerMessageId) && message.info.id === activityOwnerMessageId;
            const shouldAttachFullTurnContext = isActivityOwner || isFirstAssistant || isLastAssistant;
            const assistantHeaderMessageId = visibleAssistantMessages[0]?.info.id ?? turn.headerMessageId;

            const previousMessage = isUserMessage
                ? undefined
                : (isAssistantMessage
                    ? (isFirstAssistant
                        ? turn.userMessage
                        : undefined)
                    : (typeof messageIndex === 'number' && messageIndex > 0
                        ? messageOrder.ordered[messageIndex - 1]
                        : undefined));
            const nextMessage = isAssistantMessage && isLastAssistant ? nextEntryFirstMessage : undefined;

            const turnGroupingContext = isAssistantMessage
                ? {
                    turnId: turn.turnId,
                    activityOwnerMessageId,
                    isFirstAssistantInTurn: isFirstAssistant,
                    isLastAssistantInTurn: isLastAssistant,
                    isLatestTurn: isLastTurn,
                    isWorking: isTurnAssistantWorking({
                        messageId: message.info.id,
                        activeStreamingMessageId,
                    }),
                    hasTools: turn.hasTools,
                    hasReasoning: turn.hasReasoning,
                    ...(shouldAttachFullTurnContext ? {
                        summaryBody: turnGroupingContextBase.summaryBody,
                        activityParts: turnGroupingContextBase.activityParts,
                        activityGroupSegments: turnGroupingContextBase.activityGroupSegments,
                        headerMessageId: turnGroupingContextBase.headerMessageId,
                        diffStats: turnGroupingContextBase.diffStats,
                        changedFiles: turnGroupingContextBase.changedFiles,
                        userMessageCreatedAt: turnGroupingContextBase.userMessageCreatedAt,
                        userMessageVariant: turnGroupingContextBase.userMessageVariant,
                    } : {}),
                } satisfies TurnGroupingContext
                : undefined;

            return (
                <MessageRow
                    key={message.info.id}
                    message={message}
                    previousMessage={previousMessage}
                    nextMessage={nextMessage}
                    turnGroupingContext={turnGroupingContext}
                    assistantHeaderMessageId={assistantHeaderMessageId}
                    isInActiveTurn={Boolean(streamingAssistantMessageId) && message.info.id === streamingAssistantMessageId}
                    activeStreamingPhase={message.info.id === streamingAssistantMessageId ? activeStreamingPhase : null}
                            animateUserOnMount={shouldAnimateUserMessage(message)}
                    onUserAnimationConsumed={onUserAnimationConsumed}
                    onContentChange={onMessageContentChange}
                    animationHandlers={getAnimationHandlers(message.info.id)}
                    scrollToBottom={scrollToBottom}
                />
            );
        },
        [
            getAnimationHandlers,
            isLastTurn,
            nextEntryFirstMessage,
            messageOrder.lookup,
            messageOrder.ordered,
            onMessageContentChange,
            scrollToBottom,
            turn.headerMessageId,
            turn.hasReasoning,
            turn.hasTools,
            turn.turnId,
            turn.userMessage,
            turnGroupingContextBase,
            streamingAssistantMessageId,
            activeStreamingMessageId,
            activeStreamingPhase,
            visibleAssistantMessages,
            visibleAssistantIds,
            activityOwnerMessageId,
            shouldAnimateUserMessage,
            onUserAnimationConsumed,
        ]
    );

    return (
        <TurnItem
            turn={turn}
            stickyUserHeader={stickyUserHeader && !userMessageHidden}
            renderMessage={renderMessage}
        />
    );
});

TurnBlock.displayName = 'TurnBlock';

interface UngroupedMessageRowProps {
    message: ChatMessageEntry;
    previousMessage?: ChatMessageEntry;
    nextMessage?: ChatMessageEntry;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: () => void;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
}

const UngroupedMessageRow = React.memo(({
    message,
    previousMessage,
    nextMessage,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
}: UngroupedMessageRowProps) => {
    return (
        <MessageRow
            message={message}
            previousMessage={previousMessage}
            nextMessage={nextMessage}
            animateUserOnMount={shouldAnimateUserMessage(message)}
            onUserAnimationConsumed={onUserAnimationConsumed}
            onContentChange={onMessageContentChange}
            animationHandlers={getAnimationHandlers(message.info.id)}
            scrollToBottom={scrollToBottom}
            isInActiveTurn={Boolean(activeStreamingMessageId) && message.info.id === activeStreamingMessageId}
            activeStreamingPhase={message.info.id === activeStreamingMessageId ? activeStreamingPhase : null}
        />
    );
});

UngroupedMessageRow.displayName = 'UngroupedMessageRow';

interface MessageListEntryProps {
    entry: RenderEntry;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: () => void;
    stickyUserHeader?: boolean;
    sessionIsWorking: boolean;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
    onLoadOlderHistory?: (foldedCount: number) => void;
    onLoadAllHistory?: (foldedCount: number) => void;
}

const turnContainsMessageId = (turn: TurnRecord, messageId: string | null | undefined): boolean => {
    if (!messageId) {
        return false;
    }

    if (turn.userMessage.info.id === messageId) {
        return true;
    }

    return turn.assistantMessages.some((assistant) => assistant.info.id === messageId);
};

const MessageListEntry = React.memo(({
    entry,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    stickyUserHeader,
    sessionIsWorking,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
    onLoadOlderHistory,
    onLoadAllHistory,
}: MessageListEntryProps) => {
    streamPerfCount('ui.message_list_entry.render');
    if (entry.kind === 'ungrouped') {
        return (
            <UngroupedMessageRow
                message={entry.message}
                previousMessage={entry.previousMessage}
                nextMessage={entry.nextMessage}
                onMessageContentChange={onMessageContentChange}
                getAnimationHandlers={getAnimationHandlers}
                scrollToBottom={scrollToBottom}
                shouldAnimateUserMessage={shouldAnimateUserMessage}
                onUserAnimationConsumed={onUserAnimationConsumed}
                activeStreamingMessageId={activeStreamingMessageId}
                activeStreamingPhase={activeStreamingPhase}
                />
        );
    }

    if (entry.kind === 'history-gate') {
        return (
            <FoldedHistoryGate
                foldedCount={entry.turns.length}
                onLoadOlder={() => onLoadOlderHistory?.(entry.turns.length)}
                onLoadAll={() => onLoadAllHistory?.(entry.turns.length)}
            />
        );
    }

    return (
        <TurnBlock
            turn={entry.turn}
            isLastTurn={entry.isLastTurn}
            nextEntryFirstMessage={entry.nextEntryFirstMessage}
            sessionIsWorking={sessionIsWorking}
            shouldAnimateUserMessage={shouldAnimateUserMessage}
            onUserAnimationConsumed={onUserAnimationConsumed}
            activeStreamingMessageId={activeStreamingMessageId}
            activeStreamingPhase={activeStreamingPhase}
            onMessageContentChange={onMessageContentChange}
            getAnimationHandlers={getAnimationHandlers}
            scrollToBottom={scrollToBottom}
            stickyUserHeader={stickyUserHeader}
        />
    );
});

MessageListEntry.displayName = 'MessageListEntry';

// Inner component that renders staged turn entries.
type StaticHistoryListProps = {
    entries: RenderEntry[];
    engine: HistoryEngine;
    contentRef: React.RefObject<HTMLDivElement | null>;
    scrollRef?: React.RefObject<HTMLDivElement | null>;
    registerTanstackVirtualizer?: (virtualizer: TanstackVirtualizerInstance | null) => void;
    virtualizerKey: string;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: () => void;
    stickyUserHeader: boolean;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    onLoadOlderHistory: (foldedCount: number) => void;
    onLoadAllHistory: (foldedCount: number) => void;
};

type RevealViewportSnapshot = {
    top: number;
    height: number;
    anchor: {
        messageId: string;
        offsetTop: number;
    } | null;
};

const StaticHistoryList = React.memo(({ entries, engine, contentRef, scrollRef, registerTanstackVirtualizer, virtualizerKey, onMessageContentChange, getAnimationHandlers, scrollToBottom, stickyUserHeader, shouldAnimateUserMessage, onUserAnimationConsumed, onLoadOlderHistory, onLoadAllHistory, }: StaticHistoryListProps) => {
    const isTanstack = engine === 'tanstack';

    // --- Quiet-window prepend (mobile) --------------------------------------
    // Gesture tracking for the deferred-prepend decision. Refs only: reading
    // them never re-renders, and the render-phase reconcile below needs them.
    const touchActiveRef = React.useRef(false);
    const lastScrollAtRef = React.useRef(0);
    const holdSinceRef = React.useRef<number | null>(null);
    const deferPrepends = isTanstack && isMobileSurfaceRuntime();

    React.useEffect(() => {
        if (!deferPrepends) return;
        const element = scrollRef?.current;
        if (!element) return;
        const onTouchStart = () => { touchActiveRef.current = true; };
        const onTouchEnd = () => { touchActiveRef.current = false; };
        const onScroll = () => { lastScrollAtRef.current = performance.now(); };
        element.addEventListener('touchstart', onTouchStart, { passive: true });
        element.addEventListener('touchend', onTouchEnd, { passive: true });
        element.addEventListener('touchcancel', onTouchEnd, { passive: true });
        element.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            element.removeEventListener('touchstart', onTouchStart);
            element.removeEventListener('touchend', onTouchEnd);
            element.removeEventListener('touchcancel', onTouchEnd);
            element.removeEventListener('scroll', onScroll);
        };
    }, [deferPrepends, scrollRef]);

    const isGestureActive = React.useCallback(() => (
        touchActiveRef.current
        || performance.now() - lastScrollAtRef.current < HISTORY_PREPEND_QUIET_MS
    ), []);

    const isNearTop = React.useCallback(() => {
        const element = scrollRef?.current;
        if (!element) return true;
        return element.scrollTop < element.clientHeight * HISTORY_PREPEND_NEAR_TOP_VIEWPORTS;
    }, [scrollRef]);

    const [displayEntries, setDisplayEntries] = React.useState(entries);
    // Render-phase reconcile (official derived-state pattern): adopt the new
    // entries immediately unless this commit is a pure prepend-above landing
    // in the middle of an active touch gesture — those wait for quiet.
    let renderEntries = displayEntries;
    if (entries !== displayEntries) {
        const shouldHold = deferPrepends
            && isPrependAboveCommit(displayEntries, entries)
            && isGestureActive()
            && !isNearTop()
            && (holdSinceRef.current === null
                || performance.now() - holdSinceRef.current < HISTORY_PREPEND_MAX_HOLD_MS);
        if (shouldHold) {
            if (holdSinceRef.current === null) holdSinceRef.current = performance.now();
        } else {
            holdSinceRef.current = null;
            setDisplayEntries(entries);
            renderEntries = entries;
        }
    } else if (holdSinceRef.current !== null) {
        holdSinceRef.current = null;
    }

    // While a prepend is held, poll for the quiet window (touch/momentum have
    // no completion event we can await) and flush by re-rendering.
    const [, forceFlushTick] = React.useReducer((tick: number) => tick + 1, 0);
    React.useEffect(() => {
        if (!deferPrepends) return;
        const timer = window.setInterval(() => {
            if (holdSinceRef.current === null) return;
            const expired = performance.now() - holdSinceRef.current >= HISTORY_PREPEND_MAX_HOLD_MS;
            if (!isGestureActive() || isNearTop() || expired) {
                forceFlushTick();
            }
        }, HISTORY_PREPEND_MONITOR_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [deferPrepends, isGestureActive, isNearTop]);

    const entriesRef = React.useRef(renderEntries);
    entriesRef.current = renderEntries;
    // Initial-only read: measurement cache restore is a mount-time concern;
    // afterwards the live virtualizer owns measurements.
    const [initialMeasurements] = React.useState(() => (
        isTanstack
            ? readTanstackTimelineCache(virtualizerKey, entries.map((entry) => entry.key))
            : undefined
    ));

    const sizeContainerRef = React.useRef<HTMLDivElement | null>(null);
    // Adaptive estimate: rows this session has actually measured are a far
    // better predictor for the still-unmeasured ones than a fixed constant.
    // Smaller estimate error → smaller anchor corrections when prepended rows
    // measure in → less visible drift. The ref keeps estimateSize's identity
    // stable so updating the average never triggers a global remeasure.
    const estimatedEntrySizeRef = React.useRef(TANSTACK_ESTIMATED_ENTRY_SIZE);
    const [scrollElement, setScrollElement] = React.useState<HTMLDivElement | null>(null);
    React.useLayoutEffect(() => {
        if (!isTanstack) {
            setScrollElement((previous) => (previous === null ? previous : null));
            return;
        }

        let observer: ResizeObserver | undefined;
        let frame = 0;
        const adopt = (): boolean => {
            const next = scrollRef?.current ?? null;
            if (!isMeasurableScrollElement(next)) return false;
            setScrollElement((previous) => (previous === next ? previous : next));
            return true;
        };

        if (adopt()) return;

        const target = scrollRef?.current;
        if (target) {
            observer = new ResizeObserver(() => {
                if (adopt()) observer?.disconnect();
            });
            observer.observe(target);
        } else if (typeof window !== 'undefined') {
            frame = window.requestAnimationFrame(() => {
                if (adopt()) return;
                const late = scrollRef?.current;
                if (!late) return;
                observer = new ResizeObserver(() => {
                    if (adopt()) observer?.disconnect();
                });
                observer.observe(late);
            });
        }

        return () => {
            if (frame) window.cancelAnimationFrame(frame);
            observer?.disconnect();
        };
    }, [isTanstack, scrollRef, virtualizerKey]);
    const virtualizerReady = isTanstack && isMeasurableScrollElement(scrollElement);
    const tanstackVirtualizer = useTanstackVirtualizer<HTMLDivElement, HTMLDivElement>({
        count: renderEntries.length,
        enabled: virtualizerReady,
        getScrollElement: () => scrollElement,
        estimateSize: (index) => (
            entriesRef.current[index]?.kind === 'history-gate'
                ? HISTORY_GATE_ESTIMATED_SIZE
                : estimatedEntrySizeRef.current
        ),
        overscan: resolveTanstackOverscan(),
        scrollToFn: (offset, options, instance) => {
            // Expose the new total height before core writes an anchor
            // correction so the browser does not clamp the offset to the old
            // height.
            const sizeElement = sizeContainerRef.current;
            if (sizeElement) sizeElement.style.height = `${instance.getTotalSize()}px`;
            elementScroll(offset, options, instance);
        },
        getItemKey: (index) => entriesRef.current[index]?.key ?? `index:${index}`,
        // Bottom-anchored chat semantics: prepending older entries above the
        // viewport must not move what the user is reading, and iOS-specific
        // touch/momentum deferral for those adjustments lives in the core.
        anchorTo: 'end',
        initialOffset: () => Number.MAX_SAFE_INTEGER,
        initialMeasurementsCache: initialMeasurements,
    });
    // Only compensate scroll for rows growing ABOVE the viewport (history
    // remeasures, prepended pages). A row growing inside the viewport —
    // expanding a tool call or thinking block — must grow DOWNWARD naturally;
    // the end-anchored default made it expand upward. At the bottom,
    // app-level auto-follow owns pinning, so skip there too instead of
    // double-writing. (This is an instance field, not a constructor option.)
    tanstackVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
        if (instance.isAtEnd(TANSTACK_AT_END_THRESHOLD_PX)) return false;
        const firstVisibleIndex = instance.range?.startIndex;
        return firstVisibleIndex !== undefined && item.index < firstVisibleIndex;
    };

    React.useEffect(() => {
        if (!isTanstack) return;
        const sizes = tanstackVirtualizer.itemSizeCache;
        if (sizes.size >= TANSTACK_ESTIMATE_MIN_SAMPLES) {
            let total = 0;
            for (const size of sizes.values()) total += size;
            estimatedEntrySizeRef.current = Math.min(
                TANSTACK_ESTIMATE_MAX,
                Math.max(TANSTACK_ESTIMATE_MIN, Math.round(total / sizes.size)),
            );
        }
    });

    React.useEffect(() => {
        if (!virtualizerReady) return;
        registerTanstackVirtualizer?.(tanstackVirtualizer);
        return () => {
            writeTanstackTimelineCache(
                virtualizerKey,
                entriesRef.current.map((entry) => entry.key),
                tanstackVirtualizer,
            );
            registerTanstackVirtualizer?.(null);
        };
    }, [virtualizerReady, registerTanstackVirtualizer, tanstackVirtualizer, virtualizerKey]);

    const renderEntry = React.useCallback((entry: RenderEntry) => {
        return (
            <MessageListEntry
                key={entry.key}
                entry={entry}
                onMessageContentChange={onMessageContentChange}
                getAnimationHandlers={getAnimationHandlers}
                scrollToBottom={scrollToBottom}
                stickyUserHeader={stickyUserHeader}
                sessionIsWorking={false}
                shouldAnimateUserMessage={shouldAnimateUserMessage}
                onUserAnimationConsumed={onUserAnimationConsumed}
                activeStreamingMessageId={null}
                activeStreamingPhase={null}
                onLoadOlderHistory={onLoadOlderHistory}
                onLoadAllHistory={onLoadAllHistory}
                />
        );
    }, [getAnimationHandlers, onLoadAllHistory, onLoadOlderHistory, onMessageContentChange, onUserAnimationConsumed, scrollToBottom, shouldAnimateUserMessage, stickyUserHeader]);

    if (engine === 'none' || (engine === 'tanstack' && !virtualizerReady)) {
        // At most one pre-paint frame while the forwarded scroller is still
        // 0×0. Rendering the plain rows keeps history visible and gives the
        // scroller a real height so TanStack never attaches to an empty rect.
        return (
            <div ref={contentRef} className="relative w-full">
                {renderEntries.map((entry) => (
                    <div
                        key={entry.key}
                        data-turn-entry={entry.key}
                    >
                        {renderEntry(entry)}
                    </div>
                ))}
            </div>
        );
    }

    if (engine === 'tanstack') {
        const virtualItems = tanstackVirtualizer.getVirtualItems();
        const startOffset = virtualItems[0]?.start ?? 0;
        // Rendered rows stay in normal flow inside a single offset wrapper (not
        // per-row absolute positioning) so per-turn sticky user headers keep
        // working against the scroll container. The offset MUST be padding, not
        // transform: a transformed ancestor becomes the sticky containing block,
        // so headers would stick to the wrapper's (arbitrary, overscan-dependent)
        // top edge mid-list and float over the previous turn. Padding only
        // changes when the virtual window shifts — not per scroll frame — so the
        // layout cost is negligible.
        return (
            <div ref={sizeContainerRef} className="relative w-full" style={{ height: tanstackVirtualizer.getTotalSize() }}>
                <div style={{ paddingTop: `${startOffset}px` }}>
                    {virtualItems.map((item) => {
                        const entry = renderEntries[item.index];
                        if (!entry) return null;
                        return (
                            <div
                                key={entry.key}
                                data-index={item.index}
                                ref={tanstackVirtualizer.measureElement}
                                data-turn-entry={entry.key}
                            >
                                {renderEntry(entry)}
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    }

    return null;
});

StaticHistoryList.displayName = 'StaticHistoryList';

const StreamingTailContent: React.FC<{
    entry: StreamingTailEntry;
    sessionId: string | null;
    directory?: string;
    onMessageContentChange: (reason?: ContentChangeReason) => void;
    getAnimationHandlers: (messageId: string) => AnimationHandlers;
    scrollToBottom?: () => void;
    stickyUserHeader: boolean;
    sessionIsWorking: boolean;
    showTurnChangedFiles: boolean;
    shouldAnimateUserMessage: (message: ChatMessageEntry) => boolean;
    onUserAnimationConsumed: (messageId: string) => void;
    activeStreamingMessageId?: string | null;
    activeStreamingPhase?: StreamPhase | null;
}> = ({
    entry,
    sessionId,
    directory,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    stickyUserHeader,
    sessionIsWorking,
    showTurnChangedFiles,
    shouldAnimateUserMessage,
    onUserAnimationConsumed,
    activeStreamingMessageId,
    activeStreamingPhase,
}) => {
    const liveParts = useSessionParts(sessionId, activeStreamingMessageId ?? '', directory);
    const liveEntry = React.useMemo(() => buildLiveStreamingEntry(entry, {
        activeStreamingMessageId,
        liveParts,
        showTextJustificationActivity: false,
        showTurnChangedFiles,
        mergeHiddenUserTurns: true,
    }), [activeStreamingMessageId, entry, liveParts, showTurnChangedFiles]);

    return (
        <MessageListEntry
            entry={liveEntry}
            onMessageContentChange={onMessageContentChange}
            getAnimationHandlers={getAnimationHandlers}
            scrollToBottom={scrollToBottom}
            stickyUserHeader={stickyUserHeader}
            sessionIsWorking={sessionIsWorking}
            shouldAnimateUserMessage={shouldAnimateUserMessage}
            onUserAnimationConsumed={onUserAnimationConsumed}
            activeStreamingMessageId={activeStreamingMessageId}
            activeStreamingPhase={activeStreamingPhase}
        />
    );
};

StreamingTailContent.displayName = 'StreamingTailContent';

const MessageList = React.forwardRef<MessageListHandle, MessageListProps>(({
    sessionKey,
    messages,
    sessionIsWorking = false,
    activeStreamingMessageId = null,
    activeStreamingPhase = null,
    retryOverlay = null,
    onMessageContentChange,
    getAnimationHandlers,
    scrollToBottom,
    scrollRef,
    directory,
}, ref) => {
    streamPerfMark('react.message_list_render');
    streamPerfCount('ui.message_list.render');
    const stickyUserHeader = useUIStore(state => state.stickyUserHeader);
    const showTurnChangedFiles = useUIStore((state) => state.showTurnChangedFiles);
    const [revealedOlderCount, setRevealedOlderCount] = React.useState<number>(
        () => readRevealedOlderTurns(sessionKey),
    );
    const pendingRevealViewportRef = React.useRef<RevealViewportSnapshot | null>(null);
    const pendingExpandedTurnScrollRef = React.useRef<string | null>(null);
    const captureRevealViewport = React.useCallback((): RevealViewportSnapshot | null => {
        const container = scrollRef?.current;
        if (!container) return null;

        const containerRect = container.getBoundingClientRect();
        const visibleMessage = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'))
            .find((node) => {
                const rect = node.getBoundingClientRect();
                return rect.bottom > containerRect.top + 1
                    && !isInsideStuckSticky(node, container, containerRect.top);
            });

        return {
            top: container.scrollTop,
            height: container.scrollHeight,
            anchor: visibleMessage?.dataset.messageId
                ? {
                    messageId: visibleMessage.dataset.messageId,
                    offsetTop: visibleMessage.getBoundingClientRect().top - containerRect.top,
                }
                : null,
        };
    }, [scrollRef]);
    const setRevealedOlderTurns = React.useCallback((value: number | ((current: number) => number)) => {
        setRevealedOlderCount((current) => {
            const next = typeof value === 'function' ? value(current) : value;
            writeRevealedOlderTurns(sessionKey, next);
            return next;
        });
    }, [sessionKey]);
    const loadOlderHistory = React.useCallback((foldedCount: number) => {
        pendingRevealViewportRef.current = captureRevealViewport();
        setRevealedOlderTurns((current) => nextRevealedOlderCount(current, foldedCount));
    }, [captureRevealViewport, setRevealedOlderTurns]);
    const loadAllHistory = React.useCallback((foldedCount: number) => {
        pendingRevealViewportRef.current = captureRevealViewport();
        setRevealedOlderTurns((current) => current + foldedCount);
    }, [captureRevealViewport, setRevealedOlderTurns]);
    const revealFoldedTurn = React.useCallback((turnId: string, foldedTurns: readonly TurnRecord[], historyTurnCount: number) => {
        const ordinal = foldedTurns.findIndex((turn) => turn.turnId === turnId);
        if (ordinal < 0) return;
        pendingExpandedTurnScrollRef.current = turnId;
        setRevealedOlderTurns((current) => Math.max(current, revealedCountForTurn(ordinal, historyTurnCount)));
    }, [setRevealedOlderTurns]);
    React.useLayoutEffect(() => {
        setRevealedOlderCount(readRevealedOlderTurns(sessionKey));
        pendingExpandedTurnScrollRef.current = null;
    }, [sessionKey]);
    const userAnimationRef = React.useRef<{
        sessionKey: string | undefined;
        previousOrder: string[];
        animatedIds: Set<string>;
    }>({ sessionKey: undefined, previousOrder: [], animatedIds: new Set() });
    const stableGetAnimationHandlers = useStableEvent(getAnimationHandlers);
    const stableScrollToBottom = useStableEvent(() => {
        scrollToBottom?.();
    });

    const baseDisplayMessages = React.useMemo(() => streamPerfMeasure('ui.message_list.base_display_ms', () => {
        const seenIds = new Set<string>();
        const latestById = new Map<string, ChatMessageEntry>();
        const dedupedMessages: ChatMessageEntry[] = [];
        for (const message of messages) {
            const messageId = message.info?.id;
            if (typeof messageId === 'string') latestById.set(messageId, message);
        }

        // Preserve the first occurrence's chronological position, but use the last
        // value because prepended history can overlap with newer live store data.
        for (let index = 0; index < messages.length; index += 1) {
            const message = messages[index];
            const messageId = message.info?.id;
            if (typeof messageId === 'string') {
                if (seenIds.has(messageId)) {
                    continue;
                }
                seenIds.add(messageId);
            }
            dedupedMessages.push(getNormalizedMessageForDisplay(
                typeof messageId === 'string' ? latestById.get(messageId) ?? message : message,
            ));
        }

        const output: ChatMessageEntry[] = [];
        const compactionCommandIds = new Set<string>();
        for (let index = 0; index < dedupedMessages.length; index += 1) {
            const current = dedupedMessages[index];
            const currentWithRole = normalizeCompactionSummaryMessage(current, compactionCommandIds);
            if (hasCompactionPart(current) || current.parts.some((part) => part.type === 'text' && getPartText(part).trim() === '/compact')) {
                compactionCommandIds.add(current.info.id);
            }
            const previous = output.length > 0 ? output[output.length - 1] : undefined;

            if (isUserSubtaskMessage(previous)) {
                const bridge = isSyntheticSubtaskBridgeAssistant(currentWithRole);
                if (bridge.hide) {
                    output[output.length - 1] = withSubtaskSessionId(previous as ChatMessageEntry, bridge.taskSessionId);
                    continue;
                }
            }

            if (isUserShellMarkerMessage(previous)) {
                const bridge = getShellBridgeAssistantDetails(currentWithRole, getMessageId(previous));
                if (bridge.hide) {
                    output[output.length - 1] = withShellBridgeDetails(previous as ChatMessageEntry, bridge.details);
                    continue;
                }
            }

            output.push(currentWithRole);
        }

        return output;
    }), [messages]);

    const historyContentRef = React.useRef<HTMLDivElement | null>(null);
    const resolveScrollContainer = React.useCallback((): HTMLDivElement | null => {
        if (scrollRef?.current) {
            return scrollRef.current;
        }
        if (typeof document === 'undefined') {
            return null;
        }
        return document.querySelector<HTMLDivElement>('[data-scrollbar="chat"]');
    }, [scrollRef]);

    const displayMessages = React.useMemo(() => streamPerfMeasure('ui.message_list.retry_overlay_ms', () => {
        return applyRetryOverlay(baseDisplayMessages, {
            sessionId: retryOverlay?.sessionId ?? null,
            message: retryOverlay?.message ?? 'Quota limit reached. Retrying automatically.',
            confirmedAt: retryOverlay?.confirmedAt,
            fallbackTimestamp: retryOverlay?.fallbackTimestamp ?? 0,
        });
    }), [baseDisplayMessages, retryOverlay]);

    const { projection, staticTurns, streamingTurn } = useTurnRecords(displayMessages, {
        sessionKey,
        showTextJustificationActivity: false,
        showTurnChangedFiles,
    });
    const hasUngroupedStaticEntries = projection.ungroupedMessageIds.size > 0;
    const staticEntryMessages = hasUngroupedStaticEntries ? displayMessages : EMPTY_STATIC_ENTRY_MESSAGES;
    const staticEntryUngroupedIds = hasUngroupedStaticEntries ? projection.ungroupedMessageIds : EMPTY_UNGROUPED_MESSAGE_IDS;
    const staticRenderEntries = React.useMemo<RenderEntry[]>(() => streamPerfMeasure('ui.message_list.render_entries_ms', () => {
        const turnEntries = staticTurns.map((turn) => ({
            kind: 'turn' as const,
            key: `turn:${turn.turnId}`,
            turn,
            isLastTurn: turn.turnId === projection.lastTurnId,
        }));

        if (staticEntryUngroupedIds.size === 0) {
            return turnEntries;
        }

        const turnEntryByUserMessageId = new Map<string, RenderEntry>();
        turnEntries.forEach((entry) => {
            turnEntryByUserMessageId.set(entry.turn.userMessage.info.id, entry);
        });

        const orderedEntries: RenderEntry[] = [];
        staticEntryMessages.forEach((message, index) => {
            const turnEntry = turnEntryByUserMessageId.get(message.info.id);
            if (turnEntry) {
                orderedEntries.push(turnEntry);
                return;
            }

            if (!staticEntryUngroupedIds.has(message.info.id)) {
                return;
            }

            orderedEntries.push({
                kind: 'ungrouped',
                key: `msg:${message.info.id}`,
                message,
                previousMessage: index > 0 ? staticEntryMessages[index - 1] : undefined,
                nextMessage: index < staticEntryMessages.length - 1 ? staticEntryMessages[index + 1] : undefined,
            });
        });

        return orderedEntries;
    }), [projection.lastTurnId, staticEntryMessages, staticEntryUngroupedIds, staticTurns]);

    const trailingStreamingEntry = React.useMemo<StreamingTailEntry | undefined>(() => {
        if (streamingTurn) {
            return {
                kind: 'turn',
                key: `turn:${streamingTurn.turnId}`,
                turn: streamingTurn,
                isLastTurn: streamingTurn.turnId === projection.lastTurnId,
            } satisfies StreamingTailEntry;
        }

        if (projection.ungroupedMessageIds.size === 0) {
            return undefined;
        }

        const lastMessage = displayMessages[displayMessages.length - 1];
        if (!lastMessage || !projection.ungroupedMessageIds.has(lastMessage.info.id)) {
            return undefined;
        }

        return {
            kind: 'ungrouped',
            key: `msg:${lastMessage.info.id}`,
            message: lastMessage,
            previousMessage: displayMessages.length > 1 ? displayMessages[displayMessages.length - 2] : undefined,
            nextMessage: undefined,
        } satisfies StreamingTailEntry;
    }, [displayMessages, projection.lastTurnId, projection.ungroupedMessageIds, streamingTurn]);

    if (trailingStreamingEntry) {
        streamPerfCount('ui.message_list.render.streaming');
    }

    // Depend on the trailing entry's first message (stable while its assistant
    // streams), not the trailing entry itself, so streaming updates do not
    // recreate every static entry and re-render every turn block.
    const trailingEntryFirstMessage = trailingStreamingEntry
        ? (trailingStreamingEntry.kind === 'turn' ? trailingStreamingEntry.turn.userMessage : trailingStreamingEntry.message)
        : undefined;
    const historyEntries = React.useMemo<RenderEntry[]>(() => {
        const withNextMessage = staticRenderEntries.map((entry, index) => {
            if (entry.kind !== 'turn') {
                return entry;
            }
            const nextEntryFirstMessage = index < staticRenderEntries.length - 1
                ? (() => {
                    const nextEntry = staticRenderEntries[index + 1];
                    return nextEntry && nextEntry.kind === 'turn'
                        ? nextEntry.turn.userMessage
                        : nextEntry?.kind === 'ungrouped' ? nextEntry.message : undefined;
                })()
                : trailingEntryFirstMessage;
            if (!nextEntryFirstMessage) {
                return entry;
            }
            return { ...entry, nextEntryFirstMessage };
        });
        let historyTurnCount = 0;
        for (const entry of withNextMessage) {
            if (entry.kind === 'turn') historyTurnCount += 1;
        }
        let turnOrdinal = -1;
        const foldedTurns: TurnRecord[] = [];
        const visible: RenderEntry[] = [];
        for (const entry of withNextMessage) {
            if (entry.kind !== 'turn') {
                visible.push(entry);
                continue;
            }
            turnOrdinal += 1;
            if (shouldFoldHistoryTurn(turnOrdinal, historyTurnCount, revealedOlderCount)) {
                foldedTurns.push(entry.turn);
                continue;
            }
            visible.push(entry);
        }
        if (foldedTurns.length === 0) return visible;
        return [
            { kind: 'history-gate' as const, key: 'history-gate', turns: foldedTurns },
            ...visible,
        ];
    }, [revealedOlderCount, staticRenderEntries, trailingEntryFirstMessage]);
    React.useLayoutEffect(() => {
        const revealSnapshot = pendingRevealViewportRef.current;
        if (revealSnapshot) {
            pendingRevealViewportRef.current = null;
            const container = scrollRef?.current;
            if (container) {
                const anchor = revealSnapshot.anchor?.messageId
                    ? container.querySelector<HTMLElement>(`[data-message-id="${revealSnapshot.anchor.messageId}"]`)
                    : null;
                if (anchor && revealSnapshot.anchor) {
                    const containerRect = container.getBoundingClientRect();
                    const delta = anchor.getBoundingClientRect().top
                        - containerRect.top
                        - revealSnapshot.anchor.offsetTop;
                    if (delta !== 0) {
                        container.scrollTop += delta;
                    }
                } else {
                    const heightDelta = container.scrollHeight - revealSnapshot.height;
                    if (heightDelta > 0) {
                        container.scrollTop = revealSnapshot.top + heightDelta;
                    } else {
                        container.scrollTop = revealSnapshot.top;
                    }
                }
            }
        }

        const turnId = pendingExpandedTurnScrollRef.current;
        if (!turnId) return;
        pendingExpandedTurnScrollRef.current = null;
        const container = resolveScrollContainer();
        const turnElement = container?.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
        turnElement?.scrollIntoView({ block: 'start' });
    }, [historyEntries, resolveScrollContainer, scrollRef]);
    // Mobile always starts with the same virtualized engine it will use after
    // pagination. Switching a short list from normal DOM to TanStack during a
    // prepend remounts the history subtree, and the newly enabled end-anchored
    // virtualizer initializes at the bottom before it has prior keyed state.
    // Desktop keeps the small-list threshold where that transition is not tied
    // to the explicit mobile load-older interaction.
    const shouldVirtualizeHistory = isMobileSurfaceRuntime()
        || historyEntries.length >= MESSAGE_LIST_VIRTUALIZE_THRESHOLD;
    const historyEngine: HistoryEngine = shouldVirtualizeHistory ? 'tanstack' : 'none';
    const tanstackVirtualizerRef = React.useRef<TanstackVirtualizerInstance | null>(null);
    const registerTanstackVirtualizer = React.useCallback((virtualizer: TanstackVirtualizerInstance | null) => {
        tanstackVirtualizerRef.current = virtualizer;
    }, []);

    const allEntries = React.useMemo(() => {
        return trailingStreamingEntry ? [...historyEntries, trailingStreamingEntry] : historyEntries;
    }, [historyEntries, trailingStreamingEntry]);

    const stableHistoryContentChange = useStableEvent((reason?: ContentChangeReason) => {
        onMessageContentChange(reason);
    });

    const stableTailContentChange = useStableEvent((reason?: ContentChangeReason) => {
        onMessageContentChange(reason);
    });

    const currentUserOrder = React.useMemo(() => {
        return messages
            .filter((message) => resolveMessageRole(message) === 'user')
            .map((message) => message.info.id);
    }, [messages]);

    // Detect new user messages SYNCHRONOUSLY during render.
    // Must happen during render (not in useEffect) so that ToolRevealOnMount
    // receives animate=true on the FIRST render of the new message,
    // starting it hidden (opacity 0). An effect-based approach causes
    // the message to flash visible before the animation starts.
    {
        const anim = userAnimationRef.current;

        // Reset on session switch
        if (anim.sessionKey !== sessionKey) {
            anim.sessionKey = sessionKey;
            anim.previousOrder = currentUserOrder;
            anim.animatedIds = new Set();
        }

        // Detect appended user messages
        const prev = anim.previousOrder;
        if (currentUserOrder.length > prev.length) {
            const isAppendOnly = prev.every((id, i) => currentUserOrder[i] === id);
            if (isAppendOnly && hasPendingUserSendAnimation(sessionKey)) {
                for (let i = prev.length; i < currentUserOrder.length; i += 1) {
                    const id = currentUserOrder[i];
                    if (id && !anim.animatedIds.has(id)) {
                        if (!consumePendingUserSendAnimation(sessionKey)) break;
                        anim.animatedIds.add(id);
                    }
                }
            }
        }
        anim.previousOrder = currentUserOrder;
    }

    const shouldAnimateUserMessage = React.useCallback((message: ChatMessageEntry): boolean => {
        if (resolveMessageRole(message) !== 'user') return false;
        return userAnimationRef.current.animatedIds.has(message.info.id);
    }, []);

    const onUserAnimationConsumed = React.useCallback((messageId: string) => {
        userAnimationRef.current.animatedIds.delete(messageId);
    }, []);

    const messageIndexMap = React.useMemo(() => {
        const indexMap = new Map<string, number>();

        allEntries.forEach((entry, index) => {
            if (entry.kind === 'ungrouped') {
                indexMap.set(entry.message.info.id, index);
                return;
            }
            if (entry.kind === 'history-gate') {
                entry.turns.forEach((turn) => {
                    indexMap.set(turn.userMessage.info.id, index);
                    turn.assistantMessages.forEach((message) => {
                        indexMap.set(message.info.id, index);
                    });
                });
                return;
            }
            indexMap.set(entry.turn.userMessage.info.id, index);
            entry.turn.assistantMessages.forEach((message) => {
                indexMap.set(message.info.id, index);
            });
        });

        return indexMap;
    }, [allEntries]);

    const turnIndexMap = React.useMemo(() => {
        const indexMap = new Map<string, number>();
        allEntries.forEach((entry, index) => {
            if (entry.kind === 'turn') {
                indexMap.set(entry.turn.turnId, index);
            }
            if (entry.kind === 'history-gate') {
                entry.turns.forEach((turn) => {
                    indexMap.set(turn.turnId, index);
                });
            }
        });
        return indexMap;
    }, [allEntries]);

    const findMessageElement = React.useCallback((messageId: string): HTMLElement | null => {
        const container = resolveScrollContainer();
        if (!container) {
            return null;
        }
        return container.querySelector(`[data-message-id="${messageId}"]`);
    }, [resolveScrollContainer]);

    const scrollHistoryIndexIntoView = React.useCallback((index: number) => {
        if (index < 0 || index >= historyEntries.length) {
            return false;
        }

        if (!shouldVirtualizeHistory) {
            return false;
        }

        const virtualizer = tanstackVirtualizerRef.current;
        if (!virtualizer) {
            return false;
        }

        // Smooth scrolling can stop at a stale offset while unmounted,
        // variable-height rows replace estimates with real measurements. Use
        // exact auto-reconciliation; mounted targets still take the smooth DOM
        // path below.
        virtualizer.scrollToIndex(index, { align: 'start', behavior: 'auto' });
        return true;
    }, [historyEntries.length, shouldVirtualizeHistory]);

    const scrollMessageElementIntoView = React.useCallback((messageId: string, behavior: ScrollBehavior = 'auto') => {
        const container = resolveScrollContainer();
        if (!container) {
            return false;
        }
        const messageElement = findMessageElement(messageId);
        if (!messageElement) {
            return false;
        }

        const containerRect = container.getBoundingClientRect();
        const messageRect = messageElement.getBoundingClientRect();
        const offset = 50;
        const top = messageRect.top - containerRect.top + container.scrollTop - offset;
        container.scrollTo({ top, behavior });
        return true;
    }, [findMessageElement, resolveScrollContainer]);

    React.useEffect(() => {
        if (!ref) {
            return;
        }

        const handle: MessageListHandle = {
            scrollToTurnId: (turnId: string, options?: { behavior?: ScrollBehavior }) => {
                const gate = historyEntries.find((entry) => entry.kind === 'history-gate');
                if (gate?.kind === 'history-gate') {
                    const visibleTurns = historyEntries.reduce((count, entry) => (
                        entry.kind === 'turn' ? count + 1 : count
                    ), 0);
                    revealFoldedTurn(turnId, gate.turns, gate.turns.length + visibleTurns);
                }
                const behavior = options?.behavior ?? 'auto';
                const index = turnIndexMap.get(turnId);
                if (index === undefined) {
                    return false;
                }

                const container = resolveScrollContainer();
                if (!container) {
                    return false;
                }
                const turnElement = container.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
                if (turnElement) {
                    turnElement.scrollIntoView({ behavior, block: 'start' });
                    return true;
                }

                const targetIsTail = trailingStreamingEntry !== undefined && index >= historyEntries.length;
                if (targetIsTail) {
                    return false;
                }

                return scrollHistoryIndexIntoView(index);
            },

            scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior }) => {
                const behavior = options?.behavior ?? 'auto';
                const index = messageIndexMap.get(messageId);
                if (index === undefined) {
                    return false;
                }
                const entry = allEntries[index];
                if (entry?.kind === 'history-gate') {
                    const match = entry.turns.find((turn) => (
                        turn.userMessage.info.id === messageId
                        || turn.assistantMessages.some((message) => message.info.id === messageId)
                    ));
                    if (match) {
                        const visibleTurns = historyEntries.reduce((count, historyEntry) => (
                            historyEntry.kind === 'turn' ? count + 1 : count
                        ), 0);
                        revealFoldedTurn(match.turnId, entry.turns, entry.turns.length + visibleTurns);
                    }
                }

                return scrollMessageElementIntoView(messageId, behavior)
                    || (
                        trailingStreamingEntry !== undefined && index >= historyEntries.length
                            ? false
                            : scrollHistoryIndexIntoView(index)
                    );
            },

            holdViewportAnchor: (anchor) => {
                const container = resolveScrollContainer();
                if (!container || typeof window === 'undefined') {
                    return;
                }

                let frames = 0;
                let stable = 0;
                let cancelled = false;
                const cancelOnUserInput = () => {
                    cancelled = true;
                    container.removeEventListener('touchstart', cancelOnUserInput);
                    container.removeEventListener('wheel', cancelOnUserInput);
                };
                container.addEventListener('touchstart', cancelOnUserInput, { passive: true });
                container.addEventListener('wheel', cancelOnUserInput, { passive: true });
                const step = () => {
                    if (cancelled) return;
                    const element = findMessageElement(anchor.messageId);
                    if (element) {
                        const delta = element.getBoundingClientRect().top
                            - container.getBoundingClientRect().top
                            - anchor.offsetTop;
                        if (Math.abs(delta) > 0.5) {
                            container.scrollTop += delta;
                            stable = 0;
                        } else {
                            stable += 1;
                        }
                    }
                    frames += 1;
                    if (stable >= ANCHOR_HOLD_STABLE_FRAMES || frames >= ANCHOR_HOLD_MAX_FRAMES) {
                        container.removeEventListener('touchstart', cancelOnUserInput);
                        container.removeEventListener('wheel', cancelOnUserInput);
                        return;
                    }
                    window.requestAnimationFrame(step);
                };
                window.requestAnimationFrame(step);
            },

            isHistoryVirtualized: () => shouldVirtualizeHistory,

            captureViewportAnchor: () => {
                const container = resolveScrollContainer();
                if (!container) {
                    return null;
                }

                const containerRect = container.getBoundingClientRect();
                const nodes: HTMLElement[] = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'));
                const firstVisible = nodes.find((node) => {
                    const rect = node.getBoundingClientRect();
                    if (rect.bottom <= containerRect.top + 1) {
                        return false;
                    }

                    if (typeof window === 'undefined') {
                        return true;
                    }

                    return !isInsideStuckSticky(node, container, containerRect.top);
                }) ?? nodes.find((node) => node.getBoundingClientRect().bottom > containerRect.top + 1);
                if (!firstVisible) {
                    return null;
                }

                const messageId = firstVisible.dataset.messageId;
                if (!messageId) {
                    return null;
                }

                return {
                    messageId,
                    offsetTop: firstVisible.getBoundingClientRect().top - containerRect.top,
                };
            },

            restoreViewportAnchor: (anchor: { messageId: string; offsetTop: number }) => {
                const container = resolveScrollContainer();
                if (!container) {
                    return false;
                }

                if (!messageIndexMap.has(anchor.messageId)) {
                    return false;
                }

                const applyAnchor = (): boolean => {
                    const element = findMessageElement(anchor.messageId);
                    if (!element) {
                        return false;
                    }
                    const containerRect = container.getBoundingClientRect();
                    const targetTop = element.getBoundingClientRect().top - containerRect.top;
                    const delta = targetTop - anchor.offsetTop;
                    if (delta !== 0) {
                        container.scrollTop += delta;
                    }
                    return true;
                };

                if (!applyAnchor()) {
                    const index = messageIndexMap.get(anchor.messageId);
                    if (typeof index === 'number' && index < historyEntries.length) {
                        return scrollHistoryIndexIntoView(index);
                    }
                }

                return applyAnchor();
            },

            scrollToBottom: () => {
                if (shouldVirtualizeHistory && historyEntries.length > 0 && tanstackVirtualizerRef.current) {
                    tanstackVirtualizerRef.current.scrollToEnd();
                    return;
                }
                const container = resolveScrollContainer();
                if (!container) return;
                // Overshoot so the browser clamps to the exact fractional
                // maximum (scrollHeight is integer-rounded) — see useChatAutoFollow.
                container.scrollTop = container.scrollHeight + 4096;
            },
        };

        if (typeof ref === 'function') {
            ref(handle);
            return () => {
                ref(null);
            };
        }

        const objectRef = ref;
        objectRef.current = handle;
        return () => {
            objectRef.current = null;
        };
    }, [allEntries, findMessageElement, historyEntries, messageIndexMap, resolveScrollContainer, revealFoldedTurn, scrollHistoryIndexIntoView, scrollMessageElementIntoView, shouldVirtualizeHistory, trailingStreamingEntry, turnIndexMap, ref]);

    const disableFadeIn = false;

    return (
        <div>
                <FadeInDisabledProvider disabled={disableFadeIn}>
                    <div className="relative w-full">
                        {/* Virtualized history rows unmount/remount during scroll;
                            re-running the reveal fade on every remount reads as
                            blinking. History content is never "new", so fade-in
                            is disabled there — the streaming tail keeps it. */}
                        <FadeInDisabledProvider disabled={shouldVirtualizeHistory}>
                            <StaticHistoryList
                                key={sessionKey}
                                entries={historyEntries}
                                engine={historyEngine}
                                contentRef={historyContentRef}
                                scrollRef={scrollRef}
                                registerTanstackVirtualizer={registerTanstackVirtualizer}
                                virtualizerKey={sessionKey}
                                onMessageContentChange={stableHistoryContentChange}
                                getAnimationHandlers={stableGetAnimationHandlers}
                                scrollToBottom={stableScrollToBottom}
                                stickyUserHeader={stickyUserHeader}
                                shouldAnimateUserMessage={shouldAnimateUserMessage}
                                onUserAnimationConsumed={onUserAnimationConsumed}
                                onLoadOlderHistory={loadOlderHistory}
                                onLoadAllHistory={loadAllHistory}
                                                />
                        </FadeInDisabledProvider>
                        {trailingStreamingEntry ? (
                            <StreamingTailContent
                                entry={trailingStreamingEntry}
                                sessionId={sessionKey ?? null}
                                directory={directory}
                                onMessageContentChange={stableTailContentChange}
                                getAnimationHandlers={stableGetAnimationHandlers}
                                scrollToBottom={stableScrollToBottom}
                                stickyUserHeader={stickyUserHeader}
                                sessionIsWorking={sessionIsWorking}
                                showTurnChangedFiles={showTurnChangedFiles}
                                shouldAnimateUserMessage={shouldAnimateUserMessage}
                                onUserAnimationConsumed={onUserAnimationConsumed}
                                activeStreamingMessageId={activeStreamingMessageId}
                                activeStreamingPhase={activeStreamingPhase}
                                                />
                        ) : null}
                    </div>
                </FadeInDisabledProvider>

        </div>
    );
});

MessageList.displayName = 'MessageList';

export default React.memo(MessageList);
