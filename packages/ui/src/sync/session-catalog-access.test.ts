import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { getPiSessionStore } from '@/apps/pi-session-store';
import { piClient, PiRequestError } from '@/lib/pi/client';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { __resetDirectoryRefreshSchedulerForTests } from '@/sync/pi-session-catalog';
import {
  loadSessionCatalog,
  type SessionCatalogLoadResult,
} from '@/sync/session-catalog-access';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useWorktreeStore } from '@/stores/useWorktreeStore';

const listItem = (id: string, directory: string, overrides?: { updatedAt?: number; title?: string }) => ({
  session: {
    id,
    directory,
    title: overrides?.title ?? id,
    createdAt: 1,
    updatedAt: overrides?.updatedAt ?? 1,
    parentId: null,
  },
  updatedAt: overrides?.updatedAt ?? 1,
});

type ListStub = (scope: { directory?: string }) => Promise<{ sessions: ReturnType<typeof listItem>[] }>;

const stubListSessions = (impl: ListStub) => {
  const original = piClient.listSessions.bind(piClient);
  piClient.listSessions = (async (scope: { directory?: string }) => impl(scope)) as typeof piClient.listSessions;
  return () => {
    piClient.listSessions = original;
  };
};

const setSingletonDirectory = (directory: string | null): void => {
  const store = getPiSessionStore();
  const state = store.getState() as unknown as { directory: string | null };
  state.directory = directory;
};

const resetWorkspaceStores = (): void => {
  useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [] });
  useWorktreeStore.setState({ projects: new Map() });
};

beforeEach(() => {
  __resetDirectoryRefreshSchedulerForTests();
  resetWorkspaceStores();
  getPiSessionStore().clear();
  setSingletonDirectory(null);
});

afterEach(() => {
  __resetDirectoryRefreshSchedulerForTests();
  resetWorkspaceStores();
  getPiSessionStore().clear();
  setSingletonDirectory(null);
});

