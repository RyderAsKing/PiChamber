import { describe, expect, test } from 'bun:test';

import { PiSessionStore } from '@/apps/pi-session-store';
import { shouldShowTurnWorkingStatus } from '@/components/chat/lib/turns/assistantWorkingState';
import {
  createReducerPartMap,
  type PiReducerMessage,
  type PiReducerSessionState,
} from '@/lib/pi/event-reducer';
import { piClient } from '@/lib/pi/client';
import type { PiSessionEvent } from '@/lib/pi/protocol';

import { selectAwaitingPromptEcho } from './suspend-live-tail-records';

const userMessage = (id: string, createdAt: number): PiReducerMessage => ({
  id,
  sessionId: 's1',
  directory: '/repo',
  role: 'user',
  createdAt,
  text: `prompt ${id}`,
  thinking: '',
  streaming: false,
});

const assistantMessage = (id: string, createdAt: number): PiReducerMessage => ({
  id,
  sessionId: 's1',
  directory: '/repo',
  role: 'assistant',
  parentId: 'u1',
  createdAt,
  text: 'done',
  thinking: '',
  streaming: false,
});

const seedSession = (messages: PiReducerMessage[]): PiReducerSessionState => ({
  sessionId: 's1',
  directory: '/repo',
  lastSequence: 2,
  lifecycle: 'idle',
  messages: new Map(messages.map((message) => [message.id, message])),
  partOrder: new Map(),
  parts: createReducerPartMap(),
  toolsByCallId: new Map(),
  streamingMessages: new Set(),
  queue: { steering: 0, followUp: 0 },
  extensionStatuses: new Map(),
  extensionWidgets: new Map(),
  extensionDialogs: [],
  extensionNotices: [],
  extensionErrors: [],
});

interface StoreInternal {
  commitHydratedSession: (session: PiReducerSessionState, buffered?: readonly PiSessionEvent[]) => void;
  commitEvents: (events: readonly PiSessionEvent[]) => void;
  pendingPromptById: Set<string>;
}

const asInternal = (store: PiSessionStore): StoreInternal => store as unknown as StoreInternal;

const setup = (): { store: PiSessionStore; internal: StoreInternal } => {
  const store = new PiSessionStore();
  const internal = asInternal(store);
  internal.commitHydratedSession(seedSession([userMessage('u1', 1), assistantMessage('a1', 2)]));
  return { store, internal };
};

const userEcho = (sequence: number): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'assistant.message.start',
  sequence,
  sessionId: 's1',
  directory: '/repo',
  payload: {
    messageId: 'user-s1-3',
    role: 'user',
    text: 'second prompt',
    startedAt: 3,
  },
}) as PiSessionEvent;

const sessionOf = (store: PiSessionStore): PiReducerSessionState => {
  const session = store.getState().reducer.bySession.get('s1');
  if (!session) throw new Error('missing session');
  return session;
};

