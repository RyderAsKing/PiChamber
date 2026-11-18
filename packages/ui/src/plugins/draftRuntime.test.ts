import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { create } from 'zustand';

import type { PiComposerControl, PiSessionCreateInput, PiSessionEvent } from '@/lib/pi/protocol';

// Everything the draft runtime talks to is a fake: the Pi client, the
// shared session store's draft-event feed, health, and the composer config.

type DraftListener = { onEvent: (event: PiSessionEvent) => void; onReset: () => void };
const listeners = new Set<DraftListener>();
const calls: Array<[string, unknown]> = [];
const runDirectories: Array<string | undefined> = [];
let capabilities = ['sessions.discardDraft'];
let healthState = 'ready';
// Controls of created sessions in the (fake) shared session store.
const sessionControls = new Map<string, Map<string, PiComposerControl>>();
let createImpl: (input: PiSessionCreateInput) => Promise<unknown>;
let runImpl: (input: { sessionId: string; id: string; value?: unknown }) => Promise<{ ran: boolean }> = async () => ({ ran: true });
let modelImpl: () => Promise<void> = async () => {};
const toasts: string[] = [];

const mode = (value: string): PiComposerControl => ({
  id: 'mode',
  kind: 'cycle',
  label: 'Mode',
  value,
  options: [
    { value: 'economy', label: 'Economy', command: 'economy' },
    { value: 'balance', label: 'Balance', command: 'balance' },
  ],
});

const detail = (id: string, controls: PiComposerControl[] = [mode('economy')]) => ({
  session: { id, directory: '/work', createdAt: 1, updatedAt: 1, model: { providerId: 'p', modelId: 'm1' }, thinking: 'low' },
  messages: [],
  lastSequence: 5,
  extensionControls: controls,
});

mock.module('@/lib/pi/client', () => ({
  piClient: {
    createSession: (input: PiSessionCreateInput) => {
      calls.push(['create', input]);
      return createImpl(input);
    },
    discardDraftSession: async (sessionId: string) => {
      calls.push(['discard', sessionId]);
      return true;
    },
    setSessionModel: async (input: unknown) => {
      calls.push(['model', input]);
      return modelImpl();
    },
    setSessionThinking: async (input: unknown) => {
      calls.push(['thinking', input]);
    },
    runExtensionControl: async (input: { sessionId: string; id: string; value?: unknown }, scope?: { directory?: string }) => {
      calls.push(['run', input]);
      runDirectories.push(scope?.directory);
      return runImpl(input);
    },
  },
}));
mock.module('@/lib/pi/transport', () => ({
  fetchPiRuntimeHealth: async () => (healthState === 'ready'
    ? { state: 'ready', protocolVersion: 1, capabilities }
    : { state: healthState, capabilities: [] }),
}));
mock.module('@/apps/pi-session-store', () => ({
  getPiSessionStore: () => ({
    getState: () => ({
      directory: '/work',
      reducer: { bySession: new Map([...sessionControls].map(([id, controls]) => [id, { extensionControls: controls }])) },
    }),
  }),
  subscribeDraftEvents: (listener: DraftListener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => 'runtime-1' }));
mock.module('@/lib/pi/tab-client-id', () => ({ getTabClientId: () => 'tab-1' }));
mock.module('@/components/ui', () => ({ toast: { error: (message: string) => toasts.push(message) } }));

interface FakeConfig {
  currentProviderId: string;
  currentModelId: string;
  currentVariant: string | undefined;
  providers: Array<{ id: string; models: Array<{ id: string }> }>;
  setProvider: (id: string) => void;
  setModel: (id: string) => void;
  setCurrentVariant: (variant: string | undefined) => void;
  getCurrentModelVariants: () => string[];
}
// m3 thinks only at max, as some models do.
const VARIANTS: Record<string, string[]> = { m1: ['off', 'low', 'high'], m2: ['off', 'low', 'high'], m3: ['max'] };
const useFakeConfig = create<FakeConfig>((set, get) => ({
  currentProviderId: 'p',
  currentModelId: 'm1',
  currentVariant: 'low',
  providers: [{ id: 'p', models: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] }],
  setProvider: (id) => set({ currentProviderId: id }),
  setModel: (id) => set({ currentModelId: id }),
  setCurrentVariant: (variant) => set({ currentVariant: variant }),
  getCurrentModelVariants: () => VARIANTS[get().currentModelId] ?? [],
}));
mock.module('@/stores/useConfigStore', () => ({ useConfigStore: useFakeConfig }));

