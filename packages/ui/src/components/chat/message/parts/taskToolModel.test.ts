/* eslint-disable */
// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@/lib/chat/types';

import {
    buildTaskSummaryEntriesFromSession,
    parseTaskMetadataBlock,
    readTaskSessionIdFromRecord,
    readTaskSessionIdFromOutput,
    shouldHydrateTaskChildSession,
} from './taskToolModel';

describe('taskToolModel', () => {
    test('reads the current Pi running-state identity contract', () => {
        expect(readTaskSessionIdFromRecord({ sessionId: 'child-live' })).toBe('child-live');
        expect(readTaskSessionIdFromRecord({})).toBe(undefined);
    });

    test('reads authoritative session and summary metadata', () => {
        const output = 'result\n<task_metadata>{"sessionID":"child-1","calls":[{"id":"tool-1","tool":"read","title":"a.ts"}]}</task_metadata>';
        expect(parseTaskMetadataBlock(output)).toEqual({
            sessionId: 'child-1',
            summaryEntries: [{ id: 'tool-1', tool: 'read', state: { status: undefined, title: 'a.ts', input: undefined } }],
        });
        expect(readTaskSessionIdFromOutput(output)).toBe('child-1');
    });

    test('projects tool calls while excluding nested task and todo bookkeeping', () => {
        const message = {
            info: { id: 'message-1', role: 'assistant' } as Message,
            parts: [
                { id: 'read-1', type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'a.ts' } } },
                { id: 'task-1', type: 'tool', tool: 'task', state: { status: 'running' } },
                { id: 'todo-1', type: 'tool', tool: 'todowrite', state: { status: 'completed' } },
            ] as unknown as Part[],
        };

        expect(buildTaskSummaryEntriesFromSession([message])).toEqual([{
            id: 'read-1',
            tool: 'read',
            state: { status: 'completed', title: undefined, input: { filePath: 'a.ts' } },
        }]);
    });

    test('hydrates child transcripts only for active or expanded task details', () => {
        const base = {
            isTaskTool: true,
            isExpanded: false,
            isActive: false,
            hasFinalMetadataSummary: false,
            taskSessionId: 'child-1',
        };
        expect(shouldHydrateTaskChildSession(base)).toBe(false);
        expect(shouldHydrateTaskChildSession({ ...base, isExpanded: true })).toBe(true);
        expect(shouldHydrateTaskChildSession({ ...base, isActive: true })).toBe(true);
        expect(shouldHydrateTaskChildSession({ ...base, isExpanded: true, hasFinalMetadataSummary: true })).toBe(false);
    });
});
