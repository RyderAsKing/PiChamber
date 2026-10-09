import { afterEach, describe, expect, test } from 'bun:test';

import { PiSessionStore } from '@/apps/pi-session-store';
import { piClient } from '@/lib/pi/client';
import { createReducerPartMap, type PiReducerSessionState } from '@/lib/pi/event-reducer';
import type { PiSessionEvent } from '@/lib/pi/protocol';
import type { PiSessionId } from '@/lib/pi/types';
import { AWAITING_FIRST_PROMPT_LABEL, getSessionDisplayTitle } from '@/lib/chat/sessionTitle';
import {
  applyPendingInputObservation,
  initialCatalog,
  liveSessionRecordToUiSession,
  upsertStubRecord,
} from '@/sync/pi-session-catalog';

const reducerSession = (
  overrides: Partial<PiReducerSessionState> & Pick<PiReducerSessionState, 'sessionId'>,
): PiReducerSessionState => ({
  directory: '/repo',
  lastSequence: 7,
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

interface StoreInternal {
  state: ReturnType<PiSessionStore['getState']>;
  runtimeGeneration: number;
  streamEpoch: string | null;
  stream: { dispose: () => void } | null;
  hydratedSessionIds: Set<string>;
  hydrateInflightById: Map<string, Promise<void>>;
  pendingMetadataBackfillAttempted: Set<string>;
  commitHydratedSession: (
    session: PiReducerSessionState,
    buffered?: readonly PiSessionEvent[],
    detailInput?: { pending: { count: number; kind: 'input'; since: number } | null; sequence: number },
    detailSession?: { messageCount?: unknown },
  ) => void;
  commitNavigationSession: (
    session: PiReducerSessionState,
    detailInput?: { pending: { count: number; kind: 'input'; since: number } | null; sequence: number },
    detailSession?: { messageCount?: unknown },
  ) => void;
  applyPendingInputList: (response: {
    sessions: Array<{ sessionId: string; directory: string; pending: { count: number; kind: 'input'; since: number } }>;
    sequence: number;
    streamEpoch?: string;
  }) => void;
}

const asInternal = (store: PiSessionStore): StoreInternal => store as unknown as StoreInternal;

const seedNeedingStub = (store: PiSessionStore, sessionId: string, directory = '/repo'): void => {
  const internal = asInternal(store);
  let catalog = upsertStubRecord(initialCatalog(), sessionId, directory, 'idle');
  catalog = applyPendingInputObservation(
    catalog,
    sessionId,
    directory,
    { count: 1, kind: 'input', since: 100 },
    7,
  );
  internal.state = { ...internal.state, catalog };
};

const flushAsync = async (rounds = 20): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const stores: PiSessionStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.dispose();
});

