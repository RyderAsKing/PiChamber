import { describe, expect, test } from 'bun:test';

import { deriveLocalWorktreeName, normalizeWorktreeName } from './worktreeName';

describe('worktree naming', () => {
  test('normalizes model output into a bounded branch-safe name', () => {
    expect(normalizeWorktreeName('  Fix Auth Timeout!  ')).toBe('fix-auth-timeout');
    expect(normalizeWorktreeName('A'.repeat(80)).length).toBe(48);
  });

  test('derives a deterministic fallback without retaining the whole prompt', () => {
    expect(deriveLocalWorktreeName('Fix authentication timeout when refreshing a very old access token in mobile clients'))
      .toBe('fix-authentication-timeout-when-refreshing-a-ver');
  });

  test('returns null when no safe name can be derived', () => {
    expect(deriveLocalWorktreeName('---')).toBeNull();
  });
});
