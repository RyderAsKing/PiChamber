import { describe, expect, test } from 'bun:test';
import {
  tryExpandFencedCodeBlock,
  tryWrapSelection,
  WRAP_PAIRS,
} from './useComposerKeyNavigation';

describe('useComposerKeyNavigation helpers', () => {
  describe('tryWrapSelection', () => {
    test('returns null if there is no range selection (cursor collapsed)', () => {
      expect(tryWrapSelection('hello world', 5, 5, '`')).toBeNull();
      expect(tryWrapSelection('hello world', 6, 2, '`')).toBeNull();
    });

    test('returns null for keys not in WRAP_PAIRS', () => {
      expect(tryWrapSelection('hello world', 0, 5, 'x')).toBeNull();
    });

    test('wraps selected text with backticks', () => {
      const res = tryWrapSelection('const foo = bar;', 6, 9, '`');
      expect(res).not.toBeNull();
      expect(res?.next).toBe('const `foo` = bar;');
      expect(res?.caretStart).toBe(7);
      expect(res?.caretEnd).toBe(10);
    });

    test('wraps selected text with parentheses, brackets, and quotes', () => {
      const paren = tryWrapSelection('sum a + b', 4, 9, '(');
      expect(paren?.next).toBe('sum (a + b)');
      expect(paren?.caretStart).toBe(5);
      expect(paren?.caretEnd).toBe(10);

      const bracket = tryWrapSelection('items: 1, 2', 7, 11, '[');
      expect(bracket?.next).toBe('items: [1, 2]');

      const quote = tryWrapSelection('say hello', 4, 9, '"');
      expect(quote?.next).toBe('say "hello"');
    });

    test('supports all defined wrap pairs', () => {
      for (const [key, [open, close]] of Object.entries(WRAP_PAIRS)) {
        const res = tryWrapSelection('foo', 0, 3, key);
        expect(res?.next).toBe(`${open}foo${close}`);
      }
    });
  });

  describe('tryExpandFencedCodeBlock', () => {
    test('returns null if key is not a backtick', () => {
      expect(tryExpandFencedCodeBlock('``', 2, 2, 'a')).toBeNull();
    });

    test('returns null if selection is not collapsed', () => {
      expect(tryExpandFencedCodeBlock('``', 0, 2, '`')).toBeNull();
    });

    test('returns null if fewer than 2 backticks precede caret', () => {
      expect(tryExpandFencedCodeBlock('`', 1, 1, '`')).toBeNull();
      expect(tryExpandFencedCodeBlock('word``', 6, 6, '`')).toBeNull();
    });

    test('expands into fenced code block at line start', () => {
      const res = tryExpandFencedCodeBlock('``', 2, 2, '`');
      expect(res).not.toBeNull();
      expect(res?.next).toBe('```\n\n```');
      expect(res?.caret).toBe(4); // index inside the middle empty line
    });

    test('expands into fenced code block after newline', () => {
      const res = tryExpandFencedCodeBlock('here is code:\n``', 16, 16, '`');
      expect(res).not.toBeNull();
      expect(res?.next).toBe('here is code:\n```\n\n```');
      expect(res?.caret).toBe(18);
    });
  });
});
