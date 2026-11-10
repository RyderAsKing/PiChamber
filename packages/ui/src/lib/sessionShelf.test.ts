import { describe, expect, test } from 'bun:test';

import {
  applyShelfPatch,
  formatSnoozeWake,
  nextSnoozeWakeAt,
  resolveSessionShelfSection,
  resolveSnoozePresets,
  sessionActivityAt,
  type SessionShelfInput,
} from './sessionShelf';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 10, 10, 14, 0).getTime(); // Tuesday 14:00

const input = (overrides: Partial<SessionShelfInput & { workingShelf: boolean }> = {}) => ({
  entry: undefined,
  pinned: false,
  working: false,
  needsInput: false,
  updatedAt: NOW - DAY,
  now: NOW,
  workingShelf: true,
  ...overrides,
});

describe('session shelf rules', () => {
  test('there is no Settled section: an old idle session stays in the list', () => {
    expect(resolveSessionShelfSection(input())).toBe('active');
    expect(resolveSessionShelfSection(input({ updatedAt: NOW - 400 * DAY }))).toBe('active');
    expect(resolveSessionShelfSection(input({ updatedAt: NOW - 400 * DAY, pinned: true }))).toBe('pinned');
    // A legacy settled flag from an older server is ignored.
    const legacy = { settled: 'settled', settledAt: NOW - DAY } as unknown as SessionShelfInput['entry'];
    expect(resolveSessionShelfSection(input({ entry: legacy }))).toBe('active');
  });

  test('working sessions use the Working shelf only where it exists', () => {
    expect(resolveSessionShelfSection(input({ working: true }))).toBe('working');
    expect(resolveSessionShelfSection(input({ working: true, workingShelf: false }))).toBe('active');
    expect(resolveSessionShelfSection(input({ working: true, needsInput: true }))).toBe('active');
  });

  test('a snooze holds until its wake time; only a question ends it early', () => {
    const entry = { snoozedUntil: NOW + 1000, snoozedAt: NOW - 1000 };
    expect(resolveSessionShelfSection(input({ entry }))).toBe('snoozed');
    expect(resolveSessionShelfSection(input({ entry, working: true }))).toBe('snoozed');
    expect(resolveSessionShelfSection(input({ entry, needsInput: true }))).toBe('active');
    const woke = { snoozedUntil: NOW - 1000, snoozedAt: NOW - 10 * DAY };
    expect(resolveSessionShelfSection(input({ entry: woke, updatedAt: NOW - 10 * DAY }))).toBe('active');
  });

  test('a wake counts as activity', () => {
    const woke = { snoozedUntil: NOW - 1000, snoozedAt: NOW - 10 * DAY };
    expect(sessionActivityAt({ entry: woke, updatedAt: NOW - 10 * DAY, now: NOW })).toBe(NOW - 1000);
    expect(sessionActivityAt({ entry: undefined, updatedAt: NOW - DAY, now: NOW })).toBe(NOW - DAY);
  });

  test('patches mirror the server: a snooze sets its wake and time, null clears it', () => {
    const snoozed = applyShelfPatch(undefined, { snoozedUntil: 100 }, 9);
    expect(snoozed).toEqual({ snoozedUntil: 100, snoozedAt: 9 });
    expect(applyShelfPatch(snoozed, { snoozedUntil: null }, 10)).toBeUndefined();
    expect(applyShelfPatch(snoozed, {}, 10)).toEqual(snoozed);
  });

  test('the next wake is the soonest future snooze', () => {
    expect(nextSnoozeWakeAt({}, NOW)).toBeNull();
    expect(nextSnoozeWakeAt({
      a: { snoozedUntil: NOW + 5000, snoozedAt: NOW },
      b: { snoozedUntil: NOW + 2000, snoozedAt: NOW },
      c: { snoozedUntil: NOW - 2000, snoozedAt: NOW },
    }, NOW)).toBe(NOW + 2000);
  });
});

describe('snooze menu', () => {
  test('presets are soonest first and skip a time already passed today', () => {
    const presets = resolveSnoozePresets(new Date(NOW));
    expect(presets.map((preset) => preset.label)).toEqual(['In 1 hour', 'In 3 hours', 'This evening', 'Tomorrow', 'Next week']);
    const late = resolveSnoozePresets(new Date(2026, 10, 10, 19, 0));
    expect(late.map((preset) => preset.label)).not.toContain('This evening');
    const sorted = [...presets].sort((a, b) => a.snoozedUntil - b.snoozedUntil);
    expect(presets).toEqual(sorted);
  });

  test('Monday on a Sunday reads Tomorrow and collapses into one row', () => {
    const sunday = new Date(2026, 10, 15, 10, 0);
    const labels = resolveSnoozePresets(sunday).map((preset) => preset.label);
    expect(labels.filter((label) => label === 'Tomorrow')).toHaveLength(1);
    expect(labels).not.toContain('Next week');
  });

  test('wake labels show a time today and a weekday within the week', () => {
    expect(/[A-Z][a-z]{2} /.test(formatSnoozeWake(new Date(2026, 10, 10, 18, 0).getTime(), NOW))).toBe(false);
    expect(formatSnoozeWake(new Date(2026, 10, 12, 9, 0).getTime(), NOW)).toBe('Thu');
  });
});
