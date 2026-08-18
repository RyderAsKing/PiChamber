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
    const olderBatch = Math.min(HISTORY_FOLD_REVEAL_BATCH, foldedCount);
    const showLoadAll = foldedCount > olderBatch;

    return (
        <div className="chat-message-column flex flex-col items-center py-4">
            <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={onLoadOlder}
                    aria-label={"Load older history"}
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
                        aria-label={"Load all history"}
                        className="rounded-full px-3.5 text-[var(--surface-mutedForeground)]"
                    >
                        Load all history
                    </Button>
                ) : null}
            </div>
        </div>
    );
};

export default React.memo(FoldedHistoryGate);
