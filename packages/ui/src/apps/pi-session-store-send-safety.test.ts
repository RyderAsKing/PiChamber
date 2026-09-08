import { describe, expect, test } from 'bun:test';
import { markAmbiguousTransportFailure } from '@/lib/relay/transport-error';
import { getPiSessionCatalogCache } from '@/sync/pi-session-catalog-cache';

// Send-safety behavior of PiSessionStore.prompt (findings #3 and #4):
// - a definite server rejection rolls the send back to a visible failure;
// - an uncertain outcome (dispatched, response lost) is NOT a false failure:
//   the send stays pending and is confirmed through an authoritative read;
// - the send intent carries a stable operation id plus its captured config
//   (model/thinking) inline in the payload.
// The file is self-contained (bun test --isolate): piClient methods are
// monkey-patched on the singleton, everything else is the real store code.

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

const detail = (id: string, directory = '/repo-a', lastSequence = 10) => ({
  session: { id, directory, title: id, createdAt: 1, updatedAt: 1 },
  lastSequence,
  messages: [],
  isStreaming: false,
  lifecycle: 'idle' as const,
});

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
}

const internal = (store: PiSessionStore): StoreInternal => store as unknown as StoreInternal;

interface SeedOptions {
  directory?: string;
  residents?: string[];
  cursor?: number;
}

