import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { PiPluginListResponse, PiPluginStateInput, PiPluginView } from '@/lib/pi/protocol';

let listImpl: (directory?: string) => Promise<PiPluginListResponse> = async () => ({ plugins: [] });
let enableImpl: (id: string, enabled: boolean) => Promise<PiPluginView> = async () => {
  throw new Error('unset');
};
let stateImpl: (id: string, input: PiPluginStateInput) => Promise<PiPluginView> = async () => {
  throw new Error('unset');
};
let runtimeKey = 'runtime-1';

mock.module('@/lib/pi/client', () => ({
  piClient: {
    listPlugins: (directory?: string) => listImpl(directory),
    setPluginEnabled: (id: string, enabled: boolean) => enableImpl(id, enabled),
    setPluginState: (id: string, input: PiPluginStateInput) => stateImpl(id, input),
  },
}));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => runtimeKey }));

const { usePluginsStore, selectPlugins } = await import('./store');

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const visuals = (overrides: Partial<PiPluginView> = {}): PiPluginView => ({
  id: 'visuals',
  name: 'Visuals',
  description: 'Draw pages.',
  version: '1.0.0',
  bundled: true,
  enabled: false,
  state: { on: true, allowNetwork: false },
  stateSchema: {
    on: { type: 'boolean', scope: 'global', default: true, label: 'On' },
    allowNetwork: { type: 'boolean', scope: 'global', default: false, label: 'Network' },
    style: { type: 'enum', scope: 'project', default: 'a', label: 'Style', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
  },
  contributes: {},
  impact: null,
  ...overrides,
});

const pluginsOf = (directory?: string) => selectPlugins(directory)(usePluginsStore.getState());

describe('usePluginsStore', () => {
  beforeEach(() => {
    runtimeKey = 'runtime-1';
    usePluginsStore.getState().resetForRuntimeSwitch();
    listImpl = async () => ({ plugins: [visuals()] });
  });

  test('loads plugins per directory', async () => {
    listImpl = async (directory) => ({ plugins: [visuals({ state: { on: directory === '/a', allowNetwork: false } })] });
    await usePluginsStore.getState().load('/a');
    await usePluginsStore.getState().load(null);
    expect(pluginsOf('/a')[0]?.state.on).toBe(true);
    expect(pluginsOf()[0]?.state.on).toBe(false);
  });

  test('a failed read keeps the last list and reports the error', async () => {
    await usePluginsStore.getState().load();
    listImpl = async () => {
      throw new Error('offline');
    };
    await usePluginsStore.getState().load(undefined, { force: true });
    const entry = usePluginsStore.getState().entries[''];
    expect(entry?.status).toBe('error');
    expect(entry?.plugins?.map((plugin) => plugin.id)).toEqual(['visuals']);
  });

  test('a failed first read is an error, not an empty list', async () => {
    listImpl = async () => {
      throw new Error('offline');
    };
    await usePluginsStore.getState().load();
    expect(usePluginsStore.getState().entries['']).toMatchObject({ plugins: null, status: 'error' });
  });

  test('enabling is optimistic and rolls back on failure', async () => {
    await usePluginsStore.getState().load();
    const write = deferred<PiPluginView>();
    enableImpl = () => write.promise;
    const pending = usePluginsStore.getState().setEnabled('visuals', true);
    expect(pluginsOf()[0]?.enabled).toBe(true);
    expect(usePluginsStore.getState().pending.visuals).toBe(true);
    write.reject(new Error('nope'));
    expect(await pending).toBe(false);
    expect(pluginsOf()[0]?.enabled).toBe(false);
    expect(usePluginsStore.getState().pending.visuals).toBeUndefined();
  });

  test('enabling takes the measured impact from the reply', async () => {
    await usePluginsStore.getState().load();
    const impact = { tools: [{ name: 'render_html', exposure: 'direct', tokens: 200 }], hooks: [], commands: [] };
    enableImpl = async () => visuals({ enabled: true, impact });
    expect(await usePluginsStore.getState().setEnabled('visuals', true)).toBe(true);
    expect(pluginsOf()[0]).toMatchObject({ enabled: true, impact });
  });

  test('a read that started before a write does not undo it', async () => {
    await usePluginsStore.getState().load();
    const read = deferred<PiPluginListResponse>();
    listImpl = () => read.promise;
    const loading = usePluginsStore.getState().load(undefined, { force: true });
    stateImpl = async () => visuals({ state: { on: false, allowNetwork: false } });
    await usePluginsStore.getState().setState('visuals', 'on', false);
    read.resolve({ plugins: [visuals()] });
    await loading;
    expect(pluginsOf()[0]?.state.on).toBe(false);
  });

  test('a global state write reads the other directories again', async () => {
    await usePluginsStore.getState().load('/a');
    await usePluginsStore.getState().load('/b');
    stateImpl = async () => visuals({ state: { on: false, allowNetwork: false } });
    const reads: Array<string | undefined> = [];
    listImpl = async (directory) => {
      reads.push(directory);
      return { plugins: [visuals({ state: { on: false, allowNetwork: false } })] };
    };
    await usePluginsStore.getState().setState('visuals', 'on', false, '/a');
    expect(pluginsOf('/a')[0]?.state.on).toBe(false);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toEqual(['/b']);
    expect(pluginsOf('/b')[0]?.state.on).toBe(false);
  });

  test('a project state write needs a directory and sends it', async () => {
    await usePluginsStore.getState().load('/a');
    expect(await usePluginsStore.getState().setState('visuals', 'style', 'b')).toBe(false);
    let sent: PiPluginStateInput | null = null;
    stateImpl = async (_id, input) => {
      sent = input;
      return visuals({ state: { on: true, allowNetwork: false, style: 'b' } });
    };
    expect(await usePluginsStore.getState().setState('visuals', 'style', 'b', '/a')).toBe(true);
    expect(sent).toEqual({ key: 'style', value: 'b', directory: '/a' });
  });

  test('a state write failure restores the earlier value', async () => {
    await usePluginsStore.getState().load();
    stateImpl = async () => {
      throw new Error('nope');
    };
    expect(await usePluginsStore.getState().setState('visuals', 'allowNetwork', true)).toBe(false);
    expect(pluginsOf()[0]?.state.allowNetwork).toBe(false);
  });

  test('results for a previous runtime are dropped', async () => {
    const read = deferred<PiPluginListResponse>();
    listImpl = () => read.promise;
    const loading = usePluginsStore.getState().load();
    runtimeKey = 'runtime-2';
    usePluginsStore.getState().resetForRuntimeSwitch();
    read.resolve({ plugins: [visuals()] });
    await loading;
    expect(usePluginsStore.getState().entries).toEqual({});
  });
});
