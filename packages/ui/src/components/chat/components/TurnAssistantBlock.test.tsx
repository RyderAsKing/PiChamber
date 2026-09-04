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
        parts: [
            {
                id: `assistant-${index}-part-0-text`,
                type: 'text',
                text: 'final answer',
            },
        ] as unknown as ChatMessageEntry['parts'],
    }))
);

const renderAssistantBlock = (count: number, deferEarlierMessages: boolean) => {
    let renderedMessages = 0;
    const markup = renderToStaticMarkup(
        <TurnAssistantBlock
            turnId="turn-1"
            assistantMessages={createAssistantMessages(count)}
            deferEarlierMessages={deferEarlierMessages}
            activityPartIds={new Set()}
            renderMessage={(message) => {
                renderedMessages += 1;
                return <div data-message={message.info.id} />;
            }}
        />,
    );

    return { markup, renderedMessages };
};

const makeToolMessage = (index: number): ChatMessageEntry => ({
    info: {
        id: `assistant-${index}`,
        role: 'assistant',
        time: { created: index },
    } as Message,
    parts: [
        {
            id: `assistant-${index}-part-0-tool`,
            type: 'tool',
            tool: 'read',
        },
    ] as unknown as ChatMessageEntry['parts'],
});

const makeTextMessage = (index: number, text = 'final answer'): ChatMessageEntry => ({
    info: {
        id: `assistant-${index}`,
        role: 'assistant',
        time: { created: index },
    } as Message,
    parts: [
        {
            id: `assistant-${index}-part-0-text`,
            type: 'text',
            text,
        },
    ] as unknown as ChatMessageEntry['parts'],
});

const renderCustomBlock = (messages: ChatMessageEntry[], activityPartIds: ReadonlySet<string>) => {
    let renderedMessages = 0;
    const markup = renderToStaticMarkup(
        <TurnAssistantBlock
            turnId="turn-1"
            assistantMessages={messages}
            deferEarlierMessages
            activityPartIds={activityPartIds}
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

describe('TurnAssistantBlock activity-aware gating', () => {
    test('does not gate tool-only turns that render null behind hideAssistantActivity', () => {
        const messages = Array.from({ length: 50 }, (_, index) => makeToolMessage(index));
        const result = renderCustomBlock(messages, new Set());

        expect(result.renderedMessages).toBe(1);
        expect(result.markup).not.toContain('Load earlier response');
        expect(result.markup).not.toContain('Load full response');
    });

    test('does not gate progress text projected to the activity rail', () => {
        const messages = Array.from({ length: 40 }, (_, index) => ({
            info: {
                id: `assistant-${index}`,
                role: 'assistant',
                time: { created: index },
            } as Message,
            parts: [
                {
                    id: `assistant-${index}-part-0-text`,
                    type: 'text',
                    text: 'progress update',
                },
            ] as unknown as ChatMessageEntry['parts'],
        }));
        messages.push(makeTextMessage(40));
        const activityPartIds = new Set(
            Array.from({ length: 40 }, (_, index) => `assistant-${index}-part-0-text`),
        );
        const result = renderCustomBlock(messages, activityPartIds);

        expect(result.renderedMessages).toBe(2);
        expect(result.markup).not.toContain('Load earlier response');
    });

    test('still gates turns with more than 32 final response messages', () => {
        const messages = Array.from({ length: 40 }, (_, index) => makeTextMessage(index));
        const result = renderCustomBlock(messages, new Set());

        expect(result.renderedMessages).toBe(32);
        expect(result.markup).toContain('Load earlier response');
        expect(result.markup).toContain('data-message="assistant-0"');
        expect(result.markup).toContain('data-message="assistant-39"');
    });

    test('bounds mixed turns by final responses rather than raw activity records', () => {
        const messages = Array.from({ length: 40 }, (_, finalIndex) => [
            makeTextMessage(finalIndex * 11),
            ...Array.from({ length: 10 }, (_, toolIndex) => makeToolMessage(finalIndex * 11 + toolIndex + 1)),
        ]).flat();
        const result = renderCustomBlock(messages, new Set());

        expect(result.renderedMessages).toBe(32);
        expect(result.markup).toContain('Load earlier response');
        expect(result.markup).toContain('data-message="assistant-0"');
        expect(result.markup).not.toContain('data-message="assistant-1"');
        expect(result.markup).toContain('data-message="assistant-429"');
    });
});
