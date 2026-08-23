import { describe, expect, test } from 'bun:test';

import { createSnapshotSelectorCache, stringArrayEqual } from './select-snapshot';
import { isPiSessionLive, piLiveSessionIdsKey, piLiveStatusSignature } from './pi-session-live';
import type { PiReducerSessionState } from '@/lib/pi/event-reducer';
import { createReducerPartMap } from '@/lib/pi/event-reducer';

const session = (overrides: Partial<PiReducerSessionState> & Pick<PiReducerSessionState, 'sessionId'>): PiReducerSessionState => ({
  directory: '/work',
  lastSequence: 1,
  lifecycle: 'idle',
  messages: new Map(),
  partOrder: new Map(),
  parts: createReducerPartMap(),
  toolsByCallId: new Map(),
  streamingMessages: new Set(),
      extensionStatuses: new Map(),
      extensionWidgets: new Map(),
      extensionDialogs: [],
      extensionNotices: [],
      extensionErrors: [],
  extensionPanels: new Map(),
  extensionApps: new Map(),
  queue: { steering: 0, followUp: 0 },
  ...overrides,
});

describe('createSnapshotSelectorCache', () => {
  test('keeps the previous selection when the store snapshot identity is unchanged, even if the selector allocates', () => {
    const snapshot = { n: 1 };
    const getSelection = createSnapshotSelectorCache<typeof snapshot, { n: number }>();
    let calls = 0;
    const selector = (value: typeof snapshot) => {
      calls += 1;
      return { n: value.n };
    };
    const first = getSelection(snapshot, selector);
    const second = getSelection(snapshot, selector);
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });

  test('returns a new selection when the selected value changes', () => {
    const getSelection = createSnapshotSelectorCache<{ n: number }, number>();
    const first = getSelection({ n: 1 }, (snapshot) => snapshot.n);
    const second = getSelection({ n: 2 }, (snapshot) => snapshot.n);
    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  test('does not re-run a changed selector against an unchanged snapshot identity', () => {
    const snapshot = { a: 1, b: 2 };
    const getSelection = createSnapshotSelectorCache<typeof snapshot, number>();
    expect(getSelection(snapshot, (value) => value.a)).toBe(1);
    expect(getSelection(snapshot, (value) => value.b)).toBe(1);
  });

  test('entity lookups stay correct when they happen outside the snapshot cache', () => {
    const snapshot = {
      bySession: new Map([
        ['check', { text: 'check CSEO structure' }],
        ['look', { text: 'Take a look at CSEO' }],
      ]),
    };
    const getSelection = createSnapshotSelectorCache<typeof snapshot, Map<string, { text: string }>>();
    const bySession = getSelection(snapshot, (value) => value.bySession);
    expect(bySession.get('check')?.text).toBe('check CSEO structure');
    expect(getSelection(snapshot, (value) => value.bySession).get('look')?.text).toBe('Take a look at CSEO');
  });

  test('falls back to Object.is when a non-function equality argument is passed', () => {
    const getSelection = createSnapshotSelectorCache<{ n: number }, number>();
    expect(getSelection({ n: 1 }, (snapshot) => snapshot.n, '/repo' as never)).toBe(1);
    expect(getSelection({ n: 1 }, (snapshot) => snapshot.n, undefined)).toBe(1);
  });
});

describe('stringArrayEqual', () => {
  test('treats equal contents as equal without requiring the same array', () => {
    expect(stringArrayEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(stringArrayEqual(['a'], ['b'])).toBe(false);
  });
});

describe('pi live session signatures', () => {
  test('ignore idle sessions and stay stable across equivalent maps', () => {
    const idle = session({ sessionId: 'idle' });
    const busy = session({ sessionId: 'busy', lifecycle: 'busy' });
    const bySession = new Map<string, PiReducerSessionState>([
      ['idle', idle],
      ['busy', busy],
    ]);
    expect(isPiSessionLive(idle)).toBe(false);
    expect(isPiSessionLive(busy)).toBe(true);
    expect(piLiveStatusSignature(bySession)).toBe('busy:busy');
    expect(piLiveSessionIdsKey(bySession)).toBe('busy');
  });

  test('include retry sessions as live and ignore idle leftover streaming flags', () => {
    const streaming = session({ sessionId: 's1', streamingMessages: new Set(['m1']) });
    expect(isPiSessionLive(streaming)).toBe(false);
    expect(piLiveStatusSignature(new Map([['s1', streaming]]))).toBe('');
    const retrying = session({ sessionId: 's2', lifecycle: 'retry' });
    expect(isPiSessionLive(retrying)).toBe(true);
    expect(piLiveStatusSignature(new Map([['s2', retrying]]))).toBe('s2:retry');
  });
});
