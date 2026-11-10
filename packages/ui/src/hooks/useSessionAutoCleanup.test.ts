import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/chat/types';
import {
  partitionCleanupCandidates,
  runSessionAutoCleanupNow,
  __resetSessionAutoCleanupForTests,
} from './useSessionAutoCleanup';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { piClient, PiRequestError } from '@/lib/pi/client';
import type { PiSessionShelfEntry } from '@/lib/pi/protocol';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import {
  __resetDirectoryRefreshSchedulerForTests,
  type LiveSessionRecord,
  type PiSessionCatalogState,
  initialCatalog,
  upsertRecord,
} from '@/sync/pi-session-catalog';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getPinnedSessionKey, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { useSessionShelfStore } from '@/stores/useSessionShelfStore';
import { useWorktreeStore } from '@/stores/useWorktreeStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

describe('partitionCleanupCandidates', () => {
  const withDir = (id: string, directory: string | undefined): Session =>
    ({ id, title: id, directory, time: { created: NOW, updated: NOW } }) as Session;

  test('only ready directories are actionable; failed scopes stay unready', () => {
    const byId = new Map([
      ['a', withDir('a', '/ready')],
      ['b', withDir('b', '/failed')],
    ]);
    const { actionable, unready } = partitionCleanupCandidates(['a', 'b'], byId, new Set(['/ready']));
    expect(actionable).toEqual(['a']);
    expect(unready).toEqual(['b']);
  });

  test('missing directory metadata is never actionable', () => {
    const byId = new Map([['orphan', withDir('orphan', undefined)]]);
    const { actionable, unready } = partitionCleanupCandidates(['orphan'], byId, new Set(['/ready']));
    expect(actionable).toEqual([]);
    expect(unready).toEqual(['orphan']);
  });
});

// --- Owning run routine: async orchestration without mounting DOM ---------

type ListItem = {
  session: {
    id: string;
    directory: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    parentId: null;
    archived?: boolean;
    timeArchived?: number;
  };
  updatedAt: number;
};

const idle = (id: string, directory: string, idleDays: number): ListItem => {
  const at = NOW - idleDays * DAY_MS;
  return { session: { id, directory, title: id, createdAt: at, updatedAt: at, parentId: null }, updatedAt: at };
};

const archived = (id: string, directory: string, archivedDaysAgo: number | null): ListItem => {
  const item = idle(id, directory, 90);
  return {
    ...item,
    session: {
      ...item.session,
      archived: true,
      ...(archivedDaysAgo === null ? {} : { timeArchived: NOW - archivedDaysAgo * DAY_MS }),
    },
  };
};

const stubListSessions = (impl: (scope: { directory?: string }) => Promise<{ sessions: ListItem[] }>) => {
  const original = piClient.listSessions.bind(piClient);
  piClient.listSessions = (async (scope: { directory?: string }) => impl(scope)) as unknown as typeof piClient.listSessions;
  return () => {
    piClient.listSessions = original;
  };
};

const stubArchive = (impl?: (id: string) => Promise<void>) => {
  const original = piClient.archiveSession.bind(piClient);
  const calls: string[] = [];
  piClient.archiveSession = (async (input: { sessionId: string }) => {
    calls.push(input.sessionId);
    if (impl) await impl(input.sessionId);
  }) as typeof piClient.archiveSession;
  return { calls, restore: () => { piClient.archiveSession = original; } };
};

const stubDelete = (impl?: (id: string) => Promise<void>) => {
  const original = piClient.deleteSession.bind(piClient);
  const calls: string[] = [];
  piClient.deleteSession = (async (input: { sessionId: string }) => {
    calls.push(input.sessionId);
    if (impl) await impl(input.sessionId);
    return true;
  }) as typeof piClient.deleteSession;
  return { calls, restore: () => { piClient.deleteSession = original; } };
};

const stubShelf = (impl: () => Promise<{ sessions: Record<string, PiSessionShelfEntry> }>) => {
  const original = piClient.getSessionShelf.bind(piClient);
  const calls: number[] = [];
  piClient.getSessionShelf = (async () => {
    calls.push(1);
    return impl();
  }) as typeof piClient.getSessionShelf;
  return { calls, restore: () => { piClient.getSessionShelf = original; } };
};

const storeState = () => getPiSessionStore().getState() as unknown as {
  directory: string | null;
  catalog: PiSessionCatalogState;
};

