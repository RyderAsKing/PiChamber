import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToString } from 'react-dom/server';

// NOTE (harness): the repo has no DOM library and adding one is out of scope,
// so "mounted" follows the existing convention of this suite: components are
// mounted via `renderToString` (the real queue hook returns its server
// snapshot during SSR, so the queue list itself is driven through a
// test-controlled hook mock), user clicks are exercised by invoking the exact
// store action the button wires to (labels/roles asserted in HTML), and async
// status changes are verified by re-rendering after the awaited transition.
// Real queue-authority transitions live in `messageQueueAuthority.test.ts`,
// which uses the real store without SSR rendering.

type SendStatus = 'confirming' | 'accepted' | 'outcome-unknown' | 'rejected';
type SendRecord = {
  status: SendStatus;
  operationId: string;
  kind: 'prompt';
  streamEpoch?: string;
  runtimeKey: string;
  messageId?: string;
  updatedAt: number;
  title: string;
  action: string;
};

let mockedSessionId: string | null = 's1';
let mockedDirectory: string | null = '/repo';
let mockedSendStateById: Map<string, SendRecord> = new Map();
let mockedQueueByKey: Record<string, Array<{ id: string; content: string; createdAt: number }>> = {};

const sendRecord = (status: SendStatus, operationId: string): SendRecord => {
  const titles = {
    confirming: { title: 'Confirming send', action: 'Waiting for the server to confirm. Do not resend yet.' },
    accepted: { title: 'Send accepted', action: 'The assistant is working. No action needed.' },
    'outcome-unknown': { title: 'Send outcome unknown', action: 'The server has no record of this send. Check history for your message, then send again as a new message.' },
    rejected: { title: 'Send rejected', action: 'The server declined this send before running it. Check the message, then send again as a new message.' },
  } as const;
  return {
    status, operationId, kind: 'prompt', streamEpoch: 'epoch-1',
    runtimeKey: 'url:default', messageId: `msg_${operationId}`, updatedAt: 1, ...titles[status],
  };
};

mock.module('@/sync/pi-session-context', () => ({
  usePiSessionSnapshot: (selector: (state: Record<string, unknown>) => unknown) => selector({
    sendStateById: mockedSendStateById,
    syncReadiness: 'ready',
    catalog: {},
  }),
  usePiSessionStore: () => {
    throw new Error('usePiSessionStore is not available in this suite; use getPiSessionStore() or isolated PiSessionStore instances.');
  },
  PiSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({
      currentSessionId: mockedSessionId,
      currentSessionDirectory: mockedDirectory,
      getDirectoryForSession: () => mockedDirectory,
      sessionAbortFlags: new Map(),
    }),
    {
      getState: () => ({
        currentSessionId: mockedSessionId,
        sessionAbortFlags: new Map(),
        sendMessage: () => Promise.reject(new Error('sendMessage is stubbed in this suite')),
      }),
    },
  ),
}));

mock.module('@/sync/sync-context', () => ({
  useDirectorySync: () => undefined,
}));

// Sync hook mock (no async `await import` of the real module: that pattern
// deadlocks the loader in this suite). Pure key helpers are reimplemented
// inline; real authority transitions are covered in
// `messageQueueAuthority.test.ts` with the real store.
mock.module('@/stores/messageQueueStore', () => ({
  DEFAULT_FOLLOW_UP_BEHAVIOR: 'queue',
  isFollowUpBehavior: (value: unknown) => value === 'steer' || value === 'queue',
  normalizeFollowUpBehavior: (value: unknown) => (value === 'steer' || value === 'queue' ? value : 'queue'),
  createMessageQueueTarget: (sessionId: string, directory: string | null | undefined, runtimeKey = 'url:default') => {
    if (!runtimeKey || !directory || !sessionId) return null;
    return { runtimeKey, directory, sessionId };
  },
  getMessageQueueKey: (target: { runtimeKey: string; directory: string; sessionId: string }) =>
    `${target.runtimeKey}\n${target.directory}\n${target.sessionId}`,
  parseMessageQueueKey: (key: string) => {
    const [runtimeKey, directory, ...sessionParts] = key.split('\n');
    const sessionId = sessionParts.join('\n');
    if (!runtimeKey || !directory || !sessionId) return null;
    return { runtimeKey, directory, sessionId };
  },
  queuedSendOperationId: (queuedMessageId: string) => `qm:${queuedMessageId}`,
  useMessageQueueStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({
      queuedMessages: mockedQueueByKey,
      removeFromQueue: () => undefined,
      popToInput: () => null,
      reorderQueue: () => undefined,
      requeueWithNewIntent: () => null,
    }),
    {
      getState: () => ({
        queuedMessages: mockedQueueByKey,
        removeFromQueue: () => undefined,
        popToInput: () => null,
        reorderQueue: () => undefined,
        requeueWithNewIntent: () => null,
        getQueueForTarget: () => [],
      }),
    },
  ),
}));

