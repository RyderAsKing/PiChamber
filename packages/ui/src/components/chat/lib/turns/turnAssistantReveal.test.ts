import { describe, expect, test } from 'bun:test';

import {
    revealTurnAssistantMessage,
    subscribeToTurnAssistantRevealRequests,
} from './turnAssistantReveal';

describe('turnAssistantReveal', () => {
    test('routes a message reveal to the mounted turn and cleans up on unmount', () => {
        const received: string[] = [];
        const unsubscribe = subscribeToTurnAssistantRevealRequests('turn-1', (messageId) => {
            received.push(messageId);
            return true;
        });

        expect(revealTurnAssistantMessage('turn-1', 'assistant-4')).toBe(true);
        expect(received).toEqual(['assistant-4']);

        unsubscribe();
        expect(revealTurnAssistantMessage('turn-1', 'assistant-5')).toBe(false);
    });
});
