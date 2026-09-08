import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/chat/types';
import {
  buildAutoDeleteCandidates,
  partitionCleanupCandidates,
  runSessionAutoCleanupNow,
  __resetSessionAutoCleanupForTests,
} from './useSessionAutoCleanup';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { piClient, PiRequestError } from '@/lib/pi/client';
import { getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { __resetDirectoryRefreshSchedulerForTests } from '@/sync/pi-session-catalog';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useWorktreeStore } from '@/stores/useWorktreeStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const session = (
  id: string,
  updated: number | undefined,
  extra: Partial<Session> = {},
): Session =>
  ({
    id,
    title: id,
    time:
      updated === undefined
        ? { created: NOW - 40 * DAY_MS }
        : { created: updated, updated },
    ...extra,
  }) as Session;

describe('buildAutoDeleteCandidates', () => {
  test('returns sessions older than the cutoff', () => {
    const sessions = [
      session('old', NOW - 40 * DAY_MS),
      session('recent', NOW - 1 * DAY_MS),
      session('old-2', NOW - 31 * DAY_MS),
      session('old-3', NOW - 32 * DAY_MS),
      session('old-4', NOW - 33 * DAY_MS),
      session('old-5', NOW - 34 * DAY_MS),
      session('old-6', NOW - 35 * DAY_MS),
    ];
    const ids = buildAutoDeleteCandidates({
      sessions,
      currentSessionId: null,
      cutoffDays: 30,
      now: NOW,
    });
    // 5 most recent are protected, so only the 2 oldest are eligible.
    expect(ids).toEqual(['old-6', 'old']);
  });

  test('protects the current session even when old', () => {
    const sessions = [
      session('a', NOW - 40 * DAY_MS),
      session('b', NOW - 41 * DAY_MS),
      session('c', NOW - 42 * DAY_MS),
      session('d', NOW - 43 * DAY_MS),
      session('e', NOW - 44 * DAY_MS),
      session('f', NOW - 45 * DAY_MS),
      session('g', NOW - 46 * DAY_MS),
    ];
    const ids = buildAutoDeleteCandidates({
      sessions,
      currentSessionId: 'g',
      cutoffDays: 30,
      now: NOW,
    });
    expect(ids).not.toContain('g');
    expect(ids).toEqual(['f']);
  });

  test('skips shared sessions and sessions without timestamps', () => {
    const sessions = [
      session('shared', NOW - 60 * DAY_MS, { share: { url: 'https://x' } } as Partial<Session>),
      session('no-time', NOW - 60 * DAY_MS, { time: {} } as Partial<Session>),
      session('old-1', NOW - 60 * DAY_MS),
      session('old-2', NOW - 61 * DAY_MS),
      session('old-3', NOW - 62 * DAY_MS),
      session('old-4', NOW - 63 * DAY_MS),
      session('old-5', NOW - 64 * DAY_MS),
      session('old-6', NOW - 65 * DAY_MS),
    ];
    const ids = buildAutoDeleteCandidates({
      sessions,
      currentSessionId: null,
      cutoffDays: 30,
      now: NOW,
    });
    expect(ids).not.toContain('shared');
    expect(ids).not.toContain('no-time');
  });

  test('returns empty for non-positive cutoff', () => {
    expect(
      buildAutoDeleteCandidates({ sessions: [session('a', NOW - 99 * DAY_MS)], currentSessionId: null, cutoffDays: 0, now: NOW }),
    ).toEqual([]);
  });
});

