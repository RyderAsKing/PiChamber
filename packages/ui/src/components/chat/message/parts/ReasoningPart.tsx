import React from 'react';
import { animate, type AnimationPlaybackControls } from 'motion';
import type { Part } from '@/lib/chat/types';
import { cn } from '@/lib/utils';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from '@/components/icon/Icon';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import { MinDurationShineText } from './MinDurationShineText';
import { TOOL_NORMAL_TITLE_STYLE } from './toolPartStyles';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import type { StreamPhase } from '../types';

type PartWithText = Part & {
    text?: string;
    content?: string;
    time?: { start?: number; end?: number };
    streaming?: boolean;
};

type ReasoningVariant = 'thinking' | 'justification';

const cleanReasoningText = (text: string): string => {
    if (typeof text !== 'string' || text.trim().length === 0) {
        return '';
    }

    return text
        .split('\n')
        .map((line: string) => line.replace(/^>\s?/, '').trimEnd())
        .filter((line: string) => line.trim().length > 0)
        .join('\n')
        .trim();
};

const SUMMARY_MAX_CHARS = 80;
const LIVE_REASONING_LINE_LIMIT = 40;
const LIVE_REASONING_CHAR_LIMIT = 4000;
const EXPANDED_CONTENT_UNMOUNT_DELAY_MS = 200;
const EXPANDED_CONTENT_TRANSITION = { duration: 0.2, ease: 'easeOut' as const };

