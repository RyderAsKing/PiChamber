import { describe, expect, test } from 'bun:test';

import type { ToolPart } from '@/lib/chat/types';
import { getToolSkillName } from './skillToolPresentation';

const toolPart = (tool: string, state: ToolPart['state']): ToolPart => ({
  id: 'tool-1',
  type: 'tool',
  tool,
  state,
});

describe('skill tool presentation', () => {
  test('reads authoritative skill metadata from Pi read calls', () => {
    expect(getToolSkillName(toolPart('read', {
      input: { path: '/skills/directory-name/SKILL.md' },
      metadata: { pichamber: { skill: { name: 'frontmatter-name' } } },
    }))).toBe('frontmatter-name');
  });

  test('keeps ordinary SKILL.md reads as file reads without daemon metadata', () => {
    expect(getToolSkillName(toolPart('read', {
      input: { path: '/notes/SKILL.md' },
    }))).toBeNull();
  });

  test('supports the legacy explicit skill tool', () => {
    expect(getToolSkillName(toolPart('skill', { input: { name: 'code-review' } }))).toBe('code-review');
  });

  test('rejects malformed renderer metadata', () => {
    expect(getToolSkillName(toolPart('read', { metadata: { pichamber: { skill: { name: '   ' } } } }))).toBeNull();
    expect(getToolSkillName(toolPart('bash', { metadata: { pichamber: { skill: { name: 'code-review' } } } }))).toBeNull();
  });
});