describe('partitionCleanupCandidates', () => {
  const withDir = (id: string, directory: string, updated: number): Session =>
    ({
      id,
      title: id,
      directory,
      time: { created: updated, updated },
    }) as Session;

  test('only ready directories are actionable; failed scopes stay unready', () => {
    const a = withDir('a', '/ready', NOW - 40 * DAY_MS);
    const b = withDir('b', '/failed', NOW - 41 * DAY_MS);
    const byId = new Map([
      ['a', a],
      ['b', b],
    ]);
    const { actionable, unready } = partitionCleanupCandidates(['a', 'b'], byId, new Set(['/ready']));
    expect(actionable).toEqual(['a']);
    expect(unready).toEqual(['b']);
  });

  test('missing directory metadata is never actionable', () => {
    const orphan = session('orphan', NOW - 60 * DAY_MS, { directory: undefined } as Partial<Session>);
    const byId = new Map([['orphan', orphan]]);
    const { actionable, unready } = partitionCleanupCandidates(['orphan'], byId, new Set(['/ready']));
    expect(actionable).toEqual([]);
    expect(unready).toEqual(['orphan']);
  });

  test('newest-5 protection sees failed-directory rows before partitioning', () => {
    // Five recent rows live in a failed scope; they still protect the
    // newest-5 globally so an old ready-scope row is not over-deleted.
    const recentFailed = Array.from({ length: 5 }, (_, i) =>
      withDir(`recent-${i}`, '/failed', NOW - i * DAY_MS),
    );
    const oldReady = withDir('old-ready', '/ready', NOW - 60 * DAY_MS);
    const olderReady = withDir('older-ready', '/ready', NOW - 61 * DAY_MS);
    const all = [...recentFailed, oldReady, olderReady];
    const candidateIds = buildAutoDeleteCandidates({
      sessions: all,
      currentSessionId: null,
      cutoffDays: 30,
      now: NOW,
    });
    // Newest-5 are the failed recents, so only the two old ready rows are candidates.
    expect(candidateIds.sort()).toEqual(['old-ready', 'older-ready'].sort());
    const byId = new Map(all.map((s) => [s.id, s] as const));
    const { actionable, unready } = partitionCleanupCandidates(candidateIds, byId, new Set(['/ready']));
    expect(actionable.sort()).toEqual(['old-ready', 'older-ready'].sort());
    expect(unready).toEqual([]);
  });

  test('old ready row stays protected when failed recents occupy newest-5', () => {
    const recentFailed = Array.from({ length: 5 }, (_, i) =>
      withDir(`recent-${i}`, '/failed', NOW - i * DAY_MS),
    );
    // Only one old ready row beyond the protected five: it is the sole candidate.
    const oldReady = withDir('old-ready', '/ready', NOW - 60 * DAY_MS);
    const all = [...recentFailed, oldReady];
    const candidateIds = buildAutoDeleteCandidates({
      sessions: all,
      currentSessionId: null,
      cutoffDays: 30,
      now: NOW,
    });
    expect(candidateIds).toEqual(['old-ready']);
  });
});

// --- Owning run routine: async orchestration without mounting DOM ---------

const listItem = (id: string, directory: string, updatedAt: number) => ({
  session: {
    id,
    directory,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    parentId: null,
  },
  updatedAt,
});

const stubListSessions = (impl: (scope: { directory?: string }) => Promise<{ sessions: ReturnType<typeof listItem>[] }>) => {
  const original = piClient.listSessions.bind(piClient);
  piClient.listSessions = (async (scope: { directory?: string }) => impl(scope)) as typeof piClient.listSessions;
  return () => {
    piClient.listSessions = original;
  };
};

const stubArchive = (impl?: (input: { sessionId: string }, scope?: { directory?: string }) => Promise<void>) => {
  const original = piClient.archiveSession.bind(piClient);
  const calls: Array<{ id: string; directory?: string }> = [];
  piClient.archiveSession = (async (input: { sessionId: string }, scope?: { directory?: string }) => {
    calls.push({ id: input.sessionId, directory: scope?.directory });
    if (impl) await impl(input, scope);
  }) as typeof piClient.archiveSession;
  return {
    calls,
    restore: () => {
      piClient.archiveSession = original;
    },
  };
};

const setSingletonDirectory = (directory: string | null): void => {
  const store = getPiSessionStore();
  (store.getState() as unknown as { directory: string | null }).directory = directory;
};

const resetWorkspace = (): void => {
  useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [] });
  useWorktreeStore.setState({ projects: new Map() });
  try {
    useDirectoryStore.setState({ homeDirectory: '' });
  } catch { /* best-effort */ }
  setSingletonDirectory(null);
};

