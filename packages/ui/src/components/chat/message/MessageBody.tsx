import React from 'react';
import type { Part } from '@/lib/chat/types';

import ToolPart from './parts/ToolPart';
import AssistantTextPart from './parts/AssistantTextPart';
import ReasoningPart from './parts/ReasoningPart';
import { MessageFilesDisplay } from '../FileAttachment';
import { TurnChangedFilesDropdown } from '../TurnChangedFilesDropdown';
import type { ToolPart as ToolPartType } from '@/lib/chat/types';
import type { StreamPhase, ToolPopupContent, AgentMentionInfo } from './types';
import type { TurnChangedFile, TurnGroupingContext } from '../lib/turns/types';
import { cn } from '@/lib/utils';
import { extractTextContent, filterRenderableAssistantParts } from './partUtils';
import { FadeInOnReveal } from './FadeInOnReveal';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';

import { SimpleMarkdownRenderer } from '../MarkdownRenderer';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { TextSelectionMenu } from './TextSelectionMenu';
import { useChatSurfaceMode } from '@/components/chat/chatSurfaceContext';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import { formatTimestampForDisplay } from './timeFormat';
import { MessageRevertAction } from './MessageRevertAction';
import { MessageForkAction } from './MessageForkAction';
import { ToolRevealOnMount } from './parts/ToolRevealOnMount';
import { StaticToolRow } from './parts/StaticToolRow';
import { isExpandableTool } from './parts/toolRenderUtils';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { extractLoopbackUrls } from '@/lib/url';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { getAgentColor } from '@/lib/agentColors';
import { AssistantMessageActionButtons } from './AssistantMessageActionButtons';
import { TurnChangedFilePills, formatTurnDuration } from './TurnChangedFilesPills';
import { UserMessageBody } from './UserMessageBody';

const CONTAIN_LAYOUT_STYLE = { contain: 'layout' as const, transform: 'translateZ(0)' };
const MESSAGE_FOOTER_CONTAINER_STYLE = { containerType: 'inline-size' as const, containerName: 'message-footer' };
const INLINE_MESSAGE_ACTIONS_CLASS_NAME = 'mt-2 mb-1 flex items-center justify-start gap-1.5';

interface MessageBodyProps {
    sessionId?: string;
    messageId: string;
    parts: Part[];
    isUser: boolean;
    isMessageCompleted: boolean;
    isLatestMessage?: boolean;
    messageFinish?: string;
    messageCompletedAt?: number;
    messageCreatedAt?: number;
    durationMs?: number;


    isMobile: boolean;
    alwaysShowActions?: boolean;
    hasTouchInput?: boolean;
    copiedCode: string | null;
    onCopyCode: (code: string) => void;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    streamPhase: StreamPhase;
    allowAnimation: boolean;
    onContentChange?: (reason?: ContentChangeReason, messageId?: string) => void;

    shouldShowHeader?: boolean;
    hasTextContent?: boolean;
    onCopyMessage?: () => void | boolean | Promise<void | boolean>;
    copiedMessage?: boolean;
    onAuxiliaryContentComplete?: () => void;
    showReasoningTraces?: boolean;
    agentMention?: AgentMentionInfo;
    turnGroupingContext?: TurnGroupingContext;
    errorMessage?: string;
    errorVariant?: 'error' | 'info';
    userActionsMode?: 'inline' | 'external-content' | 'external-actions';
    stickyUserHeaderEnabled?: boolean;
    footerProviderID?: string | null;
    footerModelName?: string;
    footerAgentName?: string;
    footerVariant?: string;
    isDarkTheme?: boolean;
}

const TOOL_REVEAL_CACHE_MAX = 200;
const revealedToolIdsByMessage = new Map<string, Set<string>>();

const readRevealedToolIds = (messageId: string): Set<string> => {
    const cached = revealedToolIdsByMessage.get(messageId);
    return cached ? new Set(cached) : new Set<string>();
};

const writeRevealedToolIds = (messageId: string, value: Set<string>): void => {
    if (revealedToolIdsByMessage.size >= TOOL_REVEAL_CACHE_MAX && !revealedToolIdsByMessage.has(messageId)) {
        const oldest = revealedToolIdsByMessage.keys().next().value;
        if (oldest) {
            revealedToolIdsByMessage.delete(oldest);
        }
    }
    revealedToolIdsByMessage.set(messageId, new Set(value));
};



