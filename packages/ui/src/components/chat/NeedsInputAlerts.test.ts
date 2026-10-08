import { describe, expect, test } from 'bun:test';

import { selectStaleNeedingAlertSessions } from './NeedsInputAlerts';

const pending = { count: 1, kind: 'input' as const, since: 1_000 };

describe('selectStaleNeedingAlertSessions', () => {
  test('keeps sessions the catalog still reports as needing input', () => {
    expect(selectStaleNeedingAlertSessions(
      ['s1'],
      new Set(['s1']),
      () => ({ exists: true, pendingInput: pending }),
    )).toEqual([]);
  });

  test('dismisses sessions known clear (null) even when the needing set lags', () => {
    expect(selectStaleNeedingAlertSessions(
      ['s1'],
      new Set(),
      () => ({ exists: true, pendingInput: null }),
    )).toEqual(['s1']);
  });

  test('keeps sessions whose row is missing (listings can drop rows; deletion emits cleared)', () => {
    expect(selectStaleNeedingAlertSessions(
      ['gone'],
      new Set(),
      () => ({ exists: false, pendingInput: undefined }),
    )).toEqual([]);
  });

  test('keeps sessions whose state is unknown (undefined is not cleared)', () => {
    expect(selectStaleNeedingAlertSessions(
      ['s1'],
      new Set(),
      () => ({ exists: true, pendingInput: undefined }),
    )).toEqual([]);
  });

  test('reconciles a mix of raised sessions independently', () => {
    const states: Record<string, { exists: boolean; pendingInput: typeof pending | null | undefined }> = {
      needing: { exists: true, pendingInput: pending },
      cleared: { exists: true, pendingInput: null },
      unknown: { exists: true, pendingInput: undefined },
      deleted: { exists: false, pendingInput: undefined },
    };
    expect(selectStaleNeedingAlertSessions(
      ['needing', 'cleared', 'unknown', 'deleted'],
      new Set(['needing']),
      (sessionId) => states[sessionId] ?? { exists: false, pendingInput: undefined },
    )).toEqual(['cleared']);
  });

  test('returns nothing when nothing was raised', () => {
    expect(selectStaleNeedingAlertSessions([], new Set(), () => {
      throw new Error('lookup must not run with no raised sessions');
    })).toEqual([]);
  });
});
