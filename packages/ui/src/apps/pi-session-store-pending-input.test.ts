import { afterEach, describe, expect, test } from 'bun:test';

import { PiSessionStore, type PendingInputTransition } from '@/apps/pi-session-store';
import { piClient } from '@/lib/pi/client';
import { applyDirectoryListToCatalog, type PiSessionCatalogState } from '@/sync/pi-session-catalog';
import type { PiSessionEvent } from '@/lib/pi/protocol';

interface StoreInternal {
  commitEvents: (events: readonly PiSessionEvent[]) => void;
  commitDeletion: (sessionId: string, directory?: string) => boolean;
  resetForEpochChange: () => Set<string>;
  applyVerifiedEpochChange: (epoch: string) => Set<string> | null;
  getState: () => { catalog: { byId: Map<string, { pendingInput?: unknown }> } };
  stream: { dispose: () => void } | null;
  state: { directory: string | null };
  /** Seeded so snapshot commits skip the transcript-restore network fetch. */
  restoringTranscriptById: Set<string>;
}

const originals = {
  getSession: piClient.getSession.bind(piClient),
  listPendingInput: piClient.listPendingInput.bind(piClient),
};

/** Keep snapshot-triggered transcript restores and recovery list fetches
 *  offline: the daemon is not running under unit tests. */
const stubClientForEpochTests = (streamEpoch: string): void => {
  piClient.getSession = (async (id: string) => ({
    session: { id, directory: '/repo', createdAt: 0, updatedAt: 0 },
    lastSequence: 20,
    messages: [],
    isStreaming: false,
    lifecycle: 'idle',
    streamEpoch,
  })) as unknown as typeof piClient.getSession;
  piClient.listPendingInput = (async () => ({
    sessions: [],
    sequence: 0,
    streamEpoch,
  })) as unknown as typeof piClient.listPendingInput;
};

const asInternal = (store: PiSessionStore): StoreInternal => store as unknown as StoreInternal;

const inputEvent = (
  sessionId: string,
  sequence: number,
  pending: { count: number; kind: 'input' | 'approval'; since: number } | null,
  serverNow?: number,
  streamEpoch?: string,
): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.input',
  sequence,
  sessionId,
  directory: '/repo',
  ...(streamEpoch !== undefined ? { streamEpoch } : {}),
  payload: { pending, ...(serverNow !== undefined ? { serverNow } : {}) },
});

const snapshotEvent = (
  sessionId: string,
  sequence: number,
  pending: { count: number; kind: 'input' | 'approval'; since: number } | null,
  streamEpoch?: string,
): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.snapshot',
  sequence,
  sessionId,
  directory: '/repo',
  ...(streamEpoch !== undefined ? { streamEpoch } : {}),
  payload: {
    snapshot: {
      lifecycle: 'idle',
      inputState: { pending },
    },
  },
} as unknown as PiSessionEvent);

