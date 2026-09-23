import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { PiSessionStore } from '@/apps/pi-session-store';
import { resolveQueuedAutoSendReadiness } from '@/hooks/useQueuedMessageAutoSend';
import { piClient } from '@/lib/pi/client';
import type { PiSessionEvent, PiSessionListItem, PiSessionListLiveStatus } from '@/lib/pi/protocol';
import {
  __resetDirectoryRefreshSchedulerForTests,
  applyDirectoryListToCatalog,
  applyDirectoryListWithReconciliation,
  applyLifecycleChange,
  initialCatalog,
} from '@/sync/pi-session-catalog';
import { resetSessionActivityTiming, useSessionActivityTimingStore } from '@/sync/session-activity-timing';
import { resetSessionOrdering } from '@/sync/session-ordering';

// Live status on session listings: a resident runtime's lifecycle rides the
// list row as `live`, stamped with the daemon sequence it was sampled at.
// The catalog adopts it only through an explicit ordering gate; a missing
// field is unknown, never idle.

const EPOCH = 'epoch-1';

const item = (id: string, directory: string, live?: PiSessionListLiveStatus): PiSessionListItem => ({
  session: { id, directory, title: id, createdAt: 1, updatedAt: 1 },
  updatedAt: 1,
  ...(live ? { live } : {}),
});

const acceptAll = { acceptLiveObservation: () => true };

describe('catalog list live status (pure)', () => {
  test('an accepted busy observation marks an unopened row busy without hydrating it', () => {
    const next = applyDirectoryListToCatalog(initialCatalog(), '/repo', [
      item('a', '/repo', { lifecycle: 'busy', sequence: 3 }),
      item('b', '/repo'),
    ], 10, acceptAll);
    expect(next.byId.get('a')?.lifecycle).toBe('busy');
    expect(next.byId.get('a')?.hydrated).toBe(false);
    expect(next.byId.get('b')?.lifecycle).toBe('idle');
  });

  test('without an ordering gate the observation is ignored', () => {
    const next = applyDirectoryListToCatalog(initialCatalog(), '/repo', [
      item('a', '/repo', { lifecycle: 'busy', sequence: 3 }),
    ], 10);
    expect(next.byId.get('a')?.lifecycle).toBe('idle');
  });

  test('a rejected (older) observation keeps the event-driven lifecycle', () => {
    let state = applyDirectoryListToCatalog(initialCatalog(), '/repo', [item('a', '/repo')], 10);
    state = applyLifecycleChange(state, 'a', 'idle');
    const next = applyDirectoryListToCatalog(state, '/repo', [
      item('a', '/repo', { lifecycle: 'busy', sequence: 3 }),
    ], 10, { acceptLiveObservation: () => false });
    expect(next.byId.get('a')?.lifecycle).toBe('idle');
  });

  test('an accepted idle observation replaces a stale busy row', () => {
    let state = applyDirectoryListToCatalog(initialCatalog(), '/repo', [item('a', '/repo')], 10);
    state = applyLifecycleChange(state, 'a', 'busy');
    const next = applyDirectoryListToCatalog(state, '/repo', [
      item('a', '/repo', { lifecycle: 'idle', sequence: 9 }),
    ], 10, acceptAll);
    expect(next.byId.get('a')?.lifecycle).toBe('idle');
  });

  test('an absent observation is unknown: an existing busy row is not downgraded', () => {
    let state = applyDirectoryListToCatalog(initialCatalog(), '/repo', [item('a', '/repo')], 10);
    state = applyLifecycleChange(state, 'a', 'busy');
    const next = applyDirectoryListToCatalog(state, '/repo', [item('a', '/repo')], 10, acceptAll);
    expect(next.byId.get('a')?.lifecycle).toBe('busy');
  });

  test('retry carries its info, and an identical re-list keeps the row reference', () => {
    const live: PiSessionListLiveStatus = { lifecycle: 'retry', sequence: 4, retry: { attempt: 2, next: 50, message: 'rate limited' } };
    const first = applyDirectoryListToCatalog(initialCatalog(), '/repo', [item('a', '/repo', live)], 10, acceptAll);
    expect(first.byId.get('a')?.lifecycle).toBe('retry');
    expect(first.byId.get('a')?.retry).toEqual({ attempt: 2, next: 50, message: 'rate limited' });
    const again = applyDirectoryListToCatalog(first, '/repo', [
      item('a', '/repo', { ...live, sequence: 6, retry: { ...live.retry } }),
    ], 10, acceptAll);
    expect(again).toBe(first);
  });

  test('the reconciliation wrapper forwards the gate', () => {
    const baseline = initialCatalog();
    const next = applyDirectoryListWithReconciliation(baseline, baseline, '/repo', [
      item('a', '/repo', { lifecycle: 'busy', sequence: 3 }),
    ], 10, undefined, acceptAll);
    expect(next.byId.get('a')?.lifecycle).toBe('busy');
  });
});

