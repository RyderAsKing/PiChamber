import { describe, expect, test } from 'bun:test';

import { getFileDiffSelection, getFileStageLabel, isPartlyStaged } from './diffSource';

const file = (index: string, working_dir: string) => ({ path: 'file.ts', index, working_dir });
const noFocus = { path: null, staged: false };

describe('getFileDiffSelection', () => {
  test('All shows everything since HEAD for every status', () => {
    for (const status of [file(' ', 'M'), file('M', ' '), file('M', 'M'), file('A', 'M'), file('?', '?')]) {
      expect(getFileDiffSelection('all', status, noFocus).source).toBe('head');
    }
  });

  test('All offers unstage only for staged-only files', () => {
    expect(getFileDiffSelection('all', file('M', ' '), noFocus).staged).toBe(true);
    expect(getFileDiffSelection('all', file('M', 'M'), noFocus).staged).toBe(false);
    expect(getFileDiffSelection('all', file(' ', 'M'), noFocus).staged).toBe(false);
  });

  test('All keeps the staged actions for a file opened from a staged entry', () => {
    const focus = { path: 'file.ts', staged: true };
    expect(getFileDiffSelection('all', file('M', 'M'), focus)).toEqual({ source: 'head', staged: true });
    expect(getFileDiffSelection('all', file('M', 'M'), { ...focus, path: 'other.ts' }).staged).toBe(false);
  });

  test('Staged and Unstaged scopes are fixed', () => {
    expect(getFileDiffSelection('staged', file('M', 'M'), noFocus)).toEqual({ source: 'staged', staged: true });
    expect(getFileDiffSelection('working', file('M', 'M'), noFocus)).toEqual({ source: 'unstaged', staged: false });
  });

  test('All names how much of a file is staged', () => {
    expect(getFileStageLabel('all', file('M', ' '))).toBe('Staged');
    expect(getFileStageLabel('all', file('M', 'M'))).toBe('Partly staged');
    expect(getFileStageLabel('all', file(' ', 'M'))).toBe('Not staged');
    expect(getFileStageLabel('all', file('?', '?'))).toBe('Not staged');
    expect(getFileStageLabel('staged', file('M', 'M'))).toBeNull();
  });
});

describe('isPartlyStaged', () => {
  test('only All with staged and unstaged edits narrows the actions', () => {
    expect(isPartlyStaged('all', file('M', 'M'))).toBe(true);
    expect(isPartlyStaged('all', file('A', 'M'))).toBe(true);
    expect(isPartlyStaged('all', file('M', ' '))).toBe(false);
    expect(isPartlyStaged('all', file(' ', 'M'))).toBe(false);
    expect(isPartlyStaged('working', file('M', 'M'))).toBe(false);
  });
});