const AssistantMessageBody = React.memo(({
    sessionId,
    messageId,
    parts,
    isMessageCompleted,
    messageFinish,
    messageCompletedAt,
    messageCreatedAt,
    durationMs,
    isLatestMessage = false,

    isMobile,
    alwaysShowActions,
    hasTouchInput,
    expandedTools,
    onToggleTool,
    onShowPopup,
    streamPhase: _streamPhase,
    allowAnimation: _allowAnimation,
    onContentChange,
    hasTextContent = false,
    onCopyMessage,
    onAuxiliaryContentComplete,
    showReasoningTraces = false,
    turnGroupingContext,
    errorMessage,
    errorVariant = 'error',
    footerProviderID,
    footerModelName,
    footerAgentName,
    footerVariant,
    isDarkTheme = false,
}: Omit<MessageBodyProps, 'isUser'>) => {
    const chatSurfaceMode = useChatSurfaceMode();
    const streamPhase = _streamPhase;
    void _allowAnimation;
    const messageContentRef = React.useRef<HTMLDivElement>(null);
    const messageTextContentRef = React.useRef<HTMLDivElement>(null);
    const toolRevealReadyRef = React.useRef(false);

    React.useEffect(() => {
        toolRevealReadyRef.current = true;
    }, []);

    const isTouchContext = Boolean(hasTouchInput ?? isMobile);
    const alwaysShowMessageActions = Boolean(alwaysShowActions ?? isMobile);
    const { src: footerLogoSrc, onError: handleFooterLogoError, hasLogo: footerHasLogo } = useProviderLogo(footerProviderID ?? null);
    const awaitingMessageCompletion = !isMessageCompleted;

    const visibleParts = React.useMemo(() => {
        return filterRenderableAssistantParts(parts);
    }, [parts]);

    const toolParts = React.useMemo(() => {
        return visibleParts.filter((part): part is ToolPartType => part.type === 'tool');
    }, [visibleParts]);

    const toolRevealStateRef = React.useRef<{
        messageId: string;
        hasCommitted: boolean;
        persistedToolIds: Set<string>;
        animatedToolIds: Set<string>;
    }>({
        messageId,
        hasCommitted: false,
        persistedToolIds: readRevealedToolIds(messageId),
        animatedToolIds: new Set<string>(),
    });

    if (toolRevealStateRef.current.messageId !== messageId) {
        toolRevealStateRef.current = {
            messageId,
            hasCommitted: false,
            persistedToolIds: readRevealedToolIds(messageId),
            animatedToolIds: new Set<string>(),
        };
    }

    const currentToolIds = React.useMemo(() => {
        const ids = new Set<string>();

        for (const toolPart of toolParts) {
            ids.add(toolPart.id);
        }

        const activitySegments = turnGroupingContext?.activityGroupSegments;
        if (Array.isArray(activitySegments)) {
            for (const segment of activitySegments) {
                if (segment.anchorMessageId !== messageId) {
                    continue;
                }
                for (const activity of segment.parts) {
                    if (activity.kind !== 'tool') {
                        continue;
                    }
                    const toolId = (activity.part as { id?: unknown }).id;
                    if (typeof toolId === 'string' && toolId.length > 0) {
                        ids.add(toolId);
                    }
                }
            }
        }

        return Array.from(ids);
    }, [messageId, toolParts, turnGroupingContext?.activityGroupSegments]);
    const shouldAnimateNewToolMount = Boolean(turnGroupingContext?.isWorking && toolRevealReadyRef.current);
    const persistedToolIds = toolRevealStateRef.current.persistedToolIds;
    const animatedToolIds = toolRevealStateRef.current.animatedToolIds;

    if (shouldAnimateNewToolMount && toolRevealStateRef.current.hasCommitted) {
        for (const toolId of currentToolIds) {
            if (!persistedToolIds.has(toolId)) {
                animatedToolIds.add(toolId);
            }
        }
    }

    const animatedToolIdsKey = Array.from(animatedToolIds).join('\u0000');
    const animatedToolIdsLookup = React.useMemo(
        () => new Set(animatedToolIdsKey ? animatedToolIdsKey.split('\u0000') : []),
        [animatedToolIdsKey]
    );

    React.useEffect(() => {
        const nextPersistedToolIds = new Set(toolRevealStateRef.current.persistedToolIds);
        for (const toolId of currentToolIds) {
            nextPersistedToolIds.add(toolId);
        }
        toolRevealStateRef.current.persistedToolIds = nextPersistedToolIds;
        toolRevealStateRef.current.hasCommitted = true;
        writeRevealedToolIds(messageId, nextPersistedToolIds);
    }, [currentToolIds, messageId]);

    const assistantTextParts = React.useMemo(() => {
        return visibleParts.filter((part) => part.type === 'text');
    }, [visibleParts]);
    const openContextPreview = useUIStore((state) => state.openContextPreview);
    const isMiniChatSurface = chatSurfaceMode === 'mini-chat';

    const messagePreviewUrl = React.useMemo(() => {
        if (isMobile || isMiniChatSurface) {
            return null;
        }

        for (const part of assistantTextParts) {
            const text = (part as { text?: unknown }).text;
            if (typeof text !== 'string' || text.length === 0) {
                continue;
            }
            const url = extractLoopbackUrls(text)[0];
            if (!url) {
                continue;
            }
            return url.includes('0.0.0.0') ? url.replace('0.0.0.0', '127.0.0.1') : url;
        }
        for (const part of toolParts) {
            const state = (part as unknown as { state?: unknown }).state as Record<string, unknown> | undefined;
            const output = state && typeof state.output === 'string' ? state.output : null;
            if (!output) {
                continue;
            }
            // eslint-disable-next-line no-control-regex
            const url = extractLoopbackUrls(output.replace(/\x1b\[[0-9;]*m/g, ''))[0];
            if (!url) {
                continue;
            }
            return url.includes('0.0.0.0') ? url.replace('0.0.0.0', '127.0.0.1') : url;
        }
        return null;
    }, [assistantTextParts, isMobile, isMiniChatSurface, toolParts]);

    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const getDirectoryForSession = useSessionUIStore((state) => state.getDirectoryForSession);
    const effectiveDirectory = useEffectiveDirectory();
    const collapsibleThinkingBlocks = useUIStore((state) => state.collapsibleThinkingBlocks);
    const collapseThinkingByDefault = useUIStore((state) => state.collapseThinkingByDefault);
    const showSplitAssistantMessageActions = useUIStore((state) => state.showSplitAssistantMessageActions);
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const isLastAssistantInTurn = turnGroupingContext?.isLastAssistantInTurn ?? false;
    const hasStopFinish = messageFinish === 'stop' || (isMessageCompleted && !errorMessage);
    const effectiveStreamPhase: StreamPhase = hasStopFinish ? 'completed' : streamPhase;

    const hasTools = toolParts.length > 0;

    const hasPendingTools = React.useMemo(() => {
        return toolParts.some((toolPart) => {
            const state = (toolPart as Record<string, unknown>).state as Record<string, unknown> | undefined ?? {};
            const status = state?.status;
            return status === 'pending' || status === 'running' || status === 'started';
        });
    }, [toolParts]);

    const isToolFinalized = React.useCallback((toolPart: ToolPartType) => {
        const state = (toolPart as Record<string, unknown>).state as Record<string, unknown> | undefined ?? {};
        const status = state?.status;
        if (status === 'pending' || status === 'running' || status === 'started') {
            return false;
        }
        if (
            status === 'completed'
            || status === 'cancelled'
            || status === 'canceled'
            || status === 'error'
            || status === 'failed'
            || status === 'aborted'
            || status === 'timeout'
        ) {
            return true;
        }
        const time = state?.time as Record<string, unknown> | undefined ?? {};
        const endTime = typeof time?.end === 'number' ? time.end : undefined;
        const startTime = typeof time?.start === 'number' ? time.start : undefined;
        if (typeof endTime !== 'number') {
            return false;
        }
        if (typeof startTime === 'number' && endTime < startTime) {
            return false;
        }
        return true;
    }, []);

    const allToolsFinalized = React.useMemo(() => {
        if (toolParts.length === 0) {
            return true;
        }
        if (hasPendingTools) {
            return false;
        }
        return toolParts.every((toolPart) => isToolFinalized(toolPart));
    }, [toolParts, hasPendingTools, isToolFinalized]);

    const reasoningParts = React.useMemo(() => {
        return visibleParts.filter((part) => part.type === 'reasoning');
    }, [visibleParts]);

    const reasoningComplete = React.useMemo(() => {
        if (reasoningParts.length === 0) {
            return true;
        }
        return reasoningParts.every((part) => {
            const time = (part as Record<string, unknown>).time as { end?: number } | undefined;
            return typeof time?.end === 'number';
        });
    }, [reasoningParts]);

    // Message is considered to have an "open step" if not completed and info.finish is not yet present
    const hasOpenStep = !isMessageCompleted && typeof messageFinish !== 'string';

    const shouldHoldForReasoning =
        reasoningParts.length > 0 &&
        hasTools &&
        (hasPendingTools || hasOpenStep || !allToolsFinalized);

    const shouldHoldTools = awaitingMessageCompletion
        || (hasTools && (hasPendingTools || hasOpenStep || !allToolsFinalized));
    const shouldHoldReasoning = awaitingMessageCompletion || shouldHoldForReasoning;

    const hasAuxiliaryContent = hasTools || reasoningParts.length > 0;
    const isTextlessAssistantMessage = assistantTextParts.length === 0;
    const auxiliaryContentComplete = hasAuxiliaryContent && isTextlessAssistantMessage && !shouldHoldTools && !shouldHoldReasoning && allToolsFinalized && reasoningComplete;
    const auxiliaryCompletionAnnouncedRef = React.useRef(false);
    const soloReasoningScrollTriggeredRef = React.useRef(false);

    React.useEffect(() => {
        soloReasoningScrollTriggeredRef.current = false;
    }, [messageId]);

    React.useEffect(() => {
        if (!auxiliaryContentComplete) {
            auxiliaryCompletionAnnouncedRef.current = false;
            return;
        }
        if (auxiliaryCompletionAnnouncedRef.current) {
            return;
        }
        auxiliaryCompletionAnnouncedRef.current = true;
        onAuxiliaryContentComplete?.();
    }, [auxiliaryContentComplete, onAuxiliaryContentComplete]);

    React.useEffect(() => {
        if (awaitingMessageCompletion) {
            soloReasoningScrollTriggeredRef.current = false;
            return;
        }
        if (hasTools) {
            soloReasoningScrollTriggeredRef.current = false;
            return;
        }
        if (reasoningParts.length === 0) {
            return;
        }
        if (shouldHoldReasoning || !reasoningComplete) {
            return;
        }
        if (soloReasoningScrollTriggeredRef.current) {
            return;
        }
        soloReasoningScrollTriggeredRef.current = true;
        onContentChange?.('structural');
    }, [awaitingMessageCompletion, hasTools, onContentChange, reasoningComplete, reasoningParts.length, shouldHoldReasoning]);

    const hasCopyableText = Boolean(hasTextContent) && !awaitingMessageCompletion;

    const shareMessageAsImage = React.useCallback(
        async (requestedSourceElement?: HTMLElement | null) => {
            const sourceElement = requestedSourceElement ?? messageTextContentRef.current ?? messageContentRef.current;
            if (!sourceElement) return;

            let wrapper: HTMLDivElement | null = null;
            try {
                // Load the exporter before attaching its temporary clone so a slow
                // chunk request cannot leave export-only content in the page layout.
                const { toPng } = await import('html-to-image');
                const originalElement = sourceElement;
                const computedStyle = window.getComputedStyle(originalElement);
                const rootStyle = window.getComputedStyle(document.documentElement);
                const resolvedBackgroundColor =
                    rootStyle.getPropertyValue('--surface-background').trim() ||
                    computedStyle.backgroundColor ||
                    window.getComputedStyle(document.body).backgroundColor;
                const paddingSize = 24;

                wrapper = document.createElement('div');
                wrapper.setAttribute('data-message-image-export', 'true');
                wrapper.style.cssText = `
                    padding: ${paddingSize}px;
                    background-color: ${resolvedBackgroundColor};
                    display: inline-block;
                `;

                const clone = originalElement.cloneNode(true) as HTMLElement;
                clone.style.cssText = `
                    ${computedStyle.cssText}
                    transform: none;
                    contain: none;
                `;

                const actionRows = clone.querySelectorAll<HTMLElement>('[data-message-actions="true"]');
                actionRows.forEach((row) => {
                    row.style.display = 'none';
                });
                const actionGroups = clone.querySelectorAll<HTMLElement>('[data-message-action-group="true"]');
                actionGroups.forEach((group) => {
                    group.style.display = 'none';
                });

                const timestampElements = clone.querySelectorAll<HTMLElement>('[aria-label^="Message time:"]');
                const footerRowsAdjusted = new Set<HTMLElement>();
                timestampElements.forEach((element) => {
                    const label = element.getAttribute('aria-label');
                    const timestamp = label?.replace('Message time:', '').trim();
                    if (!timestamp || element.textContent?.includes(timestamp)) {
                        return;
                    }

                    const timestampText = document.createElement('span');
                    timestampText.style.marginLeft = '4px';
                    timestampText.textContent = timestamp;
                    element.appendChild(timestampText);

                    const metaGroup = element.parentElement;
                    const footerRow = metaGroup?.parentElement as HTMLElement | null;
                    if (!footerRow || footerRowsAdjusted.has(footerRow)) {
                        return;
                    }

                    footerRow.style.justifyContent = 'flex-start';
                    footerRowsAdjusted.add(footerRow);
                });

                wrapper.appendChild(clone);
                document.body.appendChild(wrapper);

                const dataUrl = await toPng(wrapper, {
                    quality: 1,
                    pixelRatio: 2,
                    backgroundColor: resolvedBackgroundColor,
                });

                const fileName = `message-${messageId}.png`;

                const link = document.createElement('a');
                link.download = fileName;
                link.href = dataUrl;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);

                toast.success("Image saved");
            } catch (error) {
                console.error('Failed to generate image:', error);
                toast.error("Failed to generate image");
            } finally {
                if (wrapper && wrapper.parentNode) {
                    wrapper.parentNode.removeChild(wrapper);
                }
            }
        },
        [messageId]
    );

    const showErrorMessage = Boolean(errorMessage);
    const errorIconName = errorVariant === 'info' ? 'information' : 'error-warning';
    const shouldShowMessageActions = hasCopyableText;
    const isTurnWorking = Boolean(turnGroupingContext?.isWorking);
    const shouldShowTurnFooter = isLastAssistantInTurn
        && (hasTextContent || Boolean(errorMessage))
        && !isTurnWorking;
    const shouldShowStandaloneMessageActions = showSplitAssistantMessageActions && shouldShowMessageActions && !shouldShowTurnFooter;

    const messageActionButtons = React.useMemo(() => (
        <AssistantMessageActionButtons
            hasCopyableText={hasCopyableText}
            isTouchContext={isTouchContext}
            onCopyMessage={onCopyMessage}
            onShareImage={shareMessageAsImage}
            sessionId={sessionId}
            messageId={messageId}
            isLatestMessage={isLatestMessage}
        />
    ), [hasCopyableText, isLatestMessage, isTouchContext, messageId, onCopyMessage, sessionId, shareMessageAsImage]);

    const lastRenderableTextPartIndex = React.useMemo(() => {
        if (!shouldShowStandaloneMessageActions) {
            return -1;
        }

        let lastIndex = -1;
        for (let index = 0; index < visibleParts.length; index += 1) {
            const part = visibleParts[index];
            if (!part || part.type !== 'text') {
                continue;
            }
            lastIndex = index;
        }

        return lastIndex;
    }, [shouldShowStandaloneMessageActions, visibleParts]);

    const shouldRenderStandaloneActionsAfterContent = shouldShowStandaloneMessageActions && lastRenderableTextPartIndex < 0;

    const renderedParts = React.useMemo(() => {
        const rendered: React.ReactNode[] = [];

        // Flat rendering: iterate parts in natural order.
        // Group consecutive static tools (read, grep, glob, etc.) into compact rows.
        // Expandable tools (bash, edit, task) get individual rows.
        // Text renders inline at its natural position.
        let i = 0;
        while (i < visibleParts.length) {
            const part = visibleParts[i];

            if (part.type === 'text') {
                rendered.push(
                    <div key={`assistant-text-${messageId}-${i}`} ref={messageTextContentRef} data-message-text-export-source="true">
                        <AssistantTextPart
                            part={part}
                            sessionId={sessionId}
                            messageId={messageId}
                            streamPhase={effectiveStreamPhase}
                            onContentChange={onContentChange}
                            onShowPopup={onShowPopup}
                        />
                    </div>
                );
                if (shouldShowStandaloneMessageActions && i === lastRenderableTextPartIndex) {
                    rendered.push(
                        <div key={`message-actions-${messageId}`} className={INLINE_MESSAGE_ACTIONS_CLASS_NAME} data-message-actions="true">
                            <div className="flex items-center gap-1.5" data-message-action-group="true">
                                {messageActionButtons}
                            </div>
                        </div>
                    );
                }
                i++;
                continue;
            }

            if (part.type === 'reasoning') {
                if (showReasoningTraces) {
                    if (!collapsibleThinkingBlocks) {
                        // Non-collapsible mode: render thinking blocks as plain text inline.
                        rendered.push(
                            <AssistantTextPart
                                key={`reasoning-${messageId}-${i}`}
                                part={part}
                                sessionId={sessionId}
                                messageId={messageId}
                                streamPhase={effectiveStreamPhase}
                                onContentChange={onContentChange}
                                onShowPopup={onShowPopup}
                            />
                        );
                    } else {
                        // Per-part mode: each reasoning block at its natural position.
                        rendered.push(
                            <ReasoningPart
                                key={`reasoning-${messageId}-${i}`}
                                part={part}
                                messageId={messageId}
                                streamPhase={effectiveStreamPhase}
                                onContentChange={onContentChange}
                                collapseByDefault={collapseThinkingByDefault}
                            />
                        );
                    }
                }
                i++;
                continue;
            }

            if (part.type === 'tool') {
                const toolPart = part as ToolPartType;
                const toolName = toolPart.tool?.toLowerCase() ?? '';

                // Expandable tools: bash, edit, write, task, question — individual rows
                if (isExpandableTool(toolName)) {
                    rendered.push(
                        <FadeInOnReveal key={`tool-${toolPart.id}`}>
                            <ToolRevealOnMount animate={animatedToolIdsLookup.has(toolPart.id)} wipe>
                                <ToolPart
                                    part={toolPart}
                                    isExpanded={expandedTools.has(toolPart.id)}
                                    onToggle={onToggleTool}
                                    isMobile={isMobile}
                                    alwaysShowActions={alwaysShowMessageActions}
                                    onContentChange={onContentChange}
                                    onShowPopup={onShowPopup}
                                    animateTailText={animatedToolIdsLookup.has(toolPart.id)}
                                />
                            </ToolRevealOnMount>
                        </FadeInOnReveal>
                    );
                    i++;
                    continue;
                }

                // Static tools: one row per tool call (no grouping)
                rendered.push(
                    <FadeInOnReveal key={`static-tools-${toolPart.id}`}>
                        <ToolRevealOnMount animate={animatedToolIdsLookup.has(toolPart.id)} wipe>
                            <StaticToolRow
                                toolName={toolName}
                                activities={[
                                    {
                                        id: toolPart.id,
                                        turnId: '',
                                        messageId,
                                        partIndex: 0,
                                        part: toolPart,
                                        kind: 'tool' as const,
                                    },
                                ]}
                                animateTailText={animatedToolIdsLookup.has(toolPart.id)}
                            />
                        </ToolRevealOnMount>
                    </FadeInOnReveal>
                );
                i++;
                continue;
            }

            // Unknown part type — skip
            i++;
        }

        return rendered;
    }, [
        alwaysShowMessageActions,
        animatedToolIdsLookup,
        collapsibleThinkingBlocks,
        collapseThinkingByDefault,
        expandedTools,
        isMobile,
        lastRenderableTextPartIndex,
        messageId,
        messageActionButtons,
        sessionId,
        onContentChange,
        onShowPopup,
        onToggleTool,
        shouldShowStandaloneMessageActions,
        effectiveStreamPhase,
        showReasoningTraces,
        visibleParts,
    ]);

    const turnDurationText = React.useMemo(() => {
        if (!isLastAssistantInTurn || isTurnWorking) return undefined;
        // Priority 1: Assistant message explicit durationMs (measured from first token to stream completion)
        if (typeof durationMs === 'number' && durationMs > 0) {
            return formatTurnDuration(durationMs);
        }
        // Priority 2: Assistant message completedAt - createdAt
        if (typeof messageCompletedAt === 'number' && typeof messageCreatedAt === 'number' && messageCompletedAt > messageCreatedAt) {
            return formatTurnDuration(messageCompletedAt - messageCreatedAt);
        }
        // Priority 3: Turn span from user prompt to assistant completion
        const userCreatedAt = turnGroupingContext?.userMessageCreatedAt;
        if (typeof userCreatedAt === 'number' && typeof messageCompletedAt === 'number' && messageCompletedAt > userCreatedAt) {
            return formatTurnDuration(messageCompletedAt - userCreatedAt);
        }
        return undefined;
    }, [isLastAssistantInTurn, isTurnWorking, durationMs, messageCompletedAt, messageCreatedAt, turnGroupingContext?.userMessageCreatedAt]);

    const footerTimestamp = React.useMemo(() => {
        const timestamp = typeof messageCompletedAt === 'number' && messageCompletedAt > 0
            ? messageCompletedAt
            : (typeof messageCreatedAt === 'number' && messageCreatedAt > 0 ? messageCreatedAt : null);
        if (timestamp === null) return null;

        const formatted = formatTimestampForDisplay(timestamp, timeFormatPreference);
        return formatted.length > 0 ? formatted : null;
    }, [messageCompletedAt, messageCreatedAt, timeFormatPreference]);

    const footerTimestampClassName = 'text-sm text-muted-foreground/60 tabular-nums flex items-center gap-1';
    const canOpenMessagePreview = !isMiniChatSurface && !isMobile;

    const finalTurnActionButtons = (
        <>
            {canOpenMessagePreview && messagePreviewUrl ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50"
                            aria-label={"Open preview"}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => {
                                const directory = effectiveDirectory
                                    ?? (currentSessionId ? getDirectoryForSession(currentSessionId) : null);
                                if (!directory) {
                                    return;
                                }
                                openContextPreview(directory, messagePreviewUrl);
                            }}
                        >
                            <Icon name="global" className="h-4 w-4" />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{"Open preview"}</TooltipContent>
                </Tooltip>
            ) : null}
        </>
    );
 
      return (

         <div
              ref={messageContentRef}
              data-message-text-export-root="true"
              className={cn(
                 'relative w-full group/message'
             )}
              style={CONTAIN_LAYOUT_STYLE}
          >
              <TextSelectionMenu containerRef={messageContentRef} />
              <div>
                 <div
                     className="message-content-text leading-relaxed overflow-hidden text-foreground/90 [&_p:last-child]:mb-0 [&_ul:last-child]:mb-0 [&_ol:last-child]:mb-0"
                 >
                    {renderedParts}
                    {showErrorMessage && (
                        <FadeInOnReveal key="assistant-error">
                            <div className={cn(
                                'group/assistant-text relative mt-3 p-3 rounded-lg border break-words max-w-full',
                                errorVariant === 'info'
                                    ? 'bg-[var(--status-info-background)] border-[var(--status-info-border)]'
                                    : 'bg-[var(--status-error-background)] border-[var(--status-error-border)]',
                            )}>
                                <div className="flex items-center gap-2">
                                    <Icon name={errorIconName} className={cn(
                                        'h-4 w-4 shrink-0',
                                        errorVariant === 'info' ? 'text-[var(--status-info)]' : 'text-[var(--status-error)]',
                                    )} />
                                    <div className="min-w-0 flex-1 break-words">
                                        <SimpleMarkdownRenderer
                                            content={errorMessage ?? ''}
                                            onShowPopup={onShowPopup}
                                            className="[&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0"
                                            enableFileReferences={false}
                                        />
                                    </div>
                                </div>
                            </div>
                        </FadeInOnReveal>
                    )}
                </div>
                <MessageFilesDisplay files={parts} onShowPopup={onShowPopup} />
                {shouldRenderStandaloneActionsAfterContent && (
                    <div className={INLINE_MESSAGE_ACTIONS_CLASS_NAME} data-message-actions="true">
                        <div className="flex items-center gap-1.5" data-message-action-group="true">
                            {messageActionButtons}
                        </div>
                    </div>
                )}
                {shouldShowTurnFooter && (
                    <div
                        className="mt-2 mb-1 flex flex-wrap items-center justify-start gap-x-3 gap-y-1.5"
                        style={MESSAGE_FOOTER_CONTAINER_STYLE}
                    >
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted-foreground/60">
                        {footerModelName ? (
                            <span className="flex min-w-0 items-center gap-1.5">
                                {footerHasLogo && footerLogoSrc ? (
                                    <img
                                        src={footerLogoSrc}
                                        alt=""
                                        className="h-3.5 w-3.5 flex-shrink-0"
                                        style={{
                                            filter: isDarkTheme ? 'brightness(0.9) contrast(1.1) invert(1)' : 'brightness(0.9) contrast(1.1)',
                                        }}
                                        onError={handleFooterLogoError}
                                    />
                                ) : (
                                    <Icon
                                        name="brain-ai-3"
                                        className="h-3.5 w-3.5 flex-shrink-0"
                                        style={{ color: `var(${getAgentColor(footerAgentName).var})` }}
                                    />
                                )}
                                <span className="truncate">{footerModelName}</span>
                            </span>
                        ) : null}
                        {footerVariant && !['default', 'none'].includes(footerVariant.toLowerCase()) ? (
                            <span className="flex items-center gap-1">
                                <Icon name="brain-ai-3" className="h-3.5 w-3.5 flex-shrink-0" />
                                <span className="message-footer__label">
                                    {footerVariant[0].toLowerCase() + footerVariant.slice(1)}
                                </span>
                            </span>
                        ) : null}
                        {footerAgentName ? (
                            <span className="flex items-center gap-1">
                                <Icon name="ai-agent" className="h-3.5 w-3.5 flex-shrink-0" />
                                <span className="message-footer__label">{footerAgentName}</span>
                            </span>
                        ) : null}
                        {turnDurationText ? (
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <span className="text-sm text-muted-foreground/60 tabular-nums flex items-center gap-1">
                                        <Icon name="hourglass" className="h-3.5 w-3.5" />
                                        <span className="message-footer__label">{turnDurationText}</span>
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent>{turnDurationText}</TooltipContent>
                            </Tooltip>
                        ) : null}
                        {footerTimestamp ? (
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <span
                                        className={footerTimestampClassName}
                                        aria-label={`Message time: ${footerTimestamp}`}
                                    >
                                        <Icon name="time" className="h-3.5 w-3.5" />
                                        <span className="message-footer__label">{footerTimestamp}</span>
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent>{footerTimestamp}</TooltipContent>
                            </Tooltip>
                        ) : null}
                        {!isMiniChatSurface && isLastAssistantInTurn && hasStopFinish ? (
                            <TurnChangedFilesDropdown activityParts={turnGroupingContext?.activityParts} />
                        ) : null}
                        {!isMiniChatSurface && isLastAssistantInTurn && hasStopFinish ? (
                            <TurnChangedFilePills
                                files={turnGroupingContext?.changedFiles}
                                isInteractive={turnGroupingContext?.isLatestTurn === true}
                            />
                        ) : null}
                        </div>
                        <div
                            className={cn(
                                'flex items-center gap-1.5',
                                alwaysShowMessageActions || isTouchContext
                                    ? undefined
                                    : 'pointer-events-none opacity-0 transition-opacity duration-150 focus-within:pointer-events-auto focus-within:opacity-100 group-hover/message:pointer-events-auto group-hover/message:opacity-100'
                            )}
                            data-message-action-group="true"
                        >
                            {messageActionButtons}
                            {finalTurnActionButtons}
                        </div>
                    </div>
                )}

            </div>
        </div>
    );
});

const MessageBody = React.memo(({ isUser, ...props }: MessageBodyProps) => {

    if (isUser) {
        return (
            <UserMessageBody
                sessionId={props.sessionId}
                messageId={props.messageId}
                parts={props.parts}
                messageCreatedAt={props.messageCreatedAt}
                isMobile={props.isMobile}
                alwaysShowActions={props.alwaysShowActions}
                hasTouchInput={props.hasTouchInput}
                hasTextContent={props.hasTextContent}
                onCopyMessage={props.onCopyMessage}
                copiedMessage={props.copiedMessage}
                onShowPopup={props.onShowPopup}
                agentMention={props.agentMention}
                userActionsMode={props.userActionsMode}
                stickyUserHeaderEnabled={props.stickyUserHeaderEnabled}
            />
        );
    }

    return <AssistantMessageBody {...props} />;
});

export default MessageBody;
