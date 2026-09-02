import { describe, expect, test } from 'bun:test';

import { createTextDiffDataFromPatch, isBinaryPatch } from './diffFormatters';

describe('diffFormatters', () => {
  test('detects binary diff patch header', () => {
    expect(isBinaryPatch('Binary files a/img.png and b/img.png differ')).toBe(true);
    expect(isBinaryPatch('GIT binary patch\nliteral 0\n...')).toBe(true);
    expect(isBinaryPatch('--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-a\n+b')).toBe(false);
  });

  test('creates binary diff data for binary patches', () => {
    const data = createTextDiffDataFromPatch('img.png', 'Binary files a/img.png and b/img.png differ', 'patch');
    expect(data.isBinary).toBe(true);
    expect(data.original).toBe('');
    expect(data.modified).toBe('');
    expect(data.contextMode).toBe('patch');
  });

  test('creates text diff data for textual patches', () => {
    const patch = '--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n';
    const data = createTextDiffDataFromPatch('file.txt', patch, 'patch');
    expect(data.isBinary).toBe(undefined);
    expect(data.patch).toBe(patch);
    expect(data.contextMode).toBe('patch');
  });
});