describe('loadSessionCatalog', () => {
  test('partial failure keeps ready rows but reports incomplete', async () => {
    const restore = stubListSessions(async (scope) => {
      if (scope.directory === '/proj-b') {
        throw new PiRequestError('DAEMON_UNAVAILABLE', 'boom');
      }
      return { sessions: [listItem('a-1', '/proj-a')] };
    });
    try {
      const result: SessionCatalogLoadResult = await loadSessionCatalog(['/proj-a', '/proj-b']);
      expect(result.stale).toBe(false);
      expect(result.complete).toBe(false);
      expect([...result.readyDirectories].sort()).toEqual(['/proj-a']);
      expect([...result.failedDirectories].sort()).toEqual(['/proj-b']);
      expect(result.catalog.byId.has('a-1')).toBe(true);
      expect(result.catalog.listStatusByDirectory.get('/proj-a')).toBe('ready');
      expect(result.catalog.listStatusByDirectory.get('/proj-b')).toBe('failed');
    } finally {
      restore();
    }
  });

  test('ready empty directory is complete with no rows', async () => {
    const restore = stubListSessions(async () => ({ sessions: [] }));
    try {
      const result = await loadSessionCatalog(['/empty']);
      expect(result.stale).toBe(false);
      expect(result.complete).toBe(true);
      expect([...result.readyDirectories]).toEqual(['/empty']);
      expect([...result.failedDirectories]).toEqual([]);
      expect(result.catalog.listStatusByDirectory.get('/empty')).toBe('ready');
      expect(result.catalog.byDirectory.get('/empty') ?? []).toEqual([]);
    } finally {
      restore();
    }
  });

  test('warm idle status is refreshed, never treated as complete without RPC', async () => {
    let calls = 0;
    const restore = stubListSessions(async (scope) => {
      calls += 1;
      return { sessions: [listItem('w-1', scope.directory ?? '/warm')] };
    });
    try {
      const first = await loadSessionCatalog(['/warm']);
      expect(calls).toBe(1);
      expect(first.complete).toBe(true);

      // A second demand for the same ready scope skips the RPC.
      const second = await loadSessionCatalog(['/warm']);
      expect(calls).toBe(1);
      expect(second.complete).toBe(true);
      expect(second.catalog.byId.has('w-1')).toBe(true);
    } finally {
      restore();
    }
  });

  test('coalesces in-flight demand for the same runtime and directories', async () => {
    let calls = 0;
    let release!: (value: { sessions: ReturnType<typeof listItem>[] }) => void;
    const gate = new Promise<{ sessions: ReturnType<typeof listItem>[] }>((resolve) => {
      release = resolve;
    });
    const restore = stubListSessions(async () => {
      calls += 1;
      return gate;
    });
    try {
      const first = loadSessionCatalog(['/coalesce']);
      const second = loadSessionCatalog(['/coalesce']);
      release({ sessions: [listItem('c-1', '/coalesce')] });
      const [left, right] = await Promise.all([first, second]);
      expect(calls).toBe(1);
      expect(left.catalog.byId.has('c-1')).toBe(true);
      expect(right.catalog.byId.has('c-1')).toBe(true);
      expect(left.complete).toBe(true);
      expect(right.complete).toBe(true);
    } finally {
      restore();
    }
  });

  test('runtime switch mid-load resolves stale so consumers do not act', async () => {
    const previousKey = getRuntimeKey();
    let release!: (value: { sessions: ReturnType<typeof listItem>[] }) => void;
    const gate = new Promise<{ sessions: ReturnType<typeof listItem>[] }>((resolve) => {
      release = resolve;
    });
    const restore = stubListSessions(async () => gate);
    const switchedApiBaseUrl = 'http://catalog-access-stale.test';
    try {
      const pending = loadSessionCatalog(['/stale-a']);
      // Simulate a runtime switch while the listing is in flight: new
      // endpoint (new key) plus the owner's generation bump / catalog reset.
      switchRuntimeEndpoint({ apiBaseUrl: switchedApiBaseUrl });
      getPiSessionStore().clear();
      release({ sessions: [listItem('old-1', '/stale-a')] });
      const result = await pending;
      expect(result.stale).toBe(true);
      expect(result.complete).toBe(false);
      expect(result.runtimeKey).toBe(previousKey);
    } finally {
      restore();
      // Restore the previous endpoint without emitting through disposed listeners.
      switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:0', runtimeKey: previousKey });
      getPiSessionStore().clear();
    }
  });

  test('cold mini-chat with no explicit dirs fills known project and focused scopes', async () => {
    const seen = new Set<string>();
    const restore = stubListSessions(async (scope) => {
      if (scope.directory) seen.add(scope.directory);
      if (scope.directory === '/proj-known') {
        return { sessions: [listItem('k-1', '/proj-known')] };
      }
      return { sessions: [] };
    });
    try {
      useProjectsStore.setState({
        projects: [{ id: 'proj-known', path: '/proj-known', label: 'Known' }],
        activeProjectId: 'proj-known',
        manualProjectOrder: [],
      });
      setSingletonDirectory('/focused-dir');
      try {
        useDirectoryStore.setState({ homeDirectory: '/home/tester' });
      } catch {
        // Home is best-effort; project/focused coverage is the assertion.
      }

      const result = await loadSessionCatalog();
      expect(result.stale).toBe(false);
      expect(seen.has('/proj-known')).toBe(true);
      expect(seen.has('/focused-dir')).toBe(true);
      expect(result.catalog.byId.has('k-1')).toBe(true);
      expect(result.readyDirectories.has('/proj-known')).toBe(true);
    } finally {
      restore();
    }
  });

  test('explicit empty iterable completes with no directories and no RPC', async () => {
    let calls = 0;
    const restore = stubListSessions(async () => {
      calls += 1;
      return { sessions: [] };
    });
    try {
      const result = await loadSessionCatalog([]);
      expect(result.stale).toBe(false);
      expect(result.complete).toBe(true);
      expect([...result.readyDirectories]).toEqual([]);
      expect([...result.failedDirectories]).toEqual([]);
      expect(calls).toBe(0);
    } finally {
      restore();
    }
  });

  test('default with no discoverable scopes is incomplete and authorizes nothing', async () => {
    let calls = 0;
    const restore = stubListSessions(async () => {
      calls += 1;
      return { sessions: [] };
    });
    try {
      resetWorkspaceStores();
      setSingletonDirectory(null);
      useDirectoryStore.setState({ homeDirectory: '' });
      const result = await loadSessionCatalog();
      expect(result.stale).toBe(false);
      expect(result.complete).toBe(false);
      expect([...result.readyDirectories]).toEqual([]);
      expect([...result.failedDirectories]).toEqual([]);
      expect(calls).toBe(0);
    } finally {
      restore();
    }
  });

  test('distinct case-sensitive directories stay distinct', async () => {
    const restore = stubListSessions(async (scope) => {
      const directory = scope.directory ?? '/Case-Dir';
      return { sessions: [listItem(`id-${directory}`, directory)] };
    });
    try {
      const result = await loadSessionCatalog(['/Case-Dir', '/case-dir']);
      expect(result.stale).toBe(false);
      expect(result.complete).toBe(true);
      expect([...result.readyDirectories].sort()).toEqual(['/Case-Dir', '/case-dir']);
      expect([...result.failedDirectories]).toEqual([]);
      expect(result.catalog.byId.has('id-/Case-Dir')).toBe(true);
      expect(result.catalog.byId.has('id-/case-dir')).toBe(true);
    } finally {
      restore();
    }
  });

  test('same-key runtime reset mid-load resolves stale', async () => {
    let release!: (value: { sessions: ReturnType<typeof listItem>[] }) => void;
    const gate = new Promise<{ sessions: ReturnType<typeof listItem>[] }>((resolve) => {
      release = resolve;
    });
    const restore = stubListSessions(async () => gate);
    try {
      const pending = loadSessionCatalog(['/same-key-reset']);
      getPiSessionStore().clear();
      release({ sessions: [listItem('new-1', '/same-key-reset')] });
      const result = await pending;
      expect(result.stale).toBe(true);
      expect(result.complete).toBe(false);
    } finally {
      restore();
    }
  });

  test('unexpected refresh rejection never invents ready', async () => {
    const store = getPiSessionStore();
    const original = store.refreshAllDirectoryCatalogs;
    store.refreshAllDirectoryCatalogs = (async () => {
      throw new Error('unexpected scheduler failure');
    }) as typeof store.refreshAllDirectoryCatalogs;
    try {
      const result = await loadSessionCatalog(['/unexpected-fail']);
      expect(result.stale).toBe(false);
      expect(result.complete).toBe(false);
      expect([...result.readyDirectories]).toEqual([]);
      expect([...result.failedDirectories]).toEqual([]);
      expect(result.catalog.listStatusByDirectory.get('/unexpected-fail')).not.toBe('ready');
    } finally {
      store.refreshAllDirectoryCatalogs = original;
    }
  });
});
