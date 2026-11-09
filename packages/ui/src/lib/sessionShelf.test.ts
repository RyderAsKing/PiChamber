import { describe, expect, test } from 'bun:test';

import {
  applyShelfPatch,
  autoSettleDaysFromSetting,
  formatSnoozeWake,
  isAutoSettleAfterDaysSetting,
  nextSnoozeWakeAt,
  resolveSessionShelfSection,
  resolveSnoozePresets,
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
  autoSettleAfterDays: 3,
  workingShelf: true,
  ...overrides,
});

describe('session shelf rules', () => {
  test('an idle session settles after the configured days unless kept', () => {
    expect(resolveSessionShelfSection(input())).toBe('active');
    expect(resolveSessionShelfSection(input({ updatedAt: NOW - 4 * DAY }))).toBe('settled');
    expect(resolveSessionShelfSection(input({ updatedAt: NOW - 4 * DAY, autoSettleAfterDays: null }))).toBe('active');
    expect(resolveSessionShelfSection(input({ updatedAt: NOW - 4 * DAY, pinned: true }))).toBe('pinned');
    expect(resolveSessionShelfSection(input({ updatedAt: NOW - 4 * DAY, entry: { settled: 'active' } }))).toBe('active');
  });

  test('a manual settle wins over pinned, but never over a live run or a question', () => {
    const settled = { settled: 'settled' as const, settledAt: NOW - 1000 };
    expect(resolveSessionShelfSection(input({ entry: settled, pinned: true }))).toBe('settled');
    expect(resolveSessionShelfSection(input({ entry: settled, working: true }))).toBe('working');
    expect(resolveSessionShelfSection(input({ entry: settled, needsInput: true }))).toBe('active');
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
    // After waking, the wake counts as activity, so an old session does not settle at once.
    const woke = { snoozedUntil: NOW - 1000, snoozedAt: NOW - 10 * DAY };
    expect(resolveSessionShelfSection(input({ entry: woke, updatedAt: NOW - 10 * DAY }))).toBe('active');
  });

  test('patches mirror the server: settling clears a snooze and snoozing clears a settle', () => {
    const settled = applyShelfPatch(undefined, { settled: 'settled' }, 5);
    expect(settled).toEqual({ settled: 'settled', settledAt: 5 });
    expect(applyShelfPatch(settled, { settled: 'settled' }, 9)).toEqual({ settled: 'settled', settledAt: 5 });
    expect(applyShelfPatch(settled, { snoozedUntil: 100 }, 9)).toEqual({ snoozedUntil: 100, snoozedAt: 9 });
    expect(applyShelfPatch({ snoozedUntil: 100, snoozedAt: 9 }, { settled: 'settled' }, 10)).toEqual({ settled: 'settled', settledAt: 10 });
    expect(applyShelfPatch({ settled: 'active' }, { settled: null }, 10)).toBeUndefined();
  });

  test('the setting is whole days from 1 to 90, with 0 for off', () => {
    expect(isAutoSettleAfterDaysSetting(0)).toBe(true);
    expect(isAutoSettleAfterDaysSetting(90)).toBe(true);
    expect(isAutoSettleAfterDaysSetting(91)).toBe(false);
    expect(isAutoSettleAfterDaysSetting(1.5)).toBe(false);
    expect(autoSettleDaysFromSetting(0)).toBeNull();
    expect(autoSettleDaysFromSetting(7)).toBe(7);
    expect(autoSettleDaysFromSetting('x')).toBe(3);
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
