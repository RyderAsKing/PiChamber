/**
 * Attachment and settings controls in the composer footer.
 *
 * Memoized with an explicit comparator so a re-render of the whole composer
 * does not tear down the dropdown while it is open.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

type ComposerAttachmentControlsProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    handlePickLocalFiles: () => void;
    onOpenSettings?: () => void;
    onMenuOpenChange?: (open: boolean) => void;
    /**
     * Mobile: invoke the attach action directly (opens the shared native
     * picker) instead of the desktop dropdown menu. The caller owns what
     * the action does; this control only owns placement and chrome.
     */
    onOpenMobileSheet?: () => void;
    /** Disable all controls while a send is in flight. */
    disabled?: boolean;
};

export const ComposerAttachmentControls = React.memo(function ComposerAttachmentControls(props: ComposerAttachmentControlsProps) {
    
    const {
        footerIconButtonClass,
        iconSizeClass,
        handlePickLocalFiles,
        onOpenSettings,
        disabled = false,
    } = props;

    return (
        <div className="flex items-center gap-x-1.5">
            <div className="relative inline-flex">
                {props.onOpenMobileSheet ? (
                    <button
                        type="button"
                        className={footerIconButtonClass}
                        onClick={props.onOpenMobileSheet}
                        disabled={disabled}
                        // Keep the tap from dismissing the keyboard. On Android's
                        // resizes-content viewport the keyboard-close relayout
                        // moves this button mid-tap and the click never lands.
                        onMouseDown={(event) => event.preventDefault()}
                        onPointerDownCapture={(event) => {
                            if (event.pointerType === 'touch') {
                                event.preventDefault();
                            }
                        }}
                        title={"Add attachment"}
                        aria-label={"Add attachment"}
                    >
                        <Icon name="add-circle" className={cn(iconSizeClass, 'text-current')} />
                    </button>
                ) : (
                    <DropdownMenu onOpenChange={props.onMenuOpenChange}>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                className={footerIconButtonClass}
                                title={"Add attachment"}
                                aria-label={"Add attachment"}
                                disabled={disabled}
                            >
                                <Icon name="add-circle" className={cn(iconSizeClass, 'text-current')} />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            <DropdownMenuItem
                                onSelect={() => {
                                    requestAnimationFrame(handlePickLocalFiles);
                                }}
                            >
                                <Icon name="attachment-2"/>
                                {"Attach files"}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>

            {onOpenSettings ? (
                <button
                    type="button"
                    onClick={onOpenSettings}
                    className={footerIconButtonClass}
                    title={"Model and agent settings"}
                    aria-label={"Model and agent settings"}
                    disabled={disabled}
                >
                    <Icon name="ai-agent" className={cn(iconSizeClass, 'text-current')} />
                </button>
            ) : null}
        </div>
    );
}, (prev, next) => (
    prev.footerIconButtonClass === next.footerIconButtonClass
    && prev.iconSizeClass === next.iconSizeClass
    && prev.handlePickLocalFiles === next.handlePickLocalFiles
    && prev.onOpenSettings === next.onOpenSettings
    && prev.onMenuOpenChange === next.onMenuOpenChange
    && prev.onOpenMobileSheet === next.onOpenMobileSheet
    && prev.disabled === next.disabled
));
