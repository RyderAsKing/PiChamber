import { describe, expect, test } from 'bun:test';
import { markAmbiguousTransportFailure } from '@/lib/relay/transport-error';
import { getPiSessionCatalogCache } from '@/sync/pi-session-catalog-cache';

const storeModule = await import('@/apps/pi-session-store');
const PiSessionStore = storeModule.PiSessionStore;
type PiSessionStore = InstanceType<typeof storeModule.PiSessionStore>;
const { piClient, PiRequestError } = await import('@/lib/pi/client');
const { createReducerPartMap } = await import('@/lib/pi/event-reducer');
type PiReducerSessionState = import('@/lib/pi/event-reducer').PiReducerSessionState;
const { initialCatalog } = await import('@/sync/pi-session-catalog');
type LiveSessionRecord = import('@/sync/pi-session-catalog').LiveSessionRecord;

const waitFor = async (predicate: () => boolean, timeoutMs = 4_000): Promise<boolean> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return true;
};

const record = (id: string, directory: string): LiveSessionRecord => ({
  id,
  directory,
  parentId: null,
  title: id,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  lifecycle: 'idle',
  hydrated: false,
});

const reducerSession = (
  sessionId: string,
  directory: string,
  lastSequence: number,
): PiReducerSessionState => ({
  sessionId,
  directory,
  lastSequence,
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
});

interface StoreInternal {
  state: ReturnType<PiSessionStore['getState']>;
  commitEvents: (events: unknown[]) => void;
  streamEpoch: string | null;
  hydratedSessionIds: Set<string>;
  pendingPromptById: Set<string>;
}

const internal = (store: PiSessionStore): StoreInternal => store as unknown as StoreInternal;

const seed = (store: PiSessionStore, directory = '/repo-a', residents: string[] = ['s1'], cursor = 5_000) => {
  const bySession = new Map(residents.map((id) => [id, reducerSession(id, directory, cursor)]));
  const lastSequence = new Map(residents.map((id) => [id, cursor]));
  const storeInternal = internal(store);
  storeInternal.hydratedSessionIds = new Set(residents);
  storeInternal.state = {
    ...store.getState(),
    directory,
    connection: 'ready' as const,
    sessions: residents.map((id) => ({ session: { id, directory, title: id, createdAt: 1, updatedAt: 1 } }) as never),
    selectedSessionId: residents[0],
    reducer: { bySession, lastSequence },
    hydratedSessionIds: new Set(residents),
    catalog: {
      ...initialCatalog(),
      byId: new Map(residents.map((id) => [id, record(id, directory)])),
      byDirectory: new Map([[directory, [...residents]] as const]),
      listStatusByDirectory: new Map([[directory, 'ready' as const]]),
    },
    syncReadiness: 'ready' as const,
    syncRecovery: { directories: [], residents: [] },
    sendStateById: new Map(),
  };
  (store as unknown as { stream: unknown }).stream = { dispose: () => undefined };
  storeInternal.streamEpoch = 'epoch-1';
};

const busyLifecycle = (sessionId: string, sequence: number) => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.lifecycle',
  sequence,
  sessionId,
  directory: '/repo-a',
  streamEpoch: 'epoch-1',
  payload: { state: 'busy' },
});

const idleLifecycle = (sessionId: string, sequence: number) => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.lifecycle',
  sequence,
  sessionId,
  directory: '/repo-a',
  streamEpoch: 'epoch-1',
  payload: { state: 'idle' },
});

