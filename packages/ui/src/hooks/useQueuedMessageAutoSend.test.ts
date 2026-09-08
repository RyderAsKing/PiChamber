import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { getPiSessionStore, type PiSessionStoreState } from '@/apps/pi-session-store';
import { piClient, PiRequestError } from '@/lib/pi/client';
import type { PiReducerSessionState } from '@/lib/pi/event-reducer';
import { createReducerPartMap } from '@/lib/pi/event-reducer';
import type { PiSessionEvent } from '@/lib/pi/protocol';
import {
  getMessageQueueKey,
  useMessageQueueStore,
  type MessageQueueTarget,
  type QueuedMessage,
} from '@/stores/messageQueueStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { getRuntimeKey } from '@/lib/runtime-switch';

// ---------------------------------------------------------------------------
// Mocks — only the send boundary and config resolution. The queue store, the
// directory store, and the Pi session store are the REAL modules; session
// lifecycle is driven through real store internals and real Pi events.
// ---------------------------------------------------------------------------

const sendMessageCalls: unknown[][] = [];
let sendMessageImpl: (...args: unknown[]) => Promise<void> = async () => undefined;
let abortFlags: Map<string, { timestamp: number; acknowledged: boolean }> = new Map();
const selectionReads = { count: 0 };

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      sendMessage: (...args: unknown[]) => {
        sendMessageCalls.push(args);
        return sendMessageImpl(...args);
      },
      sessionAbortFlags: abortFlags,
    }),
  },
}));

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      currentProviderId: 'cfg-provider',
      currentModelId: 'cfg-model',
      isInitialized: true,
    }),
  },
}));

mock.module('@/sync/selection-store', () => ({
  useSelectionStore: {
    getState: () => ({
      getSessionAgentSelection: () => {
        selectionReads.count += 1;
        return undefined;
      },
      getSessionModelSelection: () => undefined,
      getAgentModelForSession: () => null,
      getAgentModelVariantForSession: () => undefined,
      lastUsedProvider: undefined,
    }),
  },
}));

import {
  buildQueuedAutoSendPayload,
  createQueuedAutoSendRetryScheduler,
  getQueuedAutoSendRetryDelayMs,
  isQueuedAutoSendBackedOff,
  resolveQueuedAutoSendReadiness,
  sendQueuedAutoSendPayload,
  useQueuedMessageAutoSend,
} from './useQueuedMessageAutoSend';

// ---------------------------------------------------------------------------
// Real Pi store driving helpers (pi-session-connection.test.ts precedent)
// ---------------------------------------------------------------------------

interface StoreInternal {
  state: PiSessionStoreState;
  stream: { dispose: () => void } | null;
  hydratedSessionIds: Set<string>;
  runtimeGeneration: number;
  commitEvents: (events: readonly PiSessionEvent[]) => void;
  commitHydratedSession: (session: PiReducerSessionState, buffered?: readonly PiSessionEvent[]) => void;
  emitChrome: () => void;
}

const store = getPiSessionStore();
const asInternal = (instance: unknown = store): StoreInternal => instance as StoreInternal;

const reducerSession = (
  overrides: Partial<PiReducerSessionState> & Pick<PiReducerSessionState, 'sessionId'>,
): PiReducerSessionState => ({
  directory: '/repo',
  lastSequence: 1,
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

let eventSequence = 0;
const lifecycleEvent = (
  sessionId: string,
  state: 'busy' | 'retry' | 'idle' | 'error',
  options?: { directory?: string },
): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'session.lifecycle',
  sequence: ++eventSequence,
  sessionId,
  directory: options?.directory ?? '/repo',
  payload: { state },
}) as PiSessionEvent;

const deltaEvent = (sessionId: string, messageId: string, directory = '/repo'): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name: 'assistant.message.delta',
  sequence: ++eventSequence,
  sessionId,
  directory,
  payload: { messageId, contentIndex: 0, delta: 'more tokens' },
}) as PiSessionEvent;

const getSessionCalls: string[] = [];
let getSessionImpl: (sessionId: string) => Promise<unknown> = async (sessionId) => ({
  session: { id: sessionId, directory: '/repo', createdAt: 0, updatedAt: 0 },
  lastSequence: 0,
  messages: [],
});
const originalGetSession = piClient.getSession.bind(piClient);

