import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { PiSessionStore } from '@/apps/pi-session-store';
import { PiRequestError, piClient } from '@/lib/pi/client';
import type { PiSessionEvent, PiSessionListItem } from '@/lib/pi/protocol';
import type { PiSessionId } from '@/lib/pi/types';
import {
  applyDirectoryListToCatalog,
  applyPendingInputListToCatalog,
  applyPendingInputObservation,
  initialCatalog,
  removeRecord,
  resetCatalogPendingInput,
  selectSessionsNeedingInput,
  sessionsNeedingInputEqual,
  upsertRecord,
  type LiveSessionRecord,
  type PiSessionCatalogState,
} from '@/sync/pi-session-catalog';
import { createPiSessionCatalogCache } from '@/sync/pi-session-catalog-cache';

// Client data layer for "sessions needing input": pending-input summaries
// flow from list rows, `session.input` events, snapshots, details, and the
// global pending-input list into `LiveSessionRecord.pendingInput`
// (`undefined` = unknown, `null` = authoritatively nothing pending). Every
// source is ordered by a per-session accepted sequence, mirroring the
// `live` lifecycle gate.

const EPOCH = 'epoch-pending-input';

const pending = (since: number, count = 1, kind: 'input' | 'approval' = 'input') => ({
  count,
  kind,
  since,
});

const listItem = (
  id: string,
  directory: string,
  inputState?: { pending: ReturnType<typeof pending> | null; sequence: number },
): PiSessionListItem => ({
  session: { id, directory, title: id, createdAt: 1, updatedAt: 1 },
  updatedAt: 1,
  ...(inputState ? { inputState } : {}),
});

const acceptAll = { acceptPendingInputObservation: () => true };

const inputEvent = (
  sessionId: string,
  directory: string,
  pendingValue: ReturnType<typeof pending> | null,
  sequence: number,
): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.input',
  sequence,
  sessionId,
  directory,
  streamEpoch: EPOCH,
  payload: { pending: pendingValue },
}) as PiSessionEvent;

const snapshotEvent = (
  sessionId: string,
  directory: string,
  pendingValue: ReturnType<typeof pending> | null | undefined,
  sequence: number,
): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.snapshot',
  sequence,
  sessionId,
  directory,
  streamEpoch: EPOCH,
  payload: {
    snapshot: {
      sessionId,
      directory,
      lastSequence: sequence,
      isStreaming: false,
      lifecycle: 'idle',
      queue: { steering: 0, followUp: 0 },
      ...(pendingValue !== undefined ? { inputState: { pending: pendingValue } } : {}),
    },
  },
}) as unknown as PiSessionEvent;

const recordWithPending = (
  id: string,
  pendingValue: ReturnType<typeof pending> | null | undefined,
): LiveSessionRecord => ({
  id,
  directory: '/repo',
  parentId: null,
  title: id,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  lifecycle: 'idle',
  hydrated: false,
  ...(pendingValue !== undefined ? { pendingInput: pendingValue } : {}),
});

const flush = async (rounds = 10): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

