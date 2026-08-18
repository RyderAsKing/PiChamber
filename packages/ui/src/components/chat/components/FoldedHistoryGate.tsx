import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { HISTORY_FOLD_REVEAL_BATCH } from '../lib/turns/foldHistoryTurns';

interface FoldedHistoryGateProps {
    foldedCount: number;
    onLoadOlder: () => void;
    onLoadAll: () => void;
}

const FoldedHistoryGate: React.FC<FoldedHistoryGateProps> = ({
    foldedCount,
    onLoadOlder,
    onLoadAll,
}) => {
    const countLabel = foldedCount === 1 ? '1 earlier turn' : `${foldedCount} earlier turns`;
    const olderBatch = Math.min(HISTORY_FOLD_REVEAL_BATCH, foldedCount);
    const olderLabel = olderBatch === 1 ? 'Load 1 earlier turn' : `Load ${olderBatch} earlier turns`;
    const showLoadAll = foldedCount > olderBatch;

    return (
        <div className="chat-message-column flex flex-col items-center py-4">
            <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={onLoadOlder}
                    aria-label={`${olderLabel}, ${countLabel} remaining`}
                    className="gap-1.5 rounded-full px-3.5"
                >
                    <Icon name="history" className="size-3.5" />
                    Load older history
                </Button>
                {showLoadAll ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={onLoadAll}
                        aria-label={`Load all ${countLabel}`}
                        className="rounded-full px-3.5 text-[var(--surface-mutedForeground)]"
                    >
                        Load all history
                    </Button>
                ) : null}
            </div>
            <p className="mt-1.5 typography-meta text-[var(--surface-mutedForeground)]">
                {countLabel}
            </p>
        </div>
    );
};

export default React.memo(FoldedHistoryGate);
