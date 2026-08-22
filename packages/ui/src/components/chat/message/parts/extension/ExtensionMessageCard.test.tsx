import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ExtensionMessageCard } from './ExtensionMessageCard';

const renderCard = (props: Partial<Parameters<typeof ExtensionMessageCard>[0]>) => renderToStaticMarkup(
    <ExtensionMessageCard messageId="m1" {...props} />,
);

describe('ExtensionMessageCard', () => {
    test('renders a progress card with label and percent', () => {
        const markup = renderCard({
            customType: 'pichamber.ui',
            data: { component: 'progress', props: { label: 'Indexing', value: 40, max: 200 } },
        });
        expect(markup).toContain('Indexing');
        expect(markup).toContain('20%');
        expect(markup).toContain('progressbar');
    });

    test('renders kv rows and badges with tones', () => {
        const markup = renderCard({
            customType: 'pichamber.ui',
            data: {
                title: 'Explore',
                component: 'kv',
                props: { rows: [{ label: 'Files', value: '12', tone: 'info' }] },
            },
        });
        expect(markup).toContain('Explore');
        expect(markup).toContain('Files');
        expect(markup).toContain('12');

        const badges = renderCard({
            customType: 'pichamber.ui',
            data: { component: 'badges', props: { items: [{ label: 'passing', tone: 'success' }] } },
        });
        expect(badges).toContain('passing');
    });

    test('renders action buttons bound to the session', () => {
        const markup = renderCard({
            sessionId: 'sess-1',
            customType: 'pichamber.ui',
            data: {
                component: 'markdown',
                props: { body: 'Done' },
                actions: [{ label: 'Reindex', command: 'explore-reindex' }],
            },
        });
        expect(markup).toContain('Reindex');
        expect(markup).toContain('Reindex');
    });

    test('falls back to a preformatted card for non-GUI extension content', () => {
        const markup = renderCard({
            customType: 'my-extension',
            text: 'Status update',
            details: { count: 3 },
        });
        expect(markup).toContain('my-extension');
        expect(markup).toContain('&quot;count&quot;: 3');
    });
});
