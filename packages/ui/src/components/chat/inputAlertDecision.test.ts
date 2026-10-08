import { describe, expect, test } from 'bun:test';

import { decideInputAlert, PENDING_INPUT_MAX_ALERT_AGE_MS } from './inputAlertDecision';

describe('decideInputAlert', () => {
  test('stays quiet when the session is current and the app is visible+focused', () => {
    expect(decideInputAlert({
      isCurrent: true, visible: true, focused: true, mode: 'hidden-only', ageMs: 1_000,
    })).toBe('none');
    expect(decideInputAlert({
      isCurrent: true, visible: true, focused: true, mode: 'always', ageMs: 1_000,
    })).toBe('none');
  });

  test('toasts for a background session while the app is visible+focused', () => {
    expect(decideInputAlert({
      isCurrent: false, visible: true, focused: true, mode: 'hidden-only', ageMs: 1_000,
    })).toBe('toast');
  });

  test('notifies when the document is hidden or unfocused', () => {
    expect(decideInputAlert({
      isCurrent: false, visible: false, focused: false, mode: 'hidden-only', ageMs: 1_000,
    })).toBe('toast-and-notify');
    expect(decideInputAlert({
      isCurrent: true, visible: true, focused: false, mode: 'hidden-only', ageMs: 1_000,
    })).toBe('toast-and-notify');
    expect(decideInputAlert({
      isCurrent: true, visible: false, focused: false, mode: 'hidden-only', ageMs: 1_000,
    })).toBe('toast-and-notify');
  });

  test('notifies in always mode for a background session even when focused', () => {
    expect(decideInputAlert({
      isCurrent: false, visible: true, focused: true, mode: 'always', ageMs: 1_000,
    })).toBe('toast-and-notify');
  });

  test('ignores replay bursts older than ten minutes', () => {
    expect(PENDING_INPUT_MAX_ALERT_AGE_MS).toBe(10 * 60 * 1000);
    expect(decideInputAlert({
      isCurrent: false, visible: false, focused: false, mode: 'hidden-only',
      ageMs: PENDING_INPUT_MAX_ALERT_AGE_MS + 1,
    })).toBe('none');
    expect(decideInputAlert({
      isCurrent: false, visible: false, focused: false, mode: 'hidden-only',
      ageMs: PENDING_INPUT_MAX_ALERT_AGE_MS,
    })).toBe('toast-and-notify');
  });

  test('rejects non-finite and negative ages', () => {
    for (const ageMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(decideInputAlert({
        isCurrent: false, visible: false, focused: false, mode: 'hidden-only', ageMs,
      })).toBe('none');
    }
  });
});
