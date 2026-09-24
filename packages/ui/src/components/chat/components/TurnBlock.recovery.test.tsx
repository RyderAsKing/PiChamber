import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message, Part } from '@/lib/chat/types';

// `TurnBlock` → `TurnItem` → `TurnWorkingHeader` stay real. `MessageRow` is a
// boundary stub that exposes whether each assistant's completion footer is
// held (`turnGroupingContext.isWorking`); the activity rail is not under test.
mock.module('@/components/chat/components/MessageRow', () => ({
    MessageRow: ({ message, turnGroupingContext }: {
        message: { info: { id: string } };
        turnGroupingContext?: { isWorking?: boolean };
    }) => (
        <div data-row={message.info.id} data-footer-held={String(Boolean(turnGroupingContext?.isWorking))} />
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

const entry = (id: string, role: 'user' | 'assistant', parts: Part[] = [], extras: Record<string, unknown> = {}) => ({
    info: {
        id,
        role,
        sessionID: 'ses_1',
        ...(role === 'assistant' ? { parentID: 'u1' } : {}),
        time: { created: role === 'user' ? 1 : 2 },
        ...extras,
    } as Message,
    parts,
});

const toolPart = (id: string, messageID: string): Part => ({
    id,
    messageID,
    sessionID: 'ses_1',
    type: 'tool',
    tool: 'task',
    callID: `call-${id}`,
    state: { status: 'running', input: {}, time: { start: 2 } },
} as unknown as Part);

const textPart = (id: string, messageID: string, text: string): Part => ({
    id,
    messageID,
    sessionID: 'ses_1',
    type: 'text',
    text,
} as unknown as Part);

// A delegating turn interrupted by an outage: tool activity, an unfinished
// final assistant, and no settled duration.
const interruptedTurn = () => projectTurnRecords([
    entry('u1', 'user'),
    entry('a1', 'assistant', [toolPart('t1', 'a1')]),
    entry('a2', 'assistant', [textPart('x1', 'a2', 'Delegated the review to a sub-agent.')]),
]).turns[0]!;

const render = (props: { isLastTurn: boolean; sessionIsWorking: boolean; sessionAwaitingRecovery: boolean }) => renderToStaticMarkup(
    <TurnBlock
        turn={interruptedTurn()}
        isLastTurn={props.isLastTurn}
        sessionIsWorking={props.sessionIsWorking}
        sessionAwaitingRecovery={props.sessionAwaitingRecovery}
        onMessageContentChange={() => {}}
        getAnimationHandlers={() => ({}) as never}
        shouldAnimateUserMessage={() => false}
        onUserAnimationConsumed={() => {}}
        activeStreamingMessageId={null}
        activeStreamingPhase={null}
    />,
);

describe('TurnBlock reconnect presentation', () => {
    test('fixture has disclosed activity and no settled duration', () => {
        const turn = interruptedTurn();
        expect(turn.activityParts.length).toBeGreaterThan(0);
        expect(turn.durationMs).toBeUndefined();
    });

    test('an interrupted latest turn is labelled reconnecting and holds only its last footer', () => {
        const markup = render({ isLastTurn: true, sessionIsWorking: false, sessionAwaitingRecovery: true });
        expect(markup).toContain('Reconnecting · last seen working');
        expect(markup).toContain('data-turn-activity-toggle="true"');
        expect(markup).not.toContain('Worked for');
        expect(markup).toContain('data-row="a2" data-footer-held="true"');
        expect(markup).toContain('data-row="a1" data-footer-held="false"');
    });

    test('settled history is not affected by the latest turn awaiting recovery', () => {
        const markup = render({ isLastTurn: false, sessionIsWorking: false, sessionAwaitingRecovery: true });
        expect(markup).not.toContain('Reconnecting');
        expect(markup).toContain('data-row="a2" data-footer-held="false"');
    });

    test('once state is verified terminal the footer is released and the chevron keeps a label', () => {
        const markup = render({ isLastTurn: true, sessionIsWorking: false, sessionAwaitingRecovery: false });
        expect(markup).not.toContain('Reconnecting');
        expect(markup).toContain('data-row="a2" data-footer-held="false"');
        expect(markup).toContain('Agent activity');
    });
});
