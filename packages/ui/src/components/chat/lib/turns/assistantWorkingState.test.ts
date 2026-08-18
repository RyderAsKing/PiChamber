import { describe, expect, test } from 'bun:test';
import type { Message } from '@/lib/chat/types';

import {
    isAssistantMessageCompleted,
    isTurnAssistantWorking,
    resolveTurnStreamingAssistantId,
} from './assistantWorkingState';
import type { ChatMessageEntry } from './types';

const assistant = (id: string, extras: Record<string, unknown> = {}): ChatMessageEntry => ({
    info: {
        id,
        role: 'assistant',
        sessionID: 'ses_1',
        time: { created: 1 },
        ...extras,
    } as Message,
    parts: [],
});

describe('assistantWorkingState', () => {
    test('treats stop and error finishes as completed even without time.completed', () => {
        expect(isAssistantMessageCompleted(assistant('a1', { finish: 'stop' }))).toBe(true);
        expect(isAssistantMessageCompleted(assistant('a2', { finish: 'error' }))).toBe(true);
        expect(isAssistantMessageCompleted(assistant('a3'))).toBe(false);
    });

    test('prefers the live streaming message id when it belongs to the turn', () => {
        expect(
            resolveTurnStreamingAssistantId({
                activeStreamingMessageId: 'a2',
                assistantMessages: [assistant('a1'), assistant('a2')],
            }),
        ).toBe('a2');
    });

    test('falls back to the last incomplete assistant, not a completed last turn', () => {
        expect(
            resolveTurnStreamingAssistantId({
                activeStreamingMessageId: null,
                assistantMessages: [
                    assistant('a1', { time: { created: 1, completed: 2 } }),
                    assistant('a2'),
                ],
            }),
        ).toBe('a2');

        expect(
            resolveTurnStreamingAssistantId({
                activeStreamingMessageId: null,
                assistantMessages: [assistant('a1', { time: { created: 1, completed: 2 } })],
            }),
        ).toBeNull();
    });

    test('does not keep a completed last assistant working after the live stream ends', () => {
        const lastId = 'a1';
        expect(
            isTurnAssistantWorking({
                messageId: lastId,
                activeStreamingMessageId: lastId,
            }),
        ).toBe(true);
        expect(
            isTurnAssistantWorking({
                messageId: lastId,
                activeStreamingMessageId: null,
            }),
        ).toBe(false);
    });
});
