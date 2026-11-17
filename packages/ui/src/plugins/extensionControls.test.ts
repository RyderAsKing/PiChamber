import { describe, expect, test } from 'bun:test';

import type { PiComposerControl } from '@/lib/pi/protocol';

import {
  controlAccessibleName,
  controlHintText,
  controlPillText,
  controlSettled,
  nextControlValue,
  sameControls,
  shownControlValue,
} from './extensionControls';

const mode: PiComposerControl = {
  id: 'mode',
  kind: 'cycle',
  label: 'Mode',
  value: 'balance',
  options: [
    { value: 'economy', label: 'Economy', command: 'economy' },
    { value: 'balance', label: 'Balance', command: 'balance' },
    { value: 'premium', label: 'Premium', command: 'premium' },
  ],
};
const plan: PiComposerControl = { id: 'plan', kind: 'toggle', label: 'Plan', value: false, command: 'plan' };
const review: PiComposerControl = { id: 'review', kind: 'action', label: 'Review', command: 'review --staged' };

describe('extension composer controls', () => {
  test('a click flips a toggle and walks a cycle, wrapping after the last option', () => {
    expect(nextControlValue(plan, false)).toBe(true);
    expect(nextControlValue(plan, true)).toBe(false);
    expect(nextControlValue(mode, 'economy')).toBe('balance');
    expect(nextControlValue(mode, 'premium')).toBe('economy');
    // No known value yet: the first option.
    expect(nextControlValue(mode, undefined)).toBe('economy');
    expect(nextControlValue(review, undefined)).toBeUndefined();
  });

  test('shows the value on its way, else the extension\'s own', () => {
    expect(shownControlValue(mode, undefined)).toBe('balance');
    expect(shownControlValue(mode, 'premium')).toBe('premium');
    expect(shownControlValue(plan, true)).toBe(true);
    expect(shownControlValue(review, 'x')).toBeUndefined();
  });

  test('names the current option and what a click does', () => {
    expect(controlPillText(mode, 'balance')).toBe('Balance');
    expect(controlPillText({ ...mode, value: undefined }, undefined)).toBe('Mode');
    expect(controlPillText(plan, true)).toBe('Plan');
    expect(controlAccessibleName(mode, 'premium')).toBe('Mode: Premium');
    expect(controlAccessibleName(plan, false)).toBe('Plan');
    expect(controlHintText(mode, 'balance')).toBe('Next: Premium');
    expect(controlHintText(plan, false)).toBe('Off. Click to turn on');
    expect(controlHintText(review, undefined)).toBe('Runs /review --staged');
  });

  test('a click settles once the extension reports the asked value, or the control is gone', () => {
    expect(controlSettled(mode, 'premium')).toBe(false);
    expect(controlSettled({ ...mode, value: 'premium' }, 'premium')).toBe(true);
    expect(controlSettled(undefined, 'premium')).toBe(true);
  });

  test('compares control lists by identity and order', () => {
    expect(sameControls([mode, plan], [mode, plan])).toBe(true);
    expect(sameControls([mode, plan], [plan, mode])).toBe(false);
    expect(sameControls([mode], [{ ...mode }])).toBe(false);
  });
});
