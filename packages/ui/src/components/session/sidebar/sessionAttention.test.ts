import { describe, expect, test } from 'bun:test';
import type { PiPendingInputSummary } from '@/lib/pi/protocol';
import {
  formatNeedsInputLabel,
  formatSessionsNeedingInputLabel,
  hasPendingInput,
  resolveSessionAttention,
} from './sessionAttention';

const pending = (overrides?: Partial<PiPendingInputSummary>): PiPendingInputSummary => ({
  count: 1,
  kind: 'input',
  since: 1_700_000_000_000,
  ...overrides,
});

describe('resolveSessionAttention', () => {
  test('needs input outranks working, even for the active streaming session', () => {
    expect(
      resolveSessionAttention({
        pendingInput: pending(),
        isStreaming: true,
        unseenCount: 3,
        unseenHasError: true,
        isActive: true,
      }),
    ).toBe('needs-input');
  });

  test('needs input shows for the active session', () => {
    expect(
      resolveSessionAttention({
        pendingInput: pending({ kind: 'approval' }),
        isStreaming: false,
        unseenCount: 0,
        isActive: true,
      }),
    ).toBe('needs-input');
  });

  test('unknown (undefined) and authoritatively empty (null) pending input do not rank', () => {
    for (const pendingInput of [undefined, null] as const) {
      expect(
        resolveSessionAttention({ pendingInput, isStreaming: false, unseenCount: 0, isActive: false }),
      ).toBeNull();
    }
  });

  test('zero-count pending input does not rank', () => {
    expect(
      resolveSessionAttention({
        pendingInput: pending({ count: 0 }),
        isStreaming: false,
        unseenCount: 0,
        isActive: false,
      }),
    ).toBeNull();
  });

  test('working outranks unread', () => {
    expect(
      resolveSessionAttention({
        pendingInput: null,
        isStreaming: true,
        unseenCount: 2,
        isActive: false,
      }),
    ).toBe('working');
  });

  test('unread applies only when settled and not active', () => {
    expect(
      resolveSessionAttention({ pendingInput: null, isStreaming: false, unseenCount: 2, isActive: false }),
    ).toBe('unread');
    expect(
      resolveSessionAttention({ pendingInput: null, isStreaming: false, unseenCount: 2, isActive: true }),
    ).toBeNull();
    expect(
      resolveSessionAttention({ pendingInput: null, isStreaming: false, unseenCount: 0, isActive: false }),
    ).toBeNull();
  });
});

describe('hasPendingInput', () => {
  test('distinguishes unknown, empty, zero-count, and pending', () => {
    expect(hasPendingInput(undefined)).toBe(false);
    expect(hasPendingInput(null)).toBe(false);
    expect(hasPendingInput(pending({ count: 0 }))).toBe(false);
    expect(hasPendingInput(pending())).toBe(true);
  });
});

describe('formatNeedsInputLabel', () => {
  test('names the kind and pluralizes request counts', () => {
    expect(formatNeedsInputLabel('input', 1)).toBe('Needs input');
    expect(formatNeedsInputLabel('approval', 1)).toBe('Needs approval');
    expect(formatNeedsInputLabel('input', 2)).toBe('Needs input (2 requests)');
    expect(formatNeedsInputLabel('approval', 3)).toBe('Needs approval (3 requests)');
  });
});

describe('formatSessionsNeedingInputLabel', () => {
  test('uses singular and plural aggregate copy', () => {
    expect(formatSessionsNeedingInputLabel(1)).toBe('A session needs input');
    expect(formatSessionsNeedingInputLabel(2)).toBe('2 sessions need input');
  });
});
