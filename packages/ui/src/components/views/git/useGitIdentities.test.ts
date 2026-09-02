import { describe, expect, test } from 'bun:test';
import type { GitIdentityProfile, GitIdentitySummary } from '@/lib/api/types';
import {
  deriveActiveIdentityProfile,
  deriveAvailableIdentities,
  normalizeRepoHostPath,
} from './useGitIdentities';

describe('useGitIdentities helpers', () => {
  describe('normalizeRepoHostPath', () => {
    test('normalizes ssh git URLs', () => {
      expect(normalizeRepoHostPath('git@github.com:user/repo.git')).toBe('github.com/user/repo');
    });

    test('normalizes https git URLs', () => {
      expect(normalizeRepoHostPath('https://github.com/user/repo.git')).toBe('github.com/user/repo');
    });

    test('returns null for empty or invalid URLs', () => {
      expect(normalizeRepoHostPath(null)).toBeNull();
      expect(normalizeRepoHostPath('not a valid url ://')).toBeNull();
    });
  });

  describe('deriveAvailableIdentities', () => {
    const globalId: GitIdentityProfile = {
      id: 'global-1',
      name: 'Global User',
      userName: 'globaluser',
      userEmail: 'global@example.com',
      authType: 'token',
    } as any;

    const tokenProfile: GitIdentityProfile = {
      id: 'token-1',
      name: 'GH User',
      userName: 'ghuser',
      userEmail: 'gh@example.com',
      authType: 'token',
      host: 'github.com/user/repo',
    } as any;

    const sshProfile: GitIdentityProfile = {
      id: 'ssh-1',
      name: 'SSH User',
      userName: 'sshuser',
      userEmail: 'ssh@example.com',
      authType: 'ssh',
    } as any;

    test('includes global identity and non-token profiles', () => {
      const result = deriveAvailableIdentities([sshProfile], globalId, null);
      expect(result.map((p) => p.id)).toEqual(['global-1', 'ssh-1']);
    });

    test('matches token profiles by host path', () => {
      const result = deriveAvailableIdentities([tokenProfile], null, 'https://github.com/user/repo.git');
      expect(result.map((p) => p.id)).toEqual(['token-1']);
    });
  });

  describe('deriveActiveIdentityProfile', () => {
    const profile: GitIdentityProfile = {
      id: 'prof-1',
      name: 'Dev',
      userName: 'dev',
      userEmail: 'dev@example.com',
    } as any;

    test('matches profiles by userName and userEmail', () => {
      const current: GitIdentitySummary = { userName: 'dev', userEmail: 'dev@example.com', sshCommand: null };
      expect(deriveActiveIdentityProfile(current, [profile], null)).toEqual(profile);
    });

    test('creates local-config profile when no match exists', () => {
      const current: GitIdentitySummary = { userName: 'other', userEmail: 'other@example.com', sshCommand: null };
      const active = deriveActiveIdentityProfile(current, [profile], null);
      expect(active?.id).toBe('local-config');
      expect(active?.userName).toBe('other');
    });

    test('falls back to globalIdentity when currentIdentity is empty', () => {
      const globalId: GitIdentityProfile = { id: 'global' } as any;
      expect(deriveActiveIdentityProfile(null, [profile], globalId)).toBe(globalId);
    });
  });
});
