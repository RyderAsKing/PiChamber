/** Expands the composer to fill the surface (desktop focus mode). */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn, isMacOS } from '@/lib/utils';

type FocusModeButtonProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    isExpandedInput: boolean;
    onToggle: () => void;
};

export const FocusModeButton = React.memo(function FocusModeButton(props: FocusModeButtonProps) {
    const { footerIconButtonClass, iconSizeClass, isExpandedInput, onToggle } = props;
    

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        footerIconButtonClass,
                        'rounded-md',
                        isExpandedInput
                            ? 'text-primary'
                            : 'text-foreground hover:bg-[var(--interactive-hover)]/40'
                    )}
                    onMouseDown={(event) => {
                        event.preventDefault();
                    }}
                    onClick={onToggle}
                    aria-label={"Toggle focus mode"}
                    aria-pressed={isExpandedInput}
                >
                    <Icon name="fullscreen" className={cn(iconSizeClass)} />
                </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
                <div className="flex flex-col gap-0.5 text-center">
                    <span>{"Focus mode"}</span>
                    <span className="font-mono opacity-60">
                        {isMacOS() ? '⌘⇧E' : 'Ctrl+Shift+E'}
                    </span>
                </div>
            </TooltipContent>
        </Tooltip>
    );
});