/** Strip common markdown syntax so the header preview reads as plain text. */
const stripMarkdown = (text: string): string =>
    text
        // Empty HTML comments are frequently appended by model tool wrappers.
        .replace(/<!--\s*-->/g, '')
        // Fenced code blocks → keep inner text on one line
        .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, inner: string) => inner.trim())
        // Inline code
        .replace(/`([^`]+)`/g, '$1')
        // Bold + italic (*** / __)
        .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
        .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
        // Headings (# ## ###)
        .replace(/^#{1,6}\s+/gm, '')
        // Links [label](url) → label
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        // Blockquote markers
        .replace(/^>\s?/gm, '')
        // Horizontal rules
        .replace(/^[-*_]{3,}\s*$/gm, '')
        // Remaining leading/trailing punctuation from stripped markers
        .trim();

const truncateReasoningPreview = (text: string): string => {
    if (text.length <= SUMMARY_MAX_CHARS) {
        return text;
    }
    const cut = text.lastIndexOf(' ', SUMMARY_MAX_CHARS);
    const end = cut > 0 ? cut : SUMMARY_MAX_CHARS;
    return `${text.substring(0, end).trimEnd()}…`;
};

const getReasoningSummary = (text: string): string => {
    if (!text) {
        return '';
    }

    // Strip markdown, then collapse all whitespace runs into single spaces.
    const flat = stripMarkdown(text).replace(/\s+/g, ' ').trim();
    return truncateReasoningPreview(flat);
};

/** Header preview while thinking streams: only the latest line, not the whole blob. */
const getLatestReasoningLine = (text: string): string => {
    const visible = text.trimEnd();
    if (!visible) {
        return '';
    }
    const newline = visible.lastIndexOf('\n');
    const line = newline === -1 ? visible : visible.slice(newline + 1);
    return truncateReasoningPreview(stripMarkdown(line).replace(/\s+/g, ' ').trim());
};

/** Expanded live thinking keeps a bounded DOM, not the full growing transcript. */
const liveReasoningWindow = (text: string): string => {
    let lines = 1;
    let windowStart = 0;
    for (let index = text.length - 1; index >= 0; index -= 1) {
        if (text.charCodeAt(index) !== 10) {
            continue;
        }
        lines += 1;
        if (lines > LIVE_REASONING_LINE_LIMIT) {
            windowStart = index + 1;
            break;
        }
    }
    const windowed = windowStart > 0 ? text.slice(windowStart) : text;
    if (windowed.length <= LIVE_REASONING_CHAR_LIMIT) {
        return windowed;
    }
    return windowed.slice(-LIVE_REASONING_CHAR_LIMIT);
};

type ReasoningTimelineBlockProps = {
    text: string;
    variant: ReasoningVariant;
    onContentChange?: (reason?: ContentChangeReason) => void;
    blockId: string;
    time?: { start?: number; end?: number };
    showDuration?: boolean;
    isStreaming?: boolean;
    actions?: React.ReactNode;
    /** The turn rail already supplies the shared vertical line and indent. */
    withinActivityRail?: boolean;
};

export const ReasoningTimelineBlock: React.FC<ReasoningTimelineBlockProps> = ({
    text,
    variant,
    onContentChange,
    blockId,
    isStreaming = false,
    actions,
    withinActivityRail = false,
}) => {
    // Reasoning is always shown, collapsible, and initially collapsed for both
    // live and history mounts. The block never automatically opens or closes;
    // only click/keyboard toggles change disclosure, and that explicit choice
    // survives streaming-to-settled updates of the mounted block.
    const [isExpanded, setIsExpanded] = React.useState(false);
    const [shouldRenderExpandedContent, setShouldRenderExpandedContent] = React.useState(false);
    const innerScrollRef = React.useRef<HTMLElement | null>(null);
    const followingInnerRef = React.useRef(true);
    const contentId = React.useId();
    // True when this block mounted while its part was still streaming: the
    // arrival plays the `oc-step-in` fade. History mounts settle statically so
    // scrolling old transcripts never replays arrivals.
    const arrivedLiveRef = React.useRef(isStreaming);
    const contentRef = React.useRef<HTMLDivElement>(null);
    const contentAnimationRef = React.useRef<AnimationPlaybackControls | null>(null);
    const contentMountedRef = React.useRef(false);
    // Stable handle to onContentChange so the height-animation layout effect can
    // signal auto-follow without taking onContentChange as a dependency (which
    // would risk re-running — and thus restarting — the animation on re-render).
    const onContentChangeRef = React.useRef(onContentChange);
    onContentChangeRef.current = onContentChange;

    const summary = React.useMemo(
        () => (isStreaming ? getLatestReasoningLine(text) : getReasoningSummary(text)),
        [isStreaming, text],
    );
    const toggleAriaLabel = isExpanded
        ? "Collapse reasoning trace"
        : "Expand reasoning trace";

    const handleToggle = React.useCallback(() => {
        setShouldRenderExpandedContent(true);
        setIsExpanded((previous) => !previous);
        onContentChange?.('structural');
    }, [onContentChange]);

    const handleKeyDown = React.useCallback((event: React.KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleToggle();
        }
    }, [handleToggle]);

    const handleInnerWheelCapture = React.useCallback((event: React.WheelEvent<HTMLElement>) => {
        if (event.deltaY < 0) {
            followingInnerRef.current = false;
        }
    }, []);

    const handleInnerScroll = React.useCallback((event: React.UIEvent<HTMLElement>) => {
        const element = event.currentTarget;
        followingInnerRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
    }, []);

    React.useLayoutEffect(() => {
        if (!isStreaming || !isExpanded) {
            followingInnerRef.current = true;
            return;
        }
        const element = innerScrollRef.current;
        if (!element || !followingInnerRef.current) {
            return;
        }
        element.scrollTop = element.scrollHeight;
    }, [isExpanded, isStreaming, text]);

    React.useEffect(() => {
        if (isExpanded) {
            setShouldRenderExpandedContent(true);
            return;
        }

        if (!shouldRenderExpandedContent) {
            return;
        }

        if (typeof window === 'undefined') {
            setShouldRenderExpandedContent(false);
            return;
        }

        const timer = window.setTimeout(() => {
            setShouldRenderExpandedContent(false);
        }, EXPANDED_CONTENT_UNMOUNT_DELAY_MS);

        return () => {
            window.clearTimeout(timer);
        };
    }, [isExpanded, shouldRenderExpandedContent]);

    React.useLayoutEffect(() => {
        const element = contentRef.current;
        if (!element) {
            return;
        }

        contentAnimationRef.current?.stop();

        if (!contentMountedRef.current) {
            contentMountedRef.current = true;
            // First body mount lands statically after the user expands: live and
            // history both start collapsed with no body mounted, and the live
            // arrival fade (`oc-step-in`) carries the header motion. Later user
            // toggles animate below.
            element.style.height = isExpanded ? 'auto' : '0px';
            element.style.overflow = isExpanded ? 'visible' : 'hidden';
            return;
        }

        element.style.overflow = 'hidden';

        if (isExpanded) {
            element.style.height = '0px';
        } else {
            element.style.height = `${element.scrollHeight}px`;
            // Only the COLLAPSE animation needs the guard: it shrinks the
            // timeline and the trailing async scroll events can be misread as a
            // user scroll-away. Expansion grows the timeline and re-pins cleanly,
            // and guarding it caused a faint scroll fight while thinking streams.
            onContentChangeRef.current?.('animation');
        }

        const animation = animate(
            element,
            { height: isExpanded ? 'auto' : '0px' },
            EXPANDED_CONTENT_TRANSITION,
        );
        contentAnimationRef.current = animation;

        void animation.finished.then(() => {
            if (contentAnimationRef.current !== animation) {
                return;
            }
            contentAnimationRef.current = null;
            if (isExpanded) {
                element.style.overflow = 'visible';
                element.style.height = 'auto';
            } else {
                element.style.overflow = 'hidden';
            }
        }).catch(() => undefined);

        return () => {
            animation.stop();
            if (contentAnimationRef.current === animation) {
                contentAnimationRef.current = null;
            }
        };
    }, [isExpanded]);

    React.useEffect(() => {
        return () => {
            contentAnimationRef.current?.stop();
            contentAnimationRef.current = null;
        };
    }, []);

    if (!text || text.trim().length === 0) {
        return null;
    }

    const reasoningBody = (
        <>
            <div data-message-text-export-source="true">
                {isStreaming ? (
                    <div className="markdown-content markdown-reasoning w-full min-w-0 whitespace-pre-wrap break-words">
                        {liveReasoningWindow(text)}
                    </div>
                ) : (
                    <MarkdownRenderer
                        content={text}
                        messageId={blockId}
                        isAnimated={false}
                        isStreaming={false}
                        variant="reasoning"
                    />
                )}
            </div>
            {actions ? (
                <div className="mt-2 mb-1 flex items-center justify-start gap-1.5" data-message-actions="true">
                    <div className="flex items-center gap-1.5" data-message-action-group="true">
                        {actions}
                    </div>
                </div>
            ) : null}
        </>
    );

    return (
        <div
            data-reasoning-block-id={blockId}
            data-message-text-export-root="true"
            className={arrivedLiveRef.current ? 'oc-step-in' : undefined}
        >
            <div
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                aria-controls={contentId}
                aria-label={toggleAriaLabel}
                className={cn(
                    'group/tool flex items-center gap-1.5 py-1 pr-2 pl-px cursor-pointer',
                )}
                data-chat-activity-row="true"
                onClick={handleToggle}
                onKeyDown={handleKeyDown}
            >
                <div className="flex h-5 items-center gap-1.5 flex-shrink-0">
                    <div className="relative flex h-5 w-3.5 items-center justify-center">
                        <div
                            className={cn(
                                'absolute inset-0 flex items-center justify-center transition-opacity',
                                isExpanded && 'opacity-0',
                                !isExpanded && 'group-hover/tool:opacity-0',
                            )}
                            style={{ color: 'var(--tools-icon)' }}
                        >
                            <Icon name="brain-ai-3" className="h-3.5 w-3.5" />
                        </div>
                        <div
                            className={cn(
                                'absolute inset-0 transition-opacity flex items-center justify-center',
                                isExpanded && 'opacity-100',
                                !isExpanded && 'opacity-0 group-hover/tool:opacity-100',
                            )}
                            style={{ color: 'var(--tools-icon)' }}
                        >
                            {isExpanded ? <Icon name="arrow-down-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-right-s" className="h-3.5 w-3.5" />}
                        </div>
                    </div>

                    <MinDurationShineText
                        active={isStreaming}
                        className={cn('flex h-5 items-center typography-markdown font-medium text-[length:var(--text-markdown)] leading-none tracking-normal')}
                        style={TOOL_NORMAL_TITLE_STYLE}
                        title={variant === 'justification' ? 'Justification' : 'Thinking'}
                    >
                        {variant === 'justification' ? 'Justification' : 'Thinking'}
                    </MinDurationShineText>
                </div>

                {!isExpanded && summary ? (
                    <span
                        className={cn('flex h-5 flex-1 items-center min-w-0 truncate typography-code font-mono text-[length:var(--text-code)] leading-none tracking-normal')}
                        style={{ color: 'var(--tools-description)', opacity: 0.8 }}
                        title={summary}
                    >
                        {summary}
                    </span>
                ) : null}
            </div>

            {shouldRenderExpandedContent ? (
                <div
                    ref={contentRef}
                    id={contentId}
                    aria-hidden={!isExpanded}
                    style={{
                        height: isExpanded ? 'auto' : '0px',
                        overflow: isExpanded ? 'visible' : 'hidden',
                        overflowAnchor: 'none',
                    }}
                >
                    <div
                        className={cn(
                            'relative pt-0.5',
                            withinActivityRail ? 'pl-0 pb-0' : 'ml-2 pl-3 pb-1',
                        )}
                        style={{
                            opacity: isExpanded ? 1 : 0,
                            transform: isExpanded ? 'translateY(0)' : 'translateY(-4px)',
                            transition: 'opacity 180ms ease-out, transform 180ms ease-out',
                        }}
                    >
                        {!withinActivityRail ? (
                            <span
                                aria-hidden="true"
                                className="pointer-events-none absolute bottom-0 left-0 top-0 w-px"
                                style={{ backgroundColor: 'var(--tools-border)' }}
                            />
                        ) : null}
                        <ScrollableOverlay
                            ref={innerScrollRef}
                            as="div"
                            outerClassName="oc-reasoning-scroll max-h-80 w-full min-w-0"
                            className="p-0"
                            useScrollShadow
                            scrollShadowSize={36}
                            userIntentOnly
                            onWheelCapture={isStreaming ? handleInnerWheelCapture : undefined}
                            onScroll={isStreaming ? handleInnerScroll : undefined}
                        >
                            {reasoningBody}
                        </ScrollableOverlay>
                    </div>
                </div>
            ) : null}
        </div>
    );
};

type ReasoningPartProps = {
    part: Part;
    onContentChange?: (reason?: ContentChangeReason) => void;
    messageId: string;
    streamPhase?: StreamPhase;
    withinActivityRail?: boolean;
};

const ReasoningPart = React.memo(({
    part,
    onContentChange,
    messageId,
    streamPhase,
    withinActivityRail = false,
}: ReasoningPartProps) => {
    const partWithText = part as PartWithText;
    const rawText = partWithText.text || partWithText.content || '';
    const textContent = React.useMemo(() => cleanReasoningText(rawText), [rawText]);
    const time = partWithText.time;
    const canBeStreaming = streamPhase === undefined || streamPhase !== 'completed';
    const isStreaming = canBeStreaming
        && partWithText.streaming === true
        && typeof time?.end !== 'number';
    const throttledText = useStreamingTextThrottle({
        text: textContent,
        isStreaming,
        identityKey: `${messageId}:${part.id ?? 'reasoning'}`,
    });

    // Show reasoning even if time.end isn't set yet (during streaming)
    // Only hide if there's no text content
    if (!throttledText || throttledText.trim().length === 0) {
        return null;
    }

    return (
        <ReasoningTimelineBlock
            text={throttledText}
            variant="thinking"
            onContentChange={onContentChange}
            blockId={part.id || `${messageId}-reasoning`}
            time={time}
            isStreaming={isStreaming}
            withinActivityRail={withinActivityRail}
        />
    );
});

export default ReasoningPart;