const runtime = await import('./draftRuntime');
const {
  applyControlEvent,
  applyDraftControlPicks,
  consumeDraftRuntime,
  draftRuntimeTargetOf,
  ensureDraftRuntime,
  pickDraftControl,
  releaseDraftRuntime,
  resetDraftRuntimeForTests,
  useDraftRuntimeStore,
} = runtime;

const entry = () => useDraftRuntimeStore.getState().entry;
const target = { draftId: 'draft-1', directory: '/work' };
const event = (name: string, payload: unknown, sessionId = 'pi-draft'): PiSessionEvent => ({
  protocolVersion: 1,
  kind: 'event',
  name,
  sequence: 9,
  sessionId,
  directory: '/work',
  payload,
  draft: true,
} as unknown as PiSessionEvent);
const emit = (value: PiSessionEvent) => {
  for (const listener of listeners) listener.onEvent(value);
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resetDraftRuntimeForTests();
  calls.length = 0;
  runDirectories.length = 0;
  toasts.length = 0;
  capabilities = ['sessions.discardDraft'];
  healthState = 'ready';
  sessionControls.clear();
  modelImpl = async () => {};
  createImpl = async () => detail('pi-draft');
  runImpl = async () => ({ ran: true });
  useFakeConfig.setState({ currentProviderId: 'p', currentModelId: 'm1', currentVariant: 'low' });
});

describe('draftRuntimeTargetOf', () => {
  const draft = { open: true, id: 'draft-1', directoryOverride: null, parentID: null };

  test('starts one for an open draft in its folder or the current one', () => {
    expect(draftRuntimeTargetOf(draft, '/work')).toEqual({ draftId: 'draft-1', directory: '/work' });
    expect(draftRuntimeTargetOf({ ...draft, directoryOverride: '/other' }, '/work')).toEqual({ draftId: 'draft-1', directory: '/other' });
  });

  test('none for a closed draft, a fork, or a worktree or branch still to make', () => {
    expect(draftRuntimeTargetOf({ ...draft, open: false }, '/work')).toBeNull();
    expect(draftRuntimeTargetOf({ ...draft, parentID: 'parent' }, '/work')).toBeNull();
    expect(draftRuntimeTargetOf({ ...draft, worktreeIntent: {} as never }, '/work')).toBeNull();
    expect(draftRuntimeTargetOf({ ...draft, branchIntent: {} as never }, '/work')).toBeNull();
    expect(draftRuntimeTargetOf(draft, null)).toBeNull();
  });
});

describe('applyControlEvent', () => {
  test('replaces in place, adds at the end, and removes', () => {
    const plan: PiComposerControl = { id: 'plan', kind: 'toggle', label: 'Plan', value: false, command: 'plan' };
    const start = [mode('economy'), plan];
    expect(applyControlEvent(start, { control: mode('balance') })).toEqual([mode('balance'), plan]);
    const extra: PiComposerControl = { id: 'run', kind: 'action', label: 'Run', command: 'go' };
    expect(applyControlEvent(start, { control: extra })).toEqual([...start, extra]);
    expect(applyControlEvent(start, { id: 'mode', removed: true })).toEqual([plan]);
  });
});

