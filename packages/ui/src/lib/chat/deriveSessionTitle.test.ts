import { describe, expect, test } from 'bun:test';
import { deriveSessionTitle } from './deriveSessionTitle';

describe('deriveSessionTitle', () => {
  test('returns empty string for empty or non-string input', () => {
    expect(deriveSessionTitle('')).toBe('');
    expect(deriveSessionTitle('   \n\t  ')).toBe('');
  });

  test('extracts the first non-empty line and normalizes whitespace', () => {
    expect(deriveSessionTitle('\n\n  Fix   the bug in   parser\nDetails below')).toBe('Fix the bug in parser');
  });

  test('strips markdown code blocks and inline backticks', () => {
    expect(deriveSessionTitle('```js\nconsole.log(1)\n```\nExplain this error')).toBe('Explain this error');
    expect(deriveSessionTitle('How do I fix `ReferenceError: x is not defined` in file')).toBe('How do I fix in file');
  });

  test('strips attachment placeholders and @-mentions', () => {
    expect(deriveSessionTitle('[attachment:123] Review this log file @agent')).toBe('Review this log file');
  });

  test('truncates long lines to max length with ellipsis', () => {
    const longPrompt = 'This is a very long prompt line that exceeds fifty characters and needs to be truncated cleanly';
    const result = deriveSessionTitle(longPrompt, 50);
    expect(result.length <= 51).toBe(true); // 50 chars + ellipsis
    expect(result.endsWith('…')).toBe(true);
  });
});
