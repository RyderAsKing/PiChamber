import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ProjectEntry } from '@/lib/api/types';

// The sidebar space (folder) selection must follow Ctrl+Shift+F. These tests
// drive the real cycle action and assert the selection store — the same store
// the spaces rail reads — moves with the new active project.
const setCurrentSessionCalls: Array<{ id: string | null; directory: string | null }> = [];
const openNewSessionDraftCalls: Array<unknown> = [];
const closeMainSurfacesCalls: number[] = [];

mock.module('@/sync/sync-refs', () => ({
  getSyncSessions: () => [
    { id: 'session-b', directory: '/repo-b' },
  ],
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      setCurrentSession: (id: string | null, directory: string | null) => {
        setCurrentSessionCalls.push({ id, directory });
      },
      openNewSessionDraft: (options: unknown) => {
        openNewSessionDraftCalls.push(options);
      },
    }),
  },
}));

mock.module('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      closeMainSurfaces: () => {
        closeMainSurfacesCalls.push(1);
      },
    }),
  },
}));

const { cycleSessionFolder } = await import('./folderCycle');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useSidebarSpaceStore } = await import('@/stores/useSidebarSpaceStore');

const projectA = {
  id: 'project-a',
  path: '/repo-a',
  label: 'Repo A',
  lastOpenedAt: 100,
} as ProjectEntry;
const projectB = {
  id: 'project-b',
  path: '/repo-b',
  label: 'Repo B',
  lastOpenedAt: 200,
} as ProjectEntry;

beforeEach(() => {
  setCurrentSessionCalls.length = 0;
  openNewSessionDraftCalls.length = 0;
  closeMainSurfacesCalls.length = 0;
  useProjectsStore.setState({
    projects: [projectA, projectB],
    activeProjectId: projectA.id,
    manualProjectOrder: [projectA.id, projectB.id],
  });
  useSidebarSpaceStore.setState({
    selectedSpaceId: projectA.id,
    selectedWorktreePath: '/repo-a/wt-1',
  });
});

describe('cycleSessionFolder sidebar selection', () => {
  test('moves the sidebar space selection to the cycled folder', () => {
    expect(cycleSessionFolder()).toBe(true);

    expect(useProjectsStore.getState().activeProjectId).toBe(projectB.id);
    expect(setCurrentSessionCalls).toEqual([{ id: 'session-b', directory: '/repo-b' }]);
    // The spaces rail reads this store: it must show the folder we cycled to,
    // and drop the previous folder's worktree pin.
    expect(useSidebarSpaceStore.getState().selectedSpaceId).toBe(projectB.id);
    expect(useSidebarSpaceStore.getState().selectedWorktreePath).toBeNull();
  });

  test('leaves the space selection alone when there is nothing to cycle', () => {
    useProjectsStore.setState({
      projects: [projectA],
      activeProjectId: projectA.id,
      manualProjectOrder: [projectA.id],
    });

    expect(cycleSessionFolder()).toBe(false);

    expect(useSidebarSpaceStore.getState().selectedSpaceId).toBe(projectA.id);
    expect(useSidebarSpaceStore.getState().selectedWorktreePath).toBe('/repo-a/wt-1');
  });
});
