import { describe, expect, test } from 'bun:test';

import { splitMiddleTruncation } from './middleTruncation';
import { getProjectMark } from './projectIdentity';

describe('splitMiddleTruncation', () => {
  test('keeps a short last path segment whole', () => {
    expect(splitMiddleTruncation('pichamber/server-browser-playwright')).toEqual({
      head: 'pichamber/server-browser-',
      tail: 'playwright',
    });
    expect(splitMiddleTruncation('fix/165-subagent-session')?.tail).toBe('session');
  });

  test('starts a long tail on a word boundary', () => {
    expect(splitMiddleTruncation('feature/make-the-sidebar-cards-readable')?.tail).toBe('readable');
  });

  test('keeps a fixed tail when there is no separator nearby', () => {
    expect(splitMiddleTruncation('abcdefghijklmnopqrstuvwxyz')?.tail).toBe('qrstuvwxyz');
  });

  test('leaves short values alone', () => {
    expect(splitMiddleTruncation('main')).toBeNull();
    expect(splitMiddleTruncation('feature/x')).toBeNull();
  });

  test('never splits a surrogate pair', () => {
    const split = splitMiddleTruncation('feature/🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀');
    expect(split).not.toBeNull();
    expect(`${split?.head}${split?.tail}`).toBe('feature/🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀');
    expect(Array.from(split?.tail ?? '').every((char) => char === '🚀')).toBe(true);
  });
});

describe('getProjectMark', () => {
  test('uses the first letter or digit of the name', () => {
    expect(getProjectMark('Dotfiles').text).toBe('D');
    expect(getProjectMark('plannotator demo').text).toBe('P');
    expect(getProjectMark('.config').text).toBe('C');
    expect(getProjectMark('30-day-app').text).toBe('3');
    expect(getProjectMark('---').text).toBe('?');
  });

  test('picks a stable theme color from the name', () => {
    expect(getProjectMark('Buildora').color).toBe(getProjectMark('buildora ').color);
    expect(getProjectMark('Buildora').color.startsWith('var(--')).toBe(true);
  });
});