describe('catalog list-row inputState (pure)', () => {
  test('an accepted observation is adopted', () => {
    const next = applyDirectoryListToCatalog(
      initialCatalog(),
      '/repo',
      [listItem('a', '/repo', { pending: pending(50), sequence: 5 })],
      10,
      acceptAll,
    );
    expect(next.byId.get('a')?.pendingInput).toEqual(pending(50));
  });

  test('authoritative empty (null) is adopted', () => {
    let state = applyDirectoryListToCatalog(
      initialCatalog(),
      '/repo',
      [listItem('a', '/repo', { pending: pending(50), sequence: 5 })],
      10,
      acceptAll,
    );
    state = applyDirectoryListToCatalog(
      state,
      '/repo',
      [listItem('a', '/repo', { pending: null, sequence: 7 })],
      10,
      acceptAll,
    );
    expect(state.byId.get('a')?.pendingInput).toBeNull();
  });

  test('without a gate the observation stays unknown', () => {
    const next = applyDirectoryListToCatalog(
      initialCatalog(),
      '/repo',
      [listItem('a', '/repo', { pending: pending(50), sequence: 5 })],
      10,
    );
    expect(next.byId.get('a')?.pendingInput).toBeUndefined();
  });

  test('an absent field keeps the existing value', () => {
    const state = applyDirectoryListToCatalog(
      initialCatalog(),
      '/repo',
      [listItem('a', '/repo', { pending: pending(50), sequence: 5 })],
      10,
      acceptAll,
    );
    const again = applyDirectoryListToCatalog(state, '/repo', [listItem('a', '/repo')], 10, acceptAll);
    expect(again.byId.get('a')?.pendingInput).toEqual(pending(50));
    // No accepted observation and no other change: reference-stable.
    expect(again).toBe(state);
  });

  test('an older observation does not overwrite a newer value', () => {
    const state = applyDirectoryListToCatalog(
      initialCatalog(),
      '/repo',
      [listItem('a', '/repo', { pending: pending(50), sequence: 10 })],
      10,
      acceptAll,
    );
    const staleGate = {
      acceptPendingInputObservation: (sessionId: PiSessionId, sequence: number) =>
        sessionId === 'a' ? sequence >= 10 : true,
    };
    const next = applyDirectoryListToCatalog(
      state,
      '/repo',
      [listItem('a', '/repo', { pending: pending(60), sequence: 5 })],
      10,
      staleGate,
    );
    expect(next.byId.get('a')?.pendingInput).toEqual(pending(50));
  });

  test('an identical re-list keeps the row reference', () => {
    const first = applyDirectoryListToCatalog(
      initialCatalog(),
      '/repo',
      [listItem('a', '/repo', { pending: pending(50), sequence: 5 })],
      10,
      acceptAll,
    );
    const again = applyDirectoryListToCatalog(
      first,
      '/repo',
      [listItem('a', '/repo', { pending: { ...pending(50) }, sequence: 9 })],
      10,
      acceptAll,
    );
    // A newer accepted sequence with an equal value is still a structural no-op.
    expect(again.byId.get('a')).toBe(first.byId.get('a'));
  });

  test('a malformed summary is unknown: it never clears and never adopts', () => {
    const state = applyDirectoryListToCatalog(
      initialCatalog(),
      '/repo',
      [listItem('a', '/repo', { pending: pending(50), sequence: 5 })],
      10,
      acceptAll,
    );
    const malformed = { count: 0, kind: 'input', since: 50 } as unknown as ReturnType<typeof pending>;
    const next = applyDirectoryListToCatalog(
      state,
      '/repo',
      [listItem('a', '/repo', { pending: malformed, sequence: 7 })],
      10,
      acceptAll,
    );
    expect(next.byId.get('a')?.pendingInput).toEqual(pending(50));
    // A brand-new row with only a malformed observation stays unknown.
    const fresh = applyDirectoryListToCatalog(
      initialCatalog(),
      '/repo',
      [listItem('b', '/repo', { pending: malformed, sequence: 7 })],
      10,
      acceptAll,
    );
    expect(fresh.byId.get('b')?.pendingInput).toBeUndefined();
  });
});

