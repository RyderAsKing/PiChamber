import { describe, expect, test } from 'bun:test';
import {
  deriveDefaultBranch,
  deriveEffectiveRemotes,
  deriveLocalBranches,
  deriveRemoteBranches,
  deriveUpdateTargetBranch,
} from './useGitBranchScope';

describe('useGitBranchScope helpers', () => {
  describe('deriveLocalBranches', () => {
    test('filters out remotes/ branches and sorts', () => {
      const branches = ['remotes/origin/main', 'feat-b', 'feat-a', 'remotes/upstream/dev'];
      expect(deriveLocalBranches(branches)).toEqual(['feat-a', 'feat-b']);
    });

    test('handles undefined input', () => {
      expect(deriveLocalBranches(undefined)).toEqual([]);
    });
  });

  describe('deriveRemoteBranches', () => {
    test('filters remotes/ branches, removes prefix, and sorts', () => {
      const branches = ['remotes/origin/main', 'feat-b', 'remotes/origin/dev'];
      expect(deriveRemoteBranches(branches)).toEqual(['origin/dev', 'origin/main']);
    });

    test('handles undefined input', () => {
      expect(deriveRemoteBranches(undefined)).toEqual([]);
    });
  });

  describe('deriveEffectiveRemotes', () => {
    test('returns remotes if non-empty', () => {
      const remotes = [{ name: 'custom', fetchUrl: '', pushUrl: '' }];
      expect(deriveEffectiveRemotes(remotes, ['origin/main'], undefined, null)).toEqual(remotes);
    });

    test('infers from tracking branch', () => {
      expect(deriveEffectiveRemotes([], [], 'upstream/main', 'https://example.com/repo.git')).toEqual([
        { name: 'upstream', fetchUrl: 'https://example.com/repo.git', pushUrl: 'https://example.com/repo.git' },
      ]);
    });

    test('falls back to origin if remoteUrl is provided', () => {
      expect(deriveEffectiveRemotes([], [], undefined, 'https://example.com/repo.git')).toEqual([
        { name: 'origin', fetchUrl: 'https://example.com/repo.git', pushUrl: 'https://example.com/repo.git' },
      ]);
    });
  });

  describe('deriveDefaultBranch', () => {
    test('uses tracking remote default if present', () => {
      const defaults = { origin: 'main', upstream: 'dev' };
      expect(deriveDefaultBranch(defaults, 'upstream/feat')).toBe('dev');
    });

    test('falls back to origin default', () => {
      const defaults = { origin: 'main' };
      expect(deriveDefaultBranch(defaults, undefined)).toBe('main');
    });
  });

  describe('deriveUpdateTargetBranch', () => {
    test('finds remote branch matching baseBranch', () => {
      const remotes = [{ name: 'origin', fetchUrl: '', pushUrl: '' }];
      const remoteBranches = ['origin/main', 'origin/dev'];
      expect(deriveUpdateTargetBranch(remotes, remoteBranches, 'main')).toBe('origin/main');
    });

    test('falls back to baseBranch if no matching remote candidate', () => {
      const remotes = [{ name: 'origin', fetchUrl: '', pushUrl: '' }];
      const remoteBranches = ['origin/dev'];
      expect(deriveUpdateTargetBranch(remotes, remoteBranches, 'main')).toBe('main');
    });

    test('returns null if baseBranch is null', () => {
      expect(deriveUpdateTargetBranch([], [], null)).toBeNull();
    });
  });
});
