import { describe, expect, mock, test } from 'bun:test';

let generatedText = 'fix-auth-timeout';
const runtimeFetch = mock(async () => new Response(
  JSON.stringify({ text: generatedText }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
));

mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch }));

const { deriveLocalWorktreeName, deriveWorktreeName, normalizeWorktreeName } = await import('./worktreeName');

describe('worktree naming', () => {
  test('normalizes model output into a bounded branch-safe name', () => {
    expect(normalizeWorktreeName('  Fix Auth Timeout!  ')).toBe('fix-auth-timeout');
    expect(normalizeWorktreeName('A'.repeat(80)).length).toBe(48);
  });

  test('uses a model response only when it is already a valid slug', async () => {
    generatedText = 'fix-auth-timeout';
    expect(await deriveWorktreeName('Fix the authentication timeout', '/repo')).toBe('fix-auth-timeout');
  });

  test('rejects conversational model output and falls back to the task prompt', async () => {
    generatedText = "I'll start by exploring the authentication flow.";

    expect(await deriveWorktreeName('Fix the authentication timeout', '/repo'))
      .toBe('fix-the-authentication-timeout');
  });

  test('rejects an overlong generated slug instead of truncating model output', async () => {
    generatedText = 'a'.repeat(49);

    expect(await deriveWorktreeName('Fix the authentication timeout', '/repo'))
      .toBe('fix-the-authentication-timeout');
  });

  test('derives a deterministic fallback without retaining the whole prompt', () => {
    expect(deriveLocalWorktreeName('Fix authentication timeout when refreshing a very old access token in mobile clients'))
      .toBe('fix-authentication-timeout-when-refreshing-a-ver');
  });

  test('returns null when no safe name can be derived', () => {
    expect(deriveLocalWorktreeName('---')).toBeNull();
  });
});
