import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message, Part } from '@/lib/chat/types';

// `TurnBlock` → `TurnItem` stay real; `MessageRow` is a boundary stub that
// exposes render order so the test can assert the in-turn notice lands
// between the user message and the assistant reply.
mock.module('@/components/chat/components/MessageRow', () => ({
    MessageRow: ({ message }: {
        message: { info: { id: string } };
    }) => (
        <div data-row={message.info.id} />
    ),
}));
mock.module('@/components/chat/components/TurnActivityRail', () => ({ default: () => null }));
mock.module('@/hooks/useProviderLogo', () => ({
    useProviderLogo: () => ({ src: null, onError: () => {}, hasLogo: false }),
}));
mock.module('@/contexts/useThemeSystem', () => ({
    useThemeSystem: () => ({ currentTheme: null }),
}));

const { TurnBlock } = await import('./TurnBlock');
const { projectTurnRecords } = await import('../lib/turns/projectTurnRecords');
const { EXTENSION_NOTICE_CUSTOM_TYPE } = await import('../lib/turns/applyExtensionNoticeOverlay');

const entry = (id: string, role: 'user' | 'assistant', extras: Record<string, unknown> = {}) => ({
    info: {
        id,
        role,
        sessionID: 'ses_1',
        ...(role === 'assistant' ? { parentID: 'u1' } : {}),
        time: { created: role === 'user' ? 100 : 200 },
        ...extras,
    } as Message,
    parts: [] as Part[],
});

const noticeEntry = () => ({
    info: {
        id: 'notice:n1',
        role: 'extension',
        sessionID: 'ses_1',
        customType: EXTENSION_NOTICE_CUSTOM_TYPE,
        text: 'Deploying',
        noticeLevel: 'info',
        time: { created: 150, completed: 150 },
    } as unknown as Message,
    parts: [] as Part[],
});

describe('TurnBlock in-turn notices', () => {
    test('an in-turn notice renders after the user message and before the assistant reply', () => {
        const projection = projectTurnRecords([entry('u1', 'user'), noticeEntry(), entry('a1', 'assistant')]);
        const turn = projection.turns[0]!;
        expect(turn.notices.map((notice) => notice.info.id)).toEqual(['notice:n1']);

        const markup = renderToStaticMarkup(
            <TurnBlock
                turn={turn}
                isLastTurn
                sessionIsWorking={false}
                onMessageContentChange={() => {}}
                getAnimationHandlers={() => ({}) as never}
                shouldAnimateUserMessage={() => false}
                onUserAnimationConsumed={() => {}}
                activeStreamingMessageId={null}
                activeStreamingPhase={null}
            />,
        );

        const userIndex = markup.indexOf('data-row="u1"');
        const noticeIndex = markup.indexOf('data-row="notice:n1"');
        const assistantIndex = markup.indexOf('data-row="a1"');
        expect(userIndex).toBeGreaterThanOrEqual(0);
        expect(noticeIndex).toBeGreaterThanOrEqual(0);
        expect(assistantIndex).toBeGreaterThanOrEqual(0);
        expect(userIndex).toBeLessThan(noticeIndex);
        expect(noticeIndex).toBeLessThan(assistantIndex);
    });
});