describe('applyPendingInputObservation (pure)', () => {
  test('sets pending on an existing row and is reference-stable on no-op', () => {
    const state = upsertRecord(initialCatalog(), recordWithPending('a', undefined));
    const next = applyPendingInputObservation(state, 'a', '/repo', pending(50), 5);
    expect(next.byId.get('a')?.pendingInput).toEqual(pending(50));
    expect(applyPendingInputObservation(next, 'a', '/repo', pending(50), 6)).toBe(next);
  });

  test('clears to null when the daemon reports nothing pending', () => {
    let state = upsertRecord(initialCatalog(), recordWithPending('a', pending(50)));
    state = applyPendingInputObservation(state, 'a', '/repo', null, 6);
    expect(state.byId.get('a')?.pendingInput).toBeNull();
  });

  test('creates a stub row for an unknown session', () => {
    const next = applyPendingInputObservation(initialCatalog(), 'ghost', '/elsewhere', pending(50), 5);
    const row = next.byId.get('ghost');
    expect(row?.directory).toBe('/elsewhere');
    expect(row?.lifecycle).toBe('idle');
    expect(row?.pendingInput).toEqual(pending(50));
    expect(next.byDirectory.get('/elsewhere')).toEqual(['ghost']);
  });

  test('authoritative empty for an unknown session materializes nothing', () => {
    const empty = initialCatalog();
    expect(applyPendingInputObservation(empty, 'ghost', '/elsewhere', null, 5)).toBe(empty);
  });

  test('a rejecting gate keeps state untouched', () => {
    const state = upsertRecord(initialCatalog(), recordWithPending('a', pending(50)));
    const next = applyPendingInputObservation(state, 'a', '/repo', pending(60), 5, () => false);
    expect(next).toBe(state);
  });

  test('a malformed summary is unknown: the record is unchanged, never null', () => {
    const state = upsertRecord(initialCatalog(), recordWithPending('a', pending(50)));
    const malformed = { count: 0, kind: 'input', since: 50 } as unknown as ReturnType<typeof pending>;
    expect(applyPendingInputObservation(state, 'a', '/repo', malformed, 6)).toBe(state);
    const empty = initialCatalog();
    expect(applyPendingInputObservation(empty, 'ghost', '/elsewhere', malformed, 5)).toBe(empty);
  });
});

describe('applyPendingInputListToCatalog (pure)', () => {
  const response = (
    entries: Array<{ sessionId: string; directory: string; pending: ReturnType<typeof pending> }>,
    sequence: number,
    streamEpoch?: string,
  ) => ({ sessions: entries, sequence, ...(streamEpoch ? { streamEpoch } : {}) });

  test('sets entries and inserts stubs for unknown sessions', () => {
    const next = applyPendingInputListToCatalog(
      initialCatalog(),
      response([{ sessionId: 'a', directory: '/repo', pending: pending(50) }], 9, EPOCH),
      { acceptPendingInputObservation: () => true, streamEpoch: EPOCH },
    );
    expect(next.byId.get('a')?.pendingInput).toEqual(pending(50));
    expect(next.byId.get('a')?.directory).toBe('/repo');
  });

  test('clears absent non-null rows only when the sequence covers them', () => {
    let state = upsertRecord(initialCatalog(), recordWithPending('a', pending(50)));
    state = upsertRecord(state, recordWithPending('b', pending(60)));
    const markers = new Map<PiSessionId, number>([['a', 9], ['b', 20]]);
    const gate = {
      acceptPendingInputObservation: (sessionId: PiSessionId, sequence: number) =>
        sequence >= (markers.get(sessionId) ?? -1),
    };
    const next = applyPendingInputListToCatalog(
      state,
      response([{ sessionId: 'b', directory: '/repo', pending: pending(60) }], 10, EPOCH),
      { ...gate, streamEpoch: EPOCH },
    );
    // 'a' is absent and covered (9 <= 10): cleared. 'b' is present: kept.
    expect(next.byId.get('a')?.pendingInput).toBeNull();
    expect(next.byId.get('b')?.pendingInput).toEqual(pending(60));
    // A row whose marker is newer than the response is not cleared.
    const covered = applyPendingInputListToCatalog(
      next,
      response([], 10, EPOCH),
      { ...gate, streamEpoch: EPOCH },
    );
    expect(covered.byId.get('b')?.pendingInput).toEqual(pending(60));
  });

  test('unknown rows stay unknown when absent from the response', () => {
    let state = upsertRecord(initialCatalog(), recordWithPending('a', undefined));
    state = applyPendingInputListToCatalog(
      state,
      response([], 10, EPOCH),
      { acceptPendingInputObservation: () => true, streamEpoch: EPOCH },
    );
    expect(state.byId.get('a')?.pendingInput).toBeUndefined();
  });

  test('an epoch mismatch rejects the whole response', () => {
    const state = upsertRecord(initialCatalog(), recordWithPending('a', pending(50)));
    const next = applyPendingInputListToCatalog(
      state,
      response([{ sessionId: 'b', directory: '/repo', pending: pending(60) }], 10, 'epoch-other'),
      { acceptPendingInputObservation: () => true, streamEpoch: EPOCH },
    );
    expect(next).toBe(state);
  });

  test('an unstamped response is rejected once an epoch is established', () => {
    const state = upsertRecord(initialCatalog(), recordWithPending('a', pending(50)));
    const next = applyPendingInputListToCatalog(
      state,
      response([], 10),
      { acceptPendingInputObservation: () => true, streamEpoch: EPOCH },
    );
    expect(next).toBe(state);
  });

  test('a malformed entry is unknown: it changes nothing and blocks absence-clear', () => {
    const state = upsertRecord(initialCatalog(), recordWithPending('a', pending(50)));
    const malformed = { count: 0, kind: 'input', since: 50 } as unknown as ReturnType<typeof pending>;
    const next = applyPendingInputListToCatalog(
      state,
      response([{ sessionId: 'a', directory: '/repo', pending: malformed }], 10, EPOCH),
      { acceptPendingInputObservation: () => true, streamEpoch: EPOCH },
    );
    expect(next.byId.get('a')?.pendingInput).toEqual(pending(50));
  });
});

