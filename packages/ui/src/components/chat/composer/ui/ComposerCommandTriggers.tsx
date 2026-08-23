import React from 'react';

import { getPiSessionStore } from '@/apps/pi-session-store';
import { formatShortcutForDisplay } from '@/lib/shortcuts';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';

/**
 * User-authored quick-action buttons rendered above the composer. Each button
 * fires a slash command through the normal authenticated prompt path.
 */
export const ComposerCommandTriggers: React.FC<{ sessionId?: string | null }> = ({ sessionId }) => {
    const triggers = useUIStore((state) => state.commandTriggers);

    const runTrigger = React.useCallback((command: string, args?: string) => {
        if (!sessionId) return;
        const text = args && args.trim().length > 0 ? `/${command} ${args.trim()}` : `/${command}`;
        void getPiSessionStore().prompt(sessionId, text, 'prompt').catch(() => {});
    }, [sessionId]);

    if (!sessionId || triggers.length === 0) return null;

    return (
        <div
            className="mb-1 flex flex-wrap items-center gap-1.5 px-1"
            role="toolbar"
            aria-label="Command triggers"
        >
            {triggers.map((trigger) => (
                <Button
                    key={trigger.id}
                    size="xs"
                    variant="outline"
                    disabled={!sessionId}
                    onClick={() => runTrigger(trigger.command, trigger.args)}
                    title={trigger.combo
                        ? `${trigger.label} (${formatShortcutForDisplay(trigger.combo)})`
                        : trigger.label}
                >
                    {trigger.label}
                </Button>
            ))}
        </div>
    );
};