/** Seed live state the listing keeps (lifecycle, pending input) before a run lists the folder. */
const seedLive = (id: string, directory: string, live: Partial<LiveSessionRecord>): void => {
  const record: LiveSessionRecord = {
    id,
    directory,
    parentId: null,
    title: id,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    lifecycle: 'idle',
    hydrated: false,
    ...live,
  };
  storeState().catalog = upsertRecord(storeState().catalog ?? initialCatalog(), record);
};

const setProjects = (...paths: string[]): void => {
  useProjectsStore.setState({
    projects: paths.map((path) => ({ id: `p${path}`, path, label: path })),
    activeProjectId: paths[0] ? `p${paths[0]}` : null,
    manualProjectOrder: [],
  });
};

const setRetention = ({ archiveDays = 7, deleteDays = 0, currentSessionId = null as string | null } = {}): void => {
  useUIStore.setState({ sessionAutoArchiveAfterDays: archiveDays, sessionAutoDeleteAfterDays: deleteDays });
  useSessionUIStore.setState({ currentSessionId });
};

const resetWorkspace = (): void => {
  useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [] });
  useWorktreeStore.setState({ projects: new Map() });
  try {
    useDirectoryStore.setState({ homeDirectory: '' });
  } catch { /* best-effort */ }
  storeState().directory = null;
  useSessionPinnedStore.setState({ ids: new Set(), touchedAt: {} });
  useSessionShelfStore.setState({ runtimeKey: null, entries: {}, status: 'idle' });
};

let restoreShelf: () => void = () => undefined;

beforeEach(() => {
  __resetDirectoryRefreshSchedulerForTests();
  __resetSessionAutoCleanupForTests();
  getPiSessionStore().clear();
  resetWorkspace();
  setRetention();
  restoreShelf = stubShelf(async () => ({ sessions: {} })).restore;
});

afterEach(() => {
  restoreShelf();
  __resetDirectoryRefreshSchedulerForTests();
  __resetSessionAutoCleanupForTests();
  getPiSessionStore().clear();
  resetWorkspace();
  setRetention({ archiveDays: 0, deleteDays: 0 });
});

describe('archive pass', () => {
  test('archives every session idle past the setting, with no keep-newest rule', async () => {
    setProjects('/a');
    const items = [idle('old-1', '/a', 8), idle('old-2', '/a', 30), idle('recent', '/a', 6)];
    const restoreList = stubListSessions(async () => ({ sessions: items }));
    const archive = stubArchive();
    try {
      const result = await runSessionAutoCleanupNow({ now: NOW });
      expect(result.skippedReason).toBeUndefined();
      expect(result.archive.completedIds.sort()).toEqual(['old-1', 'old-2']);
      expect(archive.calls.sort()).toEqual(['old-1', 'old-2']);
      expect(result.delete.skippedReason).toBe('disabled');
    } finally {
      archive.restore();
      restoreList();
    }
  });

  test('skips pinned, running, waiting, snoozed, and open sessions; a woken snooze counts from its wake', async () => {
    setProjects('/a');
    setRetention({ currentSessionId: 'open' });
    const items = ['pinned', 'busy', 'retrying', 'waiting', 'snoozed', 'open', 'woke-recently', 'woke-long-ago', 'plain']
      .map((id) => idle(id, '/a', 30));
    seedLive('busy', '/a', { lifecycle: 'busy' });
    seedLive('retrying', '/a', { lifecycle: 'retry' });
    seedLive('waiting', '/a', { pendingInput: { count: 1, kind: 'input', since: NOW - 30 * DAY_MS } });
    useSessionPinnedStore.setState({ ids: new Set([getPinnedSessionKey(getRuntimeKey(), '/a', 'pinned')!]) });
    restoreShelf();
    restoreShelf = stubShelf(async () => ({
      sessions: {
        snoozed: { snoozedUntil: NOW + DAY_MS, snoozedAt: NOW - 30 * DAY_MS },
        'woke-recently': { snoozedUntil: NOW - DAY_MS, snoozedAt: NOW - 30 * DAY_MS },
        'woke-long-ago': { snoozedUntil: NOW - 10 * DAY_MS, snoozedAt: NOW - 30 * DAY_MS },
      },
    })).restore;
    const restoreList = stubListSessions(async () => ({ sessions: items }));
    const archive = stubArchive();
    try {
      const result = await runSessionAutoCleanupNow({ now: NOW });
      expect(archive.calls.sort()).toEqual(['plain', 'woke-long-ago']);
      expect(result.archive.completedIds.sort()).toEqual(['plain', 'woke-long-ago']);
      expect(result.archive.failedIds).toEqual([]);
    } finally {
      archive.restore();
      restoreList();
    }
  });

  test('without a shelf read it archives nothing (snoozes unknown), and the delete pass still runs', async () => {
    setProjects('/a');
    setRetention({ archiveDays: 7, deleteDays: 30 });
    restoreShelf();
    restoreShelf = stubShelf(async () => {
      throw new PiRequestError('DAEMON_UNAVAILABLE', 'boom');
    }).restore;
    const restoreList = stubListSessions(async () => ({
      sessions: [idle('old', '/a', 30), archived('gone', '/a', 40)],
    }));
    const archive = stubArchive();
    const remove = stubDelete();
    try {
      const result = await runSessionAutoCleanupNow({ now: NOW });
      expect(archive.calls).toEqual([]);
      expect(result.archive.skippedReason).toBe('partial');
      expect(remove.calls).toEqual(['gone']);
      expect(result.delete.completedIds).toEqual(['gone']);
      expect(result.skippedReason).toBe('partial');
    } finally {
      remove.restore();
      archive.restore();
      restoreList();
    }
  });

  test('rechecks before each write: a session opened mid-batch is skipped', async () => {
    setProjects('/a');
    const restoreList = stubListSessions(async () => ({ sessions: [idle('first', '/a', 30), idle('second', '/a', 20)] }));
    let release!: () => void;
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const archive = stubArchive(async () => {
      if (archive.calls.length === 1) {
        started();
        await gate;
      }
    });
    try {
      const pending = runSessionAutoCleanupNow({ now: NOW });
      await startedP;
      const other = archive.calls[0] === 'first' ? 'second' : 'first';
      useSessionUIStore.setState({ currentSessionId: other });
      release();
      const result = await pending;
      expect(archive.calls).toHaveLength(1);
      expect(result.archive.completedIds).toEqual([archive.calls[0]!]);
      expect(result.archive.failedIds).toEqual([other]);
      expect(result.skippedReason).toBe('partial');
    } finally {
      archive.restore();
      restoreList();
    }
  });

  test('turning the setting off mid-batch stops the remaining writes', async () => {
    setProjects('/a');
    const restoreList = stubListSessions(async () => ({ sessions: [idle('first', '/a', 30), idle('second', '/a', 20)] }));
    const archive = stubArchive(async () => {
      useUIStore.setState({ sessionAutoArchiveAfterDays: 0 });
    });
    try {
      const result = await runSessionAutoCleanupNow({ now: NOW });
      expect(archive.calls).toHaveLength(1);
      expect(result.archive.completedIds).toHaveLength(1);
    } finally {
      archive.restore();
      restoreList();
    }
  });
});