const { SendStateNotice, QueuedMessageChips } = await import('@/components/chat/QueuedMessageChips');
const storeModule = await import('@/apps/pi-session-store');
const PiSessionStore = storeModule.PiSessionStore;
type PiSessionStore = InstanceType<typeof storeModule.PiSessionStore>;
const piClientModule = await import('@/lib/pi/client');
const { piClient } = piClientModule;
const { createReducerPartMap } = await import('@/lib/pi/event-reducer');
const { getQueuedAutoSendBlockedReason } = await import('@/hooks/useQueuedMessageAutoSend');
const { getRuntimeKey } = await import('@/lib/runtime-switch');

beforeEach(() => {
  mockedSessionId = 's1';
  mockedDirectory = '/repo';
  mockedSendStateById = new Map();
  mockedQueueByKey = {};
});

describe('send uncertainty notice (mounted)', () => {
  test('outcome-unknown renders with no queue visible, with history guidance and duplicate warning', () => {
    mockedSendStateById = new Map([['s1', sendRecord('outcome-unknown', 'op-unknown-1')]]);
    // No queued messages: the chips list stays hidden, only the notice shows.
    const html = renderToString(<QueuedMessageChips onEditMessage={() => undefined} onSendMessage={() => undefined} />);
    expect(html).toContain('Send outcome unknown');
    expect(html).toContain('Check history');
    expect(html).toContain('may duplicate');
    expect(html).toContain('Send as new');
    expect(html).toContain('Dismiss');
    expect(html).not.toContain('Queued messages');
    expect(html).not.toContain('Send rejected');
    expect(html).toContain('role="alert"');
  });

  test('confirming renders distinctly with a safe status check and no duplicate warning', () => {
    mockedSendStateById = new Map([['s1', sendRecord('confirming', 'op-confirm-1')]]);
    const html = renderToString(<SendStateNotice sessionId="s1" />);
    expect(html).toContain('Confirming send');
    expect(html).toContain('Do not resend yet');
    expect(html).toContain('Check status');
    expect(html).not.toContain('may duplicate');
    expect(html).toContain('role="status"');
  });

  test('accepted renders without a stuck confirming spinner', () => {
    mockedSendStateById = new Map([['s1', sendRecord('accepted', 'op-accepted-1')]]);
    const html = renderToString(<SendStateNotice sessionId="s1" />);
    expect(html).toContain('Send accepted');
    expect(html).toContain('No action needed');
    expect(html).not.toContain('Confirming send');
    expect(html).toContain('Dismiss');
  });

  test('Check status is read-only: exact receipt, zero sends, still confirming on pending', async () => {
    const store = new PiSessionStore();
    try {
      const internal = store as unknown as {
        state: ReturnType<PiSessionStore['getState']>;
        hydratedSessionIds: Set<string>;
        streamEpoch: string | null;
        pendingPromptById: Set<string>;
        pendingSendIntentById: Map<string, { operationId: string; kind: 'prompt'; runtimeKey: string; generation: number; messageId?: string; streamEpoch?: string }>;
        promptGenerationById: Map<string, number>;
      };
      internal.hydratedSessionIds = new Set(['s1']);
      internal.streamEpoch = 'epoch-1';
      internal.pendingPromptById = new Set(['s1']);
      internal.pendingSendIntentById = new Map([['s1', {
        operationId: 'op-read-1', kind: 'prompt', runtimeKey: getRuntimeKey(), generation: 1,
        messageId: 'msg_op-read-1', streamEpoch: 'epoch-1',
      }]]);
      internal.promptGenerationById = new Map([['s1', 1]]);
      internal.state = {
        ...store.getState(),
        directory: '/repo',
        connection: 'ready' as const,
        sendStateById: new Map([['s1', { ...sendRecord('confirming', 'op-read-1'), runtimeKey: getRuntimeKey() }]]),
      } as never;
      (store as unknown as { stream: unknown }).stream = { dispose: () => undefined };
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      let sendCalls = 0;
      const receiptInputs: unknown[] = [];
      piClient.sendPrompt = (async () => {
        sendCalls += 1;
        throw new Error('must not send during a status check');
      }) as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (async (input: unknown) => {
        receiptInputs.push(input);
        return { status: 'pending', streamEpoch: 'epoch-1' };
      }) as unknown as typeof piClient.getSendReceipt;
      try {
        // The Check-status click path: read-only receipt lookup.
        const settled = await store.refreshSendConfirmation('s1');
        expect(settled).toBe(false);
        expect(receiptInputs).toHaveLength(1);
        expect(receiptInputs[0]).toMatchObject({ sessionId: 's1', operationId: 'op-read-1' });
        expect(sendCalls).toBe(0);
        expect(store.getSendState('s1')?.status).toBe('confirming');
        // Async rerender still shows the checking state, not acceptance.
        mockedSendStateById = new Map([['s1', { ...sendRecord('confirming', 'op-read-1'), runtimeKey: getRuntimeKey() }]]);
        const html = renderToString(<SendStateNotice sessionId="s1" />);
        expect(html).toContain('Confirming send');
        expect(html).toContain('Check status');
      } finally {
        piClient.sendPrompt = originalSend;
        piClient.getSendReceipt = originalReceipt;
      }
    } finally {
      store.dispose();
    }
  });

  test('accepted receipt ends checking (async rerender leaves confirming)', async () => {
    const store = new PiSessionStore();
    try {
      const internal = store as unknown as {
        state: ReturnType<PiSessionStore['getState']>;
        hydratedSessionIds: Set<string>;
        streamEpoch: string | null;
        pendingPromptById: Set<string>;
        pendingSendIntentById: Map<string, { operationId: string; kind: 'prompt'; runtimeKey: string; generation: number; messageId?: string; streamEpoch?: string }>;
        promptGenerationById: Map<string, number>;
      };
      internal.hydratedSessionIds = new Set(['s1']);
      internal.streamEpoch = 'epoch-1';
      internal.pendingPromptById = new Set(['s1']);
      internal.pendingSendIntentById = new Map([['s1', {
        operationId: 'op-accept-1', kind: 'prompt', runtimeKey: getRuntimeKey(), generation: 1,
        messageId: 'msg_op-accept-1', streamEpoch: 'epoch-1',
      }]]);
      internal.promptGenerationById = new Map([['s1', 1]]);
      internal.state = {
        ...store.getState(),
        directory: '/repo',
        connection: 'ready' as const,
        sendStateById: new Map([['s1', { ...sendRecord('confirming', 'op-accept-1'), runtimeKey: getRuntimeKey() }]]),
      } as never;
      (store as unknown as { stream: unknown }).stream = { dispose: () => undefined };
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      piClient.getSendReceipt = (async () => ({
        status: 'accepted', streamEpoch: 'epoch-1', receipt: { accepted: true, messageId: 'm-1' },
      })) as unknown as typeof piClient.getSendReceipt;
      try {
        const settled = await store.refreshSendConfirmation('s1');
        expect(settled).toBe(true);
        expect(store.getSendState('s1')?.status).toBe('accepted');
        mockedSendStateById = new Map([['s1', { ...sendRecord('accepted', 'op-accept-1'), runtimeKey: getRuntimeKey() }]]);
        const html = renderToString(<SendStateNotice sessionId="s1" />);
        expect(html).toContain('Send accepted');
        expect(html).not.toContain('Confirming send');
      } finally {
        piClient.getSendReceipt = originalReceipt;
      }
    } finally {
      store.dispose();
    }
  });

  test('dismiss clears outcome-unknown but never confirms away an uncertain send', () => {
    const store = new PiSessionStore();
    try {
      const internal = store as unknown as {
        state: ReturnType<PiSessionStore['getState']>;
      };
      internal.state = {
        ...store.getState(),
        sendStateById: new Map([['s1', { ...sendRecord('outcome-unknown', 'op-old-1'), runtimeKey: getRuntimeKey() }]]),
      } as never;
      // Dismiss click path on outcome-unknown.
      store.clearSendState('s1');
      expect(store.getSendState('s1')).toBeUndefined();
      mockedSendStateById = new Map();
      expect(renderToString(<SendStateNotice sessionId="s1" />)).toBe('');

      // Dismiss must never clear an uncertain confirming send.
      internal.state = {
        ...store.getState(),
        sendStateById: new Map([['s1', { ...sendRecord('confirming', 'op-live-1'), runtimeKey: getRuntimeKey() }]]),
      } as never;
      store.clearSendState('s1');
      expect(store.getSendState('s1')?.status).toBe('confirming');
      mockedSendStateById = new Map([['s1', { ...sendRecord('confirming', 'op-live-1'), runtimeKey: getRuntimeKey() }]]);
      const html = renderToString(<SendStateNotice sessionId="s1" />);
      expect(html).toContain('Confirming send');
    } finally {
      store.dispose();
    }
  });

  test('unrelated live events do not settle an uncertain send', () => {
    const store = new PiSessionStore();
    try {
      const internal = store as unknown as {
        state: ReturnType<PiSessionStore['getState']>;
        hydratedSessionIds: Set<string>;
        streamEpoch: string | null;
        pendingPromptById: Set<string>;
        pendingSendIntentById: Map<string, { operationId: string; kind: 'prompt'; runtimeKey: string; generation: number }>;
        promptGenerationById: Map<string, number>;
      };
      const cursor = 5_000;
      internal.hydratedSessionIds = new Set(['s1']);
      internal.streamEpoch = 'epoch-1';
      internal.pendingPromptById = new Set(['s1']);
      internal.pendingSendIntentById = new Map([['s1', { operationId: 'op-live-1', kind: 'prompt', runtimeKey: getRuntimeKey(), generation: 1 }]]);
      internal.promptGenerationById = new Map([['s1', 1]]);
      internal.state = {
        ...store.getState(),
        directory: '/repo',
        connection: 'ready' as const,
        sessions: [],
        selectedSessionId: 's1',
        reducer: {
          bySession: new Map([['s1', {
            sessionId: 's1', directory: '/repo', lastSequence: cursor, lifecycle: 'idle' as const,
            messages: new Map(), partOrder: new Map(), parts: createReducerPartMap(),
            toolsByCallId: new Map(), streamingMessages: new Set(), extensionStatuses: new Map(),
            extensionWidgets: new Map(), extensionDialogs: [], extensionNotices: [], extensionErrors: [],
            extensionPanels: new Map(), extensionApps: new Map(), queue: { steering: 0, followUp: 0 },
          }]]),
          lastSequence: new Map([['s1', cursor]]),
        },
        hydratedSessionIds: new Set(['s1']),
        sendStateById: new Map([['s1', { ...sendRecord('confirming', 'op-live-1'), runtimeKey: getRuntimeKey() }]]),
      } as never;
      (store as unknown as { stream: unknown }).stream = { dispose: () => undefined };
      const commit = (store as unknown as { commitEvents: (events: unknown[]) => void }).commitEvents.bind(store);
      commit([{
        protocolVersion: 1, kind: 'event', name: 'session.lifecycle', sequence: 5_001,
        sessionId: 's1', directory: '/repo', streamEpoch: 'epoch-1', payload: { state: 'busy' },
      }]);
      commit([{
        protocolVersion: 1, kind: 'event', name: 'session.lifecycle', sequence: 5_002,
        sessionId: 's1', directory: '/repo', streamEpoch: 'epoch-1', payload: { state: 'idle' },
      }]);
      expect(store.getSendState('s1')?.status).toBe('confirming');
      mockedSendStateById = new Map([['s1', { ...sendRecord('confirming', 'op-live-1'), runtimeKey: getRuntimeKey() }]]);
      const html = renderToString(<SendStateNotice sessionId="s1" />);
      expect(html).toContain('Confirming send');
    } finally {
      store.dispose();
    }
  });

  test('explicit Send as new after unknown mints a fresh id and never reuses the old', () => {
    const store = new PiSessionStore();
    try {
      const internal = store as unknown as {
        state: ReturnType<PiSessionStore['getState']>;
        promptGenerationById: Map<string, number>;
      };
      internal.promptGenerationById = new Map();
      internal.state = {
        ...store.getState(),
        sendStateById: new Map([['s1', { ...sendRecord('outcome-unknown', 'op-old-1'), runtimeKey: getRuntimeKey() }]]),
      } as never;
      mockedSendStateById = new Map([['s1', { ...sendRecord('outcome-unknown', 'op-old-1'), runtimeKey: getRuntimeKey() }]]);
      expect(renderToString(<SendStateNotice sessionId="s1" />)).toContain('Send as new');
      expect(store.getSendState('s1')?.operationId).toBe('op-old-1');
      // The Send-as-new click path. Clearing the unknown record is the
      // consent gate; the next send mints a fresh operation id elsewhere.
      const fresh = store.beginNewSendIntentAfterUnknown('s1');
      expect(fresh).not.toBe('op-old-1');
      expect(store.getSendState('s1')).toBeUndefined();
      mockedSendStateById = new Map();
      expect(renderToString(<SendStateNotice sessionId="s1" />)).toBe('');
    } finally {
      store.dispose();
    }
  });

  test('runtime switch scopes confirmation and invalidates stale callbacks', async () => {
    const store = new PiSessionStore();
    try {
      const internal = store as unknown as {
        state: ReturnType<PiSessionStore['getState']>;
        hydratedSessionIds: Set<string>;
        streamEpoch: string | null;
        pendingPromptById: Set<string>;
        pendingSendIntentById: Map<string, { operationId: string; kind: 'prompt'; runtimeKey: string; generation: number }>;
        promptGenerationById: Map<string, number>;
      };
      internal.hydratedSessionIds = new Set(['s1']);
      internal.streamEpoch = 'epoch-1';
      internal.pendingPromptById = new Set(['s1']);
      internal.pendingSendIntentById = new Map([['s1', { operationId: 'op-runtime-1', kind: 'prompt', runtimeKey: 'foreign-runtime', generation: 1 }]]);
      internal.promptGenerationById = new Map([['s1', 1]]);
      internal.state = {
        ...store.getState(),
        directory: '/repo',
        connection: 'ready' as const,
        sendStateById: new Map([['s1', { ...sendRecord('confirming', 'op-runtime-1'), runtimeKey: getRuntimeKey() }]]),
      } as never;
      (store as unknown as { stream: unknown }).stream = { dispose: () => undefined };
      // A foreign-runtime intent never confirms into this runtime.
      const settled = await store.refreshSendConfirmation('s1');
      expect(settled).toBe(false);
      expect(store.getSendState('s1')?.status).toBe('confirming');

      // A runtime generation bump invalidates in-flight receipt callbacks.
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      piClient.getSendReceipt = (async () => {
        (store as unknown as { runtimeGeneration: number }).runtimeGeneration += 1;
        return { status: 'accepted', streamEpoch: 'epoch-1', receipt: { accepted: true, messageId: 'm-1' } };
      }) as unknown as typeof piClient.getSendReceipt;
      try {
        internal.pendingSendIntentById = new Map([['s1', { operationId: 'op-runtime-2', kind: 'prompt', runtimeKey: getRuntimeKey(), generation: 1 }]]);
        const settledAfterSwitch = await store.refreshSendConfirmation('s1');
        expect(settledAfterSwitch).toBe(false);
        expect(store.getSendState('s1')?.status).toBe('confirming');
      } finally {
        piClient.getSendReceipt = originalReceipt;
      }
    } finally {
      store.dispose();
    }
  });
});

describe('blocked queue notice (mounted)', () => {
  test('legacy entries without authority stay visible with a requeue warning and no auto-send', () => {
    const runtime = getRuntimeKey();
    const key = `${runtime}\n/repo\ns1`;
    mockedQueueByKey = {
      [key]: [{ id: 'queued-legacy-1', content: 'legacy hello', createdAt: 1 }],
    };
    const reason = getQueuedAutoSendBlockedReason(
      { id: 'queued-legacy-1', content: 'legacy hello', createdAt: 1 },
      { runtimeKey: runtime, directory: '/repo', sessionId: 's1' },
      runtime,
      'epoch-1',
    );
    expect(reason).toBe('missing-authority');
    const html = renderToString(<QueuedMessageChips onEditMessage={() => undefined} onSendMessage={() => undefined} />);
    expect(html).toContain('Queued messages');
    expect(html).toContain('Saved before send confirmation');
    expect(html).toContain('may duplicate');
    expect(html).toContain('Send as new');
  });
});