const setupRetention = (overrides?: {
  enabled?: boolean;
  days?: number;
  action?: 'archive' | 'delete';
  lastRunAt?: number | null;
  currentSessionId?: string | null;
  isLoading?: boolean;
}): void => {
  useUIStore.setState({
    autoDeleteEnabled: overrides?.enabled ?? true,
    autoDeleteAfterDays: overrides?.days ?? 30,
    sessionRetentionAction: overrides?.action ?? 'archive',
    autoDeleteLastRunAt: overrides?.lastRunAt ?? null,
  });
  useSessionUIStore.setState({
    currentSessionId: overrides?.currentSessionId ?? null,
    isLoading: overrides?.isLoading ?? false,
  });
};

const oldSessionsForDir = (directory: string, count: number, startAgeDays = 31): Array<ReturnType<typeof listItem>> => {
  // Newest-first ages so the first 5 are protected and the rest are candidates.
  const items: Array<ReturnType<typeof listItem>> = [];
  for (let i = 0; i < count; i += 1) {
    const age = startAgeDays + i;
    items.push(listItem(`old-${directory.replace(/\//g, '')}-${i}`, directory, NOW - age * DAY_MS));
  }
  return items;
};

beforeEach(() => {
  __resetDirectoryRefreshSchedulerForTests();
  __resetSessionAutoCleanupForTests();
  resetWorkspace();
  getPiSessionStore().clear();
  setSingletonDirectory(null);
  setupRetention();
});

afterEach(() => {
  __resetDirectoryRefreshSchedulerForTests();
  __resetSessionAutoCleanupForTests();
  resetWorkspace();
  getPiSessionStore().clear();
  setSingletonDirectory(null);
  setupRetention({ enabled: false, lastRunAt: null, currentSessionId: null, isLoading: false });
});

