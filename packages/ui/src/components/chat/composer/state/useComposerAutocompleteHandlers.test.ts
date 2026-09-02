import { describe, expect, test } from 'bun:test';
import {
  buildFileMentionReplacement,
  buildPrefixTokenReplacement,
} from './useComposerAutocompleteHandlers';

describe('useComposerAutocompleteHandlers helpers', () => {
  describe('buildFileMentionReplacement', () => {
    test('replaces @mention query after existing @ symbol', () => {
      const { newMessage, nextCursor } = buildFileMentionReplacement(
        'check @file.t and more',
        13,
        'src/file.ts'
      );
      expect(newMessage).toBe('check @src/file.ts  and more');
      expect(nextCursor).toBe(6 + 'src/file.ts'.length + 2);
    });

    test('inserts @mention at cursor if no preceding @ symbol found', () => {
      const { newMessage, nextCursor } = buildFileMentionReplacement(
        'hello world',
        5,
        'src/app.tsx'
      );
      expect(newMessage).toBe('hello@src/app.tsx  world');
      expect(nextCursor).toBe(5 + 'src/app.tsx'.length + 2);
    });
  });

  describe('buildPrefixTokenReplacement', () => {
    test('replaces /skill query with confirmed skill token', () => {
      const { newMessage, nextCursor } = buildPrefixTokenReplacement(
        'please run /refact to continue',
        18,
        '/',
        'refactor'
      );
      expect(newMessage).toBe('please run /refactor  to continue');
      expect(nextCursor).toBe(11 + 'refactor'.length + 2);
    });

    test('replaces #snippet query with confirmed snippet token', () => {
      const { newMessage, nextCursor } = buildPrefixTokenReplacement(
        'include #head in file',
        13,
        '#',
        'header'
      );
      expect(newMessage).toBe('include #header  in file');
      expect(nextCursor).toBe(8 + 'header'.length + 2);
    });

    test('replaces @agent query with confirmed agent token', () => {
      const { newMessage, nextCursor } = buildPrefixTokenReplacement(
        'ask @rese for info',
        9,
        '@',
        'research'
      );
      expect(newMessage).toBe('ask @research  for info');
      expect(nextCursor).toBe(4 + 'research'.length + 2);
    });
  });
});
