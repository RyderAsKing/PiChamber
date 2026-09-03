import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useChatSurfaceMode } from '@/components/chat/chatSurfaceContext';
import { useTransientValue } from '@/hooks/useTransientValue';
import { cn } from '@/lib/utils';
import { MessageForkAction } from './MessageForkAction';
import { MessageRevertAction } from './MessageRevertAction';

export interface AssistantMessageActionButtonsProps {
    hasCopyableText: boolean;
    isTouchContext: boolean;
    onCopyMessage?: () => void | boolean | Promise<void | boolean>;
    onShareImage: (sourceElement?: HTMLElement | null) => Promise<void>;
    sessionId?: string | null;
    messageId?: string | null;
    isLatestMessage?: boolean;
}

export const AssistantMessageActionButtons = React.memo(({
    hasCopyableText,
    isTouchContext,
    onCopyMessage,
    onShareImage,
    sessionId,
    messageId,
    isLatestMessage = false,
}: AssistantMessageActionButtonsProps) => {
    const chatSurfaceMode = useChatSurfaceMode();
    const [copyHintVisible, setCopyHintVisible] = React.useState(false);
    const { value: isMessageCopied, show: showMessageCopied, clear: clearMessageCopied } = useTransientValue(false, 2000);
    const [isSharing, setIsSharing] = React.useState(false);
    const copyHintTimeoutRef = React.useRef<number | null>(null);
    const canCopyMessage = Boolean(onCopyMessage);

    const clearCopyHintTimeout = React.useCallback(() => {
        if (copyHintTimeoutRef.current !== null && typeof window !== 'undefined') {
            window.clearTimeout(copyHintTimeoutRef.current);
            copyHintTimeoutRef.current = null;
        }
    }, []);

    React.useEffect(() => clearCopyHintTimeout, [clearCopyHintTimeout]);

    React.useEffect(() => {
        if (!hasCopyableText || !canCopyMessage) {
            setCopyHintVisible(false);
            clearCopyHintTimeout();
            clearMessageCopied();
        }
    }, [canCopyMessage, clearCopyHintTimeout, clearMessageCopied, hasCopyableText]);

    const revealCopyHint = React.useCallback(() => {
        if (!isTouchContext || !canCopyMessage || !hasCopyableText || typeof window === 'undefined') {
            return;
        }

        clearCopyHintTimeout();
        setCopyHintVisible(true);
        copyHintTimeoutRef.current = window.setTimeout(() => {
            setCopyHintVisible(false);
            copyHintTimeoutRef.current = null;
        }, 1800);
    }, [canCopyMessage, clearCopyHintTimeout, hasCopyableText, isTouchContext]);

    const handleCopyButtonClick = React.useCallback(
        async (event: React.MouseEvent<HTMLButtonElement>) => {
            if (!onCopyMessage || !hasCopyableText) {
                return;
            }

            event.stopPropagation();
            event.preventDefault();

            const copied = await onCopyMessage();
            if (copied === false) {
                return;
            }

            showMessageCopied(true);

            if (isTouchContext) {
                revealCopyHint();
            }
        },
        [hasCopyableText, isTouchContext, onCopyMessage, revealCopyHint, showMessageCopied]
    );

    const handleShareImageClick = React.useCallback(
        async (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            event.preventDefault();

            if (isSharing || !hasCopyableText) {
                return;
            }

            setIsSharing(true);
            try {
                const root = event.currentTarget.closest('[data-message-text-export-root]');
                const sourceElement = root?.querySelector<HTMLElement>('[data-message-text-export-source]') ?? null;
                await onShareImage(sourceElement);
            } finally {
                setIsSharing(false);
            }
        },
        [hasCopyableText, isSharing, onShareImage]
    );

    return (
        <>
            {/* Stable keys: without them the revert insertion on send
                remounts every sibling positionally (fork->revert,
                copy->fork, ...), flashing the whole group. With keys only
                the revert slot itself mounts. The placeholder reserves its
                geometry so siblings never shift. */}
            {sessionId && messageId && !isLatestMessage ? (
                <MessageRevertAction key="message-revert" sessionId={sessionId} messageId={messageId} size="assistant" />
            ) : sessionId && messageId ? (
                <span key="message-revert" aria-hidden="true" className="h-8 w-8 flex-shrink-0" />
            ) : null}
            {sessionId && messageId ? (
                <MessageForkAction key="message-fork" sessionId={sessionId} messageId={messageId} size="assistant" />
            ) : null}
            {onCopyMessage && (
                <Tooltip key="message-copy">
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            data-visible={copyHintVisible || isMessageCopied ? 'true' : undefined}
                            className={cn(
                                'h-8 w-8 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50',
                                !hasCopyableText && 'opacity-50'
                            )}
                            disabled={!hasCopyableText}
                            aria-label={"Copy message text"}
                            aria-hidden={!hasCopyableText}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                void handleCopyButtonClick(event);
                            }}
                            onFocus={() => {
                                if (hasCopyableText) {
                                    setCopyHintVisible(true);
                                }
                            }}
                            onBlur={() => {
                                if (!isMessageCopied) {
                                    setCopyHintVisible(false);
                                }
                            }}
                        >
                            {isMessageCopied ? (
                                <Icon name="check" className="h-3.5 w-3.5 text-[color:var(--status-success)]" />
                            ) : (
                                <Icon name="file-copy" className="h-3.5 w-3.5" />
                            )}
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{"Copy answer"}</TooltipContent>
                </Tooltip>
            )}
            {chatSurfaceMode !== 'mini-chat' ? <Tooltip key="message-share">
                <TooltipTrigger asChild>
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        disabled={isSharing || !hasCopyableText}
                        className={cn(
                            'h-8 w-8 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-primary/50',
                            (!hasCopyableText || isSharing) && 'opacity-50'
                        )}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            void handleShareImageClick(event);
                        }}
                    >
                        {isSharing ? (
                            <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                        ) : (
                            <Icon name="image-download" className="h-4 w-4" />
                        )}
                    </Button>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>{isSharing ? "Saving image..." : "Save as image"}</TooltipContent>
            </Tooltip> : null}
        </>
    );
});
