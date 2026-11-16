import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type {
  PiPluginSessionStateInput,
  PiPluginSessionStateResponse,
  PiPluginSessionStateUpdate,
} from '@/lib/pi/protocol';

let getImpl: (sessionId: string) => Promise<PiPluginSessionStateResponse> = async (sessionId) => ({ sessionId, overrides: {} });
let setImpl: (id: string, sessionId: string, input: PiPluginSessionStateInput) => Promise<PiPluginSessionStateUpdate> = async () => {
  throw new Error('unset');
};
let runtimeKey = 'runtime-1';

mock.module('@/lib/pi/client', () => ({
  piClient: {
    getPluginSessionState: (sessionId: string) => getImpl(sessionId),
    setPluginSessionState: (id: string, sessionId: string, input: PiPluginSessionStateInput) => setImpl(id, sessionId, input),
  },
}));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => runtimeKey }));
const toasts: Array<[string, unknown]> = [];
mock.module('sonner', () => ({ toast: { error: (message: string, options: unknown) => toasts.push([message, options]) } }));

const { usePluginSessionStore, selectComposerOverrides, withOverride, applyDraftSwitches } = await import('./sessionStore');
const { usePluginsStore } = await import('./store');

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const overridesOf = (sessionId: string) => usePluginSessionStore.getState().sessions[sessionId]?.overrides ?? null;