// ---------------------------------------------------------------------------
// Store wiring
// ---------------------------------------------------------------------------

type ListResult = { sessions: PiSessionListItem[]; streamEpoch?: string };

const originals = {
  selectProject: piClient.selectProject.bind(piClient),
  listSessions: piClient.listSessions.bind(piClient),
  getSession: piClient.getSession.bind(piClient),
  health: piClient.health.bind(piClient),
  sendPrompt: piClient.sendPrompt.bind(piClient),
};

const stub = (listSessions: (directory: string) => Promise<ListResult>) => {
  piClient.selectProject = (async (directory: string) => ({ directory })) as typeof piClient.selectProject;
  piClient.listSessions = (async (scope: { directory?: string } = {}) => listSessions(scope.directory ?? '')) as typeof piClient.listSessions;
  piClient.getSession = (async (id: string) => ({
    session: { id, directory: '/repo', createdAt: 0, updatedAt: 0 },
    lastSequence: 0,
    messages: [],
    isStreaming: false,
    lifecycle: 'idle',
    streamEpoch: EPOCH,
  })) as unknown as typeof piClient.getSession;
  piClient.health = (async () => ({ state: 'ready', protocolVersion: 1, capabilities: [], streamEpoch: EPOCH })) as typeof piClient.health;
};

const lifecycleEvent = (sessionId: string, state: 'idle' | 'busy', sequence: number): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.lifecycle',
  sequence,
  sessionId,
  directory: '/other',
  streamEpoch: EPOCH,
  payload: { state },
} as PiSessionEvent);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

const tick = async (count = 8) => {
  for (let i = 0; i < count; i += 1) await Promise.resolve();
};

const commit = (store: PiSessionStore, events: PiSessionEvent[]) => {
  (store as unknown as { commitEvents: (events: PiSessionEvent[]) => void }).commitEvents(events);
};

