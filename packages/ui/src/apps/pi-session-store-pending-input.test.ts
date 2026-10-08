import { afterEach, describe, expect, test } from 'bun:test';

import { PiSessionStore, type PendingInputTransition } from '@/apps/pi-session-store';
import type { PiSessionEvent } from '@/lib/pi/protocol';

interface StoreInternal {
  commitEvents: (events: readonly PiSessionEvent[]) => void;
  commitDeletion: (sessionId: string, directory?: string) => boolean;
  resetForEpochChange: () => Set<string>;
  /** Seeded so snapshot commits skip the transcript-restore network fetch. */
  restoringTranscriptById: Set<string>;
}

const asInternal = (store: PiSessionStore): StoreInternal => store as unknown as StoreInternal;

const inputEvent = (
  sessionId: string,
  sequence: number,
  pending: { count: number; kind: 'input' | 'approval'; since: number } | null,
): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.input',
  sequence,
  sessionId,
  directory: '/repo',
  payload: { pending },
});

const snapshotEvent = (
  sessionId: string,
  sequence: number,
  pending: { count: number; kind: 'input' | 'approval'; since: number } | null,
): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.snapshot',
  sequence,
  sessionId,
  directory: '/repo',
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

  test('epoch resets never emit', () => {
    const { internal, seen } = freshStore();
    internal.commitEvents([inputEvent('s1', 1, { count: 1, kind: 'input', since: 1_000 })]);
    expect(seen).toHaveLength(1);

    internal.resetForEpochChange();
    expect(seen).toHaveLength(1);
  });
});
