import { beforeEach, describe, expect, mock, test } from 'bun:test';

type ToastCall = { kind: 'success' | 'error'; message: string; undo?: () => void };
const toasts: ToastCall[] = [];
mock.module('@/components/ui', () => ({
  toast: {
    success: (message: string, options?: { action?: { onClick: () => void } }) => {
      toasts.push({ kind: 'success', message, undo: options?.action?.onClick });
    },
    error: (message: string) => {
      toasts.push({ kind: 'error', message });
    },
  },
}));

const archived = new Set<string>();
let failArchive = new Set<string>();
let failUnarchive = false;
const calls: string[] = [];
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      archiveSessions: async (ids: string[]) => {
        calls.push(`archive:${ids.join(',')}`);
        const archivedIds = ids.filter((id) => !failArchive.has(id));
        archivedIds.forEach((id) => archived.add(id));
        return { archivedIds, failedIds: ids.filter((id) => failArchive.has(id)) };
      },
      unarchiveSessions: async (ids: string[]) => {
        calls.push(`unarchive:${ids.join(',')}`);
        if (failUnarchive) return { restoredIds: [], failedIds: ids };
        ids.forEach((id) => archived.delete(id));
        return { restoredIds: ids, failedIds: [] };
      },
    }),
  },
}));

const { useSessionPinnedStore, isSessionPinned } = await import('@/stores/useSessionPinnedStore');
const { archiveSessionsWithUndo } = await import('./sessionArchive');

const pinned = (sessionId: string) => isSessionPinned(useSessionPinnedStore.getState().ids, '/repo', sessionId);

describe('archiveSessionsWithUndo', () => {
  beforeEach(() => {
    toasts.length = 0;
    calls.length = 0;
    archived.clear();
    failArchive = new Set();
    failUnarchive = false;
    useSessionPinnedStore.setState({ ids: new Set(), touchedAt: {} });
  });

  test('archives a session with its forks, unpins it, and names it in a toast', async () => {
    useSessionPinnedStore.getState().toggle({ directory: '/repo', sessionId: 'a' });
    expect(pinned('a')).toBe(true);

    await archiveSessionsWithUndo([{ sessionId: 'a', directory: '/repo', forkIds: ['a-fork'] }], { title: 'Fix login' });

    expect(pinned('a')).toBe(false);
    expect([...archived].sort()).toEqual(['a', 'a-fork']);
    expect(toasts.map(({ kind, message }) => ({ kind, message }))).toEqual([
      { kind: 'success', message: 'Archived “Fix login”' },
    ]);
  });

  test('Undo unarchives the same set and restores the pin', async () => {
    useSessionPinnedStore.getState().toggle({ directory: '/repo', sessionId: 'a' });
    await archiveSessionsWithUndo([{ sessionId: 'a', directory: '/repo', forkIds: ['a-fork'] }], { title: 'Fix login' });

    toasts[0]!.undo!();
    await Promise.resolve();
    await Promise.resolve();

    expect(archived.size).toBe(0);
    expect(calls.at(-1)).toBe('unarchive:a,a-fork');
    expect(pinned('a')).toBe(true);
  });

  test('a failed archive restores the pin and reports an error instead of Undo', async () => {
    useSessionPinnedStore.getState().toggle({ directory: '/repo', sessionId: 'a' });
    failArchive = new Set(['a']);

    await archiveSessionsWithUndo([{ sessionId: 'a', directory: '/repo', forkIds: [] }], { title: 'Fix login' });

    expect(pinned('a')).toBe(true);
    expect(toasts).toEqual([{ kind: 'error', message: 'Could not archive the session' }]);
  });

  test('a failed Undo says so', async () => {
    await archiveSessionsWithUndo([{ sessionId: 'a', directory: '/repo', forkIds: [] }], { title: 'Fix login' });
    failUnarchive = true;
    toasts[0]!.undo!();
    await Promise.resolve();
    await Promise.resolve();
    expect(toasts.at(-1)).toEqual({ kind: 'error', message: 'Could not unarchive the session' });
  });

  test('bulk archive shows one toast with the count, and Undo restores every session', async () => {
    useSessionPinnedStore.getState().toggle({ directory: '/repo', sessionId: 'b' });
    await archiveSessionsWithUndo([
      { sessionId: 'a', directory: '/repo', forkIds: [] },
      { sessionId: 'b', directory: '/repo', forkIds: [] },
      { sessionId: 'c', directory: '/repo', forkIds: [] },
    ]);
    expect(toasts.map((toast) => toast.message)).toEqual(['Archived 3 sessions']);
    expect(pinned('b')).toBe(false);

    toasts[0]!.undo!();
    await Promise.resolve();
    await Promise.resolve();
    expect(archived.size).toBe(0);
    expect(pinned('b')).toBe(true);
  });

  test('a partial bulk failure counts only what archived and keeps the failed pin', async () => {
    useSessionPinnedStore.getState().toggle({ directory: '/repo', sessionId: 'b' });
    failArchive = new Set(['b']);
    await archiveSessionsWithUndo([
      { sessionId: 'a', directory: '/repo', forkIds: [] },
      { sessionId: 'b', directory: '/repo', forkIds: [] },
    ]);
    expect(toasts.map(({ kind, message }) => ({ kind, message }))).toEqual([
      { kind: 'success', message: 'Archived 1 session' },
      { kind: 'error', message: 'Could not archive 1 session' },
    ]);
    expect(pinned('b')).toBe(true);
  });
});
