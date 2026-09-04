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
        expect(markup).toContain('aria-label="Collapse activity"');
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
        expect(markup).toContain('aria-label="Expand activity"');
        expect(markup.indexOf('data-agent-worked-row="true"')).toBeLessThan(
            markup.indexOf('data-turn-activity-toggle="true"'),
        );
    });
});