describe('delete pass', () => {
  test('deletes archived sessions by archive time and never touches unarchived ones', async () => {
    setProjects('/a');
    setRetention({ archiveDays: 0, deleteDays: 30 });
    const restoreList = stubListSessions(async () => ({
      sessions: [
        archived('archived-long-ago', '/a', 31),
        archived('archived-recently', '/a', 29),
        archived('archived-unknown-time', '/a', null),
        idle('idle-but-not-archived', '/a', 400),
      ],
    }));
    const archive = stubArchive();
    const remove = stubDelete();
    try {
      const result = await runSessionAutoCleanupNow({ now: NOW });
      expect(remove.calls).toEqual(['archived-long-ago']);
      expect(result.delete.completedIds).toEqual(['archived-long-ago']);
      expect(result.archive.skippedReason).toBe('disabled');
      expect(archive.calls).toEqual([]);
      expect(result.skippedReason).toBeUndefined();
    } finally {
      remove.restore();
      archive.restore();
      restoreList();
    }
  });

  test('a session unarchived mid-batch is not deleted', async () => {
    setProjects('/a');
    setRetention({ archiveDays: 0, deleteDays: 30 });
    const restoreList = stubListSessions(async () => ({
      sessions: [archived('first', '/a', 40), archived('second', '/a', 50)],
    }));
    const archive = stubArchive();
    const remove = stubDelete(async (id) => {
      const other = id === 'first' ? 'second' : 'first';
      await getPiSessionStore().archive(other, false, '/a');
    });
    try {
      const result = await runSessionAutoCleanupNow({ now: NOW });
      expect(remove.calls).toHaveLength(1);
      expect(result.delete.failedIds).toHaveLength(1);
      expect(result.skippedReason).toBe('partial');
    } finally {
      remove.restore();
      archive.restore();
      restoreList();
    }
  });

  test('a session the archive pass just archived is not deleted in the same run', async () => {
    setProjects('/a');
    setRetention({ archiveDays: 7, deleteDays: 1 });
    const restoreList = stubListSessions(async () => ({ sessions: [idle('old', '/a', 400)] }));
    const archive = stubArchive();
    const remove = stubDelete();
    try {
      const result = await runSessionAutoCleanupNow({ now: NOW });
      expect(result.archive.completedIds).toEqual(['old']);
      expect(remove.calls).toEqual([]);
    } finally {
      remove.restore();
      archive.restore();
      restoreList();
    }
  });
});

