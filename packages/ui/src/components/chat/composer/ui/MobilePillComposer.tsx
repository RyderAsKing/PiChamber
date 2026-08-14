/**
 * The collapsed mobile composer.
 *
 * With the keyboard down the composer is a pill: attachments, a one-line
 * preview of the draft, and a mic, with a round new-session button beside it.
 * Tapping anywhere in it expands the real composer and raises the keyboard in
 * the same gesture — which is why the expand handler must run synchronously
 * from the tap rather than from an effect.
 *
 * The new-session button collapses away once a draft is already open, letting
 * the pill grow into its place.
 */

import { Icon } from '@/components/icon/Icon';
import { StopIcon } from '@/components/icons/StopIcon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { Theme } from '@/types/theme';
import { ComposerAttachmentControls } from './ComposerAttachmentControls';

export interface MobilePillComposerProps {
    message: string;
    sessionId: string | null;
    directory?: string;
    newSessionDraftOpen: boolean;
    canAbort: boolean;
    footerIconButtonClass: string;
    iconSizeClass: string;
    stopIconSizeClass: string;
    theme: Theme;
    onExpand: () => void;
    onNewSession: () => void;
    onPickLocalFiles: () => void;
    onOpenIssuePicker: () => void;
    onOpenPrPicker: () => void;
    onOpenAttachSheet: () => void;
    onAbort: () => void;
}

export function MobilePillComposer(props: MobilePillComposerProps) {
    const { t } = useI18n();
    const {
        message,
        sessionId: currentSessionId,
        newSessionDraftOpen,
        canAbort,
        footerIconButtonClass,
        iconSizeClass,
        stopIconSizeClass,
        theme: currentTheme,
        onExpand,
        onNewSession,
        onPickLocalFiles,
        onOpenIssuePicker,
        onOpenPrPicker,
        onOpenAttachSheet,
        onAbort,
    } = props;

    return (
        <div className="flex flex-col">
        <div className="flex items-center gap-2">
            <div
                className="flex h-11 min-w-0 flex-1 items-center gap-x-0.5 rounded-full border border-border/80 pl-2 pr-1 shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]"
                style={{ backgroundColor: currentTheme?.colors?.surface?.subtle }}
            >
                <ComposerAttachmentControls
                    footerIconButtonClass={footerIconButtonClass}
                    iconSizeClass={iconSizeClass}
                    handlePickLocalFiles={onPickLocalFiles}
                    openIssuePicker={onOpenIssuePicker}
                    openPrPicker={onOpenPrPicker}
                    onOpenMobileSheet={onOpenAttachSheet}
                />
                <button
                    type="button"
                    className="flex h-full min-w-0 flex-1 cursor-text items-center px-1.5 text-left"
                    onClick={onExpand}
                >
                    <span
                        className={cn(
                            'truncate typography-ui-label',
                            message.trim() ? 'text-foreground' : 'text-muted-foreground',
                        )}
                    >
                        {message.trim()
                            ? message
                            : currentSessionId || newSessionDraftOpen
                                ? t('chat.chatInput.placeholder.chatCompact')
                                : t('chat.chatInput.placeholder.selectSession')}
                    </span>
                </button>
                {/* While a turn is running the stop button appears in the end slot. */}
                {canAbort ? (
                    <button
                        type="button"
                        className={cn(footerIconButtonClass, 'text-[var(--status-error)] hover:text-[var(--status-error)]')}
                        // The pill shows only while the keyboard is down — the
                        // tap must abort in place, never focus/expand the
                        // composer or raise the keyboard.
                        onMouseDown={(event) => event.preventDefault()}
                        onPointerDownCapture={(event) => {
                            if (event.pointerType === 'touch') {
                                event.preventDefault();
                            }
                        }}
                        onClick={(event) => {
                            event.stopPropagation();
                            onAbort();
                        }}
                        title={t('chat.chatInput.actions.stopGeneratingAria')}
                        aria-label={t('chat.chatInput.actions.stopGeneratingAria')}
                    >
                        <StopIcon className={cn(stopIconSizeClass)} />
                    </button>
                ) : null}
            </div>
            {/* New-session button: fades/shrinks away when the draft is
                already open, letting the pill expand into its place. */}
            <div
                className={cn(
                    'flex-shrink-0 transition-all duration-200 ease-out',
                    newSessionDraftOpen ? 'w-0 opacity-0 overflow-hidden' : 'w-11 opacity-100',
                )}
            >
                <button
                    type="button"
                    className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-border/80 text-foreground shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]"
                    style={{ backgroundColor: currentTheme?.colors?.surface?.subtle }}
                    onClick={onNewSession}
                    disabled={newSessionDraftOpen}
                    title={t('mobile.sessions.newChat')}
                    aria-label={t('mobile.sessions.newChat')}
                >
                    <Icon name="add" className="h-5 w-5 text-current" />
                </button>
            </div>
        </div>
        </div>
    );
}
