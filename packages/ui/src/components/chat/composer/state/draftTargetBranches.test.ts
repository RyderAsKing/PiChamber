import { describe, expect, test } from 'bun:test';

import {
    buildLocalDraftBranchOptions,
    shouldRefreshDraftBranchesOnDraftEntry,
} from './draftTargetBranches';

describe('draft target branches', () => {
    test('does not refresh branch lists for existing sessions', () => {
        expect(shouldRefreshDraftBranchesOnDraftEntry({
            enabled: true,
            draftOpen: false,
            directory: '/repo',
            gitAvailable: true,
            isGitRepository: true,
            hasCachedBranches: true,
        })).toBe(false);
    });

    test('refreshes branches for an enabled Git draft with a runtime and directory', () => {
        expect(shouldRefreshDraftBranchesOnDraftEntry({
            enabled: true,
            draftOpen: true,
            directory: '/repo',
            gitAvailable: true,
            isGitRepository: true,
            hasCachedBranches: false,
        })).toBe(true);
        expect(shouldRefreshDraftBranchesOnDraftEntry({
            enabled: true,
            draftOpen: true,
            directory: null,
            gitAvailable: true,
            isGitRepository: true,
            hasCachedBranches: false,
        })).toBe(false);
    });

    test('refreshes a new draft even when its cached branch list is fresh', () => {
        expect(shouldRefreshDraftBranchesOnDraftEntry({
            enabled: true,
            draftOpen: true,
            directory: '/repo',
            gitAvailable: true,
            isGitRepository: true,
            hasCachedBranches: true,
        })).toBe(true);
    });

    test('lists sorted local branches without turning remote refs into detached targets', () => {
        expect(buildLocalDraftBranchOptions([
            'feature/z',
            'remotes/origin/feature/a',
            'main',
            'feature/a',
        ], null)).toEqual([
            { value: 'feature/a', label: 'feature/a' },
            { value: 'feature/z', label: 'feature/z' },
            { value: 'main', label: 'main' },
        ]);
    });

    test('keeps an explicitly selected stale branch visible until send preflight reports it', () => {
        expect(buildLocalDraftBranchOptions(['main'], 'deleted-branch')).toEqual([
            { value: 'main', label: 'main' },
            { value: 'deleted-branch', label: 'deleted-branch' },
        ]);
    });
});
