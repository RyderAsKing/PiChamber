import { describe, expect, test } from 'bun:test';

import type { Session } from '@/lib/chat/types';
import { resolveGlobalSessionDirectory } from '@/lib/chat/sessionDirectory';

describe('resolveGlobalSessionDirectory', () => {
  test('prefers normalized directory over project worktree', () => {
    const session = {
      id: 's-1',
      directory: '/repo/a/',
      project: { worktree: '/other' },
    } as unknown as Session;
    expect(resolveGlobalSessionDirectory(session)).toBe('/repo/a');
  });

  test('falls back to normalized project worktree', () => {
    const session = {
      id: 's-2',
      project: { worktree: 'C:\\repo\\b\\' },
    } as unknown as Session;
    expect(resolveGlobalSessionDirectory(session)).toBe('C:/repo/b');
  });

  test('returns null when neither directory nor worktree normalizes', () => {
    const empty = { id: 's-3' } as unknown as Session;
    expect(resolveGlobalSessionDirectory(empty)).toBeNull();

    const blank = {
      id: 's-4',
      directory: '   ',
      project: { worktree: '' },
    } as unknown as Session;
    expect(resolveGlobalSessionDirectory(blank)).toBeNull();
  });
});
