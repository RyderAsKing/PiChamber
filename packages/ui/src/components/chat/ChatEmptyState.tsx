/* eslint-disable */
// @ts-nocheck
import React from 'react';
import { PiChamberLogo } from '@/components/ui/PiChamberLogo';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useGlobalSyncStore } from '@/sync/global-sync-store';

const ChatEmptyState: React.FC = () => {
    const { currentTheme } = useThemeSystem();
    const initError = useGlobalSyncStore((s) => s.error);

    const textColor = currentTheme?.colors?.surface?.mutedForeground || 'var(--muted-foreground)';

    return (
        <div className="flex flex-col items-center justify-center min-h-full w-full gap-6">
            <PiChamberLogo width={140} height={140} className="opacity-20" />
            {initError ? (
                <div className="flex flex-col items-center gap-2 max-w-md text-center px-4">
                    <span className="text-body-md font-medium text-destructive">{"PiChamber is not reachable"}</span>
                    <span className="text-body-sm" style={{ color: textColor }}>
                        {initError.message}
                    </span>
                </div>
            ) : (
                <span className="text-body-md" style={{ color: textColor }}>{"Start a new chat"}</span>
            )}
        </div>
    );
};

export default React.memo(ChatEmptyState);