const RUNTIME = getRuntimeKey();
const target = (sessionId = 's1', directory = '/repo'): MessageQueueTarget => ({
  runtimeKey: RUNTIME,
  directory,
  sessionId,
});

const resetLiveStore = () => {
  store.clear();
  const internal = asInternal();
  // A connected stream handle routes `ensureHydrated` through the direct
  // `piClient.getSession` path instead of a full directory bootstrap.
  internal.stream = { dispose: () => undefined };
  internal.state = { ...store.getState(), directory: '/repo', connection: 'ready' };
};

const hydrateResident = (sessionId: string, lifecycle: 'idle' | 'busy' | 'retry' | 'error' = 'idle', directory = '/repo') => {
  asInternal().commitHydratedSession(reducerSession({ sessionId, lifecycle, directory, lastSequence: 5 }));
};

/** Mirrors `evictIdleTranscripts` for one session: drops the reducer row,
 *  clears the hydration pointer, and flips the catalog row's `hydrated`
 *  flag while keeping the row itself. */
const evictSession = (sessionId: string) => {
  const internal = asInternal();
  const bySession = new Map(internal.state.reducer.bySession);
  bySession.delete(sessionId);
  const catalog = internal.state.catalog;
  const record = catalog.byId.get(sessionId);
  if (!record) return;
  const byId = new Map(catalog.byId);
  byId.set(sessionId, { ...record, hydrated: false });
  const hydratedSessionIds = new Set(internal.hydratedSessionIds);
  hydratedSessionIds.delete(sessionId);
  internal.hydratedSessionIds = hydratedSessionIds;
  internal.state = {
    ...internal.state,
    reducer: { ...internal.state.reducer, bySession },
    hydratedSessionIds,
    catalog: { ...catalog, byId },
  };
};

const markArchived = (sessionId: string) => {
  const internal = asInternal();
  const catalog = internal.state.catalog;
  const record = catalog.byId.get(sessionId);
  if (!record) return;
  const byId = new Map(catalog.byId);
  byId.set(sessionId, { ...record, archived: true });
  internal.state = { ...internal.state, catalog: { ...catalog, byId } };
};

const enqueue = (queueTarget: MessageQueueTarget, message: Partial<QueuedMessage> = {}) => {
  useMessageQueueStore.getState().addToQueue(queueTarget, {
    content: message.content ?? 'queued prompt',
    ...(message.attachments ? { attachments: message.attachments } : {}),
    ...(message.sendConfig ? { sendConfig: message.sendConfig } : {}),
  });
};

const queueFor = (queueTarget: MessageQueueTarget): QueuedMessage[] =>
  useMessageQueueStore.getState().queuedMessages[getMessageQueueKey(queueTarget)] ?? [];

const sendingFor = (queueTarget: MessageQueueTarget): string[] =>
  useMessageQueueStore.getState().sendingIds[getMessageQueueKey(queueTarget)] ?? [];

// ---------------------------------------------------------------------------
// Minimal DOM + mounted hook harness (use-sync.test.ts precedent)
// ---------------------------------------------------------------------------

const roots: Root[] = [];
const restores: Array<() => void> = [];

function installMinimalDom() {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  class ElementStub {}
  const documentStub: Record<string, unknown> = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const container = {
    nodeType: 1,
    tagName: 'DIV',
    nodeName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentStub,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  documentStub.documentElement = container;
  documentStub.body = container;
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return () => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

function Probe({ enabled }: { enabled?: boolean }) {
  useQueuedMessageAutoSend(enabled);
  return null;
}

async function mountHook(enabled = true): Promise<void> {
  restores.push(installMinimalDom());
  const container = (globalThis as unknown as { document: { body: Element } }).document.body;
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(Probe, { enabled }));
  });
}

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

beforeEach(() => {
  sendMessageCalls.length = 0;
  sendMessageImpl = async () => undefined;
  abortFlags = new Map();
  selectionReads.count = 0;
  getSessionCalls.length = 0;
  // Start above any seeded reducer `lastSequence` so the reducer accepts
  // every crafted event as new (it rejects stale sequences).
  eventSequence = 100;
  piClient.getSession = (async (sessionId: string) => {
    getSessionCalls.push(sessionId);
    return getSessionImpl(sessionId);
  }) as typeof piClient.getSession;
  resetLiveStore();
  useMessageQueueStore.setState({ queuedMessages: {}, sendingIds: {} });
  useDirectoryStore.setState({ currentDirectory: '/repo' });
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  for (const restore of restores.splice(0)) restore();
  piClient.getSession = originalGetSession as typeof piClient.getSession;
});

