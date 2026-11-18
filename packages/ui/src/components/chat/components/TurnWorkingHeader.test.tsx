import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/hooks/useProviderLogo', () => ({
    useProviderLogo: () => ({ src: null, onError: () => {}, hasLogo: false }),
}));

mock.module('@/contexts/useThemeSystem', () => ({
    useThemeSystem: () => ({ currentTheme: null }),
}));

const { default: TurnWorkingHeader } = await import('./TurnWorkingHeader');

describe('TurnWorkingHeader', () => {
    test('keeps a completed turn visible with its duration', () => {
        const markup = renderToStaticMarkup(
            <TurnWorkingHeader
                turnId="turn-1"
                isLiveTurn={false}
                isWorking={false}
                hasActivity={false}
                isActivityExpanded={false}
                onToggleActivity={() => {}}
                startedAt={1_000}
                completedAt={3_500}
            />,
        );

        expect(markup).toContain('Worked for 2.5s');
        expect(markup).toContain('data-agent-worked-row="true"');
        expect(markup).not.toContain('data-turn-activity-toggle="true"');
    });

    test('marks a turn that was ended by steering', () => {
        const markup = renderToStaticMarkup(
            <TurnWorkingHeader
                turnId="turn-1"
                isLiveTurn={false}
                isWorking={false}
                hasActivity={false}
                isActivityExpanded={false}
                onToggleActivity={() => {}}
                durationMs={15_800}
                wasSteered
            />,
        );

        expect(markup).toContain('Worked for 15.8s · Steered');
    });

    test('does not invent a settled duration before completion', () => {
        const markup = renderToStaticMarkup(
            <TurnWorkingHeader
                turnId="turn-1"
                isLiveTurn={false}
                isWorking={false}
                hasActivity={false}
                isActivityExpanded={false}
                onToggleActivity={() => {}}
                startedAt={1_000}
            />,
        );

        expect(markup).not.toContain('Worked for');
        expect(markup).not.toContain('0.1s');
    });

    test('adds an accessible activity disclosure only when activity exists', () => {
        const markup = renderToStaticMarkup(
            <TurnWorkingHeader
                turnId="turn-1"
                isLiveTurn={false}
                isWorking={false}
                hasActivity
                isActivityExpanded={true}
                onToggleActivity={() => {}}
            />,
        );

        expect(markup).toContain('data-turn-activity-toggle="true"');
        expect(markup).toContain('aria-expanded="true"');
        expect(markup).toContain('aria-controls="turn-turn-1-activity"');
        expect(markup).toContain('class="chat-message-column mb-1"');
        expect(markup).not.toContain('flex-1 items-center overflow-hidden');
    });

    test('keeps a reopen control beside a settled collapsed turn', () => {
        const markup = renderToStaticMarkup(
            <TurnWorkingHeader
                turnId="turn-1"
                isLiveTurn={false}
                isWorking={false}
                hasActivity
                isActivityExpanded={false}
                onToggleActivity={() => {}}
                durationMs={14_000}
            />,
        );

        expect(markup).toContain('Worked for 14.0s');
        expect(markup).toContain('aria-expanded="false"');
        // The duration is inside the toggle, so the whole line opens the rail.
        expect(markup.indexOf('data-turn-activity-toggle="true"')).toBeLessThan(
            markup.indexOf('data-agent-worked-row="true"'),
        );
    });
    test('a latest turn last seen working while reconnecting is labelled, not a bare chevron', () => {
        const markup = renderToStaticMarkup(
            <TurnWorkingHeader
                turnId="turn-1"
                isLiveTurn={false}
                isWorking={false}
                isAwaitingRecovery
                hasActivity
                isActivityExpanded={false}
                onToggleActivity={() => {}}
                startedAt={1_000}
            />,
        );

        expect(markup).toContain('Reconnecting · last seen working');
        expect(markup).toContain('data-turn-reconnecting="true"');
        expect(markup).toContain('data-turn-working="false"');
        expect(markup).not.toContain('Worked for');
        expect(markup).toContain('data-turn-activity-toggle="true"');
    });

    test('reconnecting does not claim a finished duration for the latest turn', () => {
        const markup = renderToStaticMarkup(
            <TurnWorkingHeader
                turnId="turn-1"
                isLiveTurn={false}
                isWorking={false}
                isAwaitingRecovery
                hasActivity={false}
                isActivityExpanded={false}
                onToggleActivity={() => {}}
                startedAt={1_000}
                completedAt={3_500}
            />,
        );

        expect(markup).toContain('Reconnecting · last seen working');
        expect(markup).not.toContain('Worked for');
    });

    test('a settled turn with activity but no duration gets a neutral label', () => {
        const markup = renderToStaticMarkup(
            <TurnWorkingHeader
                turnId="turn-1"
                isLiveTurn={false}
                isWorking={false}
                hasActivity
                isActivityExpanded={false}
                onToggleActivity={() => {}}
            />,
        );

        expect(markup).toContain('Agent activity');
        expect(markup).not.toContain('Worked for');
        expect(markup).toContain('data-turn-activity-toggle="true"');
    });

    test('a settled turn says what its tools did, with failures marked', () => {
        const markup = renderToStaticMarkup(
            <TurnWorkingHeader
                turnId="turn-1"
                isLiveTurn={false}
                isWorking={false}
                hasActivity
                isActivityExpanded={false}
                onToggleActivity={() => {}}
                durationMs={48_000}
                activitySummary={{
                    filesRead: 1,
                    filesEdited: 1,
                    commands: 2,
                    searches: 0,
                    fetches: 0,
                    subagents: 0,
                    otherTools: 0,
                    failed: 1,
                }}
            />,
        );

        expect(markup).toContain('Worked for 48.0s');
        expect(markup).toContain(' · Read 1 file · Edited 1 file · Ran 2 commands');
        expect(markup).toContain('data-turn-activity-failed="true"');
        expect(markup).toContain(' · 1 failed');
    });

    test('a reconnecting turn shows no counts', () => {
        const markup = renderToStaticMarkup(
            <TurnWorkingHeader
                turnId="turn-1"
                isLiveTurn={false}
                isWorking={false}
                isAwaitingRecovery
                hasActivity
                isActivityExpanded={false}
                onToggleActivity={() => {}}
                activitySummary={{
                    filesRead: 3,
                    filesEdited: 0,
                    commands: 0,
                    searches: 0,
                    fetches: 0,
                    subagents: 0,
                    otherTools: 0,
                    failed: 1,
                }}
            />,
        );

        expect(markup).not.toContain('Read 3 files');
        expect(markup).not.toContain('failed');
    });
});
