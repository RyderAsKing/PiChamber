import { describe, expect, test } from 'bun:test';

import { PiSessionStore } from '@/apps/pi-session-store';
import { piClient } from '@/lib/pi/client';
import type { PiReducerSessionState } from '@/lib/pi/event-reducer';
import { createReducerPartMap } from '@/lib/pi/event-reducer';
import type { PiSessionEvent } from '@/lib/pi/protocol';

// An open request is delivered once per sequence. Loading older messages
// must not move the session's cursor back, or a replayed request would open
// again.

interface StoreInternal {
  state: ReturnType<PiSessionStore['getState']>;
  commitEvents: (events: PiSessionEvent[]) => void;
}

const internal = (store: PiSessionStore): StoreInternal => store as unknown as StoreInternal;

const resident = (overrides: Partial<PiReducerSessionState>): PiReducerSessionState => ({
  sessionId: 's1',
  directory: '/repo-a',
  lastSequence: 10,
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

const openUrl = (sequence: number): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.openUrl',
  sequence,
  sessionId: 's1',
  directory: '/repo-a',
  payload: { id: 'r1', url: 'http://localhost:5173/', attributed: true, createdAt: 1, serverNow: 1 },
});

describe('open requests', () => {
  test('a replayed request does not open again after older messages load', async () => {
    const original = piClient.getSessionMessages.bind(piClient);
    piClient.getSessionMessages = (async () => ({
      session: { id: 's1', directory: '/repo-a', title: 's1', createdAt: 1, updatedAt: 1 },
      lastSequence: 4,
      messages: [],
      hasMoreBefore: false,
      beforeCursor: null,
    })) as unknown as typeof piClient.getSessionMessages;
    const store = new PiSessionStore();
    try {
      const state = internal(store).state;
      internal(store).state = {
        ...state,
        reducer: {
          bySession: new Map(state.reducer.bySession).set('s1', resident({ hasMoreBefore: true, beforeCursor: 'cursor-0' })),
          lastSequence: new Map(state.reducer.lastSequence).set('s1', 10),
        },
      };
      const opened: number[] = [];
      store.subscribeOpenRequests((event) => opened.push(event.sequence));

      internal(store).commitEvents([openUrl(11)]);
      expect(await store.loadOlderMessages('s1')).toBe(false);
      internal(store).commitEvents([openUrl(11)]);

      expect(opened).toEqual([11]);
      expect(store.getState().reducer.lastSequence.get('s1')).toBe(11);
    } finally {
      piClient.getSessionMessages = original;
      store.dispose();
    }
  });
});