// ---------------------------------------------------------------------------
// Mounted gate behavior — real store, real events, mounted hook
// ---------------------------------------------------------------------------

describe('queued auto-send dispatch gate (mounted)', () => {
  test('dispatches once when a resident session is live-idle and clears the queue entry', async () => {
    hydrateResident('s1', 'idle');
    await mountHook();

    await act(async () => {
      enqueue(target(), { sendConfig: { providerID: 'cap-p', modelID: 'cap-m', variant: 'cap-v' } });
    });
    await flush();

    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0]?.[0]).toBe('queued prompt');
    expect(sendMessageCalls[0]?.[1]).toBe('cap-p');
    expect(sendMessageCalls[0]?.[2]).toBe('cap-m');
    expect(sendMessageCalls[0]?.[7]).toBe('cap-v');
    expect(sendMessageCalls[0]?.[8]).toBe('normal');
    expect(sendMessageCalls[0]?.[9]).toEqual({ target: target() });
    expect(queueFor(target())).toHaveLength(0);
    expect(sendingFor(target())).toHaveLength(0);
  });

  test('holds on live busy and the idle event wakes dispatch without mutating the queue', async () => {
    hydrateResident('s1', 'busy');
    await mountHook();

    let releaseSend: (() => void) | undefined;
    sendMessageImpl = () => new Promise<void>((resolve) => { releaseSend = resolve; });

    await act(async () => {
      enqueue(target());
    });
    await flush();

    expect(sendMessageCalls.length).toBe(0);
    expect(queueFor(target())).toHaveLength(1);

    // The live idle lifecycle event flips the catalog mirror and emits the
    // catalog topic — that wake alone must dispatch. The queue entry is not
    // mutated by the wake: it is retained (and marked sending) until the
    // send resolves.
    await act(async () => {
      asInternal().commitEvents([lifecycleEvent('s1', 'idle')]);
    });
    await flush();

    expect(sendMessageCalls.length).toBe(1);
    expect(queueFor(target())).toHaveLength(1);
    expect(sendingFor(target())).toHaveLength(1);

    await act(async () => {
      releaseSend?.();
    });
    await flush();

    expect(queueFor(target())).toHaveLength(0);
    expect(sendingFor(target())).toHaveLength(0);
  });

  test('holds on retry, then a terminal error lifecycle permits the fresh prompt', async () => {
    hydrateResident('s1', 'idle');
    await mountHook();

    await act(async () => {
      asInternal().commitEvents([lifecycleEvent('s1', 'retry', { })]);
      enqueue(target());
    });
    await flush();
    expect(sendMessageCalls.length).toBe(0);
    expect(queueFor(target())).toHaveLength(1);

    await act(async () => {
      asInternal().commitEvents([lifecycleEvent('s1', 'error')]);
    });
    await flush();

    expect(sendMessageCalls.length).toBe(1);
    expect(queueFor(target())).toHaveLength(0);
  });

  test('token deltas and unrelated sessions never wake the dispatch scanner', async () => {
    hydrateResident('s1', 'busy');
    await mountHook();

    await act(async () => {
      enqueue(target());
    });
    await flush();
    expect(sendMessageCalls.length).toBe(0);

    await act(async () => {
      asInternal().commitEvents([
        deltaEvent('s1', 'msg_1'),
        deltaEvent('s1', 'msg_1'),
        deltaEvent('other-session', 'msg_2'),
        lifecycleEvent('s1', 'busy'),
      ]);
    });
    await flush();

    expect(sendMessageCalls.length).toBe(0);
    expect(queueFor(target())).toHaveLength(1);
  });

  test('connection loading/error/unavailable cannot claim idle; ready wakes dispatch', async () => {
    hydrateResident('s1', 'idle');
    const internal = asInternal();
    await mountHook();

    // A non-ready connection must hold even a live-idle resident row.
    await act(async () => {
      internal.state = { ...store.getState(), connection: 'loading' };
      internal.emitChrome();
      enqueue(target());
    });
    await flush();
    expect(sendMessageCalls.length).toBe(0);

    for (const connection of ['error', 'unavailable'] as const) {
      await act(async () => {
        internal.state = { ...store.getState(), connection };
        internal.emitChrome();
      });
      await flush();
      expect(sendMessageCalls.length).toBe(0);
    }

    await act(async () => {
      internal.state = { ...store.getState(), connection: 'ready' };
      internal.emitChrome();
    });
    await flush();

    expect(sendMessageCalls.length).toBe(1);
    expect(queueFor(target())).toHaveLength(0);
  });

  test('a missing authoritative target cannot invent idle and is never hydrated on demand', async () => {
    await mountHook();

    await act(async () => {
      enqueue(target('unknown-session'));
    });
    await flush();

    expect(sendMessageCalls.length).toBe(0);
    expect(getSessionCalls).toEqual([]);
    expect(queueFor(target('unknown-session'))).toHaveLength(1);
  });

  test('a cold idle row holds, demands live state once, then dispatches from authoritative state', async () => {
    // Simulates the first-paint cache: a catalog row exists with `idle`,
    // but no live observation ever made it live (hydrated=false).
    await act(async () => {
      asInternal().commitEvents([lifecycleEvent('s1', 'idle')]);
    });
    const record = store.getState().catalog.byId.get('s1');
    expect(record?.hydrated).toBe(false);

    // Keep the demanded hydration in flight so the hold is observable.
    let releaseHydrate: (() => void) | undefined;
    getSessionImpl = (sessionId) => new Promise((resolve) => {
      releaseHydrate = () => resolve({
        session: { id: sessionId, directory: '/repo', createdAt: 0, updatedAt: 0 },
        lastSequence: 0,
        messages: [],
      });
    });

    await mountHook();
    await act(async () => {
      enqueue(target());
    });
    await flush();

    // Cold idle must not dispatch; it demanded one hydration instead.
    expect(sendMessageCalls.length).toBe(0);
    expect(getSessionCalls).toEqual(['s1']);
    expect(queueFor(target())).toHaveLength(1);

    // The hydrate commit is the live evidence: hydrated flips true, the
    // catalog re-emits, and the wake dispatches against authoritative state.
    await act(async () => {
      releaseHydrate?.();
    });
    await flush();
    expect(sendMessageCalls.length).toBe(1);
    expect(queueFor(target())).toHaveLength(0);
    expect(getSessionCalls).toEqual(['s1']);
  });

  test('a transient hydration failure retries after bounded backoff and dispatches once authoritative', async () => {
    let hydrateAttempts = 0;
    getSessionImpl = async (sessionId) => {
      hydrateAttempts += 1;
      if (hydrateAttempts === 1) throw new Error('transient hydrate failure');
      return {
        session: { id: sessionId, directory: '/repo', createdAt: 0, updatedAt: 0 },
        lastSequence: 0,
        messages: [],
      };
    };
    await act(async () => {
      asInternal().commitEvents([lifecycleEvent('s1', 'idle')]);
    });

    await mountHook();
    await act(async () => {
      enqueue(target());
    });
    await flush();
    // The failed demand is not a dispatch and does not loop.
    expect(sendMessageCalls.length).toBe(0);
    expect(getSessionCalls).toEqual(['s1']);
    expect(queueFor(target())).toHaveLength(1);

    // A failed getSession reports a runtime error; recovery (reconnect)
    // restores the connection, as the real transport does.
    const internal = asInternal();
    await act(async () => {
      internal.state = { ...store.getState(), connection: 'ready', error: null };
      internal.emitChrome();
    });

    // Wakes inside the backoff window never re-demand.
    await act(async () => {
      asInternal().commitEvents([deltaEvent('other-session', 'msg_9')]);
    });
    await flush();
    expect(getSessionCalls).toEqual(['s1']);
    expect(sendMessageCalls.length).toBe(0);

    // The scheduled retry fires after backoff, hydrates, and dispatches.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2300));
    });
    await flush();

    expect(hydrateAttempts).toBe(2);
    expect(sendMessageCalls.length).toBe(1);
    expect(queueFor(target())).toHaveLength(0);
  });

  test('a hydrated-then-evicted session re-demands live state for a re-queued item', async () => {
    await act(async () => {
      asInternal().commitEvents([lifecycleEvent('s1', 'idle')]);
    });
    await mountHook();

    await act(async () => {
      enqueue(target());
    });
    await flush();
    await flush();
    // The cold row was demanded, hydrated, and dispatched.
    expect(sendMessageCalls.length).toBe(1);
    expect(getSessionCalls).toEqual(['s1']);
    expect(queueFor(target())).toHaveLength(0);

    // Eviction clears the live evidence; the catalog row stays, cold.
    await act(async () => {
      evictSession('s1');
    });
    expect(asInternal().state.catalog.byId.get('s1')?.hydrated).toBe(false);

    // A re-queued item for the same target must demand hydration again.
    await act(async () => {
      enqueue(target());
    });
    await flush();
    await flush();

    expect(getSessionCalls).toEqual(['s1', 's1']);
    expect(sendMessageCalls.length).toBe(2);
    expect(queueFor(target())).toHaveLength(0);
  });

  test('a runtime generation reset while hydration is pending never sends stale state', async () => {
    await act(async () => {
      asInternal().commitEvents([lifecycleEvent('s1', 'idle')]);
    });
    let releaseFirstHydrate: (() => void) | undefined;
    let hydrateCalls = 0;
    getSessionImpl = (sessionId) => {
      hydrateCalls += 1;
      const detail = {
        session: { id: sessionId, directory: '/repo', createdAt: 0, updatedAt: 0 },
        lastSequence: 0,
        messages: [],
      };
      if (hydrateCalls === 1) {
        return new Promise((resolve) => { releaseFirstHydrate = () => resolve(detail); });
      }
      return Promise.resolve(detail);
    };

    await mountHook();
    await act(async () => {
      enqueue(target());
    });
    await flush();
    expect(getSessionCalls).toEqual(['s1']);
    expect(sendMessageCalls.length).toBe(0);

    // The runtime resets in place under the same runtime key: the
    // generation advances and live transcripts/hydration are dropped.
    const internal = asInternal();
    await act(async () => {
      internal.runtimeGeneration += 1;
      internal.hydratedSessionIds = new Set();
      internal.state = {
        ...internal.state,
        reducer: { ...internal.state.reducer, bySession: new Map() },
      };
    });
    await flush();
    expect(sendMessageCalls.length).toBe(0);
    expect(queueFor(target())).toHaveLength(1);

    // Releasing the stale hydrate resolves without committing (generation
    // guard): no send, and the still-cold row counts as a transient failure
    // that retries after bounded backoff under the new generation.
    await act(async () => {
      releaseFirstHydrate?.();
    });
    await flush();
    expect(getSessionCalls).toEqual(['s1']);
    expect(sendMessageCalls.length).toBe(0);
    expect(queueFor(target())).toHaveLength(1);

    // The scheduled retry re-demands and dispatches from fresh state only.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2300));
    });
    await flush();

    expect(getSessionCalls).toEqual(['s1', 's1']);
    expect(sendMessageCalls.length).toBe(1);
    expect(queueFor(target())).toHaveLength(0);
  });

  test('a terminal invalid session hydrates once, then never re-demands; the queue entry is kept and other queues proceed', async () => {
    // A cold row for the doomed target plus a live-idle row for a healthy one.
    await act(async () => {
      asInternal().commitEvents([lifecycleEvent('s1', 'idle')]);
    });
    hydrateResident('s-ok', 'idle');
    getSessionImpl = async () => {
      throw new PiRequestError('INVALID_SESSION', 'session not found');
    };

    await mountHook();
    await act(async () => {
      enqueue(target('s1'));
      enqueue(target('s-ok'));
    });
    await flush();

    // Exactly one hydrate attempt for the invalid target; it failed into
    // authoritative sessionLoadErrorById, not a transient gap.
    expect(getSessionCalls).toEqual(['s1']);
    expect(asInternal().state.sessionLoadErrorById.get('s1')?.code).toBe('INVALID_SESSION');
    // The healthy queue dispatched normally despite the failed neighbor.
    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0]?.[9]).toEqual({ target: target('s-ok') });
    expect(queueFor(target('s-ok'))).toHaveLength(0);
    // The invalid target's entry is retained for user inspection/removal.
    expect(queueFor(target('s1'))).toHaveLength(1);

    // Backoff expiry, unrelated wakes, and connection chrome changes must
    // never produce another hydrate request for the terminal target.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2300));
    });
    await act(async () => {
      asInternal().commitEvents([deltaEvent('other-session', 'msg_9')]);
      asInternal().emitChrome();
    });
    await flush();

    expect(getSessionCalls).toEqual(['s1']);
    expect(sendMessageCalls.length).toBe(1);
    expect(queueFor(target('s1'))).toHaveLength(1);
  });

  test('an archived cold target is never auto-sent and never hydrated on demand', async () => {
    await act(async () => {
      asInternal().commitEvents([lifecycleEvent('s1', 'idle')]);
    });
    markArchived('s1');
    await mountHook();

    await act(async () => {
      enqueue(target());
    });
    await flush();

    expect(sendMessageCalls.length).toBe(0);
    expect(getSessionCalls).toEqual([]);
    expect(queueFor(target())).toHaveLength(1);

    // Unrelated wakes must not demand-hydrate an archived row either.
    await act(async () => {
      asInternal().commitEvents([deltaEvent('other-session', 'msg_9')]);
    });
    await flush();
    expect(getSessionCalls).toEqual([]);
    expect(sendMessageCalls.length).toBe(0);
  });

  test('a colliding session id owned by another directory never receives the send', async () => {
    await act(async () => {
      asInternal().commitEvents([lifecycleEvent('s1', 'busy', { directory: '/other' })]);
    });
    await mountHook();

    await act(async () => {
      enqueue(target('s1', '/repo'));
    });
    await flush();

    expect(sendMessageCalls.length).toBe(0);
    expect(getSessionCalls).toEqual([]);
    expect(queueFor(target('s1', '/repo'))).toHaveLength(1);
  });

  test('a stale runtime target never sends', async () => {
    hydrateResident('s1', 'idle');
    await mountHook();

    const staleTarget: MessageQueueTarget = { runtimeKey: 'stale-runtime', directory: '/repo', sessionId: 's1' };
    await act(async () => {
      enqueue(staleTarget);
    });
    await flush();

    expect(sendMessageCalls.length).toBe(0);
    expect(queueFor(staleTarget)).toHaveLength(1);
  });

  test('captured send config is used as-is; mutable selection state is not consulted', async () => {
    hydrateResident('s1', 'idle');
    await mountHook();

    await act(async () => {
      enqueue(target(), { sendConfig: { providerID: 'cap-p', modelID: 'cap-m' } });
    });
    await flush();

    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0]?.[1]).toBe('cap-p');
    expect(sendMessageCalls[0]?.[2]).toBe('cap-m');
    expect(selectionReads.count).toBe(0);
  });

  test('one failed queue does not erase unrelated queue entries', async () => {
    hydrateResident('s1', 'idle');
    hydrateResident('s2', 'idle');
    sendMessageImpl = async (...args) => {
      const options = args[9] as { target: MessageQueueTarget } | undefined;
      if (options?.target.sessionId === 's2') throw new Error('send failed');
    };
    await mountHook();

    await act(async () => {
      enqueue(target('s1'));
      enqueue(target('s2'));
    });
    await flush();

    expect(sendMessageCalls.length).toBe(2);
    expect(queueFor(target('s1'))).toHaveLength(0);
    // The failed target keeps its entry for the backoff retry.
    expect(queueFor(target('s2'))).toHaveLength(1);
    expect(sendingFor(target('s2'))).toHaveLength(0);
  });

  test('the recent-abort window holds dispatch', async () => {
    hydrateResident('s1', 'idle');
    abortFlags.set('s1', { timestamp: Date.now(), acknowledged: false });
    await mountHook();

    await act(async () => {
      enqueue(target());
    });
    await flush();

    expect(sendMessageCalls.length).toBe(0);
    expect(queueFor(target())).toHaveLength(1);
  });

  test('disabled hook never dispatches', async () => {
    hydrateResident('s1', 'idle');
    await mountHook(false);

    await act(async () => {
      enqueue(target());
    });
    await flush();

    expect(sendMessageCalls.length).toBe(0);
    expect(queueFor(target())).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tri-state resolver over real store state
// ---------------------------------------------------------------------------

describe('resolveQueuedAutoSendReadiness', () => {
  test('reports busy for the authoritative live mirror regardless of hydration', () => {
    resetLiveStore();
    asInternal().commitEvents([lifecycleEvent('s1', 'retry')]);
    expect(resolveQueuedAutoSendReadiness(store.getState(), target())).toBe('busy');

    hydrateResident('s1', 'busy');
    expect(resolveQueuedAutoSendReadiness(store.getState(), target())).toBe('busy');
  });

  test('reports ready only for live terminal state on the owning directory', () => {
    resetLiveStore();
    hydrateResident('s1', 'idle');
    expect(resolveQueuedAutoSendReadiness(store.getState(), target())).toBe('ready');

    hydrateResident('s1', 'error');
    expect(resolveQueuedAutoSendReadiness(store.getState(), target())).toBe('ready');

    // A separate row owned by another directory: the captured /repo target
    // must not match it, while its own directory resolves live.
    hydrateResident('s2', 'idle', '/other');
    expect(resolveQueuedAutoSendReadiness(store.getState(), target('s2', '/repo'))).toBe('unknown');
    expect(resolveQueuedAutoSendReadiness(store.getState(), target('s2', '/other'))).toBe('ready');
  });

  test('reports unknown for cold rows, missing rows, and disconnected runtimes', () => {
    resetLiveStore();
    // Cold: a lifecycle event created the row but nothing observed it live.
    asInternal().commitEvents([lifecycleEvent('s1', 'idle')]);
    expect(resolveQueuedAutoSendReadiness(store.getState(), target())).toBe('unknown');

    // Missing row entirely.
    expect(resolveQueuedAutoSendReadiness(store.getState(), target('missing'))).toBe('unknown');

    // Connection not ready, even with a live-idle resident row.
    hydrateResident('s1', 'idle');
    asInternal().state = { ...store.getState(), connection: 'unavailable' };
    expect(resolveQueuedAutoSendReadiness(store.getState(), target())).toBe('unknown');
  });

  test('an archived row never resolves ready, even hydrated and idle', () => {
    resetLiveStore();
    hydrateResident('s1', 'idle');
    markArchived('s1');
    expect(resolveQueuedAutoSendReadiness(store.getState(), target())).toBe('unknown');
  });

  test('a confirmed invalid session never resolves ready, even against a hydrated row', () => {
    resetLiveStore();
    hydrateResident('s1', 'idle');
    const internal = asInternal();
    const errors = new Map(internal.state.sessionLoadErrorById);
    errors.set('s1', new PiRequestError('INVALID_SESSION', 'session not found'));
    internal.state = { ...internal.state, sessionLoadErrorById: errors };
    expect(resolveQueuedAutoSendReadiness(store.getState(), target())).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Pure helpers (unchanged contracts)
// ---------------------------------------------------------------------------

describe('queued auto-send retry scheduler', () => {
  test('wakes the queue when backoff expires', () => {
    const callbacks = new Map<number, () => void>();
    let nextTimer = 0;
    let wakeups = 0;
    const scheduler = createQueuedAutoSendRetryScheduler(
      () => { wakeups += 1; },
      () => 1_000,
      (callback, delay) => {
        callbacks.set(++nextTimer, callback);
        expect(delay).toBe(500);
        return nextTimer as unknown as ReturnType<typeof setTimeout>;
      },
      (timer) => { callbacks.delete(timer as unknown as number); },
    );

    scheduler.schedule(1_500);
    expect(callbacks.size).toBe(1);
    callbacks.values().next().value?.();
    expect(wakeups).toBe(1);
  });

  test('keeps the earliest retry and cancels it on dispose', () => {
    const callbacks = new Map<number, () => void>();
    let nextTimer = 0;
    const delays: number[] = [];
    const scheduler = createQueuedAutoSendRetryScheduler(
      () => undefined,
      () => 1_000,
      (callback, delay) => {
        callbacks.set(++nextTimer, callback);
        delays.push(delay);
        return nextTimer as unknown as ReturnType<typeof setTimeout>;
      },
      (timer) => { callbacks.delete(timer as unknown as number); },
    );

    scheduler.schedule(3_000);
    scheduler.schedule(4_000);
    scheduler.schedule(2_000);

    expect(delays).toEqual([2_000, 1_000]);
    expect(callbacks.size).toBe(1);
    scheduler.dispose();
    expect(callbacks.size).toBe(0);
  });
});

describe('queued auto-send retry backoff', () => {
  test('delay grows exponentially and is capped', () => {
    expect(getQueuedAutoSendRetryDelayMs(1)).toBe(2000);
    expect(getQueuedAutoSendRetryDelayMs(2)).toBe(4000);
    expect(getQueuedAutoSendRetryDelayMs(3)).toBe(8000);
    expect(getQueuedAutoSendRetryDelayMs(10)).toBe(60000);
    expect(getQueuedAutoSendRetryDelayMs(100)).toBe(60000);
  });

  test('backs off only the failed message within its window', () => {
    const failure = { messageId: 'queued-1', failures: 1, nextAttemptAt: 10_000 };

    expect(isQueuedAutoSendBackedOff(failure, 'queued-1', 9_999)).toBe(true);
    expect(isQueuedAutoSendBackedOff(failure, 'queued-1', 10_000)).toBe(false);
    expect(isQueuedAutoSendBackedOff(failure, 'queued-2', 9_999)).toBe(false);
    expect(isQueuedAutoSendBackedOff(undefined, 'queued-1', 0)).toBe(false);
  });
});

describe('buildQueuedAutoSendPayload', () => {
  test('returns only the first queued message for auto-send', () => {
    const queue: QueuedMessage[] = [
      { id: 'queued-1', content: 'first queued message', createdAt: 1 },
      { id: 'queued-2', content: 'second queued message', createdAt: 2 },
    ];

    const payload = buildQueuedAutoSendPayload(queue);

    expect(payload).not.toBeNull();
    expect(payload?.queuedMessageId).toBe('queued-1');
    expect(payload?.primaryText).toBe('first queued message');
    expect(payload?.primaryAttachments).toEqual([]);
  });

  test('passes queued content through with no agent mention', () => {
    const queue: QueuedMessage[] = [
      { id: 'queued-mention', content: '@Builder please take this', createdAt: 1 },
    ];

    const payload = buildQueuedAutoSendPayload(queue);

    expect(payload).not.toBeNull();
    expect(payload?.agentMentionName).toBe(undefined);
    expect(payload?.primaryText).toBe('@Builder please take this');
  });

  test('preserves attachment-only queued messages as sendable payloads', () => {
    const queue: QueuedMessage[] = [
      {
        id: 'queued-attachments',
        content: '',
        createdAt: 1,
        attachments: [
          {
            id: 'file-1',
            filename: 'notes.txt',
            mimeType: 'text/plain',
            size: 5,
            source: 'local',
            file: new File(['hello'], 'notes.txt', { type: 'text/plain' }),
            dataUrl: 'data:text/plain;base64,aGVsbG8=',
          },
        ],
      },
      { id: 'queued-2', content: 'later queued message', createdAt: 2 },
    ];

    const payload = buildQueuedAutoSendPayload(queue);

    expect(payload).not.toBeNull();
    expect(payload?.queuedMessageId).toBe('queued-attachments');
    expect(payload?.primaryText).toBe('');
    expect(payload?.primaryAttachments).toHaveLength(1);
    expect(payload?.primaryAttachments[0]?.filename).toBe('notes.txt');
  });

  test('auto-send targets the queued session explicitly', async () => {
    const payload = buildQueuedAutoSendPayload([
      { id: 'queued-1', content: 'queued message', createdAt: 1 },
    ]);

    expect(payload).not.toBeNull();
    await sendQueuedAutoSendPayload({
      runtimeKey: 'runtime-original',
      sessionId: 'session-original',
      directory: '/repo',
    }, payload!, {
      providerID: 'provider-1',
      modelID: 'model-1',
      agent: 'agent-1',
      variant: 'variant-1',
    });

    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0]).toEqual([
      'queued message',
      'provider-1',
      'model-1',
      'agent-1',
      [],
      undefined,
      undefined,
      'variant-1',
      'normal',
      {
        target: {
          runtimeKey: 'runtime-original',
          sessionId: 'session-original',
          directory: '/repo',
        },
      },
    ]);
  });
});
