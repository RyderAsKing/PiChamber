/**
 * The composer's chrome around the editor.
 *
 * Desktop (except mini-chat) uses a stacked card: editor on top, attachments
 * and model picker (with thinking after the model name) on the left of the
 * footer, send on the right. Mini-chat keeps a one-line pill with the model
 * picker under the composer. Dedicated mobile keeps a stacked footer so the
 * send control stays reachable with one thumb, with model and variant pickers
 * in that footer and no + attach control.
 */

import React from 'react';

import { cn } from '@/lib/utils';
import { ComposerActionButtons } from './ComposerActionButtons';
import { ComposerAttachmentControls } from './ComposerAttachmentControls';

export interface ComposerFooterProps {
    isMobile: boolean;
    isInline: boolean;
    alignToolsEnd: boolean;
    sessionId: string | null;
    directory?: string;
    newSessionDraftOpen: boolean;
    messageLength: number;
    children?: React.ReactNode;
    leadingExtra?: React.ReactNode;

    radius: string;
    footerPaddingClass: string;
    footerGapClass: string;
    footerIconButtonClass: string;
    iconSizeClass: string;
    sendIconSizeClass: string;
    stopIconSizeClass: string;

    canSend: boolean;
    canAbort: boolean;
    hasContent: boolean;

    onOpenSettings?: () => void;
    onPickLocalFiles: () => void;
    onOpenIssuePicker: () => void;
    onOpenPrPicker: () => void;
    onOpenAttachSheet: () => void;
    onPrimaryAction: () => void;
    onQueueMessage: () => void;
    onAbort: () => void;
}

export function ComposerFooter(props: ComposerFooterProps) {
    const {
        isMobile,
        isInline,
        alignToolsEnd,
        sessionId: currentSessionId,
        newSessionDraftOpen,
        children,
        leadingExtra,
        footerPaddingClass,
        footerGapClass,
        footerIconButtonClass,
        iconSizeClass,
        sendIconSizeClass,
        stopIconSizeClass,
        canSend,
        canAbort,
        hasContent,
        onOpenSettings,
        onPickLocalFiles,
        onOpenIssuePicker,
        onOpenPrPicker,
        onOpenAttachSheet,
        onPrimaryAction,
        onQueueMessage,
        onAbort,
    } = props;

    const attachments = (
        <ComposerAttachmentControls
            footerIconButtonClass={footerIconButtonClass}
            iconSizeClass={iconSizeClass}
            handlePickLocalFiles={onPickLocalFiles}
            openIssuePicker={onOpenIssuePicker}
            openPrPicker={onOpenPrPicker}
            onOpenSettings={onOpenSettings}
            onOpenMobileSheet={isMobile ? onOpenAttachSheet : undefined}
            hideAddButton={isMobile}
        />
    );

    const actions = (
        <ComposerActionButtons
            isMobile={isMobile}
            footerIconButtonClass={footerIconButtonClass}
            sendIconSizeClass={sendIconSizeClass}
            stopIconSizeClass={stopIconSizeClass}
            canSend={canSend}
            canAbort={canAbort}
            hasContent={hasContent}
            currentSessionId={currentSessionId}
            newSessionDraftOpen={newSessionDraftOpen}
            onPrimaryAction={onPrimaryAction}
            onQueueMessage={onQueueMessage}
            onAbort={onAbort}
        />
    );

    if (isMobile) {
        return (
            <div className="flex min-h-0 flex-1 flex-col bg-transparent">
                <div className="min-h-0 min-w-0 flex-1">{children}</div>
                <div
                    className={cn('flex-shrink-0', footerPaddingClass, 'flex items-center gap-x-1.5')}
                    data-chat-input-footer="true"
                >
                    <div className="flex w-full items-center justify-between gap-x-1.5">
                        <div className="composer-mobile-actions flex min-w-0 items-center gap-x-2 overflow-x-auto pl-1">
                            {attachments}
                            {leadingExtra ? (
                                <div className="w-max shrink-0">
                                    {leadingExtra}
                                </div>
                            ) : null}
                        </div>
                        <div className="flex min-w-0 shrink-0 items-center justify-end gap-x-1">
                            {actions}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (isInline) {
        const toolAlign = alignToolsEnd ? 'self-end' : 'self-center';
        return (
            <div
                className={cn(
                    'grid grid-cols-[auto_minmax(0,1fr)_auto] bg-transparent',
                    footerPaddingClass,
                    footerGapClass,
                )}
                data-chat-input-footer="true"
            >
                <div className={cn('flex min-w-0 items-center', footerGapClass, toolAlign)}>
                    {attachments}
                </div>
                <div className="min-w-0">{children}</div>
                <div className={cn('flex min-w-0 items-center justify-end', footerGapClass, toolAlign)}>
                    {actions}
                </div>
            </div>
        );
    }

    return (
        <div className="flex min-h-0 flex-1 flex-col bg-transparent">
            <div className="min-h-0 min-w-0 flex-1">{children}</div>
            <div
                className={cn(
                    'flex flex-shrink-0 items-center justify-between',
                    footerPaddingClass,
                    footerGapClass,
                )}
                data-chat-input-footer="true"
            >
                <div className={cn('flex min-w-0 items-center', footerGapClass)}>
                    {attachments}
                    {leadingExtra ? (
                        <div className="w-max min-w-0 shrink-0">
                            {leadingExtra}
                        </div>
                    ) : null}
                </div>
                <div className={cn('flex flex-shrink-0 items-center', footerGapClass)}>
                    {actions}
                </div>
            </div>
        </div>
    );
}
