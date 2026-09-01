import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '@/lib/chat/types';

import TurnAssistantBlock from './TurnAssistantBlock';
import type { ChatMessageEntry } from '../lib/turns/types';

const createAssistantMessages = (count: number): ChatMessageEntry[] => (
    Array.from({ length: count }, (_, index) => ({
        info: {
            id: `assistant-${index}`,
            role: 'assistant',
            time: { created: index },
        } as Message,
        parts: [],
    }))
);

const renderAssistantBlock = (count: number, deferEarlierMessages: boolean) => {
    let renderedMessages = 0;
    const markup = renderToStaticMarkup(
        <TurnAssistantBlock
            turnId="turn-1"
            assistantMessages={createAssistantMessages(count)}
            deferEarlierMessages={deferEarlierMessages}
            renderMessage={(message) => {
                renderedMessages += 1;
                return <div data-message={message.info.id} />;
            }}
        />,
    );

    return { markup, renderedMessages };
};

describe('TurnAssistantBlock large settled turns', () => {
    test('bounds the initial render while keeping the response header and tail', () => {
        const result = renderAssistantBlock(300, true);

        expect(result.renderedMessages <= 32).toBe(true);
        expect(result.markup).toContain('data-message="assistant-0"');
        expect(result.markup).toContain('data-message="assistant-299"');
        expect(result.markup).toContain('Load earlier response');
    });

    test('renders every message in the active streaming turn', () => {
        const result = renderAssistantBlock(300, false);

        expect(result.renderedMessages).toBe(300);
        expect(result.markup).not.toContain('Load earlier response');
    });

    test('activates only above the 32-message boundary', () => {
        const below = renderAssistantBlock(31, true);
        const atBoundary = renderAssistantBlock(32, true);
        const above = renderAssistantBlock(33, true);

        expect(below.renderedMessages).toBe(31);
        expect(below.markup).not.toContain('Load earlier response');
        expect(atBoundary.renderedMessages).toBe(32);
        expect(atBoundary.markup).not.toContain('Load earlier response');
        expect(above.renderedMessages).toBe(32);
        expect(above.markup).toContain('Load earlier response');
    });
});