describe('epoch reset and deletion (pure)', () => {
  test('resetCatalogPendingInput returns every row to unknown', () => {
    let state = upsertRecord(initialCatalog(), recordWithPending('a', pending(50)));
    state = upsertRecord(state, recordWithPending('b', null));
    state = upsertRecord(state, recordWithPending('c', undefined));
    const before = state.byId.get('c');
    const next = resetCatalogPendingInput(state);
    expect(next.byId.get('a')?.pendingInput).toBeUndefined();
    expect(next.byId.get('b')?.pendingInput).toBeUndefined();
    expect(next.byId.get('c')).toBe(before);
    expect(resetCatalogPendingInput(next)).toBe(next);
  });

  test('removeRecord drops the row including its pending input', () => {
    let state = upsertRecord(initialCatalog(), recordWithPending('a', pending(50)));
    state = removeRecord(state, 'a');
    expect(state.byId.has('a')).toBe(false);
    expect(selectSessionsNeedingInput(state)).toHaveLength(0);
  });
});

describe('selectSessionsNeedingInput (pure)', () => {
  test('returns pending rows sorted by since ascending', () => {
    let state = initialCatalog();
    state = upsertRecord(state, recordWithPending('b', pending(60)));
    state = upsertRecord(state, recordWithPending('a', pending(50)));
    state = upsertRecord(state, recordWithPending('idle', null));
    state = upsertRecord(state, recordWithPending('unknown', undefined));
    const selected = selectSessionsNeedingInput(state);
    expect(selected.map((entry) => entry.sessionId)).toEqual(['a', 'b']);
    expect(selected[0]).toEqual({ sessionId: 'a', directory: '/repo', pending: pending(50) });
  });

  test('equality is element-wise over session, directory, and summary', () => {
    const left = [{ sessionId: 'a', directory: '/repo', pending: pending(50) }];
    const right = [{ sessionId: 'a', directory: '/repo', pending: { ...pending(50) } }];
    expect(sessionsNeedingInputEqual(left, right)).toBe(true);
    expect(sessionsNeedingInputEqual(left, [{ sessionId: 'a', directory: '/repo', pending: pending(51) }])).toBe(
      false,
    );
    expect(sessionsNeedingInputEqual(left, [])).toBe(false);
  });
});

