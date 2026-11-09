import { describe, expect, test } from 'bun:test';

import { childDisplayPath, folderNameProblem, repositoryFolderName } from './addFolderNames';

describe('repositoryFolderName', () => {
  test('reads the folder from HTTPS and SSH URLs, with or without .git', () => {
    expect(repositoryFolderName('https://github.com/acme/web.git')).toBe('web');
    expect(repositoryFolderName('https://github.com/acme/web')).toBe('web');
    expect(repositoryFolderName('git@github.com:acme/api.git')).toBe('api');
    expect(repositoryFolderName('ssh://git@host:2222/team/tools/')).toBe('tools');
  });

  test('ignores a query or fragment', () => {
    expect(repositoryFolderName('https://host/acme/web.git?ref=main#readme')).toBe('web');
  });

  test('is empty when there is no URL', () => {
    expect(repositoryFolderName('   ')).toBe('');
  });
});

describe('folderNameProblem', () => {
  test('accepts an ordinary name', () => {
    expect(folderNameProblem('my-project')).toBeNull();
  });

  test('rejects empty names, separators, and dot names', () => {
    expect(folderNameProblem('  ')).not.toBeNull();
    expect(folderNameProblem('a/b')).not.toBeNull();
    expect(folderNameProblem('a\\b')).not.toBeNull();
    expect(folderNameProblem('..')).not.toBeNull();
  });
});

describe('childDisplayPath', () => {
  test('joins a location and a name with one slash', () => {
    expect(childDisplayPath('~/code/', 'app')).toBe('~/code/app');
    expect(childDisplayPath('/srv', 'app')).toBe('/srv/app');
  });
});
