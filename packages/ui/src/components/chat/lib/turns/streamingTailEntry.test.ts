import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@/lib/chat/types';

import { buildLiveStreamingEntry, type StreamingTailEntry } from './streamingTailEntry';
import type { ChatMessageEntry, TurnRecord } from './types';

const message = (id: string, role: 'user' | 'assistant', parentID?: string, parts: Part[] = []): ChatMessageEntry => ({
    info: {
        id,
        role,
        sessionID: 'ses_1',
        ...(parentID ? { parentID } : {}),
        time: { created: 1 },
    } as Message,
    parts,
});

const textPart = (id: string, text: string): Part => ({
    id,
    type: 'text',
    text,
} as Part);

const syntheticTextPart = (id: string, text: string): Part => ({
    id,
    type: 'text',
    text,
    synthetic: true,
} as Part);

const reasoningPart = (id: string, text: string): Part => ({
    id,
    type: 'reasoning',
    text,
} as Part);

const turnEntry = (assistant: ChatMessageEntry): StreamingTailEntry => {
    const user = message('user_1', 'user');
    return {
        kind: 'turn',
        key: 'turn:user_1',
        isLastTurn: true,
        turn: {
            turnId: 'user_1',
            userMessageId: 'user_1',
            userMessage: user,
            headerMessageId: assistant.info.id,
            messages: [],
            assistantMessageIds: [assistant.info.id],
            assistantMessages: [assistant],
            activityParts: [],
            activitySegments: [],
            summary: {},
            hasTools: false,
            hasReasoning: false,
            stream: { isStreaming: true, isRetrying: false },
        } satisfies TurnRecord,
    };
};