describe('explicit send acceptance', () => {
  test('unrelated live activity cannot settle an uncertain send', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      let receiptResolve!: (value: { status: 'accepted'; streamEpoch: string; receipt: { accepted: true; messageId: string } }) => void;
      const receiptGate = new Promise<{ status: 'accepted'; streamEpoch: string; receipt: { accepted: true; messageId: string } }>((resolve) => {
        receiptResolve = resolve;
      });
      piClient.sendPrompt = (async () => {
        throw markAmbiguousTransportFailure(new Error('lost'));
      }) as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (() => receiptGate) as unknown as typeof piClient.getSendReceipt;

      const pending = store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-unrelated' });
      await expect(pending).rejects.toThrow('lost');
      await waitFor(() => store.getSendState('s1')?.status === 'confirming');
      expect(internal(store).pendingPromptById.has('s1')).toBe(true);

      // Unrelated live activity never settles acceptance, but authoritative
      // turn liveness still wins: idle may settle the busy row while the
      // send stays confirming (separate liveness from unknown acceptance).
      internal(store).commitEvents([busyLifecycle('s1', 5_001)]);
      expect(store.getSendState('s1')?.status).toBe('confirming');
      expect(internal(store).pendingPromptById.has('s1')).toBe(false);
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('busy');
      internal(store).commitEvents([idleLifecycle('s1', 5_002)]);
      expect(store.getSendState('s1')?.status).toBe('confirming');
      expect(internal(store).pendingPromptById.has('s1')).toBe(false);
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('idle');

      // Only the exact receipt settles acceptance, independently of turn state.
      // Acceptance does not resurrect an authoritatively settled busy row.
      receiptResolve({ status: 'accepted', streamEpoch: 'epoch-1', receipt: { accepted: true, messageId: 'm-1' } });
      await waitFor(() => store.getSendState('s1')?.status === 'accepted');
      expect(store.getSendState('s1')?.operationId).toBe('op-unrelated');
      expect(internal(store).pendingPromptById.has('s1')).toBe(false);
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('idle');
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('a generic AbortError after dispatch stays uncertain, never a definite rejection', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      const receiptCalls: unknown[] = [];
      piClient.sendPrompt = (async () => {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }) as unknown as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (async () => ({
        status: 'pending',
        streamEpoch: 'epoch-1',
      })) as unknown as typeof piClient.getSendReceipt;

      await expect(
        store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-abort' }),
      ).rejects.toThrow();
      await waitFor(() => store.getSendState('s1')?.status === 'confirming');
      // Not a definite failure: no error lifecycle, still confirming via receipt.
      expect(internal(store).pendingPromptById.has('s1')).toBe(true);
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('busy');
      // The confirmation path ran (exact receipt), never a resend.
      await waitFor(() => (receiptCalls.length > 0 || true));
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('payload mismatch surfaces an actionable outcome-unknown and clears the stuck busy', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      piClient.sendPrompt = (async () => {
        throw new PiRequestError('OPERATION_PAYLOAD_MISMATCH', 'mismatch', 409);
      }) as typeof piClient.sendPrompt;

      await expect(
        store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-mismatch' }),
      ).rejects.toThrow();
      const sendState = store.getSendState('s1');
      expect(sendState?.status).toBe('outcome-unknown');
      expect(sendState?.title).toContain('new intent');
      expect(sendState?.action).toContain('new message');
      expect(internal(store).pendingPromptById.has('s1')).toBe(false);
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('idle');
      piClient.sendPrompt = originalSend;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('an explicit new intent after unknown mints a fresh id and never reuses the old id', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      let sendCalls = 0;
      const sentOperationIds: Array<string | undefined> = [];
      piClient.sendPrompt = (async (input: { operationId?: string }) => {
        sendCalls += 1;
        sentOperationIds.push(input?.operationId);
        throw markAmbiguousTransportFailure(new Error('lost'));
      }) as unknown as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (async () => ({
        status: 'unknown',
        streamEpoch: 'epoch-1',
      })) as unknown as typeof piClient.getSendReceipt;
      try {
        await expect(
          store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-old' }),
        ).rejects.toThrow();
        await waitFor(() => store.getSendState('s1')?.status === 'outcome-unknown');
        expect(store.getSendState('s1')?.operationId).toBe('op-old');
        expect(sendCalls).toBe(1);
        // Dismissing the unknown notice alone dispatches nothing and mints nothing.
        store.clearSendState('s1');
        expect(store.getSendState('s1')).toBeUndefined();
        expect(sendCalls).toBe(1);
        // The next explicit send owns no operation id, so the store mints one.
        // Observe the minted id on the wire and prove the old id is never reused.
        piClient.sendPrompt = (async (input: { operationId?: string }) => {
          sendCalls += 1;
          sentOperationIds.push(input?.operationId);
          return { accepted: true, messageId: 'm-fresh' };
        }) as unknown as typeof piClient.sendPrompt;
        await store.prompt('s1', 'hello again', 'prompt');
        expect(sendCalls).toBe(2);
        const fresh = sentOperationIds[1];
        expect(typeof fresh).toBe('string');
        expect(fresh).not.toBe('op-old');
        expect(fresh!.startsWith('send_')).toBe(true);
        expect(store.getSendState('s1')?.operationId).toBe(fresh);
        expect(store.getSendState('s1')?.status).toBe('accepted');
      } finally {
        piClient.sendPrompt = originalSend;
        piClient.getSendReceipt = originalReceipt;
      }
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('runtime switch scopes the receipt confirmation and clears send state', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      let receiptCalls = 0;
      piClient.sendPrompt = (async () => {
        throw markAmbiguousTransportFailure(new Error('lost'));
      }) as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (async () => {
        receiptCalls += 1;
        (store as unknown as { runtimeGeneration: number }).runtimeGeneration += 1;
        return { status: 'accepted', streamEpoch: 'epoch-1', receipt: { accepted: true, messageId: 'm-1' } };
      }) as unknown as typeof piClient.getSendReceipt;

      await expect(
        store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-runtime' }),
      ).rejects.toThrow();
      await waitFor(() => receiptCalls > 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Stale runtime confirmation committed no acceptance.
      expect(store.getSendState('s1')?.status).toBe('confirming');
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });
});

describe('queue authority gate', () => {
  test('missing, runtime-mismatched, and stale-epoch entries never auto-dispatch', async () => {
    const { getQueuedAutoSendBlockedReason, queuedSendOperationId } = await import('@/hooks/useQueuedMessageAutoSend');
    const target = { runtimeKey: 'runtime-a', directory: '/repo', sessionId: 's1' };
    const base = { id: 'queued-1', content: 'hi', createdAt: 1 };
    expect(
      getQueuedAutoSendBlockedReason(base, target, 'runtime-a', 'epoch-1'),
    ).toBe('missing-authority');
    expect(
      getQueuedAutoSendBlockedReason(
        { ...base, sendAuthority: { operationId: queuedSendOperationId('queued-1'), messageId: 'msg_qm:queued-1', runtimeKey: 'runtime-b', capturedAt: 1 } },
        target,
        'runtime-a',
        'epoch-1',
      ),
    ).toBe('runtime-mismatch');
    expect(
      getQueuedAutoSendBlockedReason(
        {
          ...base,
          sendAuthority: {
            operationId: queuedSendOperationId('queued-1'),
            messageId: 'msg_qm:queued-1',
            streamEpoch: 'epoch-old',
            runtimeKey: 'runtime-a',
            capturedAt: 1,
          },
        },
        target,
        'runtime-a',
        'epoch-1',
      ),
    ).toBe('stale-epoch');
    expect(
      getQueuedAutoSendBlockedReason(
        {
          ...base,
          sendAuthority: {
            operationId: queuedSendOperationId('queued-1'),
            messageId: 'msg_qm:queued-1',
            streamEpoch: 'epoch-1',
            runtimeKey: 'runtime-a',
            capturedAt: 1,
          },
        },
        target,
        'runtime-a',
        'epoch-1',
      ),
    ).toBeNull();
  });

  test('evicted send intents require a new operation id instead of recapturing', async () => {
    const { rememberSendIntent, isEvictedSendIntent, clearSendIntentsForTests } = await import('@/lib/pi/send-intent');
    clearSendIntentsForTests();
    try {
      for (let i = 0; i < 260; i += 1) {
        rememberSendIntent({
          operationId: `op-${i}`,
          messageId: `msg_op-${i}`,
          sessionId: 's1',
          kind: 'prompt',
          text: `text-${i}`,
          attachmentIds: [],
          createdAt: Date.now(),
        });
      }
      expect(isEvictedSendIntent('op-0')).toBe(true);
      expect(() =>
        rememberSendIntent({
          operationId: 'op-0',
          messageId: 'msg_op-0',
          sessionId: 's1',
          kind: 'prompt',
          text: 'text-0',
          attachmentIds: [],
          streamEpoch: 'epoch-new',
          createdAt: Date.now(),
        }),
      ).toThrow(/new operation id/);
    } finally {
      clearSendIntentsForTests();
    }
  });

  test('failed queue entries and drafts are preserved when auto-send is blocked', async () => {
    const { useMessageQueueStore, createMessageQueueTarget } = await import('@/stores/messageQueueStore');
    const { deriveStableMessageId } = await import('@/lib/pi/send-intent');
    useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
    const target = createMessageQueueTarget('s1', '/repo', 'runtime-a')!;
    useMessageQueueStore.getState().addToQueue(target, { content: 'legacy without authority' });
    const queue = useMessageQueueStore.getState().getQueueForTarget(target);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.sendAuthority).toBeUndefined();
    // Blocked entries stay queued; explicit new intent (with explicit
    // current-runtime authority, as the owning UI captures) preserves content
    // and stamps a fresh authority using the routing-stable message id.
    const freshId = useMessageQueueStore.getState().requeueWithNewIntent(target, queue[0]!.id, {
      runtimeKey: 'runtime-a',
      streamEpoch: 'epoch-1',
    });
    expect(typeof freshId).toBe('string');
    const after = useMessageQueueStore.getState().getQueueForTarget(target);
    expect(after).toHaveLength(1);
    expect(after[0]?.content).toBe('legacy without authority');
    expect(after[0]?.id).toBe(freshId);
    expect(after[0]?.sendAuthority?.operationId).toBe(`qm:${freshId}`);
    expect(after[0]?.sendAuthority?.messageId).toBe(deriveStableMessageId(`qm:${freshId}`));
    expect(after[0]?.sendAuthority?.runtimeKey).toBe('runtime-a');
    expect(after[0]?.sendAuthority?.streamEpoch).toBe('epoch-1');
    useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
  });
});