describe('needing-session messageCount convergence', () => {
  test('hydrate adopts the detail total onto a pending-input stub so every surface agrees', () => {
    const store = new PiSessionStore();
    stores.push(store);
    const internal = asInternal(store);
    // Phone path: the session was learned from a pending-input stub (no
    // title, unknown count) on a directory this device never listed.
    seedNeedingStub(store, 'sess-remote');

    internal.commitHydratedSession(
      reducerSession({ sessionId: 'sess-remote', directory: '/repo' }),
      [],
      undefined,
      { messageCount: 0 },
    );

    const row = store.getState().catalog.byId.get('sess-remote');
    expect(row?.messageCount).toBe(0);
    const uiSession = liveSessionRecordToUiSession(row!);
    // Sidebar row, needs-input toast, and other-sessions strip.
    expect(getSessionDisplayTitle(uiSession, 'Untitled session')).toBe(AWAITING_FIRST_PROMPT_LABEL);
    // Desktop header snapshot (HeaderSessionSnapshot shape: title + count).
    expect(getSessionDisplayTitle(
      { title: uiSession.title ?? null, messageCount: uiSession.messageCount ?? null },
      'Untitled session',
    )).toBe(AWAITING_FIRST_PROMPT_LABEL);
  });

  test('unknown counts keep the shared sentence-case fallback on every surface', () => {
    const untitled = { title: '', messageCount: undefined };
    expect(getSessionDisplayTitle(untitled, 'Untitled session')).toBe('Untitled session');
    expect(getSessionDisplayTitle(
      { title: null, messageCount: null },
      'Untitled session',
    )).toBe('Untitled session');
  });

  test('navigate adopts the truncated detail total', () => {
    const store = new PiSessionStore();
    stores.push(store);
    const internal = asInternal(store);
    seedNeedingStub(store, 'sess-remote');
    internal.commitHydratedSession(
      reducerSession({ sessionId: 'sess-remote', directory: '/repo' }),
      [],
      undefined,
      { messageCount: 0 },
    );
    expect(store.getState().catalog.byId.get('sess-remote')?.messageCount).toBe(0);

    internal.commitNavigationSession(
      reducerSession({ sessionId: 'sess-remote', directory: '/repo' }),
      undefined,
      { messageCount: 1 },
    );
    expect(store.getState().catalog.byId.get('sess-remote')?.messageCount).toBe(1);
  });

  test('global pending-input list backfills metadata for unlisted needing sessions once', async () => {
    const store = new PiSessionStore();
    stores.push(store);
    const internal = asInternal(store);
    internal.streamEpoch = 'epoch-1';
    internal.stream = { dispose: () => undefined };
    const originalGetSession = piClient.getSession;
    const calls: string[] = [];
    piClient.getSession = (async (id: string) => {
      calls.push(id);
      return {
        session: { id, directory: '/repo', createdAt: 1, updatedAt: 1, messageCount: 0 },
        lastSequence: 9,
        messages: [],
        streamEpoch: 'epoch-1',
      };
    }) as unknown as typeof piClient.getSession;
    try {
      const response = {
        sessions: [{ sessionId: 'sess-remote', directory: '/repo', pending: { count: 1, kind: 'input' as const, since: 100 } }],
        sequence: 5,
        streamEpoch: 'epoch-1',
      };
      internal.applyPendingInputList(response);
      // Stub row exists but carries no count yet.
      expect(store.getState().catalog.byId.get('sess-remote')?.pendingInput).not.toBeNull();
      await flushAsync();
      expect(calls).toEqual(['sess-remote']);
      expect(store.getState().catalog.byId.get('sess-remote')?.messageCount).toBe(0);
      const uiSession = liveSessionRecordToUiSession(store.getState().catalog.byId.get('sess-remote')!);
      expect(getSessionDisplayTitle(uiSession, 'Untitled session')).toBe(AWAITING_FIRST_PROMPT_LABEL);

      // A repeated trigger must not refetch: one targeted read per runtime.
      internal.applyPendingInputList(response);
      await flushAsync();
      expect(calls).toEqual(['sess-remote']);
    } finally {
      piClient.getSession = originalGetSession;
    }
  });

  test('titled needing sessions are not backfilled: the count cannot change their label', async () => {
    const store = new PiSessionStore();
    stores.push(store);
    const internal = asInternal(store);
    seedNeedingStub(store, 'sess-titled');
    const byId = new Map(internal.state.catalog.byId);
    byId.set('sess-titled', { ...byId.get('sess-titled')!, title: 'Deploy pipeline' });
    internal.state = { ...internal.state, catalog: { ...internal.state.catalog, byId } };
    const originalGetSession = piClient.getSession;
    const calls: string[] = [];
    piClient.getSession = (async (id: string) => {
      calls.push(id);
      throw new Error('unexpected fetch');
    }) as unknown as typeof piClient.getSession;
    try {
      (store as unknown as { requestNeedingSessionMetadataBackfill: (ids: readonly string[]) => void })
        .requestNeedingSessionMetadataBackfill(['sess-titled']);
      await flushAsync();
      expect(calls).toEqual([]);
    } finally {
      piClient.getSession = originalGetSession;
    }
  });

  test('live session.input events backfill metadata for unknown sessions', async () => {
    const store = new PiSessionStore();
    stores.push(store);
    const internal = asInternal(store);
    // No established epoch: the synthetic live frame is unstamped, like a
    // pre-bootstrap event. (Once an epoch is established, unstamped frames
    // are rejected as unverifiable.)
    internal.stream = { dispose: () => undefined };
    const originalGetSession = piClient.getSession;
    const calls: string[] = [];
    piClient.getSession = (async (id: string) => {
      calls.push(id);
      return {
        session: { id, directory: '/repo', createdAt: 1, updatedAt: 1, messageCount: 0 },
        lastSequence: 11,
        messages: [],
        streamEpoch: 'epoch-1',
      };
    }) as unknown as typeof piClient.getSession;
    try {
      const event = {
        protocolVersion: 1,
        kind: 'event',
        name: 'session.input',
        sequence: 11,
        sessionId: 'sess-live' as PiSessionId,
        directory: '/repo',
        payload: { pending: { count: 1, kind: 'input', since: 200 } },
      } as PiSessionEvent;
      (store as unknown as { commitEvents: (events: readonly PiSessionEvent[]) => void }).commitEvents([event]);
      await flushAsync();
      expect(calls).toEqual(['sess-live']);
      expect(store.getState().catalog.byId.get('sess-live')?.messageCount).toBe(0);
    } finally {
      piClient.getSession = originalGetSession;
    }
  });
});
