import { describe, expect, test } from 'bun:test';

import {
    buildDraftBranchProjectDirectories,
    hasNewActiveSessions,
    type DraftBranchActiveSession,
} from './draftBranchActiveSessions';

const session = (id: string): DraftBranchActiveSession => ({
    id,
    title: id,
    directory: '/workspace/project',
});

describe('draft branch active sessions', () => {
    test('scopes the warning to the selected project root and its worktrees', () => {
        expect(buildDraftBranchProjectDirectories({
            targetDirectory: '/workspace/project-worktree/',
            projectId: 'project',
            projects: [
                { id: 'project', path: '/workspace/project' },
                { id: 'other', path: '/workspace/other' },
            ],
            availableWorktreesByProject: new Map([
                ['/workspace/project', [{ path: '/workspace/project-worktree' }]],
                ['/workspace/other', [{ path: '/workspace/other-worktree' }]],
            ]),
        })).toEqual(new Set([
            '/workspace/project-worktree',
            '/workspace/project',
        ]));
    });

    test('falls back to the most specific owning project when no project id is available', () => {
        expect(buildDraftBranchProjectDirectories({
            targetDirectory: '/workspace/parent/nested',
            projects: [
                { id: 'parent', path: '/workspace/parent' },
                { id: 'nested', path: '/workspace/parent/nested' },
            ],
            availableWorktreesByProject: new Map([
                ['/workspace/parent/nested', [{ path: '/workspace/nested-worktree' }]],
            ]),
        })).toEqual(new Set([
            '/workspace/parent/nested',
            '/workspace/nested-worktree',
        ]));
    });

    test('requires another review only when a new working session appears', () => {
        expect(hasNewActiveSessions([session('one')], [session('one')])).toBe(false);
        expect(hasNewActiveSessions([session('one')], [])).toBe(false);
        expect(hasNewActiveSessions([session('one')], [session('one'), session('two')])).toBe(true);
    });
});
