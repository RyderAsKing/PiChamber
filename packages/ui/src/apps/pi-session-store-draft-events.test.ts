import { describe, expect, mock, test } from 'bun:test';

import type { PiSessionEvent } from '@/lib/pi/protocol';

// `bootstrapPiDirectory` and `reconnectPiSession` are replaced with
// controllable mocks so the bootstrap buffer and the resync path are
// deterministic; the file stays self-contained (bun test --isolate).
let bootstrapImpl: (options: Record<string, unknown>) => Promise<Record<string, unknown>> = async () => {
  throw new Error('bootstrapPiDirectory not configured for this test');
};
let reconnectImpl: (options: Record<string, unknown>) => Promise<Record<string, unknown>> = async () => {
  throw new Error('reconnectPiSession not configured for this test');
};
mock.module('@/lib/pi/bootstrap', () => ({
  bootstrapPiDirectory: (options: Record<string, unknown>) => bootstrapImpl(options),
}));
mock.module('@/lib/pi/reconnect', () => ({
  reconnectPiSession: (options: Record<string, unknown>) => reconnectImpl(options),
}));

const { PiSessionStore } = await import('@/apps/pi-session-store');
const { getRuntimeKey } = await import('@/lib/runtime-switch');
type PiSessionStore = InstanceType<typeof PiSessionStore>;

// A draft session's events (`draft: true`) go to draft listeners only: no
// catalog row (sidebar), no reducer state (transcript), no cursor.

interface StoreInternal {
  apply: (event: PiSessionEvent) => void;
  streamEpoch: string | null;
  resetForEpochChange: () => Set<string>;
  streamCursor: () => number | undefined;
  state: ReturnType<PiSessionStore['getState']>;
  runtimeGeneration: number;
  recovering: boolean;
  hydrate: (sessionId: string, expected: number) => Promise<void>;
  reconnect: (sessionId: string, expected: number, runtimeKey: string) => Promise<void>;
}

const internal = (store: PiSessionStore): StoreInternal => store as unknown as StoreInternal;

const lifecycle = (overrides: Partial<PiSessionEvent> = {}): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.lifecycle',
  sequence: 3,
  sessionId: 'pi-draft',
  directory: '/repo-a',
  payload: { state: 'busy' },
  draft: true,
  ...overrides,
} as PiSessionEvent);

