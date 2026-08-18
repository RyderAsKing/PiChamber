import { describe, expect, test } from 'bun:test';
import {
  absolutePathToDisplayPath,
  appendBrowsePathSegment,
  canNavigateUp,
  displayPathToAbsolutePath,
  getBrowseCurrentFolderName,
  getBrowseParentPath,
  normalizeDirectoryPath,
} from './directoryExplorerPaths';

describe('directoryExplorerPaths', () => {
  test('treats home as the top of the browse tree', () => {
    expect(getBrowseParentPath('~/')).toBeNull();
    expect(canNavigateUp('~/')).toBe(false);
    expect(getBrowseCurrentFolderName('~/')).toBeNull();
  });

  test('names the current folder and returns its parent path', () => {
    expect(getBrowseParentPath('~/Projects/')).toBe('~/');
    expect(canNavigateUp('~/Projects/')).toBe(true);
    expect(getBrowseCurrentFolderName('~/Projects/')).toBe('Projects');
    expect(getBrowseParentPath('~/Projects/app/')).toBe('~/Projects/');
    expect(getBrowseCurrentFolderName('~/Projects/app/')).toBe('app');
  });

  test('does not treat a typed leaf as a navigable folder', () => {
    expect(canNavigateUp('~/Projects')).toBe(false);
    expect(getBrowseCurrentFolderName('~/Projects')).toBeNull();
  });

  test('appends browse segments onto the current directory', () => {
    expect(appendBrowsePathSegment('~/Projects/', 'app')).toBe('~/Projects/app/');
    expect(appendBrowsePathSegment('~/Projects/app', 'src')).toBe('~/Projects/src/');
  });

  test('round-trips home-relative display paths', () => {
    const home = '/Users/ryder';
    expect(displayPathToAbsolutePath('~/Projects/', home)).toBe('/Users/ryder/Projects/');
    expect(absolutePathToDisplayPath('/Users/ryder', home)).toBe('~/');
    expect(absolutePathToDisplayPath('/Users/ryder/Projects', home)).toBe('~/Projects/');
    expect(absolutePathToDisplayPath('/opt/src', home)).toBe('/opt/src/');
  });

  test('normalizes directory identity without trailing separators', () => {
    expect(normalizeDirectoryPath('/Users/Ryder/Projects/')).toBe('/users/ryder/projects');
    expect(normalizeDirectoryPath('C:\\Users\\Ryder\\Projects')).toBe('c:/users/ryder/projects');
  });
});