describe('runSessionAutoCleanupNow', () => {
  test('both settings off: nothing is read or written', async () => {
    setProjects('/a');
    setRetention({ archiveDays: 0, deleteDays: 0 });
    let listed = 0;
    const restoreList = stubListSessions(async () => {
      listed += 1;
      return { sessions: [] };
    });
    try {
      const result = await runSessionAutoCleanupNow({ now: NOW });
      expect(result.skippedReason).toBe('disabled');
      expect(listed).toBe(0);
    } finally {
      restoreList();
    }
  });

  test('double run during load: second caller sees running, no double archive', async () => {
    setProjects('/a');
    const items = [idle('old-1', '/a', 30), idle('old-2', '/a', 31)];
    let releaseLoad!: (value: { sessions: ListItem[] }) => void;
    const gate = new Promise<{ sessions: ListItem[] }>((resolve) => { releaseLoad = resolve; });
    const restoreList = stubListSessions(async () => gate);
    const archive = stubArchive();
    try {
      const first = runSessionAutoCleanupNow({ now: NOW });
      const second = await runSessionAutoCleanupNow({ now: NOW });
      expect(second.skippedReason).toBe('running');
      releaseLoad({ sessions: items });
      const firstResult = await first;
      expect(firstResult.archive.completedIds.sort()).toEqual(['old-1', 'old-2']);
      expect(archive.calls).toHaveLength(2);
    } finally {
      archive.restore();
      restoreList();
    }
  });

  test('runtime switch mid-batch returns stale and skips the rest', async () => {
    const previousKey = getRuntimeKey();
    setProjects('/a');
    setRetention({ archiveDays: 7, deleteDays: 30 });
    const restoreList = stubListSessions(async () => ({
      sessions: [idle('old-1', '/a', 30), idle('old-2', '/a', 31), archived('gone', '/a', 60)],
    }));
    let release!: () => void;
    let started!: () => void;
    const startedP = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const archive = stubArchive(async () => {
      if (archive.calls.length === 1) {
        started();
        await gate;
      }
    });
    const remove = stubDelete();
    try {
      const pending = runSessionAutoCleanupNow({ now: NOW });
      await startedP;
      switchRuntimeEndpoint({ apiBaseUrl: 'http://auto-cleanup-stale.test' });
      getPiSessionStore().clear();
      release();
      const result = await pending;
      expect(result.skippedReason).toBe('stale');
      expect(archive.calls).toHaveLength(1);
      expect(result.archive.completedIds).toEqual([]);
      expect(result.archive.failedIds).toHaveLength(2);
      expect(remove.calls).toEqual([]);
    } finally {
      remove.restore();
      archive.restore();
      restoreList();
      switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:0', runtimeKey: previousKey });
      getPiSessionStore().clear();
    }
  });

  test('one failed directory does not block a ready one; the result is partial', async () => {
    setProjects('/ready', '/failed');
    setRetention({ archiveDays: 7, deleteDays: 30 });
    const restoreList = stubListSessions(async (scope) => {
      if (scope.directory === '/failed') throw new PiRequestError('DAEMON_UNAVAILABLE', 'boom');
      return { sessions: [idle('old', '/ready', 30), archived('gone', '/ready', 60)] };
    });
    const archive = stubArchive();
    const remove = stubDelete();
    try {
      const result = await runSessionAutoCleanupNow({ now: NOW });
      expect(result.archive.completedIds).toEqual(['old']);
      expect(result.delete.completedIds).toEqual(['gone']);
      expect(result.skippedReason).toBe('partial');
    } finally {
      remove.restore();
      archive.restore();
      restoreList();
    }
  });

  test('every directory failing writes nothing and reports partial', async () => {
    setProjects('/fail-a', '/fail-b');
    setRetention({ archiveDays: 7, deleteDays: 30 });
    const restoreList = stubListSessions(async () => {
      throw new PiRequestError('DAEMON_UNAVAILABLE', 'boom');
    });
    const archive = stubArchive();
    const remove = stubDelete();
    try {
      const result = await runSessionAutoCleanupNow({ now: NOW });
      expect(result.skippedReason).toBe('partial');
      expect(archive.calls).toEqual([]);
      expect(remove.calls).toEqual([]);
    } finally {
      remove.restore();
      archive.restore();
      restoreList();
    }
  });
});
