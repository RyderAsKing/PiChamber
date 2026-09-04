import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/chat/types';
import { buildAutoDeleteCandidates } from './useSessionAutoCleanup';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const session = (
  id: string,
  updated: number | undefined,
  extra: Partial<Session> = {},
): Session =>
  ({
    id,
    title: id,
    time:
      updated === undefined
        ? { created: NOW - 40 * DAY_MS }
        : { created: updated, updated },
    ...extra,
  }) as Session;

describe('buildAutoDeleteCandidates', () => {
  test('returns sessions older than the cutoff', () => {
    const sessions = [
      session('old', NOW - 40 * DAY_MS),
      session('recent', NOW - 1 * DAY_MS),
      session('old-2', NOW - 31 * DAY_MS),
      session('old-3', NOW - 32 * DAY_MS),
      session('old-4', NOW - 33 * DAY_MS),
      session('old-5', NOW - 34 * DAY_MS),
      session('old-6', NOW - 35 * DAY_MS),
    ];
    const ids = buildAutoDeleteCandidates({
      sessions,
      currentSessionId: null,
      cutoffDays: 30,
      now: NOW,
    });
    // 5 most recent are protected, so only the 2 oldest are eligible.
    expect(ids).toEqual(['old-6', 'old']);
  });

  test('protects the current session even when old', () => {
    const sessions = [
      session('a', NOW - 40 * DAY_MS),
      session('b', NOW - 41 * DAY_MS),
      session('c', NOW - 42 * DAY_MS),
      session('d', NOW - 43 * DAY_MS),
      session('e', NOW - 44 * DAY_MS),
      session('f', NOW - 45 * DAY_MS),
      session('g', NOW - 46 * DAY_MS),
    ];
    const ids = buildAutoDeleteCandidates({
      sessions,
      currentSessionId: 'g',
      cutoffDays: 30,
      now: NOW,
    });
    expect(ids).not.toContain('g');
    expect(ids).toEqual(['f']);
  });

  test('skips shared sessions and sessions without timestamps', () => {
    const sessions = [
      session('shared', NOW - 60 * DAY_MS, { share: { url: 'https://x' } } as Partial<Session>),
      session('no-time', NOW - 60 * DAY_MS, { time: {} } as Partial<Session>),
      session('old-1', NOW - 60 * DAY_MS),
      session('old-2', NOW - 61 * DAY_MS),
      session('old-3', NOW - 62 * DAY_MS),
      session('old-4', NOW - 63 * DAY_MS),
      session('old-5', NOW - 64 * DAY_MS),
      session('old-6', NOW - 65 * DAY_MS),
    ];
    const ids = buildAutoDeleteCandidates({
      sessions,
      currentSessionId: null,
      cutoffDays: 30,
      now: NOW,
    });
    expect(ids).not.toContain('shared');
    expect(ids).not.toContain('no-time');
  });

  test('returns empty for non-positive cutoff', () => {
    expect(
      buildAutoDeleteCandidates({ sessions: [session('a', NOW - 99 * DAY_MS)], currentSessionId: null, cutoffDays: 0, now: NOW }),
    ).toEqual([]);
  });
});
