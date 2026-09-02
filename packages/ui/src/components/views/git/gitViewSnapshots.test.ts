import { beforeEach, describe, expect, test } from 'bun:test';

import {
  clearGitViewSnapshots,
  getGitViewSnapshot,
  GIT_VIEW_SNAPSHOTS_CAP,
  rememberGitViewSnapshot,
} from './gitViewSnapshots';

describe('gitViewSnapshots LRU', () => {
  beforeEach(() => {
    clearGitViewSnapshots();
  });

  test('stores and retrieves snapshot for directory', () => {
    expect(getGitViewSnapshot('/repo')).toBeNull();
    rememberGitViewSnapshot('/repo', { commitMessage: 'fix: something' });
    expect(getGitViewSnapshot('/repo')).toEqual({ commitMessage: 'fix: something' });
  });

  test('promotes accessed/re-written key so oldest evicts on cap', () => {
    for (let i = 0; i <= GIT_VIEW_SNAPSHOTS_CAP; i++) {
      rememberGitViewSnapshot(`/repo-${i}`, { commitMessage: `commit-${i}` });
    }
    // repo-0 was evicted because cap was exceeded by 1
    expect(getGitViewSnapshot('/repo-0')).toBeNull();
    expect(getGitViewSnapshot('/repo-1')).not.toBeNull();
    expect(getGitViewSnapshot(`/repo-${GIT_VIEW_SNAPSHOTS_CAP}`)).not.toBeNull();
  });

  test('re-writing a key promotes it in insertion order', () => {
    rememberGitViewSnapshot('/repo-0', { commitMessage: 'commit-0' });
    for (let i = 1; i < GIT_VIEW_SNAPSHOTS_CAP; i++) {
      rememberGitViewSnapshot(`/repo-${i}`, { commitMessage: `commit-${i}` });
    }
    // Re-insert /repo-0 to promote it
    rememberGitViewSnapshot('/repo-0', { commitMessage: 'commit-0-updated' });
    // Insert one more
    rememberGitViewSnapshot('/repo-extra', { commitMessage: 'extra' });
    // /repo-1 is now the oldest and should be evicted, /repo-0 should still be present
    expect(getGitViewSnapshot('/repo-1')).toBeNull();
    expect(getGitViewSnapshot('/repo-0')).toEqual({ commitMessage: 'commit-0-updated' });
  });
});
