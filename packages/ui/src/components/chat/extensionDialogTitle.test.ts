import { describe, expect, test } from 'bun:test';
import { firstPlainLine, splitDialogTitle } from './extensionDialogTitle';

describe('splitDialogTitle', () => {
  test('a one-line title is the question, with no label', () => {
    expect(splitDialogTitle('Choose a mode')).toEqual({ label: null, text: 'Choose a mode' });
  });

  test('a multi-line title splits into its first line and the rest', () => {
    const title = 'Permission Required\nagent   : build\ncommand : git log --oneline';
    expect(splitDialogTitle(title)).toEqual({
      label: 'Permission Required',
      text: 'agent   : build\ncommand : git log --oneline',
    });
  });

  test('blank edge lines are dropped, inner spacing kept', () => {
    const title = '\n\x1b[1mPermission Required\x1b[0m\r\n\r\n  rm -rf build\n\n  and more\n\x1b[0m\n';
    expect(splitDialogTitle(title)).toEqual({
      label: '\x1b[1mPermission Required\x1b[0m',
      text: '  rm -rf build\n\n  and more',
    });
  });

  test('an empty title gives empty text', () => {
    expect(splitDialogTitle('')).toEqual({ label: null, text: '' });
    expect(splitDialogTitle('\n  \n')).toEqual({ label: null, text: '' });
  });
});

describe('firstPlainLine', () => {
  test('returns the first non-blank line without ANSI codes', () => {
    expect(firstPlainLine('\n\x1b[33m  git log\x1b[0m\nsecond')).toBe('git log');
  });
});
