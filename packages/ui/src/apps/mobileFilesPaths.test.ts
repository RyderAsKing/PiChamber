import { describe, expect, test } from 'bun:test';

import {
  canNavigateToParent,
  getNameFromPath,
  getParentDirectory,
  normalizeMobileFilesPath,
  resolveChildPath,
} from './mobileFilesPaths';

describe('mobileFilesPaths', () => {
  test('strips trailing slashes and backslashes', () => {
    expect(normalizeMobileFilesPath('C:\\work\\app\\')).toBe('C:/work/app');
    expect(normalizeMobileFilesPath('/home/proj/')).toBe('/home/proj');
  });

  test('resolves a parent inside the project root', () => {
    expect(getParentDirectory('/home/proj/src/lib')).toBe('/home/proj/src');
    expect(canNavigateToParent('/home/proj/src', '/home/proj')).toBe(true);
    expect(canNavigateToParent('/home/proj', '/home/proj')).toBe(false);
  });

  test('does not step above the project root', () => {
    expect(canNavigateToParent('/home/proj', '/home/proj')).toBe(false);
    expect(getParentDirectory('/home/proj')).toBe('/home');
  });

  test('joins relative child paths onto the current directory', () => {
    expect(resolveChildPath('src', '/home/proj')).toBe('/home/proj/src');
    expect(resolveChildPath('/home/proj/src', '/home/proj')).toBe('/home/proj/src');
  });

  test('names the current folder from its path', () => {
    expect(getNameFromPath('/home/proj/src')).toBe('src');
    expect(getNameFromPath('/')).toBe('/');
  });
});
