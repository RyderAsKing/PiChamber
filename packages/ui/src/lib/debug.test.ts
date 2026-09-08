import { describe, expect, test } from 'bun:test';

import { PiSessionStore, getPiSessionStore } from '@/apps/pi-session-store';
import type { PiReducerMessage, PiReducerSessionState } from '@/lib/pi/event-reducer';
import { createReducerPartMap } from '@/lib/pi/event-reducer';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { debugUtils } from './debug';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const reducerSession = (
  overrides: Partial<PiReducerSessionState> & Pick<PiReducerSessionState, 'sessionId'>,
): PiReducerSessionState => ({
  directory: '/repo',
  lastSequence: 0,
  lifecycle: 'idle',
  messages: new Map(),
  partOrder: new Map(),
  parts: createReducerPartMap(),
  toolsByCallId: new Map(),
  streamingMessages: new Set(),
  extensionStatuses: new Map(),
  extensionWidgets: new Map(),
  extensionDialogs: [],
  extensionNotices: [],
  extensionErrors: [],
  extensionPanels: new Map(),
  extensionApps: new Map(),
  queue: { steering: 0, followUp: 0 },
  ...overrides,
});

const reducerMessage = (
  overrides: Partial<PiReducerMessage> & Pick<PiReducerMessage, 'id' | 'role'>,
): PiReducerMessage => ({
  sessionId: 'a',
  directory: '/repo',
  createdAt: 1,
  text: '',
  thinking: '',
  streaming: false,
  ...overrides,
});

interface StoreInternal {
  state: ReturnType<PiSessionStore['getState']>;
}

const asInternal = (store: PiSessionStore): StoreInternal => store as unknown as StoreInternal;

/** Seed a two-session resident cluster: A streaming an assistant turn, B idle. */
const seedCluster = (store: PiSessionStore): void => {
  const internal = asInternal(store);
  const sessionA = reducerSession({
    sessionId: 'a',
    lastSequence: 1,
    lifecycle: 'busy',
    streamingMessages: new Set(['m1']),
    messages: new Map([['m1', reducerMessage({ id: 'm1', role: 'assistant', streaming: true })]]),
  });
  const sessionB = reducerSession({ sessionId: 'b', lastSequence: 1 });
  internal.state = {
    ...store.getState(),
    reducer: {
      bySession: new Map([['a', sessionA], ['b', sessionB]]),
      lastSequence: new Map([['a', 1], ['b', 1]]),
    },
  };
};

// ---------------------------------------------------------------------------
// Diagnostic snapshots derived from live reducer state
// ---------------------------------------------------------------------------

describe('debugUtils.getStreamingState', () => {
  test('derives streaming ids from the live Pi reducer, no lifecycle detail fields', () => {
    const store = getPiSessionStore();
    seedCluster(store);
    useSessionUIStore.setState({ currentSessionId: 'a' });

    const snapshot = debugUtils.getStreamingState();

    expect(snapshot.streamingMessageId).toBe('m1');
    expect(snapshot.streamingMessageIds.get('a')).toBe('m1');
    expect(snapshot.streamingMessageIds.get('b')).toBeNull();
    // Retired streaming-store lifecycle detail fields are not reconstructed.
    expect('streamStates' in snapshot).toBe(false);
  });

  test('reports no streaming id once the resident reducer settles', () => {
    const store = getPiSessionStore();
    seedCluster(store);
    const internal = asInternal(store);
    const sessionA = reducerSession({
      sessionId: 'a',
      lastSequence: 2,
      lifecycle: 'idle',
    });
    internal.state = {
      ...store.getState(),
      reducer: {
        bySession: new Map([['a', sessionA]]),
        lastSequence: new Map([['a', 2]]),
      },
    };
    useSessionUIStore.setState({ currentSessionId: 'a' });

    const snapshot = debugUtils.getStreamingState();

    expect(snapshot.streamingMessageId).toBeNull();
    expect(snapshot.streamingMessageIds.get('a')).toBeNull();
  });
});
