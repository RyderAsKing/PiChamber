import { describe, expect, test } from 'bun:test';

import type { Part } from '@/lib/chat/types';
import type { TurnActivityRecord } from './types';
import { formatTurnActivityClauses, summarizeTurnActivity } from './summarizeTurnActivity';

let nextId = 0;
const tool = (name: string, input: Record<string, unknown> = {}, status = 'completed'): TurnActivityRecord => {
    nextId += 1;
    return {
        id: `tool-${nextId}`,
        turnId: 'turn-1',
        messageId: 'assistant-1',
        partIndex: nextId,
        kind: 'tool',
        part: { id: `tool-${nextId}`, type: 'tool', tool: name, state: { status, input } } as Part,
    };
};

const reasoning: TurnActivityRecord = {
    id: 'thinking',
    turnId: 'turn-1',
    messageId: 'assistant-1',
    partIndex: 0,
    kind: 'reasoning',
    part: { id: 'thinking', type: 'reasoning', text: 'Look first.' } as Part,
};

describe('summarizeTurnActivity', () => {
    test('counts each file once however often it was read or edited', () => {
        const summary = summarizeTurnActivity([
            reasoning,
            tool('read', { path: 'src/a.ts' }),
            tool('read', { path: 'src/a.ts' }),
            tool('read', { path: 'src/b.ts' }),
            tool('edit', { path: 'src/a.ts' }),
            tool('edit', { path: 'src/a.ts' }),
            tool('write', { path: 'src/c.ts' }),
        ]);

        expect(summary.filesRead).toBe(2);
        expect(summary.filesEdited).toBe(2);
        expect(formatTurnActivityClauses(summary)).toEqual(['Read 2 files', 'Edited 2 files']);
    });

    test('names commands, searches, fetches, sub-agents and other tools in reading order', () => {
        const summary = summarizeTurnActivity([
            tool('bash', { command: 'bun test' }),
            tool('grep', { pattern: 'charge' }),
            tool('find'),
            tool('webfetch'),
            tool('task'),
            tool('todowrite'),
            tool('read', { path: 'README.md' }),
        ]);

        expect(formatTurnActivityClauses(summary)).toEqual([
            'Read 1 file',
            '2 searches',
            'Fetched 1 page',
            'Ran 1 command',
            '1 sub-agent',
            '1 other tool',
        ]);
    });

    test('counts failed calls whatever their kind', () => {
        const summary = summarizeTurnActivity([
            tool('bash', {}, 'error'),
            tool('edit', { path: 'a.ts' }, 'failed'),
            tool('read', { path: 'a.ts' }, 'completed'),
            tool('bash', {}, 'running'),
        ]);

        expect(summary.failed).toBe(2);
        expect(summary.commands).toBe(2);
    });

    test('a call without a path still counts', () => {
        const summary = summarizeTurnActivity([tool('read'), tool('read'), tool('edit')]);

        expect(summary.filesRead).toBe(2);
        expect(summary.filesEdited).toBe(1);
    });

    test('says "tools" rather than "other tools" when nothing else was named', () => {
        expect(formatTurnActivityClauses(summarizeTurnActivity([tool('mcp_lookup'), tool('question')])))
            .toEqual(['2 tools']);
    });

    test('has no clauses for a turn that only reasoned', () => {
        expect(formatTurnActivityClauses(summarizeTurnActivity([reasoning]))).toEqual([]);
    });
});