describe('usePluginSessionStore', () => {
  beforeEach(() => {
    runtimeKey = 'runtime-1';
    usePluginSessionStore.getState().resetForRuntimeSwitch();
    getImpl = async (sessionId) => ({ sessionId, overrides: {} });
  });

  test('withOverride sets and removes one value, dropping empty plugins', () => {
    const one = withOverride({}, 'subagents', 'on', false);
    expect(one).toEqual({ subagents: { on: false } });
    expect(withOverride(one, 'subagents', 'on', undefined)).toEqual({});
  });

  test('loads a session\'s own values', async () => {
    getImpl = async (sessionId) => ({ sessionId, overrides: { subagents: { on: false } } });
    await usePluginSessionStore.getState().load('s1');
    expect(overridesOf('s1')).toEqual({ subagents: { on: false } });
    expect(usePluginSessionStore.getState().sessions.s1?.status).toBe('ready');
  });

  test('a failed read keeps the previous values and is not empty success', async () => {
    getImpl = async (sessionId) => ({ sessionId, overrides: { subagents: { on: false } } });
    await usePluginSessionStore.getState().load('s1');
    getImpl = async () => { throw new Error('offline'); };
    await usePluginSessionStore.getState().load('s1', { force: true });
    expect(overridesOf('s1')).toEqual({ subagents: { on: false } });
    expect(usePluginSessionStore.getState().sessions.s1?.status).toBe('error');
  });

  test('stores a value that differs from the default and clears one that matches', async () => {
    const writes: PiPluginSessionStateInput[] = [];
    setImpl = async (id, sessionId, input) => {
      writes.push(input);
      return { id, sessionId, overrides: input.value === null ? {} : { [input.key]: input.value } };
    };
    expect(await usePluginSessionStore.getState().set('s1', 'subagents', 'on', false, true)).toBe(true);
    expect(overridesOf('s1')).toEqual({ subagents: { on: false } });
    expect(await usePluginSessionStore.getState().set('s1', 'subagents', 'on', true, true)).toBe(true);
    expect(overridesOf('s1')).toEqual({});
    expect(writes).toEqual([{ key: 'on', value: false }, { key: 'on', value: null }]);
  });

  test('shows a write at once and takes it back when it fails', async () => {
    const write = deferred<PiPluginSessionStateUpdate>();
    setImpl = () => write.promise;
    const result = usePluginSessionStore.getState().set('s1', 'subagents', 'on', false, true);
    expect(overridesOf('s1')).toEqual({ subagents: { on: false } });
    expect(usePluginSessionStore.getState().pending['s1\nsubagents\non']).toBe(true);
    write.reject(new Error('nope'));
    expect(await result).toBe(false);
    expect(overridesOf('s1')).toEqual({});
    expect(usePluginSessionStore.getState().pending).toEqual({});
  });

  test('a read that started before a write keeps the written value', async () => {
    const read = deferred<PiPluginSessionStateResponse>();
    getImpl = () => read.promise;
    const loading = usePluginSessionStore.getState().load('s1');
    setImpl = async (id, sessionId) => ({ id, sessionId, overrides: { on: false } });
    await usePluginSessionStore.getState().set('s1', 'subagents', 'on', false, true);
    read.resolve({ sessionId: 's1', overrides: {} });
    await loading;
    expect(overridesOf('s1')).toEqual({ subagents: { on: false } });
  });

  test('a read that started before a write keeps only that key local', async () => {
    const read = deferred<PiPluginSessionStateResponse>();
    getImpl = () => read.promise;
    const loading = usePluginSessionStore.getState().load('s1');
    const write = deferred<PiPluginSessionStateUpdate>();
    setImpl = () => write.promise;
    const writing = usePluginSessionStore.getState().set('s1', 'subagents', 'on', false, true);
    // The first click on a session not read yet must not drop its other values.
    read.resolve({ sessionId: 's1', overrides: { plan: { on: false }, subagents: { on: true } } });
    await loading;
    expect(overridesOf('s1')).toEqual({ plan: { on: false }, subagents: { on: false } });
    write.resolve({ id: 'subagents', sessionId: 's1', overrides: { on: false } });
    await writing;
    expect(overridesOf('s1')).toEqual({ plan: { on: false }, subagents: { on: false } });
  });

  test('an answer for one switch leaves another switch still being written', async () => {
    await usePluginSessionStore.getState().load('s1');
    const first = deferred<PiPluginSessionStateUpdate>();
    const second = deferred<PiPluginSessionStateUpdate>();
    setImpl = async (_id, _sessionId, input) => (input.key === 'on' ? first.promise : second.promise);
    const a = usePluginSessionStore.getState().set('s1', 'subagents', 'on', false, true);
    const b = usePluginSessionStore.getState().set('s1', 'subagents', 'network', true, false);
    first.resolve({ id: 'subagents', sessionId: 's1', overrides: { on: false } });
    await a;
    expect(overridesOf('s1')).toEqual({ subagents: { on: false, network: true } });
    second.reject(new Error('nope'));
    await b;
    expect(overridesOf('s1')).toEqual({ subagents: { on: false } });
  });

  test('keeps draft switches for the open draft only and applies them to the new session', async () => {
    const store = usePluginSessionStore.getState();
    store.setDraft('d1', 'subagents', 'on', false, true);
    store.setDraft('d1', 'plan', 'on', true, true);
    expect(selectComposerOverrides({ kind: 'draft', draftId: 'd1' })(usePluginSessionStore.getState())).toEqual({ subagents: { on: false } });
    expect(selectComposerOverrides({ kind: 'draft', draftId: 'd2' })(usePluginSessionStore.getState())).toEqual({});

    const writes: Array<[string, string, PiPluginSessionStateInput]> = [];
    setImpl = async (id, sessionId, input) => {
      writes.push([id, sessionId, input]);
      return { id, sessionId, overrides: { [input.key]: input.value as boolean } };
    };
    expect(await usePluginSessionStore.getState().applyDraft('d2', 's1')).toEqual([]);
    expect(writes).toEqual([]);
    expect(await usePluginSessionStore.getState().applyDraft('d1', 's1')).toEqual([]);
    expect(writes).toEqual([['subagents', 's1', { key: 'on', value: false }]]);
    expect(overridesOf('s1')).toEqual({ subagents: { on: false } });
    expect(usePluginSessionStore.getState().draft).toBeNull();
  });

  test('a new draft drops the previous draft\'s switches', () => {
    usePluginSessionStore.getState().setDraft('d1', 'subagents', 'on', false, true);
    usePluginSessionStore.getState().setDraft('d2', 'subagents', 'on', false, true);
    expect(usePluginSessionStore.getState().draft).toEqual({ draftId: 'd2', overrides: { subagents: { on: false } } });
  });

  test('a draft switch that cannot be written is taken back and reported', async () => {
    usePluginSessionStore.getState().setDraft('d1', 'subagents', 'on', false, true);
    setImpl = async () => { throw new Error('offline'); };
    expect(await usePluginSessionStore.getState().applyDraft('d1', 's1')).toEqual([{ id: 'subagents', key: 'on' }]);
    expect(overridesOf('s1')).toEqual({});
  });

  test('names a draft switch that did not save', async () => {
    usePluginsStore.setState({
      entries: {
        '': {
          status: 'ready',
          error: null,
          loadedAt: 0,
          plugins: [{ id: 'subagents', name: 'Sub-agents', contributes: { composerToggles: [{ state: 'on', label: 'Sub-agents' }] } }],
        },
      },
    } as never);
    usePluginSessionStore.getState().setDraft('d1', 'subagents', 'on', false, true);
    setImpl = async () => { throw new Error('offline'); };
    toasts.length = 0;
    await applyDraftSwitches('d1', 's1');
    expect(toasts.map(([message]) => message)).toEqual(['Could not save Sub-agents for this session']);
  });

  test('ignores answers that land after a runtime switch', async () => {
    const write = deferred<PiPluginSessionStateUpdate>();
    setImpl = () => write.promise;
    const result = usePluginSessionStore.getState().set('s1', 'subagents', 'on', false, true);
    usePluginSessionStore.getState().resetForRuntimeSwitch();
    runtimeKey = 'runtime-2';
    write.resolve({ id: 'subagents', sessionId: 's1', overrides: { on: false } });
    await result;
    expect(usePluginSessionStore.getState().sessions).toEqual({});
  });
});
