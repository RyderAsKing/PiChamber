/**
 * The composer's send / queue / stop control.
 *
 * Which one is shown depends on whether a turn is running: idle sends, a busy
 * session with content offers both queue (above) and stop, a busy session
 * without content offers only stop.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { StopIcon } from '@/components/icons/StopIcon';
import { cn } from '@/lib/utils';

type ComposerActionButtonsProps = {
    isMobile: boolean;
    footerIconButtonClass: string;
    sendIconSizeClass: string;
    stopIconSizeClass: string;
    canSend: boolean;
    disabledReason?: string | null;
    canAbort: boolean;
    hasContent: boolean;
    currentSessionId: string | null;
    newSessionDraftOpen: boolean;
    /** True while a new-session send is in flight: show pending, block input. */
    isSending?: boolean;
    onPrimaryAction: () => void;
    onQueueMessage: () => void;
    onAbort: () => void;
};

export const ComposerActionButtons = React.memo(function ComposerActionButtons(props: ComposerActionButtonsProps) {
    const {
        isMobile,
        footerIconButtonClass,
        sendIconSizeClass,
        stopIconSizeClass,
        canSend,
        disabledReason,
        canAbort,
        hasContent,
        currentSessionId,
        newSessionDraftOpen,
        isSending = false,
        onPrimaryAction,
        onQueueMessage,
        onAbort,
    } = props;
    

    const sendButton = (
        <button
            type={isMobile ? 'button' : 'submit'}
            disabled={!canSend || (!currentSessionId && !newSessionDraftOpen) || isSending}
            onClick={(event) => {
                if (!isMobile) {
                    return;
                }

                event.preventDefault();
                onPrimaryAction();
            }}
            className={cn(
                footerIconButtonClass,
                canSend && (currentSessionId || newSessionDraftOpen) && !isSending
                    ? 'text-primary hover:text-primary'
                    : 'opacity-30',
                isSending && 'animate-pulse'
            )}
            aria-label={isSending ? "Creating session…" : disabledReason || "Send message"}
            title={isSending ? "Creating session…" : disabledReason || undefined}
        >
            {isSending
                ? <Icon name="loader-4" className={cn(sendIconSizeClass, 'animate-spin')} />
                : <Icon name="send-plane-2" className={cn(sendIconSizeClass)} />}
        </button>
    );

    if (!canAbort) {
        return sendButton;
    }

    return (
        <div className="relative">
            {hasContent ? (
                <button
                    type="button"
                    disabled={!currentSessionId || !canSend}
                    onClick={(event) => {
                        if (isMobile) {
                            event.preventDefault();
                        }
                        onQueueMessage();
                    }}
                    className={cn(
                        footerIconButtonClass,
                        'absolute z-20 bottom-full left-1/2 -translate-x-1/2 mb-1',
                        currentSessionId && canSend ? 'text-primary hover:text-primary' : 'opacity-30'
                    )}
                    aria-label={disabledReason || "Queue message"}
                    title={disabledReason || undefined}
                >
                    <Icon name="send-plane-2" className={cn(sendIconSizeClass, '-rotate-90')} />
                </button>
            ) : null}
            <button
                type="button"
                onClick={onAbort}
                className={cn(
                    footerIconButtonClass,
                    'text-[var(--status-error)] hover:text-[var(--status-error)]'
                )}
                aria-label={"Stop generating"}
            >
                <StopIcon className={cn(stopIconSizeClass)} />
            </button>
        </div>
    );
}, (prev, next) => (
    prev.isMobile === next.isMobile
    && prev.footerIconButtonClass === next.footerIconButtonClass
    && prev.sendIconSizeClass === next.sendIconSizeClass
    && prev.stopIconSizeClass === next.stopIconSizeClass
    && prev.canSend === next.canSend
    && prev.disabledReason === next.disabledReason
    && prev.canAbort === next.canAbort
    && prev.hasContent === next.hasContent
    && prev.currentSessionId === next.currentSessionId
    && prev.newSessionDraftOpen === next.newSessionDraftOpen
    && prev.isSending === next.isSending
    && prev.onPrimaryAction === next.onPrimaryAction
    && prev.onQueueMessage === next.onQueueMessage
    && prev.onAbort === next.onAbort
));
