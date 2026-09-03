import { describe, expect, test } from 'bun:test';

import { matchGitmojiFromSubject } from './gitmojiMatcher';
import type { GitmojiEntry } from '@/hooks/useGitmojiList';

const sampleGitmojis: GitmojiEntry[] = [
  { emoji: '✨', code: ':sparkles:', description: 'Introduce new features' },
  { emoji: '🐛', code: ':bug:', description: 'Fix a bug' },
  { emoji: '📝', code: ':memo:', description: 'Add or update documentation' },
  { emoji: '♻️', code: ':recycle:', description: 'Refactor code' },
];

describe('matchGitmojiFromSubject', () => {
  test('matches conventional commit prefix with colon', () => {
    const result = matchGitmojiFromSubject('feat: add user login', sampleGitmojis);
    expect(result).toEqual(sampleGitmojis[0]);
  });

  test('matches conventional commit prefix with scope', () => {
    const result = matchGitmojiFromSubject('fix(auth): prevent token leak', sampleGitmojis);
    expect(result).toEqual(sampleGitmojis[1]);
  });

  test('matches conventional commit prefix with breaking change exclamation mark', () => {
    const result = matchGitmojiFromSubject('feat(api)!: remove v1 endpoints', sampleGitmojis);
    expect(result).toEqual(sampleGitmojis[0]);
  });

  test('matches starting word when conventional commit prefix is not present', () => {
    const result = matchGitmojiFromSubject('docs update readme with installation guide', sampleGitmojis);
    expect(result).toEqual(sampleGitmojis[2]);
  });

  test('returns null for unknown commit subject', () => {
    const result = matchGitmojiFromSubject('random commit message', sampleGitmojis);
    expect(result).toBeNull();
  });
});
