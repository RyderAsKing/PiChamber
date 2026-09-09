import { describe, expect, test } from 'bun:test';
import { markAmbiguousTransportFailure } from '@/lib/relay/transport-error';
import { getPiSessionCatalogCache } from '@/sync/pi-session-catalog-cache';

// Send ownership + automatic receipt recovery (overlapping protection,
// bounded read-only retries, single-flight, cleanup, and liveness separation).
// Self-contained (bun test --isolate): piClient methods are monkey-patched on
// the singleton, everything else is the real store code.

const storeModule = await import('@/apps/pi-session-store');
const PiSessionStore = storeModule.PiSessionStore;
type PiSessionStore = InstanceType<typeof storeModule.PiSessionStore>;
const { piClient, PiRequestError } = await import('@/lib/pi/client');
const { createReducerPartMap } = await import('@/lib/pi/event-reducer');
type PiReducerSessionState = import('@/lib/pi/event-reducer').PiReducerSessionState;
const { initialCatalog } = await import('@/sync/pi-session-catalog');
type LiveSessionRecord = import('@/sync/pi-session-catalog').LiveSessionRecord;

const waitFor = async (predicate: () => boolean, timeoutMs = 6_000): Promise<boolean> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
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
  stream: { dispose: () => void } | null;
  streamEpoch: string | null;
  streamGeneration: number;
  hydratedSessionIds: Set<string>;
  pendingPromptById: Set<string>;
  pendingSendIntentById: Map<string, { operationId: string; generation: number; runtimeKey: string }>;
  promptGenerationById: Map<string, number>;
}

const internal = (store: PiSessionStore): StoreInternal => store as unknown as StoreInternal;

const seed = (store: PiSessionStore, residents: string[] = ['s1'], cursor = 5_000) => {
  const directory = '/repo-a';
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
  };
  storeInternal.stream = { dispose: () => undefined };
  storeInternal.streamEpoch = 'epoch-1';
  storeInternal.streamGeneration = 7;
};

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

