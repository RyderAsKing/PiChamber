import { describe, expect, test } from 'bun:test';

import {
  buildGuardedWriteOptions,
  isRevisionUsableForSave,
  isSameFileRevision,
  isSaveScopeCurrent,
  shouldInvalidateLoadedRevision,
  toExpectedRevision,
} from './fileRevisionCache';

describe('fileRevisionCache', () => {
  test('compares revisions exact without normalization', () => {
    expect(isSameFileRevision('v1:1:2:abc', 'v1:1:2:abc')).toBe(true);
    expect(isSameFileRevision('v1:1:2:abc', 'v1:1:2:abc ')).toBe(false);
    expect(isSameFileRevision('V1:1:2:ABC', 'v1:1:2:abc')).toBe(false);
    expect(isSameFileRevision(null, null)).toBe(true);
    expect(isSameFileRevision(undefined, undefined)).toBe(true);
    expect(isSameFileRevision(null, undefined)).toBe(false);
  });

  test('defines usable revisions for guarded saves', () => {
    expect(isRevisionUsableForSave('v1:1:2:abc')).toBe(true);
    expect(isRevisionUsableForSave(null)).toBe(true);
    expect(isRevisionUsableForSave(undefined)).toBe(false);
  });

  test('invalidates on runtime, path, root, or generation races', () => {
    const cached = {
      runtimeKey: 'local',
      root: '/repo',
      path: '/repo/a.txt',
      generation: 3,
      revision: 'v1:1:2:abc',
    };
    const current = { runtimeKey: 'local', root: '/repo', path: '/repo/a.txt', generation: 3 };
    expect(shouldInvalidateLoadedRevision(cached, current)).toBe(false);
    expect(shouldInvalidateLoadedRevision(cached, { ...current, runtimeKey: 'url:https://remote' })).toBe(true);
    expect(shouldInvalidateLoadedRevision(cached, { ...current, path: '/repo/b.txt' })).toBe(true);
    expect(shouldInvalidateLoadedRevision(cached, { ...current, root: '/other' })).toBe(true);
    expect(shouldInvalidateLoadedRevision(cached, { ...current, generation: 4 })).toBe(true);
    expect(shouldInvalidateLoadedRevision(null, current)).toBe(true);
  });

  test('treats runtime switch as stale even for identical paths', () => {
    const cached = {
      runtimeKey: 'local',
      root: '/repo',
      path: '/repo/a.txt',
      generation: 1,
      revision: 'v1:1:2:abc',
    };
    expect(shouldInvalidateLoadedRevision(cached, {
      runtimeKey: 'url:https://pair',
      root: '/repo',
      path: '/repo/a.txt',
      generation: 1,
    })).toBe(true);
  });

  test('resolves wire expectedRevision values', () => {
    expect(toExpectedRevision('v1:1:2:abc')).toBe('v1:1:2:abc');
    expect(toExpectedRevision(null)).toBeNull();
    expect(toExpectedRevision(undefined)).toBeUndefined();
  });

  test('builds guarded write options for new-file, guarded, legacy, and overwrite saves', () => {
    expect(buildGuardedWriteOptions(null)).toEqual({ expectedRevision: null });
    expect(buildGuardedWriteOptions('v1:1:2:abc')).toEqual({ expectedRevision: 'v1:1:2:abc' });
    expect(buildGuardedWriteOptions(undefined)).toBeUndefined();
    expect(buildGuardedWriteOptions('v1:1:2:abc', true)).toEqual({
      expectedRevision: 'v1:1:2:abc',
      overwrite: true,
    });
    expect(buildGuardedWriteOptions(undefined, true)).toEqual({ overwrite: true });
  });

  test('requires exact runtime/root/path/generation authority for save completions', () => {
    const scope = { runtimeKey: 'local', root: '/repo', path: '/repo/a.txt', generation: 3 };
    expect(isSaveScopeCurrent(scope, { ...scope })).toBe(true);
    expect(isSaveScopeCurrent(scope, { ...scope, runtimeKey: 'url:https://remote' })).toBe(false);
    expect(isSaveScopeCurrent(scope, { ...scope, root: '/other' })).toBe(false);
    expect(isSaveScopeCurrent(scope, { ...scope, path: '/repo/b.txt' })).toBe(false);
    expect(isSaveScopeCurrent(scope, { ...scope, generation: 4 })).toBe(false);
    expect(isSaveScopeCurrent(scope, null)).toBe(false);
    expect(isSaveScopeCurrent(null, scope)).toBe(false);
    expect(isSaveScopeCurrent(undefined, undefined)).toBe(false);
  });
});