describe('runSessionAutoCleanupNow', () => {
  test('double run during load: second caller sees running, no double delete', async () => {
    useProjectsStore.setState({
      projects: [{ id: 'p-a', path: '/proj-a', label: 'A' }],
      activeProjectId: 'p-a',
      manualProjectOrder: [],
    });
    const items = oldSessionsForDir('/proj-a', 7);
    let releaseLoad!: (value: { sessions: typeof items }) => void;
    const gate = new Promise<{ sessions: typeof items }>((resolve) => {
      releaseLoad = resolve;
    });
    const restoreList = stubListSessions(async () => gate);
    const archive = stubArchive();
    try {
      const first = runSessionAutoCleanupNow({ force: true, now: NOW });
      const second = runSessionAutoCleanupNow({ force: true, now: NOW });
      const secondResult = await second;
      expect(secondResult.skippedReason).toBe('running');
      expect(secondResult.completedIds).toEqual([]);
      releaseLoad({ sessions: items });
      const firstResult = await first;
      // 7 old: 5 protected, 2 candidates, both archived once.
      expect(firstResult.completedIds.sort()).toEqual(
        [items[5]!.session.id, items[6]!.session.id].sort(),
      );
      expect(archive.calls).toHaveLength(2);
    } finally {
      archive.restore();
      restoreList();
    }
  });

  test('runtime switch mid-batch returns stale, skips tail, no cooldown', async () => {
    const previousKey = getRuntimeKey();
    useProjectsStore.setState({
      projects: [{ id: 'p-a', path: '/proj-a', label: 'A' }],
      activeProjectId: 'p-a',
      manualProjectOrder: [],
    });
    const items = oldSessionsForDir('/proj-a', 7);
    const restoreList = stubListSessions(async () => ({ sessions: items }));
    let releaseArchive!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    let archiveCalls = 0;
    const archive = stubArchive(async () => {
      archiveCalls += 1;
      if (archiveCalls === 1) {
        firstStarted();
        await gate;
      }
    });
    const switchedApi = 'http://auto-cleanup-stale.test';
    try {
      const pending = runSessionAutoCleanupNow({ force: true, now: NOW });
      await started;
      switchRuntimeEndpoint({ apiBaseUrl: switchedApi });
      getPiSessionStore().clear();
      releaseArchive();
      const result = await pending;
      expect(result.skippedReason).toBe('stale');
      // Tail never runs after the switch.
      expect(archiveCalls).toBe(1);
      expect(result.completedIds).toEqual([]);
      expect(result.failedIds).toHaveLength(2);
      expect(useUIStore.getState().autoDeleteLastRunAt).toBeNull();
    } finally {
      archive.restore();
      restoreList();
      switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:0', runtimeKey: previousKey });
      getPiSessionStore().clear();
    }
  });

  test('selected session change mid-batch skips the newly opened id', async () => {
    useProjectsStore.setState({
      projects: [{ id: 'p-a', path: '/proj-a', label: 'A' }],
      activeProjectId: 'p-a',
      manualProjectOrder: [],
    });
    const items = oldSessionsForDir('/proj-a', 7);
    const candidateA = items[5]!.session.id;
    const candidateB = items[6]!.session.id;
    const restoreList = stubListSessions(async () => ({ sessions: items }));
    let releaseArchive!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    let calls = 0;
    const archive = stubArchive(async () => {
      calls += 1;
      if (calls === 1) {
        firstStarted();
        await gate;
      }
    });
    try {
      const pending = runSessionAutoCleanupNow({ force: true, now: NOW });
      await started;
      // User opens the second candidate while the first archive awaits.
      useSessionUIStore.setState({ currentSessionId: candidateB });
      releaseArchive();
      const result = await pending;
      expect(result.completedIds).toEqual([candidateA]);
      expect(result.failedIds).toContain(candidateB);
      expect(result.skippedReason).toBe('partial');
      expect(archive.calls.map((c) => c.id)).toEqual([candidateA]);
      expect(useUIStore.getState().autoDeleteLastRunAt).toBeNull();
    } finally {
      archive.restore();
      restoreList();
    }
  });

  test('wholly failed scopes return partial with no cooldown and no deletes', async () => {
    useProjectsStore.setState({
      projects: [
        { id: 'p-a', path: '/fail-a', label: 'A' },
        { id: 'p-b', path: '/fail-b', label: 'B' },
      ],
      activeProjectId: 'p-a',
      manualProjectOrder: [],
    });
    const restoreList = stubListSessions(async () => {
      throw new PiRequestError('DAEMON_UNAVAILABLE', 'boom');
    });
    const archive = stubArchive();
    try {
      const result = await runSessionAutoCleanupNow({ force: true, now: NOW });
      expect(result.skippedReason).toBe('partial');
      expect(result.completedIds).toEqual([]);
      expect(archive.calls).toEqual([]);
      expect(useUIStore.getState().autoDeleteLastRunAt).toBeNull();
    } finally {
      archive.restore();
      restoreList();
    }
  });

  test('partial failure still cleans ready dirs but never advances cooldown', async () => {
    useProjectsStore.setState({
      projects: [
        { id: 'p-ready', path: '/ready', label: 'Ready' },
        { id: 'p-failed', path: '/failed', label: 'Failed' },
      ],
      activeProjectId: 'p-ready',
      manualProjectOrder: [],
    });
    const readyItems = oldSessionsForDir('/ready', 7);
    const restoreList = stubListSessions(async (scope) => {
      if (scope.directory === '/failed') {
        throw new PiRequestError('DAEMON_UNAVAILABLE', 'boom');
      }
      return { sessions: readyItems };
    });
    const archive = stubArchive();
    try {
      const result = await runSessionAutoCleanupNow({ force: true, now: NOW });
      // Ready scope still proceeds despite the failed sibling.
      expect(result.completedIds.sort()).toEqual(
        [readyItems[5]!.session.id, readyItems[6]!.session.id].sort(),
      );
      expect(result.skippedReason).toBe('partial');
      expect(useUIStore.getState().autoDeleteLastRunAt).toBeNull();
    } finally {
      archive.restore();
      restoreList();
    }
  });

  test('complete success advances cooldown', async () => {
    useProjectsStore.setState({
      projects: [{ id: 'p-a', path: '/proj-a', label: 'A' }],
      activeProjectId: 'p-a',
      manualProjectOrder: [],
    });
    const items = oldSessionsForDir('/proj-a', 7);
    const restoreList = stubListSessions(async () => ({ sessions: items }));
    const archive = stubArchive();
    try {
      const result = await runSessionAutoCleanupNow({ force: true, now: NOW });
      expect(result.skippedReason).toBe(undefined);
      expect(result.completedIds).toHaveLength(2);
      expect(result.failedIds).toEqual([]);
      expect(useUIStore.getState().autoDeleteLastRunAt).toBe(NOW);
    } finally {
      archive.restore();
      restoreList();
    }
  });
});
