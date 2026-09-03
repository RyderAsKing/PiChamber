import { describe, expect, test } from 'bun:test';

import {
  buildSkillMentionInstruction,
  collectInlineSkillMentions,
} from '../buildOutgoingMessage';

describe('collectInlineSkillMentions — native /skill:name only', () => {
  test('collects /skill:name, not bare /name', () => {
    const skills = new Set(['code-review']);
    expect(collectInlineSkillMentions('please run /skill:code-review now', skills)).toEqual([
      'code-review',
    ]);
    expect(collectInlineSkillMentions('please run /code-review now', skills)).toEqual([]);
  });

  test('dashes and underscores work', () => {
    const skills = new Set(['code-review', 'my_skill']);
    expect(collectInlineSkillMentions('/skill:code-review', skills)).toEqual(['code-review']);
    expect(collectInlineSkillMentions('/skill:my_skill', skills)).toEqual(['my_skill']);
  });

  test('unknown skills remain unresolved (no hint)', () => {
    expect(collectInlineSkillMentions('/skill:unknown', new Set(['code-review']))).toEqual([]);
  });

  test('instruction uses /skill:name form', () => {
    expect(buildSkillMentionInstruction(['code-review'])).toContain('/skill:code-review');
    expect(buildSkillMentionInstruction([])).toBeNull();
  });
});
