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
