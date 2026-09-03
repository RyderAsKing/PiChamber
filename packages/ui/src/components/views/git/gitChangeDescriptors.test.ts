import { describe, expect, test } from 'bun:test';

import { describeGitChange } from './gitChangeDescriptors';
import type { GitStatusFile } from './gitStatusPredicates';

const file = (index: string = ' ', working_dir: string = ' '): GitStatusFile => ({
  path: 'file.ts',
  index,
  working_dir,
});

describe('git change descriptors', () => {
  test('describes untracked files accurately', () => {
    const descriptor = describeGitChange(file('?', '?'));
    expect(descriptor.code).toBe('?');
    expect(descriptor.description).toBe('Untracked file');
    expect(descriptor.color).toBe('var(--status-info)');
  });

  test('describes added, deleted, renamed, and copied files', () => {
    expect(describeGitChange(file('A', ' ')).description).toBe('New file');
    expect(describeGitChange(file('D', ' ')).description).toBe('Deleted file');
    expect(describeGitChange(file('R', ' ')).description).toBe('Renamed file');
    expect(describeGitChange(file('C', ' ')).description).toBe('Copied file');
  });

  test('prioritizes staged index over working tree when not untracked', () => {
    const mixed = describeGitChange(file('M', 'D'));
    expect(mixed.code).toBe('M');
  });

  test('falls back to working tree or modified for unknown symbols', () => {
    expect(describeGitChange(file(' ', 'M')).code).toBe('M');
    expect(describeGitChange(file('X', ' ')).code).toBe('M');
  });
});
