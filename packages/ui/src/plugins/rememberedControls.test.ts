import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { PiComposerControl } from '@/lib/pi/protocol';
import { isRememberedControl, readRememberedControls, rememberControls } from './rememberedControls';

const memory = new Map<string, string>();
const fakeStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, value);
  },
};

const plan: PiComposerControl = { id: 'plan', kind: 'toggle', label: 'Plan', value: true, command: 'plan' };
const mode: PiComposerControl = {
  id: 'mode',
  kind: 'cycle',
  label: 'Mode',
  value: 'balance',
  options: [
    { value: 'economy', label: 'Economy', command: 'economy' },
    { value: 'balance', label: 'Balance', command: 'balance' },
  ],
};

describe('remembered composer controls', () => {
  const original = (globalThis as { window?: unknown }).window;
  beforeEach(() => {
    memory.clear();
    (globalThis as { window?: unknown }).window = { localStorage: fakeStorage };
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = original;
  });

  test('keeps a folder\'s controls per server and folder', () => {
    rememberControls('runtime-1', '/repo', [mode, plan], { authoritative: true });
    expect(readRememberedControls('runtime-1', '/repo')).toEqual([mode, plan]);
    expect(readRememberedControls('runtime-2', '/repo')).toEqual([]);
    expect(readRememberedControls('runtime-1', '/other')).toEqual([]);
    expect(readRememberedControls('runtime-1', null)).toEqual([]);
  });

  test('a draft\'s empty set replaces the picture; an open session\'s does not', () => {
    rememberControls('runtime-1', '/repo', [plan], { authoritative: true });
    rememberControls('runtime-1', '/repo', [], { authoritative: false });
    expect(readRememberedControls('runtime-1', '/repo')).toEqual([plan]);
    rememberControls('runtime-1', '/repo', [], { authoritative: true });
    expect(readRememberedControls('runtime-1', '/repo')).toEqual([]);
  });

  test('drops malformed stored controls and unreadable storage', () => {
    memory.set('pichamber:remembered-composer-controls:v1', JSON.stringify({
      'runtime-1\n/repo': { controls: [plan, { id: 'bad', kind: 'cycle', label: 'Bad', options: [] }, 'nonsense'], at: 1 },
    }));
    expect(readRememberedControls('runtime-1', '/repo')).toEqual([plan]);
    memory.set('pichamber:remembered-composer-controls:v1', '{not json');
    expect(readRememberedControls('runtime-1', '/repo')).toEqual([]);
  });

  test('keeps the most recently seen folders only', () => {
    for (let index = 0; index < 45; index += 1) {
      rememberControls('runtime-1', `/repo-${index}`, [plan], { authoritative: true });
    }
    const stored = JSON.parse(memory.get('pichamber:remembered-composer-controls:v1') ?? '{}');
    expect(Object.keys(stored)).toHaveLength(40);
  });

  test('validates the shape the composer draws', () => {
    expect(isRememberedControl(mode)).toBe(true);
    expect(isRememberedControl({ id: 'go', kind: 'action', label: 'Go', command: 'go' })).toBe(true);
    expect(isRememberedControl({ id: 'go', kind: 'action', label: 'Go' })).toBe(false);
    expect(isRememberedControl({ ...plan, value: 'yes' })).toBe(false);
  });
});
