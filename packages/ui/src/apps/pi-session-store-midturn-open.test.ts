import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { PiSessionStore } from '@/apps/pi-session-store';
import { piClient } from '@/lib/pi/client';
import { piMessageToRecord } from '@/lib/chat/pi-to-renderable';
import { resetSessionActivityTiming } from '@/sync/session-activity-timing';
import { resetSessionOrdering } from '@/sync/session-ordering';

// Opening a session while its turn is still streaming (deep link, fresh
// launch, or selecting it after resume). The detail says busy/isStreaming,
// so the in-flight assistant must stay streaming: otherwise the chat renders
// it as a completed turn ("Worked for 0.1s" plus the completion footer).

const EPOCH = 'epoch-1';
const DIR = '/repo';

const busyDetail = () => ({
  session: { id: 'live', directory: DIR, createdAt: 1, updatedAt: 1 },
  messages: [
    { message: { id: 'u1', sessionId: 'live', directory: DIR, role: 'user', createdAt: 1000, text: 'hello' }, parts: [] },
    {
      message: { id: 'a1', sessionId: 'live', directory: DIR, role: 'assistant', parentId: 'u1', createdAt: 1100, text: 'word1 word2' },
      parts: [{ id: 'a1:text', index: 0, type: 'text', text: 'word1 word2' }],
    },
  ],
  lastSequence: 40,
  isStreaming: true,
  lifecycle: 'busy',
  runStartedAt: Date.now() - 5_000,
  serverNow: Date.now(),
  streamEpoch: EPOCH,
});

const originals = {
  selectProject: piClient.selectProject.bind(piClient),
  listSessions: piClient.listSessions.bind(piClient),
  getSession: piClient.getSession.bind(piClient),
  health: piClient.health.bind(piClient),
};

describe('opening a session mid-turn', () => {
  let store: PiSessionStore;

  beforeEach(() => {
    resetSessionOrdering();
    resetSessionActivityTiming();
    piClient.selectProject = (async (directory: string) => ({ directory })) as typeof piClient.selectProject;
    piClient.listSessions = (async () => ({
      streamEpoch: EPOCH,
      sessions: [{ session: { id: 'live', directory: DIR, createdAt: 1, updatedAt: 1 }, updatedAt: 1, live: { lifecycle: 'busy', sequence: 39 } }],
    })) as unknown as typeof piClient.listSessions;
    piClient.getSession = (async () => busyDetail()) as unknown as typeof piClient.getSession;
    piClient.health = (async () => ({ state: 'ready', protocolVersion: 1, capabilities: ['events.streamEpoch'], streamEpoch: EPOCH })) as typeof piClient.health;
    store = new PiSessionStore();
  });

  afterEach(() => {
    store.dispose();
    Object.assign(piClient, originals);
  });

  const assertStillStreaming = () => {
    const session = store.getState().reducer.bySession.get('live');
    expect(session?.lifecycle).toBe('busy');
    const assistant = session?.messages.get('a1');
    expect(assistant?.streaming).toBe(true);
    expect(session?.streamingMessages.has('a1')).toBe(true);
    const record = piMessageToRecord({ ...(assistant as NonNullable<typeof assistant>), parts: [] } as never, 'live');
    expect((record.info as { time?: { completed?: number } }).time?.completed).toBeUndefined();
    expect((record.info as { finish?: string }).finish).toBeUndefined();
  };

  test('deep link with directory keeps the in-flight assistant streaming', async () => {
    await store.start({ directory: DIR, sessionId: 'live' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertStillStreaming();
  });

  test('deep link without directory keeps the in-flight assistant streaming', async () => {
    await store.start({ sessionId: 'live' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertStillStreaming();
  });
  test('the attach snapshot and live deltas that follow keep it streaming', async () => {
    await store.start({ directory: DIR, sessionId: 'live' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const frame = (name: string, sequence: number, payload: Record<string, unknown>) => ({
      protocolVersion: 1, kind: 'event', name, sequence, sessionId: 'live', directory: DIR, streamEpoch: EPOCH, payload,
    });
    (store as unknown as { commitEvents: (events: unknown[]) => void }).commitEvents([
      frame('session.snapshot', 41, { snapshot: { sessionId: 'live', directory: DIR, isStreaming: true, lifecycle: 'busy', queue: { steering: 0, followUp: 0 }, lastText: 'word1 word2', lastSequence: 41, serverNow: Date.now() } }),
      frame('assistant.message.delta', 42, { messageId: 'a1', contentIndex: 0, delta: ' word3', partId: 'a1:text:0' }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertStillStreaming();
  });
  test('deep link from another active project keeps the in-flight assistant streaming', async () => {
    piClient.listSessions = (async (scope: { directory?: string } = {}) => ({
      streamEpoch: EPOCH,
      sessions: scope.directory === DIR
        ? [{ session: { id: 'live', directory: DIR, createdAt: 1, updatedAt: 1 }, updatedAt: 1, live: { lifecycle: 'busy', sequence: 39 } }]
        : [{ session: { id: 'other', directory: '/alpha', createdAt: 1, updatedAt: 1 }, updatedAt: 1 }],
    })) as unknown as typeof piClient.listSessions;
    await store.start({ directory: '/alpha', sessionId: 'live' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().selectedSessionId).toBe('live');
    assertStillStreaming();
  });

  test('selecting it from an attached cluster in another folder keeps it streaming', async () => {
    const internal = store as unknown as { stream: unknown; state: ReturnType<typeof store.getState> };
    internal.stream = { dispose: () => undefined };
    internal.state = { ...store.getState(), directory: '/alpha', connection: 'ready' };
    await store.select('live', DIR);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertStillStreaming();
  });
});