describe('catalog cache does not persist pending input', () => {
  test('restored rows are unknown', () => {
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => { storageValues.set(key, value); },
      removeItem: (key: string) => { storageValues.delete(key); },
      clear: () => { storageValues.clear(); },
      key: (index: number) => [...storageValues.keys()][index] ?? null,
      get length() { return storageValues.size; },
    } as Storage;
    const cache = createPiSessionCatalogCache(storage, { flushDelayMs: 0 });
    try {
      const catalog = applyDirectoryListToCatalog(
        initialCatalog(),
        '/repo',
        [listItem('a', '/repo', { pending: pending(50), sequence: 5 })],
        10,
        acceptAll,
      );
      expect(catalog.byId.get('a')?.pendingInput).toEqual(pending(50));
      cache.schedule('runtime-pending-cache', catalog);
      cache.flush();
      const restored = cache.read('runtime-pending-cache');
      expect(restored?.byId.get('a')?.pendingInput).toBeUndefined();
      expect(selectSessionsNeedingInput(restored as PiSessionCatalogState)).toHaveLength(0);
    } finally {
      cache.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Store wiring
// ---------------------------------------------------------------------------

interface StoreInternal {
  state: ReturnType<PiSessionStore['getState']>;
  stream: { dispose: () => void } | null;
  streamEpoch: string | null;
  hydratedSessionIds: Set<string>;
  pendingInputSequenceById: Map<string, number>;
  pendingInputUnsupported: boolean;
  commitEvents: (events: readonly PiSessionEvent[]) => void;
  commitDeletion: (sessionId: string, directory?: string) => boolean;
  commitSessionDetail: (detail: unknown, buffered?: readonly PiSessionEvent[]) => void;
  applyPendingInputList: (response: unknown) => void;
  refreshPendingInputList: () => void;
  applyVerifiedEpochChange: (epoch: string) => unknown;
}

const asInternal = (store: PiSessionStore): StoreInternal =>
  store as unknown as StoreInternal;

const originals = {
  listSessions: piClient.listSessions.bind(piClient),
  getSession: piClient.getSession.bind(piClient),
  listPendingInput: piClient.listPendingInput.bind(piClient),
};

const emptyDetail = (id: string, directory: string, lastSequence: number, streamEpoch = EPOCH) => ({
  session: { id, directory, createdAt: 0, updatedAt: 0 },
  lastSequence,
  messages: [],
  isStreaming: false,
  lifecycle: 'idle',
  streamEpoch,
});

describe('PiSessionStore pending input', () => {
  let store: PiSessionStore;
  let internal: StoreInternal;

  beforeEach(() => {
    store = new PiSessionStore();
    internal = asInternal(store);
    internal.stream = { dispose: () => undefined };
    internal.streamEpoch = EPOCH;
    // A focused directory so snapshot-triggered transcript restores can
    // resolve their hydrate scope instead of throwing.
    internal.state = { ...internal.state, directory: '/repo' };
    piClient.getSession = (async (id: string) => emptyDetail(id, '/repo', 20)) as unknown as typeof piClient.getSession;
  });

  afterEach(() => {
    store.dispose();
    piClient.listSessions = originals.listSessions;
    piClient.getSession = originals.getSession;
    piClient.listPendingInput = originals.listPendingInput;
  });

  test('session.input events update the row and create stubs for unknown sessions', () => {
    internal.commitEvents([inputEvent('ghost', '/elsewhere', pending(50), 10)]);
    const row = store.getState().catalog.byId.get('ghost');
    expect(row?.directory).toBe('/elsewhere');
    expect(row?.pendingInput).toEqual(pending(50));

    internal.commitEvents([inputEvent('ghost', '/elsewhere', null, 12)]);
    expect(store.getState().catalog.byId.get('ghost')?.pendingInput).toBeNull();
  });

  test('out-of-order session.input events are rejected', () => {
    internal.commitEvents([inputEvent('a', '/repo', pending(50), 10)]);
    expect(store.getState().catalog.byId.get('a')?.pendingInput).toEqual(pending(50));
    internal.commitEvents([inputEvent('a', '/repo', pending(60), 8)]);
    expect(store.getState().catalog.byId.get('a')?.pendingInput).toEqual(pending(50));
    expect(internal.pendingInputSequenceById.get('a')).toBe(10);
  });

  test('session.snapshot inputState is adopted by frame sequence', () => {
    internal.commitEvents([snapshotEvent('a', '/repo', pending(50), 20)]);
    expect(store.getState().catalog.byId.get('a')?.pendingInput).toEqual(pending(50));
    // A snapshot without inputState (older daemon) keeps the current value.
    internal.commitEvents([snapshotEvent('a', '/repo', undefined, 22)]);
    expect(store.getState().catalog.byId.get('a')?.pendingInput).toEqual(pending(50));
  });

  test('session detail hydration adopts inputState ordered by lastSequence', () => {
    internal.commitSessionDetail({
      ...emptyDetail('a', '/repo', 30),
      inputState: { pending: pending(50) },
    });
    expect(store.getState().catalog.byId.get('a')?.pendingInput).toEqual(pending(50));
    // An older detail must not overwrite the newer observation.
    internal.commitSessionDetail({
      ...emptyDetail('a', '/repo', 25),
      inputState: { pending: pending(60) },
    });
    expect(store.getState().catalog.byId.get('a')?.pendingInput).toEqual(pending(50));
    // A newer detail without inputState (older server) keeps the value.
    internal.commitSessionDetail(emptyDetail('a', '/repo', 40));
    expect(store.getState().catalog.byId.get('a')?.pendingInput).toEqual(pending(50));
  });

  test('directory list rows adopt inputState through the sequence gate', async () => {
    piClient.listSessions = (async () => ({
      streamEpoch: EPOCH,
      sessions: [listItem('a', '/repo', { pending: pending(50), sequence: 5 })],
    })) as unknown as typeof piClient.listSessions;
    await store.refreshDirectoryCatalog('/repo');
    expect(store.getState().catalog.byId.get('a')?.pendingInput).toEqual(pending(50));

    // A re-list without the field keeps the value; an older observation loses.
    piClient.listSessions = (async () => ({
      streamEpoch: EPOCH,
      sessions: [listItem('a', '/repo')],
    })) as unknown as typeof piClient.listSessions;
    await store.refreshDirectoryCatalog('/repo');
    expect(store.getState().catalog.byId.get('a')?.pendingInput).toEqual(pending(50));

    piClient.listSessions = (async () => ({
      streamEpoch: EPOCH,
      sessions: [listItem('a', '/repo', { pending: pending(60), sequence: 3 })],
    })) as unknown as typeof piClient.listSessions;
    await store.refreshDirectoryCatalog('/repo');
    expect(store.getState().catalog.byId.get('a')?.pendingInput).toEqual(pending(50));
  });

  test('pending-input list commit sets, clears, and inserts stubs', () => {
    internal.commitEvents([inputEvent('old', '/repo', pending(50), 10)]);
    internal.applyPendingInputList({
      sessions: [{ sessionId: 'new', directory: '/other', pending: pending(60) }],
      sequence: 20,
      streamEpoch: EPOCH,
    });
    // 'old' is absent and covered: cleared. 'new' gains a stub row.
    expect(store.getState().catalog.byId.get('old')?.pendingInput).toBeNull();
    const stub = store.getState().catalog.byId.get('new');
    expect(stub?.directory).toBe('/other');
    expect(stub?.pendingInput).toEqual(pending(60));
  });

  test('pending-input list from another epoch is rejected wholesale', () => {
    internal.commitEvents([inputEvent('a', '/repo', pending(50), 10)]);
    internal.applyPendingInputList({ sessions: [], sequence: 20, streamEpoch: 'epoch-other' });
    expect(store.getState().catalog.byId.get('a')?.pendingInput).toEqual(pending(50));
  });

  test('epoch change resets every row to unknown and drops the markers', () => {
    internal.commitEvents([inputEvent('a', '/repo', pending(50), 10)]);
    expect(internal.pendingInputSequenceById.get('a')).toBe(10);
    piClient.listPendingInput = (async () => ({
      sessions: [],
      sequence: 0,
      streamEpoch: 'epoch-2',
    })) as unknown as typeof piClient.listPendingInput;
    internal.applyVerifiedEpochChange('epoch-2');
    expect(store.getState().catalog.byId.get('a')?.pendingInput).toBeUndefined();
    expect(internal.pendingInputSequenceById.has('a')).toBe(false);
  });

  test('deletion drops the row and its ordering marker', () => {
    internal.commitEvents([inputEvent('a', '/repo', pending(50), 10)]);
    internal.commitDeletion('a', '/repo');
    expect(store.getState().catalog.byId.has('a')).toBe(false);
    expect(internal.pendingInputSequenceById.has('a')).toBe(false);
  });

  test('a failed listPendingInput leaves state untouched', async () => {
    internal.commitEvents([inputEvent('a', '/repo', pending(50), 10)]);
    let calls = 0;
    piClient.listPendingInput = (async () => {
      calls += 1;
      throw new PiRequestError('DAEMON_UNAVAILABLE', 'daemon down', 503);
    }) as unknown as typeof piClient.listPendingInput;
    internal.refreshPendingInputList();
    await flush();
    expect(calls).toBe(1);
    expect(store.getState().catalog.byId.get('a')?.pendingInput).toEqual(pending(50));
    expect(internal.pendingInputSequenceById.get('a')).toBe(10);
    // Failure is retried on the next trigger, not parked.
    expect(internal.pendingInputUnsupported).toBe(false);
  });

  test('a 404 disables the feature for this runtime', async () => {
    let calls = 0;
    piClient.listPendingInput = (async () => {
      calls += 1;
      throw new PiRequestError('DAEMON_REQUEST_FAILED', 'not found', 404);
    }) as unknown as typeof piClient.listPendingInput;
    internal.refreshPendingInputList();
    await flush();
    expect(calls).toBe(1);
    expect(internal.pendingInputUnsupported).toBe(true);
    internal.refreshPendingInputList();
    await flush();
    expect(calls).toBe(1);
  });

  test('a stream-epoch change clears the 404 latch (daemon may have been upgraded)', async () => {
    let calls = 0;
    piClient.listPendingInput = (async () => {
      calls += 1;
      throw new PiRequestError('DAEMON_REQUEST_FAILED', 'not found', 404);
    }) as unknown as typeof piClient.listPendingInput;
    internal.refreshPendingInputList();
    await flush();
    expect(internal.pendingInputUnsupported).toBe(true);
    piClient.listPendingInput = (async () => ({
      sessions: [{ sessionId: 'upgraded', directory: '/repo', pending: pending(70) }],
      sequence: 30,
      streamEpoch: 'epoch-2',
    })) as unknown as typeof piClient.listPendingInput;
    internal.applyVerifiedEpochChange('epoch-2');
    expect(internal.pendingInputUnsupported).toBe(false);
    await flush();
    await flush();
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(store.getState().catalog.byId.get('upgraded')?.pendingInput).toEqual(pending(70));
  });

  test('a trigger during an in-flight fetch runs one more fetch after it settles', async () => {
    let calls = 0;
    let releaseFirst: () => void = () => undefined;
    piClient.listPendingInput = (async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return { sessions: [], sequence: 5, streamEpoch: EPOCH };
      }
      return { sessions: [{ sessionId: 'late', directory: '/repo', pending: pending(80) }], sequence: 40, streamEpoch: EPOCH };
    }) as unknown as typeof piClient.listPendingInput;
    internal.refreshPendingInputList();
    internal.refreshPendingInputList();
    internal.refreshPendingInputList();
    expect(calls).toBe(1);
    releaseFirst();
    await flush();
    await flush();
    expect(calls).toBe(2);
    expect(store.getState().catalog.byId.get('late')?.pendingInput).toEqual(pending(80));
  });

  test('bootstrap fetch commits the global list once the epoch is established', async () => {
    piClient.listPendingInput = (async () => ({
      sessions: [{ sessionId: 'boot', directory: '/repo', pending: pending(70) }],
      sequence: 30,
      streamEpoch: EPOCH,
    })) as unknown as typeof piClient.listPendingInput;
    internal.refreshPendingInputList();
    await flush();
    expect(store.getState().catalog.byId.get('boot')?.pendingInput).toEqual(pending(70));
  });
});