describe('send ownership + receipt recovery', () => {
  test('overlapping distinct send is rejected locally and preserves the winner', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      let sendCalls = 0;
      let receiptCalls = 0;
      let receiptResolve!: (value: { status: 'accepted'; streamEpoch: string; receipt: { accepted: true; messageId: string } }) => void;
      const receiptGate = new Promise<{ status: 'accepted'; streamEpoch: string; receipt: { accepted: true; messageId: string } }>((resolve) => {
        receiptResolve = resolve;
      });
      piClient.sendPrompt = (async () => {
        sendCalls += 1;
        throw markAmbiguousTransportFailure(new Error('lost-A'));
      }) as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (async () => {
        receiptCalls += 1;
        return receiptGate;
      }) as unknown as typeof piClient.getSendReceipt;

      await expect(store.prompt('s1', 'first', 'prompt', undefined, { operationId: 'op-A' })).rejects.toThrow('lost-A');
      await waitFor(() => store.getSendState('s1')?.status === 'confirming');
      const generationAfterA = internal(store).promptGenerationById.get('s1');
      expect(sendCalls).toBe(1);
      await waitFor(() => receiptCalls >= 1);

      // Newer distinct prompt while A is confirming must not overwrite.
      const loser = await store.prompt('s1', 'second', 'prompt', undefined, { operationId: 'op-B' }).then(
        () => null,
        (error: unknown) => error,
      );
      expect((loser as { code?: string }).code).toBe('SESSION_BUSY');
      // No second daemon send; winner's generation/intent/send-state intact.
      expect(sendCalls).toBe(1);
      expect(internal(store).promptGenerationById.get('s1')).toBe(generationAfterA);
      expect(internal(store).pendingSendIntentById.get('s1')?.operationId).toBe('op-A');
      expect(store.getSendState('s1')?.operationId).toBe('op-A');
      expect(store.getSendState('s1')?.status).toBe('confirming');
      expect(internal(store).pendingPromptById.has('s1')).toBe(true);

      // Winner's receipt still settles (generation not invalidated by loser).
      receiptResolve({ status: 'accepted', streamEpoch: 'epoch-1', receipt: { accepted: true, messageId: 'm-A' } });
      await waitFor(() => store.getSendState('s1')?.status === 'accepted');
      expect(store.getSendState('s1')?.operationId).toBe('op-A');
      expect(sendCalls).toBe(1);
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('same-operation retry reuses authority and stays single-flight', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      let sendCalls = 0;
      const sendInputs: unknown[] = [];
      let receiptCalls = 0;
      let receiptResolve!: (value: { status: 'accepted'; streamEpoch: string; receipt: { accepted: true; messageId: string } }) => void;
      const receiptGate = new Promise<{ status: 'accepted'; streamEpoch: string; receipt: { accepted: true; messageId: string } }>((resolve) => {
        receiptResolve = resolve;
      });
      piClient.sendPrompt = (async (input: unknown) => {
        sendCalls += 1;
        sendInputs.push(input);
        throw markAmbiguousTransportFailure(new Error(`lost-${sendCalls}`));
      }) as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (async () => {
        receiptCalls += 1;
        return receiptGate;
      }) as unknown as typeof piClient.getSendReceipt;

      await expect(store.prompt('s1', 'same', 'prompt', undefined, { operationId: 'op-same' })).rejects.toThrow('lost-1');
      await waitFor(() => receiptCalls >= 1);
      const generationFirst = internal(store).promptGenerationById.get('s1');

      // Same operation id retries safely: no SESSION_BUSY, same generation,
      // same message id/epoch, daemon deduplicates (second send allowed).
      await expect(store.prompt('s1', 'same', 'prompt', undefined, { operationId: 'op-same' })).rejects.toThrow('lost-2');
      expect(sendCalls).toBe(2);
      expect(internal(store).promptGenerationById.get('s1')).toBe(generationFirst);
      expect(internal(store).pendingSendIntentById.get('s1')?.operationId).toBe('op-same');
      expect(store.getSendState('s1')?.operationId).toBe('op-same');
      const firstInput = sendInputs[0] as { messageId?: string; streamEpoch?: string; operationId?: string };
      const secondInput = sendInputs[1] as { messageId?: string; streamEpoch?: string; operationId?: string };
      expect(secondInput.operationId).toBe('op-same');
      expect(secondInput.messageId).toBe(firstInput.messageId);
      expect(secondInput.streamEpoch).toBe(firstInput.streamEpoch);
      // Single-flight: second uncertain did not start a concurrent receipt fetch.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(receiptCalls).toBe(1);

      receiptResolve({ status: 'accepted', streamEpoch: 'epoch-1', receipt: { accepted: true, messageId: 'm-same' } });
      await waitFor(() => store.getSendState('s1')?.status === 'accepted');
      expect(store.getSendState('s1')?.operationId).toBe('op-same');
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('legitimate steer after acceptance is not blocked', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalPrompt = piClient.sendPrompt.bind(piClient);
      const originalSteer = piClient.sendSteer.bind(piClient);
      piClient.sendPrompt = (async () => ({ accepted: true, messageId: 'm-1' })) as typeof piClient.sendPrompt;
      piClient.sendSteer = (async () => ({ accepted: true, messageId: 'm-2' })) as typeof piClient.sendSteer;

      await store.prompt('s1', 'first', 'prompt', undefined, { operationId: 'op-first' });
      expect(store.getSendState('s1')?.status).toBe('accepted');
      expect(store.getSendState('s1')?.operationId).toBe('op-first');

      await store.prompt('s1', 'steer me', 'steer', undefined, { operationId: 'op-steer-1' });
      expect(store.getSendState('s1')?.status).toBe('accepted');
      expect(store.getSendState('s1')?.operationId).toBe('op-steer-1');
      expect(store.getSendState('s1')?.kind).toBe('steer');
      piClient.sendPrompt = originalPrompt;
      piClient.sendSteer = originalSteer;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('pending then accepted via automatic retry never resends', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      let sendCalls = 0;
      const receiptStatuses: string[] = [];
      let calls = 0;
      piClient.sendPrompt = (async () => {
        sendCalls += 1;
        throw markAmbiguousTransportFailure(new Error('lost'));
      }) as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (async () => {
        calls += 1;
        receiptStatuses.push(calls === 1 ? 'pending' : 'accepted');
        if (calls === 1) return { status: 'pending', streamEpoch: 'epoch-1' };
        return { status: 'accepted', streamEpoch: 'epoch-1', receipt: { accepted: true, messageId: 'm-1' } };
      }) as unknown as typeof piClient.getSendReceipt;

      await expect(store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-pending-accept' })).rejects.toThrow('lost');
      await waitFor(() => store.getSendState('s1')?.status === 'accepted');
      expect(sendCalls).toBe(1);
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(receiptStatuses[0]).toBe('pending');
      expect(store.getSendState('s1')?.operationId).toBe('op-pending-accept');
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('lookup failure then accepted via automatic retry never resends', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      let sendCalls = 0;
      let receiptCalls = 0;
      piClient.sendPrompt = (async () => {
        sendCalls += 1;
        throw markAmbiguousTransportFailure(new Error('lost'));
      }) as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (async () => {
        receiptCalls += 1;
        if (receiptCalls === 1) throw new Error('receipt network down');
        return { status: 'accepted', streamEpoch: 'epoch-1', receipt: { accepted: true, messageId: 'm-1' } };
      }) as unknown as typeof piClient.getSendReceipt;

      await expect(store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-fail-accept' })).rejects.toThrow('lost');
      await waitFor(() => store.getSendState('s1')?.status === 'accepted');
      expect(sendCalls).toBe(1);
      expect(receiptCalls).toBeGreaterThanOrEqual(2);
      expect(store.getSendState('s1')?.operationId).toBe('op-fail-accept');
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('receipt failure exhaustion parks bounded without resending', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      let sendCalls = 0;
      let receiptCalls = 0;
      piClient.sendPrompt = (async () => {
        sendCalls += 1;
        throw markAmbiguousTransportFailure(new Error('lost'));
      }) as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (async () => {
        receiptCalls += 1;
        throw new Error(`receipt down ${receiptCalls}`);
      }) as unknown as typeof piClient.getSendReceipt;

      await expect(store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-exhaust' })).rejects.toThrow('lost');
      // Bounded: exactly max attempts, then parks (no endless loop).
      await waitFor(() => receiptCalls >= 5, 8_000);
      const parkedAt = receiptCalls;
      expect(parkedAt).toBe(5);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(receiptCalls).toBe(parkedAt);
      expect(sendCalls).toBe(1);
      expect(store.getSendState('s1')?.status).toBe('confirming');
      expect(store.getSendState('s1')?.operationId).toBe('op-exhaust');
      expect(internal(store).pendingPromptById.has('s1')).toBe(true);
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('authoritative idle settles busy without confirming the send', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      let receiptResolve!: (value: { status: 'pending'; streamEpoch: string }) => void;
      const receiptGate = new Promise<{ status: 'pending'; streamEpoch: string }>((resolve) => {
        receiptResolve = resolve;
      });
      piClient.sendPrompt = (async () => {
        throw markAmbiguousTransportFailure(new Error('lost'));
      }) as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (() => receiptGate) as unknown as typeof piClient.getSendReceipt;

      await expect(store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-idle' })).rejects.toThrow('lost');
      await waitFor(() => store.getSendState('s1')?.status === 'confirming');
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('busy');

      internal(store).commitEvents([idleLifecycle('s1', 5_001)]);
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('idle');
      expect(store.getSendState('s1')?.status).toBe('confirming');
      expect(store.getSendState('s1')?.operationId).toBe('op-idle');
      expect(internal(store).pendingPromptById.has('s1')).toBe(false);

      receiptResolve({ status: 'pending', streamEpoch: 'epoch-1' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      // Pending keeps confirming; idle stays settled (no busy resurrection).
      expect(store.getSendState('s1')?.status).toBe('confirming');
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('idle');
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('runtime switch cancels polling without settling stale acceptance', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      let receiptCalls = 0;
      let receiptResolve!: (value: { status: 'accepted'; streamEpoch: string; receipt: { accepted: true; messageId: string } }) => void;
      const receiptGate = new Promise<{ status: 'accepted'; streamEpoch: string; receipt: { accepted: true; messageId: string } }>((resolve) => {
        receiptResolve = resolve;
      });
      piClient.sendPrompt = (async () => {
        throw markAmbiguousTransportFailure(new Error('lost'));
      }) as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (async () => {
        receiptCalls += 1;
        return receiptGate;
      }) as unknown as typeof piClient.getSendReceipt;

      await expect(store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-runtime-cancel' })).rejects.toThrow('lost');
      await waitFor(() => receiptCalls >= 1);
      (store as unknown as { runtimeGeneration: number }).runtimeGeneration += 1;
      receiptResolve({ status: 'accepted', streamEpoch: 'epoch-1', receipt: { accepted: true, messageId: 'm-1' } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(store.getSendState('s1')?.status).toBe('confirming');
      expect(internal(store).pendingPromptById.has('s1')).toBe(true);
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('deletion cancels polling and blocks resurrection', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      let sendCalls = 0;
      let receiptCalls = 0;
      piClient.sendPrompt = (async () => {
        sendCalls += 1;
        throw markAmbiguousTransportFailure(new Error('lost'));
      }) as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (async () => {
        receiptCalls += 1;
        return { status: 'pending', streamEpoch: 'epoch-1' };
      }) as unknown as typeof piClient.getSendReceipt;

      await expect(store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-delete' })).rejects.toThrow('lost');
      await waitFor(() => receiptCalls >= 1);
      expect(store.getSendState('s1')?.status).toBe('confirming');

      store.commitMissedDeletion('s1', '/repo-a');
      expect(store.isDeleted('s1')).toBe(true);
      expect(store.getSendState('s1')).toBeUndefined();
      const callsAtDelete = receiptCalls;
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(receiptCalls).toBe(callsAtDelete);
      expect(sendCalls).toBe(1);
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('dispose cancels polling without further receipt checks', async () => {
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
        return { status: 'pending', streamEpoch: 'epoch-1' };
      }) as unknown as typeof piClient.getSendReceipt;

      await expect(store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-dispose' })).rejects.toThrow('lost');
      await waitFor(() => receiptCalls >= 1);
      const callsAtDispose = receiptCalls;
      store.dispose();
      await new Promise((resolve) => setTimeout(resolve, 600));
      // Dispose cleared timers; at most the in-flight fetch (already counted)
      // may have completed, never a new scheduled check.
      expect(receiptCalls <= callsAtDispose + 1).toBe(true);
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      try {
        store.dispose();
      } catch {
        // Already disposed; second dispose is idempotent for the test.
      }
      getPiSessionCatalogCache().dispose();
    }
  });

  test('SESSION_BUSY loser preserves the winner turn and send state', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalPrompt = piClient.sendPrompt.bind(piClient);
      const originalSteer = piClient.sendSteer.bind(piClient);
      piClient.sendPrompt = (async () => ({ accepted: true, messageId: 'm-1' })) as typeof piClient.sendPrompt;
      // Winner accepted and turn running (busy). Loser steer fails busy.
      await store.prompt('s1', 'first', 'prompt', undefined, { operationId: 'op-winner' });
      expect(store.getSendState('s1')?.operationId).toBe('op-winner');
      piClient.sendSteer = (async () => {
        throw new PiRequestError('SESSION_BUSY', 'busy', 409);
      }) as typeof piClient.sendSteer;

      const loser = await store.prompt('s1', 'steer late', 'steer', undefined, { operationId: 'op-loser' }).then(
        () => null,
        (error: unknown) => error,
      );
      expect((loser as { code?: string }).code).toBe('SESSION_BUSY');
      // Loser records its own rejected state but must not flip the winner's
      // running turn to error nor drop its pending protection.
      expect(store.getSendState('s1')?.operationId).toBe('op-loser');
      expect(store.getSendState('s1')?.status).toBe('rejected');
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('busy');
      expect(internal(store).pendingPromptById.has('s1')).toBe(true);
      piClient.sendPrompt = originalPrompt;
      piClient.sendSteer = originalSteer;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('heartbeat during dispatch makes zero receipt calls', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      let sendResolve!: (value: { accepted: true; messageId: string }) => void;
      const sendGate = new Promise<{ accepted: true; messageId: string }>((resolve) => { sendResolve = resolve; });
      let receiptCalls = 0;
      piClient.sendPrompt = (() => sendGate) as unknown as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (async () => {
        receiptCalls += 1;
        return { status: 'accepted', streamEpoch: 'epoch-1', receipt: { accepted: true, messageId: 'm-1' } };
      }) as unknown as typeof piClient.getSendReceipt;
      const task = store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-heartbeat' });
      await waitFor(() => store.getSendState('s1')?.status === 'confirming');
      (store as unknown as { retryPendingSendReceipts: () => void }).retryPendingSendReceipts();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(receiptCalls).toBe(0);
      sendResolve({ accepted: true, messageId: 'm-1' });
      await task;
      expect(store.getSendState('s1')?.status).toBe('accepted');
      expect(receiptCalls).toBe(0);
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('same id accepted retry dedups at daemon instead of local expired', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      let sendCalls = 0;
      piClient.sendPrompt = (async () => {
        sendCalls += 1;
        return { accepted: true, messageId: 'm-1' };
      }) as unknown as typeof piClient.sendPrompt;
      await store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-dedup' });
      expect(store.getSendState('s1')?.status).toBe('accepted');
      await store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-dedup' });
      expect(sendCalls).toBe(2);
      expect(store.getSendState('s1')?.status).toBe('accepted');
      expect(store.getSendState('s1')?.operationId).toBe('op-dedup');
      piClient.sendPrompt = originalSend;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('cross-session same id keeps separate polls and stale completion cannot clear new flight', async () => {
    const store = new PiSessionStore();
    try {
      seed(store, ['s1', 's2']);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      piClient.sendPrompt = (async () => {
        throw markAmbiguousTransportFailure(new Error('lost'));
      }) as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (async () => ({
        status: 'accepted', streamEpoch: 'epoch-1', receipt: { accepted: true, messageId: 'm-1' },
      })) as unknown as typeof piClient.getSendReceipt;
      await expect(store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-shared' })).rejects.toThrow();
      await expect(store.prompt('s2', 'hello', 'prompt', undefined, { operationId: 'op-shared' })).rejects.toThrow();
      await waitFor(() => store.getSendState('s1')?.status === 'accepted');
      await waitFor(() => store.getSendState('s2')?.status === 'accepted');
      expect(store.getSendState('s1')?.operationId).toBe('op-shared');
      expect(store.getSendState('s2')?.operationId).toBe('op-shared');
      const polls = (store as unknown as { sendReceiptPollBySession: Map<string, unknown> }).sendReceiptPollBySession;
      expect(polls.size).toBe(0);
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('stale receipt after runtime reset cannot settle new poll with same id', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      let receiptResolve!: (value: { status: 'accepted'; streamEpoch: string; receipt: { accepted: true; messageId: string } }) => void;
      const receiptGate = new Promise<{ status: 'accepted'; streamEpoch: string; receipt: { accepted: true; messageId: string } }>((resolve) => { receiptResolve = resolve; });
      piClient.sendPrompt = (async () => {
        throw markAmbiguousTransportFailure(new Error('lost'));
      }) as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (() => receiptGate) as unknown as typeof piClient.getSendReceipt;
      await expect(store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-stale' })).rejects.toThrow();
      await waitFor(() => store.getSendState('s1')?.status === 'confirming');
      const oldPoll = (store as unknown as { sendReceiptPollBySession: Map<string, object> }).sendReceiptPollBySession.get('s1');
      expect(oldPoll).toBeDefined();
      (store as unknown as { runtimeGeneration: number }).runtimeGeneration += 1;
      receiptResolve({ status: 'accepted', streamEpoch: 'epoch-1', receipt: { accepted: true, messageId: 'm-1' } });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(store.getSendState('s1')?.status).toBe('confirming');
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('manual refresh still settles confirming via exact receipt', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      let gateOpen = false;
      piClient.sendPrompt = (async () => {
        throw markAmbiguousTransportFailure(new Error('lost'));
      }) as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (async () => {
        if (!gateOpen) return { status: 'pending', streamEpoch: 'epoch-1' };
        return { status: 'accepted', streamEpoch: 'epoch-1', receipt: { accepted: true, messageId: 'm-1' } };
      }) as unknown as typeof piClient.getSendReceipt;
      await expect(store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-manual' })).rejects.toThrow();
      await waitFor(() => store.getSendState('s1')?.status === 'confirming');
      gateOpen = true;
      const settled = await store.refreshSendConfirmation('s1');
      expect(settled).toBe(true);
      expect(store.getSendState('s1')?.status).toBe('accepted');
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('manual Check after exhaustion fetches then settles', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      let sendCalls = 0;
      let receiptCalls = 0;
      let allowAccept = false;
      piClient.sendPrompt = (async () => {
        sendCalls += 1;
        throw markAmbiguousTransportFailure(new Error('lost-exhausted'));
      }) as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (async () => {
        receiptCalls += 1;
        if (!allowAccept) throw new Error(`receipt down ${receiptCalls}`);
        return { status: 'accepted', streamEpoch: 'epoch-1', receipt: { accepted: true, messageId: 'm-exhausted' } };
      }) as unknown as typeof piClient.getSendReceipt;

      await expect(
        store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-manual-exhausted' }),
      ).rejects.toThrow('lost-exhausted');
      // Public observable: still confirming while automatic retries run.
      await waitFor(() => store.getSendState('s1')?.status === 'confirming');
      // Bounded automatic retries park at exactly 5 without resending.
      await waitFor(() => receiptCalls >= 5, 8_000);
      expect(receiptCalls).toBe(5);
      expect(sendCalls).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(receiptCalls).toBe(5);
      expect(store.getSendState('s1')?.status).toBe('confirming');
      expect(store.getSendState('s1')?.operationId).toBe('op-manual-exhausted');

      // Manual Check must fetch again (attempt 6) and settle via the exact receipt.
      allowAccept = true;
      const settled = await store.refreshSendConfirmation('s1');
      expect(settled).toBe(true);
      expect(receiptCalls).toBeGreaterThanOrEqual(6);
      expect(store.getSendState('s1')?.status).toBe('accepted');
      expect(store.getSendState('s1')?.operationId).toBe('op-manual-exhausted');
      expect(sendCalls).toBe(1);
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('manual Check while dispatch pending makes zero receipt calls and later accepted survives', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      let sendResolve!: (value: { accepted: true; messageId: string }) => void;
      const sendGate = new Promise<{ accepted: true; messageId: string }>((resolve) => {
        sendResolve = resolve;
      });
      let receiptCalls = 0;
      piClient.sendPrompt = (() => sendGate) as unknown as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (async () => {
        receiptCalls += 1;
        return { status: 'pending', streamEpoch: 'epoch-1' };
      }) as unknown as typeof piClient.getSendReceipt;

      const task = store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-dispatch-pending' });
      await waitFor(() => store.getSendState('s1')?.status === 'confirming');
      // Manual Check during the initial HTTP dispatch must not start a receipt read.
      const settled = await store.refreshSendConfirmation('s1');
      expect(settled).toBe(false);
      expect(receiptCalls).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(receiptCalls).toBe(0);
      expect(store.getSendState('s1')?.status).toBe('confirming');

      // The in-flight HTTP acceptance still settles without receipt interference.
      sendResolve({ accepted: true, messageId: 'm-pending' });
      await task;
      expect(store.getSendState('s1')?.status).toBe('accepted');
      expect(store.getSendState('s1')?.operationId).toBe('op-dispatch-pending');
      expect(receiptCalls).toBe(0);
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('same-op concurrent different delivery rejects OPERATION_PAYLOAD_MISMATCH', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalPrompt = piClient.sendPrompt.bind(piClient);
      const originalSteer = piClient.sendSteer.bind(piClient);
      let sendResolve!: (value: { accepted: true; messageId: string }) => void;
      const sendGate = new Promise<{ accepted: true; messageId: string }>((resolve) => {
        sendResolve = resolve;
      });
      let steerCalls = 0;
      piClient.sendPrompt = (() => sendGate) as unknown as typeof piClient.sendPrompt;
      piClient.sendSteer = (async () => {
        steerCalls += 1;
        return { accepted: true, messageId: 'm-steer' };
      }) as unknown as typeof piClient.sendSteer;

      const winner = store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-payload-delivery' });
      await waitFor(() => store.getSendState('s1')?.status === 'confirming');
      // Concurrent same-op with a different payload must reject instead of
      // inheriting the winner's flight. Start the loser without awaiting so a
      // buggy shared flight cannot deadlock this test: resolving the winner
      // also resolves the shared promise and exposes the wrong inheritance.
      const loserPromise = store
        .prompt('s1', 'hello', 'steer', undefined, { operationId: 'op-payload-delivery' })
        .then(() => null, (error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 20));
      sendResolve({ accepted: true, messageId: 'm-winner' });
      const loser = await loserPromise;
      expect((loser as { code?: string } | null)?.code).toBe('OPERATION_PAYLOAD_MISMATCH');
      expect(steerCalls).toBe(0);

      await winner;
      expect(store.getSendState('s1')?.status).toBe('accepted');
      expect(store.getSendState('s1')?.operationId).toBe('op-payload-delivery');
      expect(store.getSendState('s1')?.kind).toBe('prompt');
      piClient.sendPrompt = originalPrompt;
      piClient.sendSteer = originalSteer;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('same-op concurrent different text rejects OPERATION_PAYLOAD_MISMATCH', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      let sendCalls = 0;
      let sendResolve!: (value: { accepted: true; messageId: string }) => void;
      const sendGate = new Promise<{ accepted: true; messageId: string }>((resolve) => {
        sendResolve = resolve;
      });
      piClient.sendPrompt = (async () => {
        sendCalls += 1;
        return sendGate;
      }) as unknown as typeof piClient.sendPrompt;

      const winner = store.prompt('s1', 'original text', 'prompt', undefined, { operationId: 'op-payload-text' });
      await waitFor(() => store.getSendState('s1')?.status === 'confirming');
      const loserPromise = store
        .prompt('s1', 'different text', 'prompt', undefined, { operationId: 'op-payload-text' })
        .then(() => null, (error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 20));
      sendResolve({ accepted: true, messageId: 'm-text' });
      const loser = await loserPromise;
      expect((loser as { code?: string } | null)?.code).toBe('OPERATION_PAYLOAD_MISMATCH');
      expect(sendCalls).toBe(1);

      await winner;
      expect(store.getSendState('s1')?.status).toBe('accepted');
      expect(store.getSendState('s1')?.operationId).toBe('op-payload-text');
      piClient.sendPrompt = originalSend;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('same-op concurrent different model/thinking rejects OPERATION_PAYLOAD_MISMATCH', async () => {
    for (const variant of ['model', 'thinking'] as const) {
      const store = new PiSessionStore();
      try {
        seed(store);
        const originalSend = piClient.sendPrompt.bind(piClient);
        let sendCalls = 0;
        let sendResolve!: (value: { accepted: true; messageId: string }) => void;
        const sendGate = new Promise<{ accepted: true; messageId: string }>((resolve) => {
          sendResolve = resolve;
        });
        piClient.sendPrompt = (async () => {
          sendCalls += 1;
          return sendGate;
        }) as unknown as typeof piClient.sendPrompt;

        const operationId = variant === 'model' ? 'op-payload-model' : 'op-payload-thinking';
        const winnerOptions =
          variant === 'model'
            ? { operationId, model: { providerId: 'p1', modelId: 'm1' } as const, thinking: 'low' as const }
            : { operationId, model: { providerId: 'p1', modelId: 'm1' } as const, thinking: 'low' as const };
        const loserOptions =
          variant === 'model'
            ? { operationId, model: { providerId: 'p2', modelId: 'm2' } as const, thinking: 'low' as const }
            : { operationId, model: { providerId: 'p1', modelId: 'm1' } as const, thinking: 'high' as const };
        const winner = store.prompt('s1', 'hello', 'prompt', undefined, winnerOptions);
        await waitFor(() => store.getSendState('s1')?.status === 'confirming');
        const loserPromise = store
          .prompt('s1', 'hello', 'prompt', undefined, loserOptions)
          .then(() => null, (error: unknown) => error);
        await new Promise((resolve) => setTimeout(resolve, 20));
        sendResolve({ accepted: true, messageId: `m-${variant}` });
        const loser = await loserPromise;
        expect((loser as { code?: string } | null)?.code).toBe('OPERATION_PAYLOAD_MISMATCH');
        expect(sendCalls).toBe(1);

        await winner;
        expect(store.getSendState('s1')?.status).toBe('accepted');
        expect(store.getSendState('s1')?.operationId).toBe(operationId);
        piClient.sendPrompt = originalSend;
      } finally {
        store.dispose();
        getPiSessionCatalogCache().dispose();
      }
    }
  });

  test('same-op concurrent different attachments rejects OPERATION_PAYLOAD_MISMATCH', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      let sendCalls = 0;
      let sendResolve!: (value: { accepted: true; messageId: string }) => void;
      const sendGate = new Promise<{ accepted: true; messageId: string }>((resolve) => {
        sendResolve = resolve;
      });
      piClient.sendPrompt = (async () => {
        sendCalls += 1;
        return sendGate;
      }) as unknown as typeof piClient.sendPrompt;

      const winner = store.prompt('s1', 'hello', 'prompt', [{ id: 'att-1' }], { operationId: 'op-payload-attachments' });
      await waitFor(() => store.getSendState('s1')?.status === 'confirming');
      const loserPromise = store
        .prompt('s1', 'hello', 'prompt', [{ id: 'att-2' }], { operationId: 'op-payload-attachments' })
        .then(() => null, (error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 20));
      sendResolve({ accepted: true, messageId: 'm-att' });
      const loser = await loserPromise;
      expect((loser as { code?: string } | null)?.code).toBe('OPERATION_PAYLOAD_MISMATCH');
      expect(sendCalls).toBe(1);

      await winner;
      expect(store.getSendState('s1')?.status).toBe('accepted');
      expect(store.getSendState('s1')?.operationId).toBe('op-payload-attachments');
      piClient.sendPrompt = originalSend;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('live busy before unknown receipt does not force idle when pending already cleared', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      let receiptResolve!: (value: { status: 'unknown'; streamEpoch: string }) => void;
      const receiptGate = new Promise<{ status: 'unknown'; streamEpoch: string }>((resolve) => {
        receiptResolve = resolve;
      });
      piClient.sendPrompt = (async () => {
        throw markAmbiguousTransportFailure(new Error('lost-busy-unknown'));
      }) as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (() => receiptGate) as unknown as typeof piClient.getSendReceipt;

      await expect(
        store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-busy-unknown' }),
      ).rejects.toThrow('lost-busy-unknown');
      await waitFor(() => store.getSendState('s1')?.status === 'confirming');
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('busy');

      // Live turn progress arrives on the event channel before the receipt settles.
      // The lifecycle channel owns liveness; the read-only receipt must not
      // downgrade an authoritatively live turn to idle.
      internal(store).commitEvents([busyLifecycle('s1', 5_001)]);
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('busy');

      receiptResolve({ status: 'unknown', streamEpoch: 'epoch-1' });
      await waitFor(() => store.getSendState('s1')?.status === 'outcome-unknown');
      expect(store.getSendState('s1')?.operationId).toBe('op-busy-unknown');
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('busy');
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('same-id receipt acceptance after authoritative idle does not resurrect busy', async () => {
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
        throw markAmbiguousTransportFailure(new Error('lost-idle-accept'));
      }) as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (() => receiptGate) as unknown as typeof piClient.getSendReceipt;

      await expect(
        store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-idle-accept' }),
      ).rejects.toThrow('lost-idle-accept');
      await waitFor(() => store.getSendState('s1')?.status === 'confirming');
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('busy');

      // Authoritative idle settles the optimistic busy without confirming the send.
      internal(store).commitEvents([idleLifecycle('s1', 5_001)]);
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('idle');
      expect(store.getSendState('s1')?.status).toBe('confirming');

      // The same-id receipt settles acceptance but must not resurrect the
      // authoritatively idle turn back to busy.
      receiptResolve({ status: 'accepted', streamEpoch: 'epoch-1', receipt: { accepted: true, messageId: 'm-idle-accept' } });
      await waitFor(() => store.getSendState('s1')?.status === 'accepted');
      expect(store.getSendState('s1')?.operationId).toBe('op-idle-accept');
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('idle');
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('accepted dedup retry after authoritative idle creates no new pending or busy', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      let sendCalls = 0;
      piClient.sendPrompt = (async () => {
        sendCalls += 1;
        return { accepted: true, messageId: 'm-dedup-idle' };
      }) as unknown as typeof piClient.sendPrompt;

      await store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-dedup-idle' });
      expect(store.getSendState('s1')?.status).toBe('accepted');
      expect(store.getSendState('s1')?.operationId).toBe('op-dedup-idle');

      // Authoritative idle settles the optimistic turn without confirming a new one.
      internal(store).commitEvents([idleLifecycle('s1', 5_001)]);
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('idle');
      expect(internal(store).pendingPromptById.has('s1')).toBe(false);
      expect(store.getSendState('s1')?.status).toBe('accepted');

      // Same operation, same payload: daemon dedups without emitting a new turn.
      await store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-dedup-idle' });
      expect(sendCalls).toBe(2);
      expect(store.getSendState('s1')?.status).toBe('accepted');
      expect(store.getSendState('s1')?.operationId).toBe('op-dedup-idle');
      expect(internal(store).pendingPromptById.has('s1')).toBe(false);
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('idle');

      piClient.sendPrompt = originalSend;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('rejected steer on authoritatively busy session retains busy without pending leak', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalPrompt = piClient.sendPrompt.bind(piClient);
      const originalSteer = piClient.sendSteer.bind(piClient);
      piClient.sendPrompt = (async () => ({ accepted: true, messageId: 'm-winner-busy' })) as typeof piClient.sendPrompt;
      await store.prompt('s1', 'first', 'prompt', undefined, { operationId: 'op-winner-busy' });
      // Authoritative busy retires optimistic ownership while the turn stays live.
      internal(store).commitEvents([busyLifecycle('s1', 5_001)]);
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('busy');
      expect(internal(store).pendingPromptById.has('s1')).toBe(false);

      piClient.sendSteer = (async () => {
        throw new PiRequestError('SESSION_BUSY', 'busy', 409);
      }) as typeof piClient.sendSteer;
      const loser = await store.prompt('s1', 'steer late', 'steer', undefined, { operationId: 'op-loser-busy' }).then(
        () => null,
        (error: unknown) => error,
      );
      expect((loser as { code?: string }).code).toBe('SESSION_BUSY');
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('busy');
      expect(internal(store).pendingPromptById.has('s1')).toBe(false);

      piClient.sendPrompt = originalPrompt;
      piClient.sendSteer = originalSteer;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('prompt hydrate race with deletion never dispatches or recreates', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      // Force a missing transcript so prompt() must hydrate before sending.
      internal(store).state.reducer.bySession.delete('s1');
      internal(store).hydratedSessionIds.delete('s1');
      internal(store).state = {
        ...internal(store).state,
        hydratedSessionIds: new Set([...internal(store).state.hydratedSessionIds].filter((id) => id !== 's1')),
      };

      const originalGet = piClient.getSession.bind(piClient);
      const originalSend = piClient.sendPrompt.bind(piClient);
      let getCalls = 0;
      let sendCalls = 0;
      let getResolve!: (value: unknown) => void;
      const getGate = new Promise<unknown>((resolve) => {
        getResolve = resolve;
      });
      piClient.getSession = (async () => {
        getCalls += 1;
        return getGate;
      }) as unknown as typeof piClient.getSession;
      piClient.sendPrompt = (async () => {
        sendCalls += 1;
        return { accepted: true, messageId: 'm-race' };
      }) as unknown as typeof piClient.sendPrompt;

      const task = store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-hydrate-race' }).then(
        () => null,
        (error: unknown) => error,
      );
      await waitFor(() => getCalls >= 1);
      // Authoritative deletion lands while the hydrate is in flight (public entry point).
      expect(store.commitMissedDeletion('s1', '/repo-a')).toBe(true);
      expect(store.isDeleted('s1')).toBe(true);
      getResolve({
        session: { id: 's1', directory: '/repo-a', title: 's1', createdAt: 1, updatedAt: 1 },
        lastSequence: 5_000,
        messages: [],
      });
      await task;
      // Let any late completion incorrectly dispatch or recreate.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(sendCalls).toBe(0);
      expect(store.isDeleted('s1')).toBe(true);
      expect(store.getState().reducer.bySession.has('s1')).toBe(false);
      expect(store.getState().catalog.byId.has('s1')).toBe(false);
      expect(internal(store).pendingPromptById.has('s1')).toBe(false);
      expect(store.getSendState('s1')).toBeUndefined();

      piClient.getSession = originalGet;
      piClient.sendPrompt = originalSend;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });
});
