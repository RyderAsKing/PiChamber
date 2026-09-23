import { describe, expect, test } from 'bun:test';
import type { Message } from '@/lib/chat/types';

import {
    isAssistantMessageCompleted,
    isSessionAssistantWorking,
    isTurnAssistantWorking,
    resolveSessionWorkingPresentation,
    resolveTurnStreamingAssistantId,
    shouldShowTurnWorkingStatus,
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

    test('suppresses stale working state while the runtime connection is unavailable', () => {
        expect(isSessionAssistantWorking({
            connection: 'error',
            authoritativeWorking: true,
            hasPendingAssistant: true,
        })).toBe(false);
        expect(isSessionAssistantWorking({
            connection: 'ready',
            authoritativeWorking: true,
            hasPendingAssistant: false,
        })).toBe(true);
    });

    test('keeps a retry notice working while no token stream is active', () => {
        expect(
            isTurnAssistantWorking({
                messageId: 'a1',
                activeStreamingMessageId: null,
                isRetrying: true,
            }),
        ).toBe(true);
    });

    test('keeps working status on the turn that owns the live stream after a steer', () => {
        expect(shouldShowTurnWorkingStatus({
            isLastTurn: false,
            sessionIsWorking: true,
            turnIsInActiveStream: true,
            activeStreamingMessageId: 'a1',
        })).toBe(true);
        expect(shouldShowTurnWorkingStatus({
            isLastTurn: true,
            sessionIsWorking: true,
            turnIsInActiveStream: false,
            activeStreamingMessageId: 'a1',
        })).toBe(false);
        expect(shouldShowTurnWorkingStatus({
            isLastTurn: true,
            sessionIsWorking: true,
            turnIsInActiveStream: false,
            activeStreamingMessageId: 'a1',
            isSteering: true,
        })).toBe(true);
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
    test('separates verified live work from last-observed work while the transport is uncertain', () => {
        const busy = { authoritativeWorking: true, hasPendingAssistant: false, hasRetainedStream: false };
        expect(resolveSessionWorkingPresentation({ connection: 'ready', transportUncertain: false, ...busy }))
            .toEqual({ isWorking: true, isAwaitingRecovery: false });
        for (const connection of ['error', 'unavailable', 'loading'] as const) {
            expect(resolveSessionWorkingPresentation({ connection, transportUncertain: false, ...busy }))
                .toEqual({ isWorking: false, isAwaitingRecovery: true });
        }
        // Native resume probe: the transport still says ready but is unverified.
        expect(resolveSessionWorkingPresentation({ connection: 'ready', transportUncertain: true, ...busy }))
            .toEqual({ isWorking: false, isAwaitingRecovery: true });
        // A retained stream id alone is last-observed work too.
        expect(resolveSessionWorkingPresentation({
            connection: 'error',
            transportUncertain: false,
            authoritativeWorking: false,
            hasPendingAssistant: false,
            hasRetainedStream: true,
        })).toEqual({ isWorking: false, isAwaitingRecovery: true });
    });

    test('an idle session is neither working nor awaiting recovery during an outage', () => {
        expect(resolveSessionWorkingPresentation({
            connection: 'error',
            transportUncertain: true,
            authoritativeWorking: false,
            hasPendingAssistant: false,
            hasRetainedStream: false,
        })).toEqual({ isWorking: false, isAwaitingRecovery: false });
    });

    test('holds the completion footer on the latest assistant while awaiting recovery', () => {
        expect(isTurnAssistantWorking({
            messageId: 'a1',
            activeStreamingMessageId: null,
            isAwaitingRecovery: true,
        })).toBe(true);
        expect(isTurnAssistantWorking({
            messageId: 'a1',
            activeStreamingMessageId: null,
            isAwaitingRecovery: false,
        })).toBe(false);
    });
});