describe('pending-input transitions', () => {
  let stores: PiSessionStore[] = [];
  afterEach(() => {
    for (const store of stores) store.dispose();
    stores = [];
    piClient.getSession = originals.getSession;
    piClient.listPendingInput = originals.listPendingInput;
  });

  const freshStore = (): { store: PiSessionStore; internal: StoreInternal; seen: PendingInputTransition[] } => {
    const store = new PiSessionStore();
    stores.push(store);
    const seen: PendingInputTransition[] = [];
    store.subscribePendingInputTransitions((transition) => {
      seen.push(transition);
    });
    return { store, internal: asInternal(store), seen };
  };

  test('opened fires when a summary appears, cleared when it resolves', () => {
    const { internal, seen } = freshStore();
    const pending = { count: 1, kind: 'input' as const, since: 1_000 };

    internal.commitEvents([inputEvent('s1', 1, pending)]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ type: 'opened', sessionId: 's1', directory: '/repo', pending });

    internal.commitEvents([inputEvent('s1', 2, null)]);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ type: 'cleared', sessionId: 's1', directory: '/repo', pending: null });
  });

  test('opened fires from unknown and does not refire while pending', () => {
    const { internal, seen } = freshStore();

    internal.commitEvents([inputEvent('s1', 1, { count: 1, kind: 'approval', since: 1_000 })]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe('opened');

    // Count/since changes while staying non-null emit nothing.
    internal.commitEvents([inputEvent('s1', 2, { count: 3, kind: 'approval', since: 2_000 })]);
    internal.commitEvents([inputEvent('s1', 3, { count: 1, kind: 'input', since: 2_000 })]);
    expect(seen).toHaveLength(1);

    // Duplicate nulls emit nothing either.
    internal.commitEvents([inputEvent('s1', 4, null)]);
    expect(seen).toHaveLength(2);
    internal.commitEvents([inputEvent('s1', 5, null)]);
    expect(seen).toHaveLength(2);
  });

  test('unsubscribe stops delivery', () => {
    const { store, internal, seen } = freshStore();
    const extra: PendingInputTransition[] = [];
    const unsubscribe = store.subscribePendingInputTransitions((transition) => {
      extra.push(transition);
    });
    unsubscribe();

    internal.commitEvents([inputEvent('s1', 1, { count: 1, kind: 'input', since: 1_000 })]);
    expect(seen).toHaveLength(1);
    expect(extra).toHaveLength(0);
  });

  test('deleting a row while pending emits cleared', () => {
    const { internal, seen } = freshStore();
    internal.commitEvents([inputEvent('s1', 1, { count: 2, kind: 'approval', since: 1_000 })]);
    expect(seen).toHaveLength(1);

    expect(internal.commitDeletion('s1', '/repo')).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ type: 'cleared', sessionId: 's1', directory: '/repo', pending: null });
  });

  test('deleting a row with nothing pending emits nothing', () => {
    const { internal, seen } = freshStore();
    internal.commitEvents([inputEvent('s1', 1, null)]);
    expect(seen).toHaveLength(0);
    internal.commitDeletion('s1', '/repo');
    expect(seen).toHaveLength(0);
  });

  /** A `/repo` listing that no longer includes any row: the catalog drops
   *  them without a deletion. */
  const dropRepoRows = (store: PiSessionStore): void => {
    const target = store as unknown as { state: { catalog: PiSessionCatalogState } };
    target.state = {
      ...target.state,
      catalog: applyDirectoryListToCatalog(target.state.catalog, '/repo', [], 0),
    };
  };

  test('a live null for an opened session whose row dropped out still emits cleared', () => {
    const { store, internal, seen } = freshStore();
    internal.commitEvents([inputEvent('s1', 1, { count: 1, kind: 'input', since: 1_000 })]);
    expect(seen).toHaveLength(1);
    dropRepoRows(store);
    expect(store.getState().catalog.byId.has('s1')).toBe(false);

    internal.commitEvents([inputEvent('s1', 2, null)]);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ type: 'cleared', sessionId: 's1', directory: '/repo', pending: null });
    // Authoritative empty still materializes no row, and a repeat is quiet.
    expect(store.getState().catalog.byId.has('s1')).toBe(false);
    internal.commitEvents([inputEvent('s1', 3, null)]);
    expect(seen).toHaveLength(2);
  });

  test('a live null for a dropped row never reported opened emits nothing', () => {
    const { store, internal, seen } = freshStore();
    internal.commitEvents([inputEvent('s1', 1, { count: 1, kind: 'input', since: 1_000 })]);
    internal.commitEvents([inputEvent('s1', 2, null)]);
    expect(seen).toHaveLength(2);
    dropRepoRows(store);

    internal.commitEvents([inputEvent('s1', 3, null)]);
    internal.commitEvents([inputEvent('s-other', 1, null)]);
    expect(seen).toHaveLength(2);
  });

  test('a stale live null for a dropped row emits nothing', () => {
    const { store, internal, seen } = freshStore();
    internal.commitEvents([inputEvent('s1', 5, { count: 1, kind: 'input', since: 1_000 })]);
    dropRepoRows(store);

    // Older than the accepted open: the ordering gate rejects it.
    internal.commitEvents([inputEvent('s1', 4, null)]);
    expect(seen).toHaveLength(1);
  });

  test('verified epoch reset emits cleared for an opened session whose row dropped out', () => {
    const { store, internal, seen } = freshStore();
    internal.commitEvents([inputEvent('s1', 1, { count: 1, kind: 'input', since: 1_000 })]);
    dropRepoRows(store);
    seen.length = 0;

    internal.resetForEpochChange();
    expect(seen).toEqual([{ type: 'cleared', sessionId: 's1', directory: '/repo', pending: null }]);
  });

  test('snapshots never emit, even when they change the summary', () => {
    const { internal, seen } = freshStore();
    internal.commitEvents([inputEvent('s1', 1, { count: 1, kind: 'input', since: 1_000 })]);
    expect(seen).toHaveLength(1);

    // Snapshots trigger transcript restore in production; seed the guard so
    // this unit stays offline. The snapshot adopts `null` into the catalog
    // (authoritative), but the live-only listener stays quiet.
    internal.restoringTranscriptById.add('s1');
    internal.commitEvents([snapshotEvent('s1', 2, null)]);
    expect(seen).toHaveLength(1);
  });

  test('verified epoch reset emits cleared for needing sessions and returns rows to unknown', () => {
    const { store, internal, seen } = freshStore();
    const pending = { count: 1, kind: 'input' as const, since: 1_000 };
    // Stub row, never listed: learned from the live event alone.
    internal.commitEvents([inputEvent('s-need', 1, pending)]);
    expect(seen).toHaveLength(1);
    // A row that resolved to known-clear before the reset.
    internal.commitEvents([inputEvent('s-clear', 1, pending)]);
    internal.commitEvents([inputEvent('s-clear', 2, null)]);
    expect(seen).toHaveLength(3);
    seen.length = 0;

    internal.resetForEpochChange();

    // Exactly one `cleared` for the needing session; null/unknown rows emit nothing.
    expect(seen).toEqual([{ type: 'cleared', sessionId: 's-need', directory: '/repo', pending: null }]);
    // The catalog contract holds: rows go to `undefined` (unknown), not `null`.
    expect(store.getState().catalog.byId.get('s-need')?.pendingInput).toBeUndefined();
    expect(store.getState().catalog.byId.get('s-clear')?.pendingInput).toBeUndefined();
  });

  test('epoch reset emits nothing for null or unknown rows', () => {
    const { internal, seen } = freshStore();
    // Authoritative empty for an unknown id materializes nothing.
    internal.commitEvents([inputEvent('s-empty', 1, null)]);
    expect(seen).toHaveLength(0);

    internal.resetForEpochChange();
    expect(seen).toHaveLength(0);
  });

  test('a new-epoch session.input emits opened again after a verified reset', () => {
    const { internal, seen } = freshStore();
    const pending = { count: 1, kind: 'input' as const, since: 1_000 };
    internal.commitEvents([inputEvent('s1', 1, pending)]);
    expect(seen).toHaveLength(1);

    internal.resetForEpochChange();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ type: 'cleared', sessionId: 's1', directory: '/repo', pending: null });

    // The reset dropped the ordering markers, so the next lifetime's open
    // is not suppressed and its clear is not duplicated.
    internal.commitEvents([inputEvent('s1', 2, { count: 1, kind: 'approval', since: 2_000 })]);
    expect(seen).toHaveLength(3);
    expect(seen[2]?.type).toBe('opened');
    internal.commitEvents([inputEvent('s1', 3, null)]);
    expect(seen).toHaveLength(4);
    expect(seen[3]).toEqual({ type: 'cleared', sessionId: 's1', directory: '/repo', pending: null });
  });

  test('initial epoch establishment emits nothing and preserves pending', () => {
    const { store, internal, seen } = freshStore();
    const pending = { count: 1, kind: 'input' as const, since: 1_000 };
    internal.commitEvents([inputEvent('s1', 1, pending)]);
    expect(seen).toHaveLength(1);

    // First contact with the daemon lifetime establishes the epoch: no
    // reset runs, so no `cleared` emits and pending survives.
    internal.commitEvents([inputEvent('s-other', 1, pending, undefined, 'epoch-1')]);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.type).toBe('opened');
    expect(store.getState().catalog.byId.get('s1')?.pendingInput).toEqual(pending);
  });

  test('health-verified epoch change emits cleared through applyVerifiedEpochChange', () => {
    const { store, internal, seen } = freshStore();
    stubClientForEpochTests('epoch-2');
    internal.stream = { dispose: () => undefined };
    const pending = { count: 1, kind: 'input' as const, since: 1_000 };
    // The stamped live event establishes the first epoch and opens the alert.
    internal.commitEvents([inputEvent('s1', 1, pending, undefined, 'epoch-1')]);
    expect(seen).toHaveLength(1);

    // A health-verified restart resets the lifetime: one `cleared` for the
    // needing row, and the row returns to unknown.
    expect(internal.applyVerifiedEpochChange('epoch-2')).not.toBeNull();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ type: 'cleared', sessionId: 's1', directory: '/repo', pending: null });
    expect(store.getState().catalog.byId.get('s1')?.pendingInput).toBeUndefined();

    // New-lifetime frames order from the cleared markers, so `opened` fires again.
    internal.commitEvents([inputEvent('s1', 2, pending, undefined, 'epoch-2')]);
    expect(seen).toHaveLength(3);
    expect(seen[2]?.type).toBe('opened');
  });

  test('snapshot-driven verified epoch change emits cleared through commitEvents', () => {
    const { store, internal, seen } = freshStore();
    stubClientForEpochTests('epoch-2');
    internal.stream = { dispose: () => undefined };
    internal.state = { ...store.getState(), directory: '/repo' };
    const pending = { count: 1, kind: 'input' as const, since: 1_000 };
    internal.commitEvents([inputEvent('s1', 1, pending, undefined, 'epoch-1')]);
    expect(seen).toHaveLength(1);

    // A snapshot stamped with an unseen epoch is a verified restart: the
    // reset emits `cleared` for the needing row before the new lifetime's
    // frames apply. (The stubbed detail keeps the snapshot's transcript
    // restore offline.)
    internal.commitEvents([snapshotEvent('s-other', 3, null, 'epoch-2')]);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ type: 'cleared', sessionId: 's1', directory: '/repo', pending: null });
    expect(store.getState().catalog.byId.get('s1')?.pendingInput).toBeUndefined();

    // New-lifetime frames order from the cleared markers, so `opened` fires again.
    internal.commitEvents([inputEvent('s1', 4, pending, undefined, 'epoch-2')]);
    expect(seen).toHaveLength(3);
    expect(seen[2]?.type).toBe('opened');
  });

  test('clear+open in one batch emits cleared then opened', () => {
    const { internal, seen } = freshStore();
    internal.commitEvents([inputEvent('s1', 1, { count: 1, kind: 'input', since: 1_000 })]);
    expect(seen).toHaveLength(1);
    seen.length = 0;
    internal.commitEvents([
      inputEvent('s1', 2, null),
      inputEvent('s1', 3, { count: 1, kind: 'approval', since: 2_000 }),
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ type: 'cleared', sessionId: 's1', directory: '/repo', pending: null });
    expect(seen[1]).toEqual({
      type: 'opened',
      sessionId: 's1',
      directory: '/repo',
      pending: { count: 1, kind: 'approval', since: 2_000 },
    });
  });

  test('two opens in one batch emit a single opened', () => {
    const { internal, seen } = freshStore();
    internal.commitEvents([
      inputEvent('s1', 1, { count: 1, kind: 'input', since: 1_000 }),
      inputEvent('s1', 2, { count: 2, kind: 'input', since: 2_000 }),
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe('opened');
  });

  test('opened carries the event serverNow for skew-corrected age math', () => {
    const { internal, seen } = freshStore();
    const pending = { count: 1, kind: 'input' as const, since: 1_000 };

    internal.commitEvents([inputEvent('s1', 1, pending, 1_500)]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      type: 'opened',
      sessionId: 's1',
      directory: '/repo',
      pending,
      serverNow: 1_500,
    });
  });

  test('opened omits serverNow when the event carries none (older server)', () => {
    const { internal, seen } = freshStore();
    const pending = { count: 1, kind: 'input' as const, since: 1_000 };

    internal.commitEvents([inputEvent('s1', 1, pending)]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ type: 'opened', sessionId: 's1', directory: '/repo', pending });
    expect('serverNow' in (seen[0] as object)).toBe(false);

    // A malformed clock sample is dropped rather than committed.
    seen.length = 0;
    internal.commitEvents([inputEvent('s1', 2, null)]);
    internal.commitEvents([inputEvent('s1', 3, pending, Number.NaN)]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ type: 'cleared', sessionId: 's1', directory: '/repo', pending: null });
    expect(seen[1]).toEqual({ type: 'opened', sessionId: 's1', directory: '/repo', pending });
  });
});
