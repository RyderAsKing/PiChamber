import { describe, expect, test } from 'bun:test';

import { didFileStatChange } from './useFileStatReconciliation';

describe('didFileStatChange', () => {
  test('detects size and authoritative mtime changes', () => {
    expect(didFileStatChange(
      { path: '/tmp/file', size: 2, mtimeMs: 10 },
      { path: '/tmp/file', size: 3, mtimeMs: 10 },
    )).toBe(true);
    expect(didFileStatChange(
      { path: '/tmp/file', size: 2, mtimeMs: 10 },
      { path: '/tmp/file', size: 2, mtimeMs: 11 },
    )).toBe(true);
  });

  test('treats opaque revision mismatch as an external change', () => {
    expect(didFileStatChange(
      { path: '/tmp/file', size: 2, mtimeMs: 10, revision: 'v1:2:10:aaa' },
      { path: '/tmp/file', size: 2, mtimeMs: 10, revision: 'v1:2:10:bbb' },
    )).toBe(true);
    expect(didFileStatChange(
      { path: '/tmp/file', size: 2, mtimeMs: 10, revision: 'v1:2:10:aaa' },
      { path: '/tmp/file', size: 2, mtimeMs: 10, revision: 'v1:2:10:aaa' },
    )).toBe(false);
  });

  test('falls back to size/mtime when either side omits a revision', () => {
    expect(didFileStatChange(
      { path: '/tmp/file', size: 2, mtimeMs: 10 },
      { path: '/tmp/file', size: 2, mtimeMs: 10, revision: 'v1:2:10:bbb' },
    )).toBe(false);
    expect(didFileStatChange(
      { path: '/tmp/file', size: 2, mtimeMs: 10, revision: 'v1:2:10:aaa' },
      { path: '/tmp/file', size: 3, mtimeMs: 10 },
    )).toBe(true);
  });

  test('does not infer an mtime change when either snapshot omits it', () => {
    expect(didFileStatChange(
      { path: '/tmp/file', size: 2, mtimeMs: 10 },
      { path: '/tmp/file', size: 2 },
    )).toBe(false);
    expect(didFileStatChange(
      { path: '/tmp/file', size: 2 },
      { path: '/tmp/file', size: 2, mtimeMs: 11 },
    )).toBe(false);
  });
});
