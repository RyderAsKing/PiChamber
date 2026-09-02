import { describe, expect, test } from 'bun:test';

import { isNewStatusFile, isStagedStatusFile, isWorkingStatusFile } from './gitStatusPredicates';

const file = (index: string, working_dir: string) => ({ path: 'file.ts', index, working_dir });

describe('git status predicates', () => {
  test('separates staged and working changes', () => {
    expect(isStagedStatusFile(file('M', ' '))).toBe(true);
    expect(isWorkingStatusFile(file(' ', 'M'))).toBe(true);
    expect(isStagedStatusFile(file(' ', 'M'))).toBe(false);
  });

  test('treats untracked files as working and new, not staged', () => {
    const untracked = file('?', '?');
    expect(isWorkingStatusFile(untracked)).toBe(true);
    expect(isNewStatusFile(untracked)).toBe(true);
    expect(isStagedStatusFile(untracked)).toBe(false);
  });

  test('recognizes added files from either status column', () => {
    expect(isNewStatusFile(file('A', ' '))).toBe(true);
    expect(isNewStatusFile(file(' ', 'A'))).toBe(true);
    expect(isNewStatusFile(file('M', ' '))).toBe(false);
  });
});