describe('draft session events', () => {
  test('reach draft listeners and never the session list or transcripts', () => {
    const store = new PiSessionStore();
    try {
      const received: PiSessionEvent[] = [];
      let resets = 0;
      const unsubscribe = store.subscribeDraftEvents({ onEvent: (event) => received.push(event), onReset: () => { resets += 1; } });
      internal(store).apply(lifecycle());
      internal(store).apply(lifecycle({ name: 'session.deleted', payload: {} } as Partial<PiSessionEvent>));

      expect(received.map((event) => event.name)).toEqual(['session.lifecycle', 'session.deleted']);
      expect(store.getState().catalog.byId.has('pi-draft')).toBe(false);
      expect(store.getState().reducer.bySession.has('pi-draft')).toBe(false);
      expect(store.getState().reducer.lastSequence.has('pi-draft')).toBe(false);

      // Another daemon lifetime's draft is already gone.
      internal(store).streamEpoch = 'epoch-2';
      internal(store).apply(lifecycle({ streamEpoch: 'epoch-1' }));
      expect(received).toHaveLength(2);
      internal(store).apply(lifecycle({ streamEpoch: 'epoch-2' }));
      expect(received).toHaveLength(3);

      // A restarted daemon has none of them.
      internal(store).resetForEpochChange();
      expect(resets).toBe(1);
      unsubscribe();
      internal(store).apply(lifecycle({ streamEpoch: 'epoch-2' }));
      expect(received).toHaveLength(3);
    } finally {
      store.dispose();
    }
  });

  test('a draft event during bootstrap reaches draft listeners and never the buffer', async () => {
    const store = new PiSessionStore();
    try {
      const received: PiSessionEvent[] = [];
      store.subscribeDraftEvents({ onEvent: (event) => received.push(event), onReset: () => {} });
      internal(store).state = { ...store.getState(), directory: '/repo-a' };
      bootstrapImpl = async (options) => {
        const onEvent = options.onEvent as (event: PiSessionEvent) => void;
        onEvent(lifecycle());
        onEvent(lifecycle({ name: 'session.deleted', payload: {} } as Partial<PiSessionEvent>));
        return { phase: 'failed', errors: [], reducerState: { bySession: new Map(), lastSequence: new Map() }, lastSequence: new Map(), stream: null, health: { state: 'pending' } };
      };
      await internal(store).hydrate('pi-other', internal(store).runtimeGeneration).catch(() => undefined);

      expect(received.map((event) => event.name)).toEqual(['session.lifecycle', 'session.deleted']);
      expect(store.getState().catalog.byId.has('pi-draft')).toBe(false);
      expect(store.getState().reducer.bySession.has('pi-draft')).toBe(false);
    } finally {
      store.dispose();
    }
  });

  test('a replay miss (resync) resets draft listeners', async () => {
    const store = new PiSessionStore();
    try {
      let resets = 0;
      store.subscribeDraftEvents({ onEvent: () => {}, onReset: () => { resets += 1; } });
      internal(store).state = { ...store.getState(), directory: '/repo-a' };
      internal(store).streamEpoch = 'epoch-1';
      reconnectImpl = async (options) => {
        (options.onEvent as (event: PiSessionEvent) => void)({
          protocolVersion: 1,
          kind: 'event',
          name: 'session.snapshot',
          sequence: 9,
          streamEpoch: 'epoch-1',
          sessionId: 'pi-real',
          directory: '/repo-a',
          payload: { snapshot: { sessionId: 'pi-real', directory: '/repo-a', lastSequence: 9, isStreaming: false, lifecycle: 'idle', queue: { steering: 0, followUp: 0 }, resync: true } },
        } as PiSessionEvent);
        return { phase: 'failed', error: { code: 'DAEMON_UNAVAILABLE' } };
      };
      store.subscribe(() => {});
      await internal(store).reconnect('pi-real', internal(store).runtimeGeneration, getRuntimeKey()).catch(() => undefined);
      expect(resets).toBe(1);
    } finally {
      store.dispose();
    }
  });

  test('a draft event replayed after a reconnect is dropped, and the stream cursor stays the reducer\'s', () => {
    const store = new PiSessionStore();
    try {
      const received: number[] = [];
      store.subscribeDraftEvents({ onEvent: (event) => received.push(event.sequence), onReset: () => {} });
      internal(store).streamEpoch = 'epoch-1';
      internal(store).apply(lifecycle({ sequence: 40, streamEpoch: 'epoch-1' }));
      internal(store).apply(lifecycle({ sequence: 41, streamEpoch: 'epoch-1' }));
      // The replay after a reconnect starts at the reducer's cursor, below these.
      internal(store).apply(lifecycle({ sequence: 40, streamEpoch: 'epoch-1' }));
      internal(store).apply(lifecycle({ sequence: 41, streamEpoch: 'epoch-1' }));
      internal(store).apply(lifecycle({ sequence: 42, streamEpoch: 'epoch-1' }));
      expect(received).toEqual([40, 41, 42]);
      // A draft event must never let a reconnect skip a session event that
      // is still buffered or queued: the cursor is the reducer's alone.
      expect(internal(store).streamCursor()).toBeUndefined();
      // A restarted daemon's sequence space is unrelated to the old one.
      internal(store).resetForEpochChange();
      internal(store).streamEpoch = 'epoch-2';
      internal(store).apply(lifecycle({ sequence: 2, streamEpoch: 'epoch-2' }));
      expect(received).toEqual([40, 41, 42, 2]);
    } finally {
      store.dispose();
    }
  });
});
