import { describe, expect, test } from 'bun:test';

import { parseSlashCommand } from '../slashCommands';

describe('parseSlashCommand', () => {
    test('reads a bare command', () => {
        expect(parseSlashCommand('/explore')).toEqual({ name: 'explore', argument: '' });
    });

    test('reads a command with an argument', () => {
        expect(parseSlashCommand('/summary rate limiting'))
            .toEqual({ name: 'summary', argument: 'rate limiting' });
    });

    test('leading whitespace is tolerated', () => {
        expect(parseSlashCommand('   /debug')).toEqual({ name: 'debug', argument: '' });
    });

    test('the name is lowercased but the argument keeps its casing', () => {
        expect(parseSlashCommand('/Summary Rate Limiting'))
            .toEqual({ name: 'summary', argument: 'Rate Limiting' });
    });

    test('ordinary prose is not a command', () => {
        expect(parseSlashCommand('explore the code')).toBeNull();
        expect(parseSlashCommand('see src/a.ts')).toBeNull();
        expect(parseSlashCommand('')).toBeNull();
    });

    test('a bare slash is not a command', () => {
        expect(parseSlashCommand('/')).toBeNull();
        expect(parseSlashCommand('/   ')).toBeNull();
    });
});

describe('tryExecuteLocalSlashCommand', () => {
    test('identifies local slash commands', async () => {
        const { isLocalSlashCommand } = await import('../slashCommands');
        expect(isLocalSlashCommand('undo')).toBe(true);
        expect(isLocalSlashCommand('redo')).toBe(true);
        expect(isLocalSlashCommand('timeline')).toBe(true);
        expect(isLocalSlashCommand('compact')).toBe(true);
        expect(isLocalSlashCommand('other')).toBe(false);
    });

    test('executes undo command for active session', async () => {
        const { tryExecuteLocalSlashCommand } = await import('../slashCommands');
        let undoneSession: string | null = null;
        let scrolled = false;
        const handled = await tryExecuteLocalSlashCommand({
            command: { name: 'undo', argument: '' },
            currentSessionId: 'sess-123',
            scrollToBottom: () => {
                scrolled = true;
            },
            setTimelineDialogOpen: () => {},
            onUndoSession: async (id) => {
                undoneSession = id;
            },
            onRedoSession: async () => {},
            onCompactSession: async () => {},
        });

        expect(handled).toBe(true);
        expect(undoneSession).toBe('sess-123');
        expect(scrolled).toBe(true);
    });

    test('executes timeline command', async () => {
        const { tryExecuteLocalSlashCommand } = await import('../slashCommands');
        let timelineOpen = false;
        const handled = await tryExecuteLocalSlashCommand({
            command: { name: 'timeline', argument: '' },
            currentSessionId: 'sess-123',
            setTimelineDialogOpen: (open) => {
                timelineOpen = open;
            },
            onUndoSession: async () => {},
            onRedoSession: async () => {},
            onCompactSession: async () => {},
        });

        expect(handled).toBe(true);
        expect(timelineOpen).toBe(true);
    });

    test('returns false for non-local commands', async () => {
        const { tryExecuteLocalSlashCommand } = await import('../slashCommands');
        const handled = await tryExecuteLocalSlashCommand({
            command: { name: 'custom', argument: '' },
            currentSessionId: 'sess-123',
            setTimelineDialogOpen: () => {},
            onUndoSession: async () => {},
            onRedoSession: async () => {},
            onCompactSession: async () => {},
        });

        expect(handled).toBe(false);
    });
});
