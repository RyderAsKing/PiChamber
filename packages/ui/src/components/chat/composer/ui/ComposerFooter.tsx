/**
 * The composer's footer row.
 *
 * Desktop lays it out as attachments and toggles on the left, model controls
 * and send on the right. Mobile keeps everything on one line and swaps the
 * model controls for the compact buttons above the text, because the footer
 * has to stay reachable with one thumb.
 *
 * The dictation component is rendered here on desktop only: on mobile it lives
 */

import React from 'react';

import { cn } from '@/lib/utils';
import { ModelControls } from '../../ModelControls';
import { ComposerActionButtons } from './ComposerActionButtons';
import { ComposerAttachmentControls } from './ComposerAttachmentControls';
import { FocusModeButton } from './FocusModeButton';
import { PermissionAutoAcceptButton } from './PermissionAutoAcceptButton';

const MemoModelControls = React.memo(ModelControls);

export interface ComposerFooterProps {
    isMobile: boolean;
    sessionId: string | null;
    directory?: string;
    newSessionDraftOpen: boolean;
    messageLength: number;

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
    isExpandedInput: boolean;
    permissionAutoAcceptEnabled: boolean;
    isPermissionAutoAcceptInteractive: boolean;

    onOpenSettings?: () => void;
    onPickLocalFiles: () => void;
    onOpenIssuePicker: () => void;
    onOpenPrPicker: () => void;
    onOpenAttachSheet: () => void;
    onToggleExpandedInput: () => void;
    onTogglePermissionAutoAccept: () => void;
    onPrimaryAction: () => void;
    onQueueMessage: () => void;
    onAbort: () => void;
}

export function ComposerFooter(props: ComposerFooterProps) {
    const {
        isMobile,
        sessionId: currentSessionId,
        newSessionDraftOpen,
        radius: chatInputRadius,
        footerPaddingClass,
        footerGapClass,
        footerIconButtonClass,
        iconSizeClass,
        sendIconSizeClass,
        stopIconSizeClass,
        canSend,
        canAbort,
        hasContent,
        isExpandedInput,
        permissionAutoAcceptEnabled,
        isPermissionAutoAcceptInteractive,
        onOpenSettings,
        onPickLocalFiles,
        onOpenIssuePicker,
        onOpenPrPicker,
        onOpenAttachSheet,
        onToggleExpandedInput,
        onTogglePermissionAutoAccept,
        onPrimaryAction,
        onQueueMessage,
        onAbort,
    } = props;

    return (
        <div
            className={cn(
                'bg-transparent flex-shrink-0',
                footerPaddingClass,
                isMobile ? 'flex items-center gap-x-1.5' : cn('flex items-center justify-between', footerGapClass)
            )}
            style={{
                borderBottomLeftRadius: chatInputRadius,
                borderBottomRightRadius: chatInputRadius,
            }}
            data-chat-input-footer="true"
        >
            {isMobile ? (
                <div className="flex w-full items-center justify-between gap-x-1.5">
                    <div className="composer-mobile-actions flex items-center gap-x-2 pl-1">
                        <ComposerAttachmentControls
                            footerIconButtonClass={footerIconButtonClass}
                            iconSizeClass={iconSizeClass}
                            handlePickLocalFiles={onPickLocalFiles}
                            openIssuePicker={onOpenIssuePicker}
                            openPrPicker={onOpenPrPicker}
                            onOpenSettings={onOpenSettings}
                            onOpenMobileSheet={onOpenAttachSheet}
                        />
                        <PermissionAutoAcceptButton
                            footerIconButtonClass={footerIconButtonClass}
                            iconSizeClass={iconSizeClass}
                            isInteractive={isPermissionAutoAcceptInteractive}
                            permissionAutoAcceptEnabled={permissionAutoAcceptEnabled}
                            handlePermissionAutoAcceptToggle={onTogglePermissionAutoAccept}
                        />
                    </div>
                    <div className="flex items-center min-w-0 gap-x-1 justify-end">
                        <div className="flex items-center gap-x-1 flex-shrink-0">
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
                        </div>
                    </div>
                </div>
            ) : (
                <>
                    <div className={cn("flex items-center flex-shrink-0", footerGapClass)}>
                        <ComposerAttachmentControls
                            footerIconButtonClass={footerIconButtonClass}
                            iconSizeClass={iconSizeClass}
                            handlePickLocalFiles={onPickLocalFiles}
                            openIssuePicker={onOpenIssuePicker}
                            openPrPicker={onOpenPrPicker}
                            onOpenSettings={onOpenSettings}
                        />
                        <FocusModeButton
                            footerIconButtonClass={footerIconButtonClass}
                            iconSizeClass={iconSizeClass}
                            isExpandedInput={isExpandedInput}
                            onToggle={onToggleExpandedInput}
                        />
                        <PermissionAutoAcceptButton
                            footerIconButtonClass={footerIconButtonClass}
                            iconSizeClass={iconSizeClass}
                            isInteractive={isPermissionAutoAcceptInteractive}
                            permissionAutoAcceptEnabled={permissionAutoAcceptEnabled}
                            handlePermissionAutoAcceptToggle={onTogglePermissionAutoAccept}
                            withTooltip
                        />
                    </div>
                    <div className={cn('flex items-center flex-1 justify-end', footerGapClass, 'md:gap-x-3')}>
                        <MemoModelControls className={cn('flex-1 min-w-0 justify-end')} />
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
                    </div>
                </>
            )}
        </div>
    );
}
