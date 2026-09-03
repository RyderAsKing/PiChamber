/**
 * The composer's local slash commands.
 *
 * These commands stay with the composer because they manipulate session state
 * or open UI rather than producing a message. Other slash commands pass
 * through to Pi's skill and extension registries.
 */

export interface ParsedSlashCommand {
    name: string;
    /** Everything typed after the command name, trimmed. */
    argument: string;
}

/**
 * Read the leading slash command out of a message, if there is one. Only the
 * first word counts as the command; the rest is its argument.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith('/')) return null;

    const withoutSlash = trimmed.slice(1);
    const name = withoutSlash.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (!name) return null;

    return {
        name,
        argument: withoutSlash.slice(name.length).trim(),
    };
}

export const LOCAL_SLASH_COMMANDS = ['undo', 'redo', 'timeline', 'compact'] as const;
export type LocalSlashCommandName = typeof LOCAL_SLASH_COMMANDS[number];

export function isLocalSlashCommand(name: string): name is LocalSlashCommandName {
    return (LOCAL_SLASH_COMMANDS as readonly string[]).includes(name);
}

export interface ExecuteLocalSlashCommandOptions {
    command: ParsedSlashCommand;
    currentSessionId: string | null;
    scrollToBottom?: () => void;
    setTimelineDialogOpen: (open: boolean) => void;
    onCompactSession: (sessionId: string, argument?: string) => Promise<void>;
    onUndoSession: (sessionId: string) => Promise<void>;
    onRedoSession: (sessionId: string) => Promise<void>;
}

export async function tryExecuteLocalSlashCommand({
    command,
    currentSessionId,
    scrollToBottom,
    setTimelineDialogOpen,
    onCompactSession,
    onUndoSession,
    onRedoSession,
}: ExecuteLocalSlashCommandOptions): Promise<boolean> {
    const { name, argument } = command;
    if (!isLocalSlashCommand(name)) return false;

    if (name === 'undo' && currentSessionId) {
        await onUndoSession(currentSessionId);
        scrollToBottom?.();
        return true;
    }
    if (name === 'redo' && currentSessionId) {
        await onRedoSession(currentSessionId);
        scrollToBottom?.();
        return true;
    }
    if (name === 'timeline' && currentSessionId) {
        setTimelineDialogOpen(true);
        return true;
    }
    if (name === 'compact') {
        if (!currentSessionId) {
            const { toast } = await import('@/components/ui');
            toast.error('Open a session before compacting.');
            return true;
        }
        await onCompactSession(currentSessionId, argument.trim() || undefined);
        return true;
    }

    return false;
}
