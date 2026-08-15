import React from 'react';
import { PiChamberLogo } from '@/components/ui/PiChamberLogo';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useGlobalSyncStore } from '@/sync/global-sync-store';

interface ChatEmptyStateProps {
    isNewSession?: boolean;
}

const ChatEmptyState: React.FC<ChatEmptyStateProps> = ({ isNewSession = false }) => {
    const { currentTheme } = useThemeSystem();
    const initError = useGlobalSyncStore((s) => s.error);

    const textColor = currentTheme?.colors?.surface?.mutedForeground || 'var(--muted-foreground)';

    return (
        <div className="flex flex-col items-center justify-center min-h-full w-full gap-6">
            <PiChamberLogo
                width={120}
                height={120}
                isAnimated={!isNewSession}
                className={isNewSession ? "opacity-20" : undefined}
            />
            {initError ? (
                <div className="flex flex-col items-center gap-2 max-w-md text-center px-4">
                    <span className="text-body-md font-medium text-destructive">{"PiChamber is not reachable"}</span>
                    <span className="text-body-sm" style={{ color: textColor }}>
                        {typeof initError === 'string' ? initError : (initError as { message?: string })?.message || String(initError)}
                    </span>
                </div>
            ) : isNewSession ? (
                <span className="text-body-md" style={{ color: textColor }}>{"Start a new chat"}</span>
            ) : null}
        </div>
    );
};

export default React.memo(ChatEmptyState);
