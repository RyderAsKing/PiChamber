import { describe, expect, test } from 'bun:test';

import type { PiPluginView } from '@/lib/pi/protocol';
import { listComposerToggles } from './composerToggles';

const plugin = (overrides: Partial<PiPluginView>): PiPluginView => ({
  id: 'p',
  name: 'P',
  description: '',
  version: '1.0.0',
  bundled: true,
  enabled: true,
  state: { on: true },
  stateSchema: { on: { type: 'boolean', label: 'On', scope: 'global', default: false } },
  contributes: { composerToggles: [{ id: 't', state: 'on', label: 'P' }] },
  impact: null,
  ...overrides,
});

describe('listComposerToggles', () => {
  test('lists toggles of enabled plugins with their state', () => {
    const items = listComposerToggles([plugin({}), plugin({ id: 'q', state: { on: false } })]);
    expect(items.map((item) => [item.plugin.id, item.on])).toEqual([['p', true], ['q', false]]);
  });

  test('skips plugins that are off and toggles bound to non-boolean state', () => {
    expect(listComposerToggles([plugin({ enabled: false })])).toEqual([]);
    expect(listComposerToggles([plugin({
      stateSchema: { on: { type: 'enum', label: 'On', scope: 'global', default: 'a', options: [{ value: 'a', label: 'A' }] } },
    })])).toEqual([]);
  });

  test('a session value wins over the default, for that plugin only', () => {
    const items = listComposerToggles(
      [plugin({}), plugin({ id: 'q', state: { on: false } })],
      { p: { on: false }, q: { other: true } },
    );
    expect(items.map((item) => [item.plugin.id, item.on, item.defaultOn])).toEqual([['p', false, true], ['q', false, false]]);
  });
});
