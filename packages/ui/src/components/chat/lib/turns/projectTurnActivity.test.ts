import { describe, expect, test } from 'bun:test';

import type { Part } from '@/lib/chat/types';
import type { ChatMessageEntry } from './types';
import { projectTurnActivity } from './projectTurnActivity';

const assistant = (
    id: string,
    parts: Part[],
    finish?: string,
): ChatMessageEntry => ({
    info: {
        id,
        role: 'assistant',
        ...(finish ? { finish } : {}),
    },
    parts,
});

describe('projectTurnActivity text progress', () => {
    test('classifies earlier text as progress when a later activity and answer exist', () => {
        const result = projectTurnActivity({
            turnId: 'turn-1',
            assistantMessages: [
                assistant('assistant-1', [
                    { id: 'progress', type: 'text', text: 'I will inspect the project first.' } as Part,
                ]),
                assistant('assistant-2', [
                    {
                        id: 'tool-1',
                        type: 'tool',
                        tool: 'read',
                        state: { status: 'completed' },
                    } as Part,
                ]),
                assistant('assistant-3', [
                    { id: 'answer', type: 'text', text: 'The project is ready.' } as Part,
                ], 'stop'),
            ],
            summarySourceMessageId: 'assistant-3',
            summarySourcePartId: 'answer',
            showTextJustificationActivity: true,
        });

        expect(result.activityParts.map((activity) => activity.id)).toEqual(['progress', 'tool-1']);
        expect(result.activityParts[0]?.kind).toBe('justification');
        expect(result.activityParts[1]?.kind).toBe('tool');
    });

    test('keeps the confirmed summary out of progress activity', () => {
        const result = projectTurnActivity({
            turnId: 'turn-1',
            assistantMessages: [
                assistant('assistant-1', [
                    { id: 'intro', type: 'text', text: 'First I will check the file.' } as Part,
                    {
                        id: 'tool-1',
                        type: 'tool',
                        tool: 'read',
                        state: { status: 'completed' },
                    } as Part,
                    { id: 'answer', type: 'text', text: 'Here is the result.' } as Part,
                ], 'stop'),
            ],
            summarySourceMessageId: 'assistant-1',
            summarySourcePartId: 'answer',
            showTextJustificationActivity: true,
        });

        expect(result.activityParts.map((activity) => activity.id)).toEqual(['intro', 'tool-1']);
    });
});
