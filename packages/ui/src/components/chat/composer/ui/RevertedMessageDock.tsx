/**
 * The reverted-messages dock.
 *
 * After a revert the messages that were undone are not thrown away: they stay
 * listed here so the user can put one back, or fork a new session from it.
 * Restoring the newest reverted message is an un-revert of everything, which
 * is why it routes through handleSlashRedo rather than reverting forward.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useRevertNavigation } from '@/sync/revert-navigation-store';

type RevertedMessageDockProps = {
    sessionId: string | null;
    directory?: string;
};

export const RevertedMessageDock: React.FC<RevertedMessageDockProps> = React.memo(({ sessionId }) => {
    
    const revertToMessage = useSessionUIStore((s) => s.revertToMessage);
    const forkFromMessage = useSessionUIStore((s) => s.forkFromMessage);
    const handleSlashRedo = useSessionUIStore((s) => s.handleSlashRedo);
    const [restoringId, setRestoringId] = React.useState<string | null>(null);
    const [forkingId, setForkingId] = React.useState<string | null>(null);
    const [collapsed, setCollapsed] = React.useState(true);
    const navigation = useRevertNavigation(sessionId);
    const revertMessageID = navigation?.targetEntryId;
    const abandonedUser = React.useMemo(() => {
        if (!navigation) return [];
        return navigation.abandoned.filter((entry) => entry.role === 'user');
    }, [navigation]);
    const noTextContent = "No text content";
    const items = React.useMemo(() => {
        if (!navigation || abandonedUser.length === 0) return [];
        return abandonedUser.map((entry) => ({
            id: entry.id,
            text: entry.preview?.replace(/\s+/g, ' ').trim() || noTextContent,
        }));
    }, [abandonedUser, navigation, noTextContent]);
    const firstRevertedMessageId = items[0]?.id;

    React.useEffect(() => {
        setCollapsed(true);
    }, [revertMessageID, firstRevertedMessageId]);

    const handleRestore = React.useCallback(async (messageId: string) => {
        if (!sessionId || restoringId) return;
        setRestoringId(messageId);
        try {
            // Use branch order (array position), not lexical ID comparison.
            const index = abandonedUser.findIndex((entry) => entry.id === messageId);
            const next = index >= 0 ? abandonedUser[index + 1] : undefined;
            if (next) {
                await revertToMessage(sessionId, next.id);
            } else {
                await handleSlashRedo(sessionId, { fullUnrevert: true });
            }
        } finally {
            setRestoringId(null);
        }
    }, [abandonedUser, handleSlashRedo, revertToMessage, restoringId, sessionId]);

    const handleFork = React.useCallback(async (messageId: string) => {
        if (!sessionId || forkingId) return;
        setForkingId(messageId);
        try {
            await forkFromMessage(sessionId, messageId);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to fork session');
        } finally {
            setForkingId(null);
        }
    }, [forkFromMessage, forkingId, sessionId]);

    if (!sessionId || items.length === 0) return null;

    return (
        <div className="pb-2 w-full px-1">
            <div className="rounded-xl border border-border/60 bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)] shadow-sm overflow-hidden">
                <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--interactive-hover)] transition-colors"
                    onClick={() => setCollapsed((value) => !value)}
                    aria-expanded={!collapsed}
                >
                    <span className="typography-ui-label font-medium text-foreground flex-shrink-0">
                        {"Reverted"} messages {items.length}
                    </span>
                    <Icon
                        name="arrow-down-s"
                        className={cn("ml-auto h-4 w-4 text-muted-foreground transition-transform", !collapsed && "rotate-180")}
                        aria-hidden="true"
                    />
                </button>
                {!collapsed && (
                    <div className="px-3 pb-3 flex flex-col gap-1.5 max-h-[10.5rem] overflow-y-auto">
                        {items.map((item) => (
                            <div key={item.id} className="flex min-w-0 items-center gap-2 py-1">
                                <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
                                    {item.text}
                                </span>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="xs"
                                    disabled={Boolean(restoringId || forkingId)}
                                    onClick={() => { void handleFork(item.id); }}
                                >
                                    {forkingId === item.id ? (
                                        <Icon name="loader-4" className="h-3 w-3 animate-spin" aria-hidden="true" />
                                    ) : (
                                        <Icon name="git-branch" className="h-3 w-3" aria-hidden="true" />
                                    )}
                                    {"Fork"}
                                </Button>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="xs"
                                    disabled={Boolean(restoringId || forkingId)}
                                    onClick={() => { void handleRestore(item.id); }}
                                >
                                    {restoringId === item.id ? (
                                        <Icon name="loader-4" className="h-3 w-3 animate-spin" aria-hidden="true" />
                                    ) : (
                                        <Icon name="arrow-go-forward" className="h-3 w-3" aria-hidden="true" />
                                    )}
                                    {"Restore"}
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
});

RevertedMessageDock.displayName = 'RevertedMessageDock';
