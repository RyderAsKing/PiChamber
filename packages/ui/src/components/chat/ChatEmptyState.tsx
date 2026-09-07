import React from 'react';
import { PiChamberLogo } from '@/components/ui/PiChamberLogo';
import { useThemeSystem } from '@/contexts/useThemeSystem';

interface ChatEmptyStateProps {
    isNewSession?: boolean;
}

const ChatEmptyState: React.FC<ChatEmptyStateProps> = ({ isNewSession = false }) => {
    const { currentTheme } = useThemeSystem();

    const textColor = currentTheme?.colors?.surface?.mutedForeground || 'var(--muted-foreground)';

    return (
        <div className="flex flex-col items-center justify-center min-h-full w-full gap-6">
            <PiChamberLogo
                width={120}
                height={120}
                isAnimated={!isNewSession}
                className={isNewSession ? "opacity-20" : undefined}
            />
            {isNewSession ? (
                <span className="text-body-md" style={{ color: textColor }}>{"Start a new chat"}</span>
            ) : null}
        </div>
    );
};

export default React.memo(ChatEmptyState);
