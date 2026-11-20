import { describe, expect, it } from 'vitest';

import { CARD_COMPONENTS, normalizeExtensionCard } from './extension-card.js';

describe('normalizeExtensionCard', () => {
  it('keeps what the browser reads and drops the rest', () => {
    const actions = [{ label: 'Focus', command: '/focus', args: 'src' }];
    expect(normalizeExtensionCard({ id: 'old-panel', protocol: 'x', version: 1, title: 'Build', component: 'progress', props: { value: 4 }, actions }))
      .toEqual({ card: { title: 'Build', component: 'progress', props: { value: 4 }, actions } });
    expect(normalizeExtensionCard({ component: 'markdown' })).toEqual({ card: { component: 'markdown', props: {} } });
  });

  it('says why a card cannot be shown', () => {
    for (const bad of [
      null,
      [],
      { component: 'chart' },
      { component: 'kv', props: [] },
      { component: 'kv', title: 3 },
      { component: 'kv', actions: Array.from({ length: 9 }, () => ({ label: 'A', command: 'a' })) },
      { component: 'kv', actions: [{ label: ' ', command: 'a' }] },
      { component: 'kv', actions: [{ label: 'Run', command: 'bad;name' }] },
    ]) {
      expect(normalizeExtensionCard(bad).error).toEqual(expect.any(String));
    }
  });

  it('lists the components the types file declares', async () => {
    const { readFile } = await import('node:fs/promises');
    const types = await readFile(new URL('../../../pichamber.d.ts', import.meta.url), 'utf8');
    const declared = [...types.matchAll(/\{ component: '([a-z]+)'/g)].map((match) => match[1]);
    expect(declared.sort()).toEqual([...CARD_COMPONENTS].sort());
  });
});