describe('PiSessionStore list live status', () => {
  let store: PiSessionStore;

  beforeEach(() => {
    resetSessionOrdering();
    resetSessionActivityTiming();
    store = new PiSessionStore();
  });

  afterEach(() => {
    store.dispose();
    piClient.selectProject = originals.selectProject;
    piClient.listSessions = originals.listSessions;
    piClient.getSession = originals.getSession;
    piClient.health = originals.health;
    piClient.sendPrompt = originals.sendPrompt;
    resetSessionOrdering();
    resetSessionActivityTiming();
    __resetDirectoryRefreshSchedulerForTests();
  });

  test('fresh launch: an unopened running session in another folder shows busy with the server run clock', async () => {
    const now = Date.now();
    stub(async (directory) => ({
      streamEpoch: EPOCH,
      sessions: directory === '/other'
        ? [item('running', '/other', { lifecycle: 'busy', sequence: 7, runStartedAt: now - 30_000, serverNow: now })]
        : [item('focused', '/repo')],
    }));
    await store.start({ directory: '/repo' });
    await tick();
    await store.refreshDirectoryCatalog('/other');

    const row = store.getState().catalog.byId.get('running');
    expect(row?.lifecycle).toBe('busy');
    expect(row?.hydrated).toBe(false);
    const startedAt = useSessionActivityTimingStore.getState().startedAt.get('running');
    expect(startedAt).toBeDefined();
    expect(Math.abs((startedAt ?? 0) - (now - 30_000))).toBeLessThan(2_000);
  });

  test('the focused folder list on first attach carries live status too', async () => {
    stub(async () => ({
      streamEpoch: EPOCH,
      sessions: [item('focused', '/repo', { lifecycle: 'retry', sequence: 2, retry: { attempt: 1 } })],
    }));
    await store.start({ directory: '/repo' });
    await tick();
    expect(store.getState().catalog.byId.get('focused')?.lifecycle).toBe('retry');
  });

  test('a terminal event that lands while a busy list is in flight is not undone by the list', async () => {
    stub(async (directory) => ({ streamEpoch: EPOCH, sessions: directory === '/repo' ? [item('focused', '/repo')] : [] }));
    await store.start({ directory: '/repo' });
    await tick();

    const list = deferred<ListResult>();
    piClient.listSessions = (async () => list.promise) as typeof piClient.listSessions;
    const refresh = store.refreshDirectoryCatalog('/other');
    commit(store, [lifecycleEvent('racer', 'busy', 5), lifecycleEvent('racer', 'idle', 9)]);
    expect(store.getState().catalog.byId.get('racer')?.lifecycle).toBe('idle');
    // The daemon sampled busy at sequence 6, before the idle event (9).
    list.resolve({ streamEpoch: EPOCH, sessions: [item('racer', '/other', { lifecycle: 'busy', sequence: 6 })] });
    await refresh;

    expect(store.getState().catalog.byId.get('racer')?.lifecycle).toBe('idle');
  });

  test('content deltas newer than a busy list do not reject it (a streaming background session shows busy)', async () => {
    stub(async (directory) => ({ streamEpoch: EPOCH, sessions: directory === '/repo' ? [item('focused', '/repo')] : [] }));
    await store.start({ directory: '/repo' });
    await tick();

    const list = deferred<ListResult>();
    piClient.listSessions = (async () => list.promise) as typeof piClient.listSessions;
    const refresh = store.refreshDirectoryCatalog('/other');
    // The listed session keeps streaming text while the list is in flight.
    commit(store, [{
      protocolVersion: 1, kind: 'event', name: 'assistant.message.delta', sequence: 9, sessionId: 'streaming', directory: '/other', streamEpoch: EPOCH,
      payload: { messageId: 'a1', contentIndex: 0, delta: 'more', partId: 'a1:text:0' },
    } as PiSessionEvent]);
    list.resolve({ streamEpoch: EPOCH, sessions: [item('streaming', '/other', { lifecycle: 'busy', sequence: 6 })] });
    await refresh;

    expect(store.getState().catalog.byId.get('streaming')?.lifecycle).toBe('busy');
  });

  test('a content delta after the busy list commits does not mirror a default idle onto the row', async () => {
    stub(async (directory) => ({
      streamEpoch: EPOCH,
      sessions: directory === '/repo' ? [item('focused', '/repo')] : [item('streaming', '/other', { lifecycle: 'busy', sequence: 6 })],
    }));
    await store.start({ directory: '/repo' });
    await tick();
    await store.refreshDirectoryCatalog('/other');
    expect(store.getState().catalog.byId.get('streaming')?.lifecycle).toBe('busy');

    commit(store, [{
      protocolVersion: 1, kind: 'event', name: 'assistant.message.delta', sequence: 9, sessionId: 'streaming', directory: '/other', streamEpoch: EPOCH,
      payload: { messageId: 'a1', contentIndex: 0, delta: 'more', partId: 'a1:text:0' },
    } as PiSessionEvent]);

    expect(store.getState().catalog.byId.get('streaming')?.lifecycle).toBe('busy');
    // A real terminal lifecycle event still settles it.
    commit(store, [lifecycleEvent('streaming', 'idle', 10)]);
    expect(store.getState().catalog.byId.get('streaming')?.lifecycle).toBe('idle');
  });

  test('an idle list sampled before the daemon took a prompt does not clear the optimistic busy row', async () => {
    stub(async () => ({ streamEpoch: EPOCH, sessions: [item('focused', '/repo')] }));
    await store.start({ directory: '/repo' });
    await tick();
    const sent = deferred<unknown>();
    piClient.sendPrompt = (async () => sent.promise) as typeof piClient.sendPrompt;
    const prompt = store.prompt('focused', 'hi', 'prompt', undefined, { knownEmptyTranscript: true });
    await tick();
    expect(store.getState().catalog.byId.get('focused')?.lifecycle).toBe('busy');

    piClient.listSessions = (async () => ({
      streamEpoch: EPOCH,
      sessions: [item('focused', '/repo', { lifecycle: 'idle', sequence: 5 })],
    })) as typeof piClient.listSessions;
    await store.refreshDirectoryCatalog('/repo');

    expect(store.getState().catalog.byId.get('focused')?.lifecycle).toBe('busy');
    sent.resolve({ accepted: true });
    await prompt.catch(() => undefined);
  });

  test('a newer idle observation clears a stale busy row', async () => {
    stub(async (directory) => ({ streamEpoch: EPOCH, sessions: directory === '/repo' ? [item('focused', '/repo')] : [] }));
    await store.start({ directory: '/repo' });
    await tick();
    commit(store, [lifecycleEvent('stale', 'busy', 5)]);
    expect(store.getState().catalog.byId.get('stale')?.lifecycle).toBe('busy');

    piClient.listSessions = (async () => ({
      streamEpoch: EPOCH,
      sessions: [item('stale', '/other', { lifecycle: 'idle', sequence: 12 })],
    })) as typeof piClient.listSessions;
    await store.refreshDirectoryCatalog('/other');

    expect(store.getState().catalog.byId.get('stale')?.lifecycle).toBe('idle');
  });

  test('an old server without live fields leaves a busy row busy (unknown, not idle)', async () => {
    stub(async (directory) => ({ streamEpoch: EPOCH, sessions: directory === '/repo' ? [item('focused', '/repo')] : [] }));
    await store.start({ directory: '/repo' });
    await tick();
    commit(store, [lifecycleEvent('legacy', 'busy', 5)]);

    piClient.listSessions = (async () => ({ streamEpoch: EPOCH, sessions: [item('legacy', '/other')] })) as typeof piClient.listSessions;
    await store.refreshDirectoryCatalog('/other');

    expect(store.getState().catalog.byId.get('legacy')?.lifecycle).toBe('busy');
  });

  test('an unstamped list cannot be ordered, so its live status is ignored', async () => {
    stub(async () => ({ sessions: [item('focused', '/repo', { lifecycle: 'busy', sequence: 1 })] }));
    piClient.health = (async () => ({ state: 'ready', protocolVersion: 1, capabilities: [] })) as typeof piClient.health;
    await store.start({ directory: '/repo' });
    await tick();
    expect(store.getState().catalog.byId.get('focused')?.lifecycle).toBe('idle');
  });

  test('a list-only idle row never unlocks queued auto-send; a list-only busy row holds it', async () => {
    stub(async (directory) => ({
      streamEpoch: EPOCH,
      sessions: directory === '/other'
        ? [
            item('quiet', '/other', { lifecycle: 'idle', sequence: 3 }),
            item('working', '/other', { lifecycle: 'busy', sequence: 3 }),
          ]
        : [item('focused', '/repo')],
    }));
    await store.start({ directory: '/repo' });
    await tick();
    await store.refreshDirectoryCatalog('/other');

    const state = { ...store.getState(), connection: 'ready' as const };
    expect(resolveQueuedAutoSendReadiness(state, { runtimeKey: 'test', sessionId: 'quiet', directory: '/other' })).toBe('unknown');
    expect(resolveQueuedAutoSendReadiness(state, { runtimeKey: 'test', sessionId: 'working', directory: '/other' })).toBe('busy');
  });
  test('no folder focused still attaches a live stream, so list status is adopted and events settle it', async () => {
    stub(async () => ({
      streamEpoch: EPOCH,
      sessions: [item('orphan', '/other', { lifecycle: 'busy', sequence: 4 })],
    }));
    await store.connectWithoutProject();
    const internal = store as unknown as { stream: unknown; streamEpoch: string | null };
    expect(internal.stream).not.toBeNull();
    expect(internal.streamEpoch).toBe(EPOCH);
    await store.refreshDirectoryCatalog('/other');
    expect(store.getState().catalog.byId.get('orphan')?.lifecycle).toBe('busy');
    commit(store, [lifecycleEvent('orphan', 'idle', 9)]);
    expect(store.getState().catalog.byId.get('orphan')?.lifecycle).toBe('idle');
  });

  test('without any live event channel list status is not adopted', async () => {
    // Nothing could clear a list-asserted busy row without events, so it
    // stays unknown (event-driven default) instead of busy forever.
    stub(async () => ({
      streamEpoch: EPOCH,
      sessions: [item('orphan', '/other', { lifecycle: 'busy', sequence: 4 })],
    }));
    await store.connectWithoutProject();
    const internal = store as unknown as { stream: { dispose: () => void } | null };
    internal.stream?.dispose();
    internal.stream = null;
    await store.refreshDirectoryCatalog('/other');
    expect(store.getState().catalog.byId.get('orphan')?.lifecycle).toBe('idle');
  });
});