describe('prompt() pre-echo marker', () => {
  test('plain prompt marks the window until the server echo arrives', async () => {
    const { store, internal } = setup();
    const original = piClient.sendPrompt;
    let resolveSend!: (result: { accepted: true; messageId: string }) => void;
    piClient.sendPrompt = (() =>
      new Promise((resolve) => {
        resolveSend = resolve;
      })) as typeof piClient.sendPrompt;
    try {
      const pending = store.prompt('s1', 'second prompt', 'prompt', undefined, { directory: '/repo' });
      expect(internal.pendingPromptById.has('s1')).toBe(true);
      expect(sessionOf(store).awaitingPromptEcho).toEqual({ baselineUserMessageId: 'u1' });
      expect(selectAwaitingPromptEcho(sessionOf(store))).toBe(true);
      // The previous last turn must not present the new busy state as live work.
      expect(
        shouldShowTurnWorkingStatus({
          isLastTurn: true,
          sessionIsWorking: true,
          turnIsInActiveStream: false,
          activeStreamingMessageId: null,
          awaitingPromptEcho: selectAwaitingPromptEcho(sessionOf(store)),
        }),
      ).toBe(false);
      resolveSend({ accepted: true, messageId: 'msg_x' });
      await pending;
      // The send settled but the transcript is unchanged: still awaiting echo.
      expect(sessionOf(store).lifecycle).toBe('busy');
      expect(selectAwaitingPromptEcho(sessionOf(store))).toBe(true);
      // The daemon echoes the user message under its own id. No explicit
      // clear is needed: the selector resolves on insertion.
      internal.commitEvents([userEcho(3)]);
      expect(sessionOf(store).messages.has('user-s1-3')).toBe(true);
      expect(selectAwaitingPromptEcho(sessionOf(store))).toBe(false);
      // The echo also drops the marker, so streamed tokens never pay a scan.
      expect(sessionOf(store).awaitingPromptEcho).toBeUndefined();
      expect(
        shouldShowTurnWorkingStatus({
          isLastTurn: true,
          sessionIsWorking: true,
          turnIsInActiveStream: false,
          activeStreamingMessageId: null,
          awaitingPromptEcho: selectAwaitingPromptEcho(sessionOf(store)),
        }),
      ).toBe(true);
    } finally {
      piClient.sendPrompt = original;
      store.dispose();
    }
  });

  for (const delivery of ['steer', 'followUp'] as const) {
    test(`${delivery} does not set the marker and clears a stale one`, async () => {
      const { store } = setup();
      const stub = (async (input: { messageId?: string }) => ({
        accepted: true as const,
        messageId: input.messageId ?? 'msg_x',
      }));
      const original = delivery === 'steer' ? piClient.sendSteer : piClient.sendFollowUp;
      if (delivery === 'steer') piClient.sendSteer = stub as typeof piClient.sendSteer;
      else piClient.sendFollowUp = stub as typeof piClient.sendFollowUp;
      try {
        // A stale marker from an earlier prompt must not survive a steer/follow-up.
        const marked = sessionOf(store);
        marked.awaitingPromptEcho = { baselineUserMessageId: 'u1' };
        await store.prompt('s1', 'adjust', delivery, undefined, { directory: '/repo' });
        expect(sessionOf(store).awaitingPromptEcho).toBeUndefined();
        expect(selectAwaitingPromptEcho(sessionOf(store))).toBe(false);
      } finally {
        if (delivery === 'steer') piClient.sendSteer = original as typeof piClient.sendSteer;
        else piClient.sendFollowUp = original as typeof piClient.sendFollowUp;
        store.dispose();
      }
    });
  }

  test('send failure clears the marker with the abandoned prompt', async () => {
    const { store, internal } = setup();
    const original = piClient.sendPrompt;
    piClient.sendPrompt = (async () => {
      throw new Error('daemon unavailable');
    }) as typeof piClient.sendPrompt;
    try {
      await expect(store.prompt('s1', 'second prompt', 'prompt', undefined, { directory: '/repo' })).rejects.toThrow(
        'daemon unavailable',
      );
      expect(internal.pendingPromptById.has('s1')).toBe(false);
      expect(sessionOf(store).awaitingPromptEcho).toBeUndefined();
      expect(sessionOf(store).lifecycle).toBe('error');
      expect(selectAwaitingPromptEcho(sessionOf(store))).toBe(false);
    } finally {
      piClient.sendPrompt = original;
      store.dispose();
    }
  });

  test('terminal event clears the marker without waiting for the echo', async () => {
    const { store, internal } = setup();
    const original = piClient.sendPrompt;
    let resolveSend!: (result: { accepted: true; messageId: string }) => void;
    piClient.sendPrompt = (() =>
      new Promise((resolve) => {
        resolveSend = resolve;
      })) as typeof piClient.sendPrompt;
    try {
      const pending = store.prompt('s1', 'second prompt', 'prompt', undefined, { directory: '/repo' });
      expect(selectAwaitingPromptEcho(sessionOf(store))).toBe(true);
      resolveSend({ accepted: true, messageId: 'msg_x' });
      await pending;
      internal.commitEvents([
        {
          protocolVersion: 1,
          kind: 'event',
          name: 'session.interrupted',
          sequence: 3,
          sessionId: 's1',
          directory: '/repo',
          payload: {},
        } as PiSessionEvent,
      ]);
      expect(sessionOf(store).awaitingPromptEcho).toBeUndefined();
      expect(selectAwaitingPromptEcho(sessionOf(store))).toBe(false);
    } finally {
      piClient.sendPrompt = original;
      store.dispose();
    }
  });
});