const seed = (store: PiSessionStore, options: SeedOptions = {}) => {
  const directory = options.directory ?? '/repo-a';
  const residents = options.residents ?? ['s1'];
  const cursor = options.cursor ?? 5_000;
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

describe('PiSessionStore send safety', () => {
  test('a definite rejection is a visible failure, not pending state', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      let sendCalls = 0;
      piClient.sendPrompt = (async () => {
        sendCalls += 1;
        throw new PiRequestError('SESSION_BUSY', 'busy', 409);
      }) as typeof piClient.sendPrompt;

      const rejection = await store
        .prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-definite' })
        .then(() => null, (error: unknown) => error);
      expect((rejection as { code?: string }).code).toBe('SESSION_BUSY');

      expect(sendCalls).toBe(1);
      const resident = store.getState().reducer.bySession.get('s1');
      expect(resident?.lifecycle).toBe('error');
      expect(internal(store).pendingPromptById.has('s1')).toBe(false);
      piClient.sendPrompt = originalSend;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('an uncertain outcome stays pending and is confirmed by an authoritative read', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      const originalGetSession = piClient.getSession.bind(piClient);
      const receiptCalls: unknown[] = [];
      let getSessionCalls = 0;
      piClient.sendPrompt = (async () => {
        throw markAmbiguousTransportFailure(new Error('relay stream died mid-request'));
      }) as typeof piClient.sendPrompt;
      piClient.getSendReceipt = (async (input: unknown) => {
        receiptCalls.push(input);
        return { status: 'accepted', streamEpoch: 'epoch-1', receipt: { accepted: true, messageId: 'm-1' } };
      }) as unknown as typeof piClient.getSendReceipt;
      piClient.getSession = (async (id: string) => {
        getSessionCalls += 1;
        return detail(id);
      }) as unknown as typeof piClient.getSession;

      await expect(
        store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-uncertain' }),
      ).rejects.toThrow('relay stream died mid-request');

      // No false failure: the optimistic send is not rolled back to error.
      expect(internal(store).pendingPromptById.has('s1')).toBe(true);
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('busy');
      // The confirmation path is the exact authenticated receipt — never an
      // unrelated lifecycle read and never a resend.
      await waitFor(() => receiptCalls.length > 0);
      expect(receiptCalls).toHaveLength(1);
      expect(receiptCalls[0]).toMatchObject({ kind: 'prompt', sessionId: 's1', operationId: 'op-uncertain' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(getSessionCalls).toBe(0);
      // Accepted settles send acceptance independently of turn state: the
      // live event stream still owns progress, and no automatic replay fires
      // (exactly one Pi call). The turn stays pending while acceptance is
      // explicit.
      expect(internal(store).pendingPromptById.has('s1')).toBe(true);
      expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('busy');
      expect(store.getSendState('s1')?.status).toBe('accepted');
      expect(store.getSendState('s1')?.operationId).toBe('op-uncertain');
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
      piClient.getSession = originalGetSession;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('a request timeout is uncertain exactly like an ambiguous transport failure', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalSteer = piClient.sendSteer.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      const originalGetSession = piClient.getSession.bind(piClient);
      const receiptCalls: unknown[] = [];
      let getSessionCalls = 0;
      const timeoutError = () => {
        throw new PiRequestError('DAEMON_TIMEOUT');
      };
      piClient.sendPrompt = timeoutError as typeof piClient.sendPrompt;
      piClient.sendSteer = timeoutError as typeof piClient.sendSteer;
      piClient.getSendReceipt = (async (input: unknown) => {
        receiptCalls.push(input);
        return { status: 'pending', streamEpoch: 'epoch-1' };
      }) as unknown as typeof piClient.getSendReceipt;
      piClient.getSession = (async (id: string) => {
        getSessionCalls += 1;
        return detail(id);
      }) as unknown as typeof piClient.getSession;

      const timeoutRejection = await store
        .prompt('s1', 'hello', 'steer', undefined, { operationId: 'op-timeout' })
        .then(() => null, (error: unknown) => error);
      expect((timeoutRejection as { code?: string }).code).toBe('DAEMON_TIMEOUT');

      expect(internal(store).pendingPromptById.has('s1')).toBe(true);
      await waitFor(() => receiptCalls.length > 0);
      expect(receiptCalls[0]).toMatchObject({ kind: 'steer', sessionId: 's1', operationId: 'op-timeout' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Steer timeout confirms via receipt too — never via lifecycle.
      expect(getSessionCalls).toBe(0);
      expect(internal(store).pendingPromptById.has('s1')).toBe(true);
      piClient.sendPrompt = originalSend;
      piClient.sendSteer = originalSteer;
      piClient.getSendReceipt = originalReceipt;
      piClient.getSession = originalGetSession;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('the send intent carries its operation id and captured config inline', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const inputs: unknown[] = [];
      const recordSend = (async (input: unknown) => {
        inputs.push(input);
        return { accepted: true, messageId: 'm-1' };
      }) as typeof piClient.sendPrompt;
      piClient.sendPrompt = recordSend;

      await store.prompt('s1', 'hello', 'prompt', undefined, {
        operationId: 'op-intent',
        model: { providerId: 'provider', modelId: 'model' },
        thinking: 'high',
      });

      expect(inputs).toHaveLength(1);
      const sentInput = inputs[0] as Record<string, unknown>;
      expect(sentInput.sessionId).toBe('s1');
      expect(sentInput.text).toBe('hello');
      expect(typeof sentInput.messageId).toBe('string');
      expect(sentInput.operationId).toBe('op-intent');
      expect(sentInput.model).toEqual({ providerId: 'provider', modelId: 'model' });
      expect(sentInput.thinking).toBe('high');
      // The captured config is reflected optimistically until the daemon's
      // authoritative session.model/session.thinking events arrive.
      const resident = store.getState().reducer.bySession.get('s1');
      expect(resident?.model).toEqual({ providerId: 'provider', modelId: 'model' });
      expect(resident?.thinking).toBe('high');
      // Stable intent: the message id is derived from the operation id and
      // the verified epoch is stamped once.
      expect(sentInput.messageId).toBe('msg_op-intent');
      expect(sentInput.streamEpoch).toBe('epoch-1');
      piClient.sendPrompt = originalSend;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('a follow-up lost ack confirms via receipt and never resends', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalFollowUp = piClient.sendFollowUp.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      const originalGetSession = piClient.getSession.bind(piClient);
      let sendCalls = 0;
      const receiptCalls: unknown[] = [];
      let getSessionCalls = 0;
      piClient.sendFollowUp = (async () => {
        sendCalls += 1;
        throw markAmbiguousTransportFailure(new Error('lost ack'));
      }) as typeof piClient.sendFollowUp;
      piClient.getSendReceipt = (async (input: unknown) => {
        receiptCalls.push(input);
        return { status: 'pending', streamEpoch: 'epoch-1' };
      }) as unknown as typeof piClient.getSendReceipt;
      piClient.getSession = (async (id: string) => {
        getSessionCalls += 1;
        return detail(id);
      }) as unknown as typeof piClient.getSession;

      await expect(
        store.prompt('s1', 'again', 'followUp', undefined, { operationId: 'op-followup' }),
      ).rejects.toThrow('lost ack');
      await waitFor(() => receiptCalls.length > 0);
      expect(receiptCalls[0]).toMatchObject({ kind: 'followUp', sessionId: 's1', operationId: 'op-followup' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sendCalls).toBe(1);
      expect(getSessionCalls).toBe(0);
      expect(internal(store).pendingPromptById.has('s1')).toBe(true);
      piClient.sendFollowUp = originalFollowUp;
      piClient.getSendReceipt = originalReceipt;
      piClient.getSession = originalGetSession;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('expired and unknown receipts become an explicit outcome-unknown, not busy forever', async () => {
    for (const status of ['expired', 'unknown'] as const) {
      const store = new PiSessionStore();
      try {
        seed(store);
        const originalSend = piClient.sendPrompt.bind(piClient);
        const originalReceipt = piClient.getSendReceipt.bind(piClient);
        let sendCalls = 0;
        piClient.sendPrompt = (async () => {
          sendCalls += 1;
          throw markAmbiguousTransportFailure(new Error(`lost-${status}`));
        }) as typeof piClient.sendPrompt;
        piClient.getSendReceipt = (async () => ({
          status, streamEpoch: 'epoch-1',
        })) as unknown as typeof piClient.getSendReceipt;

        await expect(
          store.prompt('s1', 'hello', 'prompt', undefined, { operationId: `op-${status}` }),
        ).rejects.toThrow();
        await waitFor(() => store.getSendState('s1')?.status === 'outcome-unknown');
        await new Promise((resolve) => setTimeout(resolve, 20));
        // Retention gone or never seen: explicit unknown, never assume success
        // and never auto-replay with the same id — the caller needs an
        // explicit new intent. The stuck busy is cleared so the chat is not
        // working forever, with user-visible safe next action.
        expect(sendCalls).toBe(1);
        expect(internal(store).pendingPromptById.has('s1')).toBe(false);
        expect(store.getState().reducer.bySession.get('s1')?.lifecycle).toBe('idle');
        const sendState = store.getSendState('s1');
        expect(sendState?.status).toBe('outcome-unknown');
        expect(sendState?.operationId).toBe(`op-${status}`);
        expect(typeof sendState?.title).toBe('string');
        expect(sendState?.title.length).toBeGreaterThan(0);
        expect(typeof sendState?.action).toBe('string');
        expect(sendState?.action).toContain('new message');
        piClient.sendPrompt = originalSend;
        piClient.getSendReceipt = originalReceipt;
      } finally {
        store.dispose();
        getPiSessionCatalogCache().dispose();
      }
    }
  });

  test('an unrelated receipt identity never confirms the pending send', async () => {
    const store = new PiSessionStore();
    try {
      seed(store);
      const originalSend = piClient.sendPrompt.bind(piClient);
      const originalReceipt = piClient.getSendReceipt.bind(piClient);
      const seen: unknown[] = [];
      piClient.sendPrompt = (async () => {
        throw markAmbiguousTransportFailure(new Error('lost'));
      }) as typeof piClient.sendPrompt;
      // The store always queries the exact kind/session/operation identity;
      // a caller that looked up a different kind would see unknown and must
      // not treat it as confirmation of this send. Unknown becomes an
      // explicit outcome-unknown (not a silent pending-forever).
      piClient.getSendReceipt = (async (input: unknown) => {
        seen.push(input);
        const typed = input as { kind: string; sessionId: string; operationId: string };
        expect(typed.kind).toBe('prompt');
        expect(typed.sessionId).toBe('s1');
        expect(typed.operationId).toBe('op-exact');
        return { status: 'unknown', streamEpoch: 'epoch-1' };
      }) as unknown as typeof piClient.getSendReceipt;

      await expect(
        store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-exact' }),
      ).rejects.toThrow();
      await waitFor(() => seen.length > 0);
      await waitFor(() => store.getSendState('s1')?.status === 'outcome-unknown');
      expect(store.getSendState('s1')?.operationId).toBe('op-exact');
      expect(internal(store).pendingPromptById.has('s1')).toBe(false);
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });

  test('a runtime switch guards the receipt confirmation', async () => {
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
        // Simulate a runtime switch racing the confirmation: the generation
        // guard must drop the stale result without touching new state.
        (store as unknown as { runtimeGeneration: number }).runtimeGeneration += 1;
        return { status: 'accepted', streamEpoch: 'epoch-1', receipt: { accepted: true, messageId: 'm-1' } };
      }) as unknown as typeof piClient.getSendReceipt;

      await expect(
        store.prompt('s1', 'hello', 'prompt', undefined, { operationId: 'op-switch' }),
      ).rejects.toThrow();
      await waitFor(() => receiptCalls > 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Stale confirmation committed nothing beyond the still-pending intent.
      expect(internal(store).pendingPromptById.has('s1')).toBe(true);
      piClient.sendPrompt = originalSend;
      piClient.getSendReceipt = originalReceipt;
    } finally {
      store.dispose();
      getPiSessionCatalogCache().dispose();
    }
  });
});
