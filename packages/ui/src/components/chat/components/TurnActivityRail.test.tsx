import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Message, Part } from '@/lib/chat/types';
import type { TurnRecord } from '../lib/turns/types';

mock.module('@/components/chat/markdown/markdown-worker', () => ({
    highlightCodeInWorker: async () => null,
    highlightLinesInWorker: async () => [],
    highlightTokensInWorker: async () => null,
}));

const { default: TurnActivityRail } = await import('./TurnActivityRail');

const makeTurn = (activities: TurnRecord['activityParts']): TurnRecord => ({
    turnId: 'turn-1',
    userMessageId: 'user-1',
    userMessage: {
        info: { id: 'user-1', role: 'user' } as Message,
        parts: [],
    },
    messages: [],
    assistantMessageIds: [],
    assistantMessages: [],
    activityParts: activities,
    activitySegments: [],
    summary: {},
    hasTools: activities.some((activity) => activity.kind === 'tool'),
    hasReasoning: activities.some((activity) => activity.kind === 'reasoning'),
    stream: { isStreaming: false, isRetrying: false },
});

const makeReadActivity = (index: number, tool = 'read') => ({
    id: `tool-${index}`,
    turnId: 'turn-1',
    messageId: `assistant-${index}`,
    partIndex: 0,
    part: {
        id: `tool-${index}`,
        type: 'tool',
        tool,
        state: { status: 'completed', time: { start: 1000 + index, end: 1100 + index } },
    } as Part,
    kind: 'tool' as const,
});

describe('TurnActivityRail', () => {
    test('does not mount activity rows while initially collapsed', () => {
        const markup = renderToStaticMarkup(
            <TurnActivityRail
                turn={makeTurn([makeReadActivity(0)])}
                isExpanded={false}
                isLiveTurn={false}
            />,
        );

        expect(markup).toContain('data-turn-activity-expanded="false"');
        expect(markup).not.toContain('data-turn-activity-panel="true"');
        expect(markup).not.toContain('title="Read File"');
    });

    test('renders the latest forty tools without a count group', () => {
        const activities = Array.from({ length: 41 }, (_, index) => makeReadActivity(index, index === 0 ? 'skill' : 'read'));
        const markup = renderToStaticMarkup(
            <TurnActivityRail
                turn={makeTurn(activities)}
                isExpanded
                isLiveTurn={false}
            />,
        );

        expect(markup).toContain('Load earlier activity');
        expect(markup).toContain('class="chat-message-column"><div id="turn-turn-1-activity" class="relative min-w-0 pl-[18px]"');
        expect(markup).toContain('class="pointer-events-none absolute bottom-0 -left-[18px] top-0 w-px"');
        expect(markup).toContain('data-turn-activity-panel="true"');
        expect(markup).toContain('grid-rows-[1fr]');
        expect(markup).toContain('class="min-w-0 space-y-1"');
        expect(markup.match(/title="Read File"/g)).toHaveLength(40);
        expect(markup).not.toContain('title="Skill"');
        expect(markup).not.toContain('tool calls');
        expect(markup).not.toContain('data-tool-call-group');
    });

    test('hides the earlier-activity control while the rail is collapsed', () => {
        const activities = Array.from({ length: 41 }, (_, index) => makeReadActivity(index));
        const markup = renderToStaticMarkup(
            <TurnActivityRail
                turn={makeTurn(activities)}
                isExpanded={false}
                isLiveTurn={false}
            />,
        );

        expect(markup).toContain('data-turn-activity-expanded="false"');
        expect(markup).not.toContain('Load earlier activity');
    });
});
