import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { getMessagePreview } from '../lib/messagePreview';
import type { TurnRecord } from '../lib/turns/types';

interface FoldedTurnRowProps {
    turn: TurnRecord;
    onExpand: (turnId: string) => void;
}

const FoldedTurnRow: React.FC<FoldedTurnRowProps> = ({ turn, onExpand }) => {
    const preview = getMessagePreview(turn.userMessage.parts, 72) || 'Turn';
    const toolCount = turn.activityParts.filter((part) => part.kind === 'tool').length;
    const toolLabel = toolCount === 1 ? '1 tool' : toolCount > 0 ? `${toolCount} tools` : null;
    const label = toolLabel ? `${preview} · ${toolLabel}` : preview;

    return (
        <button
            type="button"
            data-turn-id={turn.turnId}
            data-message-id={turn.userMessage.info.id}
            data-scroll-spy-id={turn.turnId}
            onClick={() => onExpand(turn.turnId)}
            aria-label={`Show this turn: ${label}`}
            className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left',
                'rounded-lg typography-meta text-[var(--surface-mutedForeground)]',
                'hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focusRing)]',
            )}
        >
            <Icon name="arrow-right-s" className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">{preview}</span>
            {toolLabel ? (
                <span className="shrink-0 text-[var(--surface-mutedForeground)]">{toolLabel}</span>
            ) : null}
        </button>
    );
};

export default React.memo(FoldedTurnRow);
