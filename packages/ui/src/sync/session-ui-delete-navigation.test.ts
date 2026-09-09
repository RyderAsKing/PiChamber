import { afterEach, describe, expect, test } from 'bun:test';

import { getPiSessionStore } from '@/apps/pi-session-store';
import { useSessionUIStore } from './session-ui-store';

const piStore = getPiSessionStore();
const originalRemove = piStore.remove;

const resetUi = () => {
  useSessionUIStore.setState({
    currentSessionId: null,
    currentSessionDirectory: null,
    newSessionDraft: {
      id: null,
      open: false,
      selectedProjectId: null,
      directoryOverride: null,
      branchIntent: null,
      worktreeIntent: null,
      preserveDirectoryOverride: false,
      parentID: null,
      title: undefined,
      initialPrompt: undefined,
      syntheticParts: undefined,
      targetFolderId: undefined,
    },
  });
};

afterEach(() => {
  piStore.remove = originalRemove;
  resetUi();
});

describe('delete navigates away from the visible session', () => {
  test('deleteSession opens a new draft when the current session is deleted', async () => {
    piStore.remove = (async () => undefined) as typeof piStore.remove;
    useSessionUIStore.setState({ currentSessionId: 'sess-current', currentSessionDirectory: '/workspace' });

    const result = await useSessionUIStore.getState().deleteSession('sess-current');

    expect(result).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
  });

  test('deleteSession keeps the current session when another session is deleted', async () => {
    piStore.remove = (async () => undefined) as typeof piStore.remove;
    useSessionUIStore.setState({ currentSessionId: 'sess-other', currentSessionDirectory: '/workspace' });

    const result = await useSessionUIStore.getState().deleteSession('sess-current');

    expect(result).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('sess-other');
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false);
  });

  test('deleteSession does not navigate when the delete fails', async () => {
    piStore.remove = (async () => {
      throw new Error('delete failed');
    }) as typeof piStore.remove;
    useSessionUIStore.setState({ currentSessionId: 'sess-current', currentSessionDirectory: '/workspace' });

    await expect(useSessionUIStore.getState().deleteSession('sess-current')).rejects.toThrow('delete failed');
    expect(useSessionUIStore.getState().currentSessionId).toBe('sess-current');
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false);
  });

  test('deleteSession does not steal a session selected during the delete RPC', async () => {
    piStore.remove = (async () => {
      useSessionUIStore.setState({ currentSessionId: 'sess-new', currentSessionDirectory: '/workspace' });
    }) as typeof piStore.remove;
    useSessionUIStore.setState({ currentSessionId: 'sess-current', currentSessionDirectory: '/workspace' });

    const result = await useSessionUIStore.getState().deleteSession('sess-current');

    expect(result).toBe(true);
    expect(useSessionUIStore.getState().currentSessionId).toBe('sess-new');
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false);
  });

  test('deleteSessions opens a new draft when the current session is among the deleted ids', async () => {
    piStore.remove = (async () => undefined) as typeof piStore.remove;
    useSessionUIStore.setState({ currentSessionId: 'sess-a', currentSessionDirectory: '/workspace' });

    const result = await useSessionUIStore.getState().deleteSessions(['sess-a', 'sess-b']);

    expect(result.deletedIds).toEqual(['sess-a', 'sess-b']);
    expect(useSessionUIStore.getState().currentSessionId).toBeNull();
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true);
  });

  test('deleteSessions keeps the current session when it was not deleted', async () => {
    piStore.remove = (async (id: string) => {
      if (id === 'sess-current') throw new Error('delete failed');
    }) as typeof piStore.remove;
    useSessionUIStore.setState({ currentSessionId: 'sess-current', currentSessionDirectory: '/workspace' });

    const result = await useSessionUIStore.getState().deleteSessions(['sess-current', 'sess-b']);

    expect(result.deletedIds).toEqual(['sess-b']);
    expect(result.failedIds).toEqual(['sess-current']);
    expect(useSessionUIStore.getState().currentSessionId).toBe('sess-current');
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false);
  });
});
