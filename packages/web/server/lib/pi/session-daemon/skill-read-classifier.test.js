import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { createSkillReadClassifier } from './skill-read-classifier.js';

describe('skill read classifier', () => {
  it('matches absolute and cwd-relative reads using Pi skill names', () => {
    const cwd = join('/workspace', 'project');
    const skillPath = join(cwd, '.agents', 'skills', 'directory-name', 'SKILL.md');
    const classify = createSkillReadClassifier({
      cwd,
      skills: [{ name: 'frontmatter-name', filePath: skillPath }],
      platform: 'linux',
    });

    expect(classify('read', { path: skillPath })).toEqual({ name: 'frontmatter-name' });
    expect(classify('read', { path: join('.agents', 'skills', 'directory-name', 'SKILL.md') })).toEqual({ name: 'frontmatter-name' });
  });

  it('does not infer skills from filenames or classify other tools', () => {
    const cwd = join('/workspace', 'project');
    const classify = createSkillReadClassifier({
      cwd,
      skills: [{ name: 'known', filePath: join(cwd, '.agents', 'skills', 'known', 'SKILL.md') }],
      platform: 'linux',
    });

    expect(classify('read', { path: join(cwd, 'notes', 'SKILL.md') })).toBeUndefined();
    expect(classify('write', { path: join(cwd, '.agents', 'skills', 'known', 'SKILL.md') })).toBeUndefined();
  });

  it('normalizes Windows path casing', () => {
    const classify = createSkillReadClassifier({
      cwd: 'C:\\Workspace',
      skills: [{ name: 'review', filePath: 'C:\\Workspace\\skills\\review\\SKILL.md' }],
      platform: 'win32',
    });

    expect(classify('READ', { file_path: 'c:\\workspace\\SKILLS\\review\\skill.md' })).toEqual({ name: 'review' });
  });
});