describe('buildLiveStreamingEntry', () => {
    test('returns the same entry when the active message is not in the tail', () => {
        const assistant = message('assistant_1', 'assistant', 'user_1', [textPart('part_1', 'old')]);
        const entry = turnEntry(assistant);

        const next = buildLiveStreamingEntry(entry, {
            activeStreamingMessageId: 'assistant_other',
            liveParts: [textPart('part_live', 'live')],
            showTextJustificationActivity: false,
            showTurnChangedFiles: false,
        });

        expect(next).toBe(entry);
    });

    test('rebuilds only the streaming turn with live parts', () => {
        const assistant = message('assistant_1', 'assistant', 'user_1', [textPart('part_1', 'hel')]);
        const entry = turnEntry(assistant);
        const liveParts = [reasoningPart('part_1_live', 'thinking')];

        const next = buildLiveStreamingEntry(entry, {
            activeStreamingMessageId: 'assistant_1',
            liveParts,
            showTextJustificationActivity: false,
            showTurnChangedFiles: false,
        });

        expect(next).not.toBe(entry);
        expect(next.kind).toBe('turn');
        if (next.kind !== 'turn') return;
        expect(next.turn.assistantMessages[0]?.parts).toBe(liveParts);
        expect(next.turn.activityParts.length).toBeGreaterThan(0);
    });

    test('updates an ungrouped streaming message with live parts', () => {
        const stale = message('assistant_1', 'assistant', undefined, [textPart('part_1', 'old')]);
        const entry: StreamingTailEntry = {
            kind: 'ungrouped',
            key: 'msg:assistant_1',
            message: stale,
        };
        const liveParts = [textPart('part_1_live', 'live')];

        const next = buildLiveStreamingEntry(entry, {
            activeStreamingMessageId: 'assistant_1',
            liveParts,
            showTextJustificationActivity: false,
            showTurnChangedFiles: false,
        });

        expect(next).not.toBe(entry);
        expect(next.kind).toBe('ungrouped');
        if (next.kind !== 'ungrouped') return;
        expect(next.message.parts).toBe(liveParts);
    });

    test('normalizes live tail parts with the display filtering path', () => {
        const stale = message('assistant_1', 'assistant', 'user_1', [textPart('part_1', 'old')]);
        const entry = turnEntry(stale);
        const visible = textPart('part_visible', 'visible');
        const synthetic = syntheticTextPart('part_synthetic', 'hidden while streaming');

        const next = buildLiveStreamingEntry(entry, {
            activeStreamingMessageId: 'assistant_1',
            liveParts: [synthetic, visible],
            showTextJustificationActivity: false,
            showTurnChangedFiles: false,
        });

        expect(next.kind).toBe('turn');
        if (next.kind !== 'turn') return;
        expect(next.turn.assistantMessages[0]?.parts).toEqual([visible]);
    });

    test('keeps user message and activity identity for text-only live updates', () => {
        const assistant = message('assistant_1', 'assistant', 'user_1', [textPart('part_1', 'hel')]);
        const entry = turnEntry(assistant);
        const next = buildLiveStreamingEntry(entry, {
            activeStreamingMessageId: 'assistant_1',
            liveParts: [textPart('part_1', 'hello')],
            showTextJustificationActivity: false,
            showTurnChangedFiles: false,
        });

        expect(next).not.toBe(entry);
        expect(next.kind).toBe('turn');
        if (next.kind !== 'turn' || entry.kind !== 'turn') return;
        expect(next.turn.userMessage).toBe(entry.turn.userMessage);
        expect(next.turn.activityParts).toBe(entry.turn.activityParts);
        expect(next.turn.assistantMessages[0]).not.toBe(entry.turn.assistantMessages[0]);
        expect(next.turn.assistantMessages[0]?.parts[0]?.text).toBe('hello');
    });

    test('keeps sibling assistant identity when only the live text part changes', () => {
        const settled = message('assistant_1', 'assistant', 'user_1', [textPart('part_done', 'done')]);
        const streaming = message('assistant_2', 'assistant', 'user_1', [textPart('part_live', 'hel')]);
        const user = message('user_1', 'user');
        const entry: StreamingTailEntry = {
            kind: 'turn',
            key: 'turn:user_1',
            isLastTurn: true,
            turn: {
                turnId: 'user_1',
                userMessageId: 'user_1',
                userMessage: user,
                headerMessageId: streaming.info.id,
                messages: [],
                assistantMessageIds: [settled.info.id, streaming.info.id],
                assistantMessages: [settled, streaming],
                activityParts: [],
                activitySegments: [],
                summary: {},
                hasTools: false,
                hasReasoning: false,
                stream: { isStreaming: true, isRetrying: false },
            },
        };

        const next = buildLiveStreamingEntry(entry, {
            activeStreamingMessageId: 'assistant_2',
            liveParts: [textPart('part_live', 'hello')],
            showTextJustificationActivity: false,
            showTurnChangedFiles: false,
        });

        expect(next.kind).toBe('turn');
        if (next.kind !== 'turn') return;
        expect(next.turn.assistantMessages[0]).toBe(settled);
        expect(next.turn.assistantMessages[1]).not.toBe(streaming);
        expect(next.turn.userMessage).toBe(user);
        expect(next.turn.activityParts).toBe(entry.kind === 'turn' ? entry.turn.activityParts : []);
    });

    test('re-projects when a non-text part is replaced even with the same id', () => {
        const tool = { id: 'tool_1', type: 'tool', tool: 'bash', state: { status: 'running' } } as Part;
        const assistant = message('assistant_1', 'assistant', 'user_1', [tool, textPart('part_1', 'hel')]);
        const entry = turnEntry(assistant);
        const nextTool = { id: 'tool_1', type: 'tool', tool: 'bash', state: { status: 'completed' } } as Part;

        const next = buildLiveStreamingEntry(entry, {
            activeStreamingMessageId: 'assistant_1',
            liveParts: [nextTool, textPart('part_1', 'hello')],
            showTextJustificationActivity: false,
            showTurnChangedFiles: false,
        });

        expect(next.kind).toBe('turn');
        if (next.kind !== 'turn' || entry.kind !== 'turn') return;
        expect(next.turn.activityParts).not.toBe(entry.turn.activityParts);
        expect(next.turn.assistantMessages[0]?.parts[0]).toBe(nextTool);
    });
});
