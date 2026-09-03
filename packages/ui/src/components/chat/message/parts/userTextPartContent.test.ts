import { describe, expect, test } from 'bun:test';

import { prepareUserMarkdownContent, SKILL_TOKEN_PATTERN } from './userTextPartContent';

describe('userTextPartContent — skill links use /skill:name', () => {
  test('pattern matches /skill:name, not bare /name', () => {
    SKILL_TOKEN_PATTERN.lastIndex = 0;
    const match = SKILL_TOKEN_PATTERN.exec('please run /skill:code-review now');
    expect(match?.[2]).toBe('code-review');
    SKILL_TOKEN_PATTERN.lastIndex = 0;
    expect(SKILL_TOKEN_PATTERN.exec('please run /code-review now')).toBeNull();
  });

  test('markdown links known skills with skill: form', () => {
    const content = prepareUserMarkdownContent({
      textContent: 'run /skill:code-review and /review',
      skillNames: new Set(['code-review']),
    });
    expect(content).toContain('[/skill:code-review]');
    expect(content).not.toContain('[/review]');
  });

  test('unknown skills stay prose', () => {
    const content = prepareUserMarkdownContent({
      textContent: 'run /skill:unknown',
      skillNames: new Set(['code-review']),
    });
    expect(content).toContain('/skill:unknown');
    expect(content).not.toContain('](');
  });
});
