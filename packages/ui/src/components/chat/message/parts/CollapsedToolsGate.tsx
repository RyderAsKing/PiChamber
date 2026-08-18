import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';

interface CollapsedToolsGateProps {
    toolCount: number;
    expanded: boolean;
    onToggle: () => void;
}

const CollapsedToolsGate: React.FC<CollapsedToolsGateProps> = ({ toolCount, expanded, onToggle }) => {
    const countLabel = toolCount === 1 ? '1 tool' : `${toolCount} tools`;
    const actionLabel = expanded ? 'Hide tools' : `Show ${countLabel}`;

    return (
        <div className="flex justify-center py-2">
            <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onToggle}
                aria-expanded={expanded}
                aria-label={actionLabel}
                className="gap-1.5 rounded-full text-[var(--surface-mutedForeground)]"
            >
                <Icon name="arrow-right-s" className="size-3.5" style={expanded ? { transform: 'rotate(90deg)' } : undefined} />
                {actionLabel}
            </Button>
        </div>
    );
};

export default React.memo(CollapsedToolsGate);
