import { describe, expect, test } from 'bun:test';

import { applyAssistantTextDelta } from './text-delta';

describe('applyAssistantTextDelta', () => {
  test('appends incremental suffixes', () => {
    expect(applyAssistantTextDelta('Hello, ', 'world!')).toBe('Hello, world!');
  });

  test('replaces with a cumulative snapshot instead of concatenating it', () => {
    expect(applyAssistantTextDelta('Let', 'Let me look')).toBe('Let me look');
    expect(applyAssistantTextDelta('Let me look', 'Let me look at the tests')).toBe(
      'Let me look at the tests',
    );
  });

  test('ignores a stale shorter snapshot', () => {
    expect(applyAssistantTextDelta('Let me look at the tests', 'Let me look')).toBe(
      'Let me look at the tests',
    );
  });

  test('merges overlapping window chunks instead of stuttering', () => {
    expect(
      applyAssistantTextDelta(
        'Let me look at the tests',
        ' me look at the tests and documentation',
      ),
    ).toBe('Let me look at the tests and documentation');
  });

  test('keeps identical chunks as a no-op', () => {
    expect(applyAssistantTextDelta('KhulaPolicy', 'KhulaPolicy')).toBe('KhulaPolicy');
  });
});
