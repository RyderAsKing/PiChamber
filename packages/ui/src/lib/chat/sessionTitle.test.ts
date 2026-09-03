import { describe, expect, test } from 'bun:test';

import { AWAITING_FIRST_PROMPT_LABEL, getSessionDisplayTitle } from './sessionTitle';

describe('getSessionDisplayTitle', () => {
  test('prefers the stored title over any fallback', () => {
    expect(getSessionDisplayTitle({ title: 'Build me', messageCount: 0 })).toBe('Build me');
  });

  test('labels an untitled session with an empty transcript as awaiting its first prompt', () => {
    expect(getSessionDisplayTitle({ messageCount: 0 })).toBe(AWAITING_FIRST_PROMPT_LABEL);
    expect(getSessionDisplayTitle({ title: '   ', messageCount: 0 })).toBe(AWAITING_FIRST_PROMPT_LABEL);
  });

  test('keeps the untitled fallback when the transcript is not empty', () => {
    expect(getSessionDisplayTitle({ messageCount: 3 })).toBe('Untitled Session');
  });

  test('never infers emptiness from an unknown message count', () => {
    expect(getSessionDisplayTitle({})).toBe('Untitled Session');
    expect(getSessionDisplayTitle(null)).toBe('Untitled Session');
    expect(getSessionDisplayTitle(undefined)).toBe('Untitled Session');
  });

  test('preserves a caller-supplied fallback for unknown counts', () => {
    expect(getSessionDisplayTitle({}, 'Untitled session')).toBe('Untitled session');
    expect(getSessionDisplayTitle({ messageCount: 2 }, 'Untitled session')).toBe('Untitled session');
  });
});