describe('draft runtime', () => {
  test('starts a draft session with the composer\'s model and keeps its controls', async () => {
    await ensureDraftRuntime(target);
    expect(calls[0]).toEqual(['create', { cwd: '/work', draft: true, model: { providerId: 'p', modelId: 'm1' }, thinking: 'low' }]);
    expect(entry()).toMatchObject({ status: 'ready', sessionId: 'pi-draft', controls: [mode('economy')] });
    await ensureDraftRuntime(target);
    expect(calls.filter(([name]) => name === 'create')).toHaveLength(1);
  });

  test('a server without draft sessions is never asked to start one, until the server or daemon changes', async () => {
    capabilities = [];
    await ensureDraftRuntime(target);
    expect(calls).toEqual([]);
    expect(entry()).toMatchObject({ status: 'failed', unsupported: true });
    await ensureDraftRuntime({ draftId: 'draft-2', directory: '/work' });
    expect(calls).toEqual([]);

    for (const listener of listeners) listener.onReset();
    expect(entry()?.unsupported).toBe(false);
    capabilities = ['sessions.discardDraft'];
    await ensureDraftRuntime({ draftId: 'draft-2', directory: '/work' });
    expect(entry()).toMatchObject({ status: 'ready', sessionId: 'pi-draft' });
  });

  test('an unreachable daemon is a failure to retry, not a server without draft sessions', async () => {
    healthState = 'unavailable';
    await ensureDraftRuntime(target);
    expect(entry()).toMatchObject({ status: 'failed' });
    expect(entry()?.unsupported).toBeFalsy();
  });

  test('releasing discards it, and a start that lands after release is discarded too', async () => {
    await ensureDraftRuntime(target);
    releaseDraftRuntime();
    expect(calls.at(-1)).toEqual(['discard', 'pi-draft']);
    expect(entry()).toBeNull();

    const pending = deferred<unknown>();
    createImpl = () => pending.promise;
    const started = ensureDraftRuntime(target);
    await settle();
    releaseDraftRuntime();
    pending.resolve(detail('pi-late'));
    await started;
    expect(calls.at(-1)).toEqual(['discard', 'pi-late']);
    expect(entry()).toBeNull();
  });

  test('a failed start is reported as failed, not as a draft without controls', async () => {
    createImpl = async () => {
      throw new Error('daemon down');
    };
    await ensureDraftRuntime(target);
    expect(entry()).toMatchObject({ status: 'failed', sessionId: null, controls: null });
  });

  test('follows its events: controls, expiry, and a daemon restart', async () => {
    await ensureDraftRuntime(target);
    emit(event('extension.control', { control: mode('balance') }));
    expect(entry()?.controls).toEqual([mode('balance')]);
    emit(event('extension.control', { control: mode('economy') }, 'someone-else'));
    expect(entry()?.controls).toEqual([mode('balance')]);
    emit(event('session.deleted', {}));
    expect(entry()).toMatchObject({ status: 'expired', sessionId: null, controls: [mode('balance')] });

    await ensureDraftRuntime(target);
    expect(entry()?.status).toBe('ready');
    for (const listener of listeners) listener.onReset();
    expect(entry()).toMatchObject({ status: 'expired', sessionId: null });
  });

  test('applies events that arrived while it started', async () => {
    const pending = deferred<unknown>();
    createImpl = () => pending.promise;
    const started = ensureDraftRuntime(target);
    await settle();
    emit({ ...event('extension.control', { control: mode('balance') }), sequence: 6 } as PiSessionEvent);
    emit({ ...event('extension.control', { control: mode('economy') }), sequence: 4 } as PiSessionEvent);
    pending.resolve(detail('pi-draft'));
    await started;
    expect(entry()?.controls).toEqual([mode('balance')]);
  });

  test('a click before it is ready waits, then runs there and shows until confirmed', async () => {
    const pending = deferred<unknown>();
    createImpl = () => pending.promise;
    const started = ensureDraftRuntime(target);
    await settle();
    pickDraftControl('draft-1', mode('economy'), 'balance');
    expect(calls.some(([name]) => name === 'run')).toBe(false);
    expect(useDraftRuntimeStore.getState().picks?.values.mode).toEqual({ value: 'balance' });

    pending.resolve(detail('pi-draft'));
    await started;
    expect(calls.find(([name]) => name === 'run')).toEqual(['run', { sessionId: 'pi-draft', id: 'mode', value: 'balance', clientId: 'tab-1' }]);
    // The draft's folder routes it: nothing is on disk for the server to read.
    expect(runDirectories).toEqual(['/work']);
    expect(typeof useDraftRuntimeStore.getState().picks?.values.mode?.sentAt).toBe('number');
    emit(event('extension.control', { control: mode('balance') }));
    expect(useDraftRuntimeStore.getState().picks).toBeNull();
  });

  test('clicking back to the value the draft session reported asks for nothing', async () => {
    await ensureDraftRuntime(target);
    runImpl = () => new Promise(() => {});
    pickDraftControl('draft-1', mode('economy'), 'balance');
    // Settled by the extension's report, then back again.
    emit(event('extension.control', { control: mode('balance') }));
    pickDraftControl('draft-1', mode('balance'), 'economy');
    expect(useDraftRuntimeStore.getState().picks?.values.mode?.value).toBe('economy');
  });

  test('a click on a remembered value is kept: it is no proof of the session\'s', async () => {
    // Before the draft session reported, the composer shows a remembered
    // "economy"; choosing it must still reach the new session.
    pickDraftControl('draft-1', mode('economy'), 'economy');
    expect(useDraftRuntimeStore.getState().picks?.values.mode).toEqual({ value: 'economy' });
    sessionControls.set('pi-created', new Map([['mode', mode('balance')]]));
    await applyDraftControlPicks('draft-1', 'pi-created');
    expect(calls).toEqual([['run', { sessionId: 'pi-created', id: 'mode', value: 'economy', clientId: 'tab-1' }]]);
  });

  test('an action waits for nothing: it needs a ready draft session', () => {
    pickDraftControl('draft-1', { id: 'go', kind: 'action', label: 'Go', command: 'go' }, undefined);
    expect(useDraftRuntimeStore.getState().picks).toBeNull();
  });

  test('a send adopts it only when it is ready in the same folder', async () => {
    await ensureDraftRuntime(target);
    expect(consumeDraftRuntime('draft-1', '/elsewhere')).toBeNull();
    expect(calls.at(-1)).toEqual(['discard', 'pi-draft']);

    await ensureDraftRuntime(target);
    expect(consumeDraftRuntime('draft-1', '/work')).toEqual({ sessionId: 'pi-draft', runtimeSelection: null });
    expect(entry()).toBeNull();
    expect(calls.at(-1)?.[0]).toBe('create');
  });

  test('clicks that never reached a draft session run on the created one', async () => {
    pickDraftControl('draft-1', mode('economy'), 'balance');
    await applyDraftControlPicks('draft-1', 'pi-created');
    expect(calls).toEqual([['run', { sessionId: 'pi-created', id: 'mode', value: 'balance', clientId: 'tab-1' }]]);
    expect(useDraftRuntimeStore.getState().picks).toBeNull();

    pickDraftControl('draft-1', mode('economy'), 'balance');
    runImpl = async () => {
      throw new Error('gone');
    };
    await applyDraftControlPicks('draft-1', 'pi-created');
    expect(toasts).toEqual(['Could not apply a composer control to this session']);
  });

  test('the composer follows a model the runtime changed, but not its own echo', async () => {
    await ensureDraftRuntime(target);
    emit(event('session.model', { model: { providerId: 'p', modelId: 'm2' } }));
    expect(useFakeConfig.getState().currentModelId).toBe('m2');
    emit(event('session.thinking', { thinking: 'high' }));
    expect(useFakeConfig.getState().currentVariant).toBe('high');

    // An unknown model never replaces the composer's.
    emit(event('session.model', { model: { providerId: 'unknown', modelId: 'unknown' } }));
    expect(useFakeConfig.getState().currentModelId).toBe('m2');
  });

  test('a mode that changes model and thinking moves both, even from a model without that thinking', async () => {
    await ensureDraftRuntime(target);
    useFakeConfig.setState({ currentModelId: 'm3', currentVariant: 'max' });
    // Pi reports the thinking first: m3 cannot take it yet.
    emit(event('session.thinking', { thinking: 'low' }));
    expect(useFakeConfig.getState().currentVariant).toBe('max');
    emit(event('session.model', { model: { providerId: 'p', modelId: 'm2' } }));
    expect(useFakeConfig.getState()).toMatchObject({ currentModelId: 'm2', currentVariant: 'low' });
    // Nothing is pushed back: the composer now matches the runtime.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(calls.some(([kind]) => kind === 'model' || kind === 'thinking')).toBe(false);
  });

  test('a model picked in the draft reaches its runtime', async () => {
    await ensureDraftRuntime(target);
    useFakeConfig.getState().setModel('m2');
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(calls.at(-1)).toEqual(['model', { sessionId: 'pi-draft', model: { providerId: 'p', modelId: 'm2' } }]);
    // Its echo changes nothing.
    useFakeConfig.getState().setModel('m1');
    emit(event('session.model', { model: { providerId: 'p', modelId: 'm2' } }));
    expect(useFakeConfig.getState().currentModelId).toBe('m1');
  });

  test('a value chosen on a draft session that expired is sent to the next one', async () => {
    await ensureDraftRuntime(target);
    pickDraftControl('draft-1', mode('economy'), 'balance');
    await settle();
    emit(event('extension.control', { control: mode('balance') }));
    expect(useDraftRuntimeStore.getState().picks).toBeNull();
    emit(event('session.deleted', {}));
    calls.length = 0;
    createImpl = async () => detail('pi-draft-2');
    await ensureDraftRuntime(target);
    await settle();
    expect(calls.find(([name]) => name === 'run')).toEqual(['run', { sessionId: 'pi-draft-2', id: 'mode', value: 'balance', clientId: 'tab-1' }]);
  });

  test('a control declared after the draft session started gets the value chosen before', async () => {
    createImpl = async () => detail('pi-draft', []);
    // Clicked on the folder's remembered controls, before the session reported.
    pickDraftControl('draft-1', mode('economy'), 'balance');
    await ensureDraftRuntime(target);
    await settle();
    // The session does not have the control yet: nothing to run it on.
    expect(calls.filter(([name]) => name === 'run')).toEqual([]);
    emit(event('extension.control', { control: mode('economy') }));
    await settle();
    expect(calls.filter(([name]) => name === 'run'))
      .toEqual([['run', { sessionId: 'pi-draft', id: 'mode', value: 'balance', clientId: 'tab-1' }]]);
  });

  test('a click that failed is not applied to a session created without the draft session', async () => {
    await ensureDraftRuntime(target);
    runImpl = async () => {
      throw new Error('command failed');
    };
    pickDraftControl('draft-1', mode('economy'), 'balance');
    await settle();
    await settle();
    expect(toasts).toEqual(['Could not change Mode']);
    expect(useDraftRuntimeStore.getState().picks).toBeNull();
    consumeDraftRuntime('draft-1', '/work');
    calls.length = 0;
    runImpl = async () => ({ ran: true });
    // The composer showed economy again, so the new session keeps economy.
    sessionControls.set('pi-new', new Map([['mode', mode('economy')]]));
    await applyDraftControlPicks('draft-1', 'pi-new', 'pi-draft');
    expect(calls).toEqual([]);
  });

  test('a model turn in the draft session hands it over: not discarded, and the draft starts no other', async () => {
    await ensureDraftRuntime(target);
    const first = deferred<{ ran: boolean }>();
    runImpl = () => first.promise;
    pickDraftControl('draft-1', mode('economy'), 'balance');
    await settle();
    // A command running without a turn changes nothing.
    emit(event('session.lifecycle', { state: 'busy', command: '/balance' }));
    expect(entry()).toMatchObject({ status: 'ready', sessionId: 'pi-draft' });
    // The command sent a message: the daemon made the session an ordinary one.
    emit(event('session.lifecycle', { state: 'busy' }));
    first.resolve({ ran: true });
    await settle();
    expect(entry()).toMatchObject({ status: 'failed', sessionId: null, turnStarted: true });
    expect(useDraftRuntimeStore.getState().picks).toBeNull();
    expect(calls.filter(([name]) => name === 'discard')).toEqual([]);

    // Neither the window coming back nor a click starts another draft session.
    calls.length = 0;
    await ensureDraftRuntime(target);
    pickDraftControl('draft-1', mode('economy'), 'economy');
    await settle();
    expect(calls).toEqual([]);
    // The send creates as usual; the click that started the turn is not run
    // again, the one made afterwards is.
    expect(consumeDraftRuntime('draft-1', '/work')).toBeNull();
    sessionControls.set('pi-new', new Map([['mode', mode('balance')]]));
    runImpl = async () => ({ ran: true });
    await applyDraftControlPicks('draft-1', 'pi-new', null);
    expect(calls).toEqual([['run', { sessionId: 'pi-new', id: 'mode', value: 'economy', clientId: 'tab-1' }]]);
  });

  test('a send that could not adopt the draft session applies every chosen value the new session lacks', async () => {
    await ensureDraftRuntime(target);
    pickDraftControl('draft-1', mode('economy'), 'balance');
    await settle();
    emit(event('extension.control', { control: mode('balance') }));
    const consumed = consumeDraftRuntime('draft-1', '/work');
    calls.length = 0;
    // The daemon had dropped it: a new session with its own id.
    sessionControls.set('pi-new', new Map([['mode', mode('economy')]]));
    await applyDraftControlPicks('draft-1', 'pi-new', consumed?.sessionId ?? null);
    expect(calls).toEqual([['run', { sessionId: 'pi-new', id: 'mode', value: 'balance', clientId: 'tab-1' }]]);

    // Adopted: what the draft session confirmed is not run again.
    await ensureDraftRuntime({ draftId: 'draft-2', directory: '/work' });
    pickDraftControl('draft-2', mode('economy'), 'balance');
    await settle();
    emit(event('extension.control', { control: mode('balance') }));
    const adopted = consumeDraftRuntime('draft-2', '/work');
    calls.length = 0;
    await applyDraftControlPicks('draft-2', 'pi-draft', adopted?.sessionId ?? null);
    expect(calls).toEqual([]);
  });

  test('a click that did not run while the runtime shows another value restarts a dropped draft session', async () => {
    await ensureDraftRuntime(target);
    let first = true;
    runImpl = async () => {
      if (first) {
        first = false;
        return { ran: false };
      }
      return { ran: true };
    };
    createImpl = async () => detail('pi-draft-2');
    pickDraftControl('draft-1', mode('economy'), 'balance');
    await settle();
    await settle();
    expect(entry()).toMatchObject({ status: 'ready', sessionId: 'pi-draft-2' });
    expect(calls.filter(([name]) => name === 'run').map(([, input]) => (input as { sessionId: string }).sessionId))
      .toEqual(['pi-draft', 'pi-draft-2']);
    // Should the first still be there, it is not left running beside the new one.
    expect(calls.filter(([name]) => name === 'discard')).toEqual([['discard', 'pi-draft']]);
  });

  test('a push the daemon answers with an unknown session restarts the draft session', async () => {
    await ensureDraftRuntime(target);
    let gone = 1;
    modelImpl = async () => {
      if (gone-- > 0) throw Object.assign(new Error('gone'), { code: 'INVALID_SESSION' });
    };
    createImpl = async () => detail('pi-draft-2');
    useFakeConfig.getState().setModel('m2');
    await new Promise((resolve) => setTimeout(resolve, 350));
    await settle();
    expect(entry()).toMatchObject({ status: 'ready', sessionId: 'pi-draft-2' });
    expect(calls.filter(([name]) => name === 'model')).toHaveLength(2);

    // One that keeps dropping them backs off instead of looping.
    modelImpl = async () => {
      throw Object.assign(new Error('gone'), { code: 'INVALID_SESSION' });
    };
    useFakeConfig.getState().setModel('m1');
    await new Promise((resolve) => setTimeout(resolve, 350));
    await settle();
    expect(entry()).toMatchObject({ status: 'failed', sessionId: null });
  });

  test('clicks run one at a time', async () => {
    const plan: PiComposerControl = { id: 'plan', kind: 'toggle', label: 'Plan', value: false, command: 'plan' };
    createImpl = async () => detail('pi-draft', [mode('economy'), plan]);
    await ensureDraftRuntime(target);
    const first = deferred<{ ran: boolean }>();
    runImpl = () => first.promise;
    pickDraftControl('draft-1', mode('economy'), 'balance');
    pickDraftControl('draft-1', plan, true);
    await settle();
    expect(calls.filter(([name]) => name === 'run')).toHaveLength(1);
    runImpl = async () => ({ ran: true });
    first.resolve({ ran: true });
    await settle();
    await settle();
    expect(calls.filter(([name]) => name === 'run')).toHaveLength(2);
  });

  test('an older click\'s timer does not clear a newer click on the same control', async () => {
    await ensureDraftRuntime(target);
    const realSetTimeout = globalThis.setTimeout;
    const timers: Array<() => void> = [];
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      if (ms === 8_000) {
        timers.push(fn);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout;
    try {
      pickDraftControl('draft-1', mode('economy'), 'balance');
      await settle();
      emit(event('extension.control', { control: mode('balance') }));
      pickDraftControl('draft-1', mode('balance'), 'economy');
      await settle();
      expect(timers).toHaveLength(2);
      timers[0]();
      expect(useDraftRuntimeStore.getState().picks?.values.mode?.value).toBe('economy');
      timers[1]();
      expect(useDraftRuntimeStore.getState().picks).toBeNull();
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test('a send waits briefly for a click still running on the draft session', async () => {
    await ensureDraftRuntime(target);
    const run = deferred<{ ran: boolean }>();
    runImpl = () => run.promise;
    pickDraftControl('draft-1', mode('economy'), 'balance');
    await settle();
    let settled = false;
    const waiting = runtime.settleDraftPicks('draft-1').then(() => {
      settled = true;
    });
    await settle();
    expect(settled).toBe(false);
    run.resolve({ ran: true });
    emit(event('extension.control', { control: mode('balance') }));
    await waiting;
    expect(settled).toBe(true);
  });

  test('a click that did not run on the created session and is still not set is reported', async () => {
    pickDraftControl('draft-1', mode('economy'), 'balance');
    sessionControls.set('pi-created', new Map([['mode', mode('economy')]]));
    runImpl = async () => ({ ran: false });
    await applyDraftControlPicks('draft-1', 'pi-created');
    expect(toasts).toEqual(['Could not apply a composer control to this session']);
  });

  test('an unlisted model an extension set is not undone by the composer or the send', async () => {
    await ensureDraftRuntime(target);
    emit(event('session.model', { model: { providerId: 'ext', modelId: 'secret' } }));
    expect(entry()?.modelUnlisted).toBe(true);
    useFakeConfig.getState().setCurrentVariant('high');
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(calls.some(([kind]) => kind === 'model' || kind === 'thinking')).toBe(false);
    expect(consumeDraftRuntime('draft-1', '/work')).toEqual({
      sessionId: 'pi-draft',
      runtimeSelection: { model: { providerId: 'ext', modelId: 'secret' }, thinking: 'low' },
    });

    // A model the user picks clears it.
    await ensureDraftRuntime({ draftId: 'draft-2', directory: '/work' });
    emit(event('session.model', { model: { providerId: 'ext', modelId: 'secret' } }));
    useFakeConfig.getState().setModel('m2');
    expect(entry()?.modelUnlisted).toBe(false);
  });

  test('a thinking echo the runtime clamped does not swallow a later change of its own', async () => {
    await ensureDraftRuntime(target);
    useFakeConfig.getState().setCurrentVariant('high');
    await new Promise((resolve) => setTimeout(resolve, 350));
    // Clamped: the answer carries another level, which the composer takes.
    emit(event('session.thinking', { thinking: 'off' }));
    expect(useFakeConfig.getState().currentVariant).toBe('off');
    // A runtime change to 'high' later is the runtime's own.
    emit(event('session.thinking', { thinking: 'high' }));
    expect(useFakeConfig.getState().currentVariant).toBe('high');
  });
});
