import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type {
  PiExtensionConfigItem,
  PiExtensionConfigResponse,
  PiExtensionConfigWrite,
  PiExtensionPackageInstall,
} from '@/lib/pi/protocol';

let readImpl: (directory?: string) => Promise<PiExtensionConfigResponse> = async () => {
  throw new Error('unset');
};
let writeImpl: (id: string, input: PiExtensionConfigWrite) => Promise<PiExtensionConfigResponse> = async () => {
  throw new Error('unset');
};
let removeImpl: (id: string, directory?: string) => Promise<PiExtensionConfigResponse> = async () => {
  throw new Error('unset');
};
let installImpl: (input: PiExtensionPackageInstall) => Promise<PiExtensionConfigResponse> = async () => {
  throw new Error('unset');
};
let updateImpl: (id: string, directory?: string) => Promise<PiExtensionConfigResponse> = async () => {
  throw new Error('unset');
};
let runtimeKey = 'runtime-1';

mock.module('@/lib/pi/client', () => ({
  piClient: {
    getExtensionConfig: (directory?: string) => readImpl(directory),
    setExtensionConfig: (id: string, input: PiExtensionConfigWrite) => writeImpl(id, input),
    removeExtensionPackage: (id: string, directory?: string) => removeImpl(id, directory),
    installExtensionPackage: (input: PiExtensionPackageInstall) => installImpl(input),
    updateExtensionPackage: (id: string, directory?: string) => updateImpl(id, directory),
  },
}));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => runtimeKey }));

const { installKey, useExtensionConfigStore } = await import('./extensionConfigStore');

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const PROJECT = '/work/app';

const modes = (overrides: Partial<PiExtensionConfigItem> = {}): PiExtensionConfigItem => ({
  id: 'ext-modes',
  name: 'modes.ts',
  group: 'auto',
  scope: 'user',
  global: true,
  ...overrides,
});

const globalView = (items: PiExtensionConfigItem[] = [modes()]): PiExtensionConfigResponse => ({
  project: { available: false, trusted: false },
  packages: [{ id: 'pkg-a', source: 'npm:pi-a', scope: 'user', kind: 'npm', installed: true, filtered: false }],
  extensions: items,
  installFailures: [],
});

const projectView = (items: PiExtensionConfigItem[]): PiExtensionConfigResponse => ({
  directory: PROJECT,
  project: { available: true, trusted: true },
  packages: [],
  extensions: items,
  installFailures: [],
});

const inProject = (state: 'inherit' | 'load' | 'unload', inherited = true): PiExtensionConfigItem => modes({
  project: { state, inherited, enabled: state === 'inherit' ? inherited : state === 'load' },
});

const store = () => useExtensionConfigStore.getState();
const itemOf = (directory = '') => store().entries[directory]?.config?.extensions[0];

describe('useExtensionConfigStore', () => {
  beforeEach(() => {
    runtimeKey = 'runtime-1';
    store().resetForRuntimeSwitch();
    readImpl = async (directory) => (directory ? projectView([inProject('inherit')]) : globalView());
    writeImpl = async () => {
      throw new Error('unset');
    };
    removeImpl = async () => {
      throw new Error('unset');
    };
    installImpl = async () => {
      throw new Error('unset');
    };
    updateImpl = async () => {
      throw new Error('unset');
    };
  });

  test('keeps the global view and each project view apart', async () => {
    await store().load();
    await store().load(PROJECT);
    expect(itemOf()?.project).toBeUndefined();
    expect(itemOf(PROJECT)?.project?.state).toBe('inherit');
  });

  test('a failed read keeps the last list and reports the error', async () => {
    await store().load();
    readImpl = async () => {
      throw new Error('offline');
    };
    await store().load(null, { force: true });
    expect(store().entries['']?.status).toBe('error');
    expect(store().entries['']?.error).toBe('offline');
    expect(itemOf()?.id).toBe('ext-modes');
  });

  test('a failed first read is an error, not an empty list', async () => {
    readImpl = async () => {
      throw new Error('offline');
    };
    await store().load();
    expect(store().entries['']?.config).toBeNull();
    expect(store().entries['']?.status).toBe('error');
  });

  test('a global switch shows at once, then takes the server list and ages other views', async () => {
    await store().load();
    await store().load(PROJECT);
    const answer = deferred<PiExtensionConfigResponse>();
    let sent: PiExtensionConfigWrite | undefined;
    writeImpl = (_id, input) => {
      sent = input;
      return answer.promise;
    };
    const write = store().setGlobal('ext-modes', false);
    expect(itemOf()?.global).toBe(false);
    expect(store().pending['ext-modes']).toBe(true);
    answer.resolve({ ...globalView([modes({ global: false })]), deferred: true });
    expect(await write).toEqual({ ok: true, deferred: true });
    expect(sent).toEqual({ scope: 'global', enabled: false });
    expect(store().pending['ext-modes']).toBeUndefined();
    expect(itemOf()?.global).toBe(false);
    expect(store().entries['']?.config?.deferred).toBeUndefined();
    // The project view inherits the global value, so it is read again when shown.
    expect(store().entries[PROJECT]?.loadedAt).toBe(0);
  });

  test('a failed switch goes back and reads the list again', async () => {
    await store().load();
    let reads = 0;
    readImpl = async () => {
      reads += 1;
      return globalView();
    };
    writeImpl = async () => {
      throw Object.assign(new Error('busy'), { code: 'SESSION_BUSY' });
    };
    const result = await store().setGlobal('ext-modes', false);
    expect(result.ok).toBe(false);
    expect(itemOf()?.global).toBe(true);
    expect(store().pending['ext-modes']).toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
    expect(reads).toBe(1);
  });

  test('a second write to the same extension waits for the first', async () => {
    await store().load();
    const answer = deferred<PiExtensionConfigResponse>();
    let writes = 0;
    writeImpl = () => {
      writes += 1;
      return answer.promise;
    };
    const first = store().setGlobal('ext-modes', false);
    const second = await store().setGlobal('ext-modes', true);
    expect(second.ok).toBe(false);
    expect(writes).toBe(1);
    answer.resolve(globalView([modes({ global: false })]));
    await first;
    expect(itemOf()?.global).toBe(false);
  });

  test('a project override works out what loads until the server answers', async () => {
    await store().load(PROJECT);
    const answer = deferred<PiExtensionConfigResponse>();
    let sent: PiExtensionConfigWrite | undefined;
    writeImpl = (_id, input) => {
      sent = input;
      return answer.promise;
    };
    const write = store().setProjectState('ext-modes', 'unload', PROJECT);
    expect(itemOf(PROJECT)?.project).toEqual({ state: 'unload', inherited: true, enabled: false });
    answer.resolve(projectView([inProject('unload')]));
    expect(await write).toEqual({ ok: true, deferred: false });
    expect(sent).toEqual({ scope: 'project', state: 'unload', directory: PROJECT });
    expect(itemOf(PROJECT)?.project?.state).toBe('unload');
  });

  test('on or off in a project sends the wanted value and takes the override from the answer', async () => {
    await store().load(PROJECT);
    const answer = deferred<PiExtensionConfigResponse>();
    let sent: PiExtensionConfigWrite | undefined;
    writeImpl = (_id, input) => {
      sent = input;
      return answer.promise;
    };
    const write = store().setProjectEnabled('ext-modes', false, PROJECT);
    expect(itemOf(PROJECT)?.project).toEqual({ state: 'unload', inherited: true, enabled: false });
    // The global value had changed elsewhere: off is what the project gets anyway.
    answer.resolve(projectView([{ ...inProject('inherit'), global: false, project: { state: 'inherit', inherited: false, enabled: false } }]));
    expect(await write).toEqual({ ok: true, deferred: false });
    expect(sent).toEqual({ scope: 'project', enabled: false, directory: PROJECT });
    expect(itemOf(PROJECT)?.project).toEqual({ state: 'inherit', inherited: false, enabled: false });
    expect((await store().setProjectEnabled('ext-modes', true, '')).ok).toBe(false);
  });

  test('a project override needs a project', async () => {
    const result = await store().setProjectState('ext-modes', 'load', '');
    expect(result.ok).toBe(false);
  });

  test('a read that started before a write does not undo it', async () => {
    await store().load();
    const read = deferred<PiExtensionConfigResponse>();
    readImpl = () => read.promise;
    const loading = store().load(null, { force: true });
    const answer = deferred<PiExtensionConfigResponse>();
    writeImpl = () => answer.promise;
    const write = store().setGlobal('ext-modes', false);
    read.resolve(globalView([modes({ global: true })]));
    await loading;
    expect(itemOf()?.global).toBe(false);
    expect(store().entries['']?.status).toBe('ready');
    answer.resolve(globalView([modes({ global: false })]));
    await write;
    expect(itemOf()?.global).toBe(false);
  });

  test('an answer for another view is not stored; the view is read again', async () => {
    await store().load();
    let reads = 0;
    readImpl = async () => {
      reads += 1;
      return globalView([modes({ global: false })]);
    };
    writeImpl = async () => projectView([inProject('inherit', false)]);
    await store().setGlobal('ext-modes', false);
    await Promise.resolve();
    await Promise.resolve();
    expect(reads).toBe(1);
    expect(itemOf()?.project).toBeUndefined();
    expect(itemOf()?.global).toBe(false);
  });

  test('removing a package takes the server list', async () => {
    await store().load();
    const answer = deferred<PiExtensionConfigResponse>();
    let asked: { id: string; directory?: string } | undefined;
    removeImpl = (id, directory) => {
      asked = { id, directory };
      return answer.promise;
    };
    const removal = store().removePackage('pkg-a');
    expect(store().pending['pkg-a']).toBe(true);
    // Not optimistic: the package stays listed until the server says it is gone.
    expect(store().entries['']?.config?.packages).toHaveLength(1);
    answer.resolve({ ...globalView(), packages: [] });
    expect(await removal).toEqual({ ok: true, deferred: false });
    expect(asked).toEqual({ id: 'pkg-a', directory: undefined });
    expect(store().entries['']?.config?.packages).toEqual([]);
    expect(store().pending['pkg-a']).toBeUndefined();
  });

  test('a failed removal keeps the package and hands back the error', async () => {
    await store().load();
    const failure = Object.assign(new Error('npm failed'), { code: 'PACKAGE_REMOVE_FAILED' });
    removeImpl = async () => {
      throw failure;
    };
    const result = await store().removePackage('pkg-a');
    expect(result).toEqual({ ok: false, error: failure });
    expect(store().entries['']?.config?.packages).toHaveLength(1);
    expect(store().pending['pkg-a']).toBeUndefined();
  });

  test('an install sends the scope from the folder and shows the list it returns', async () => {
    await store().load();
    await store().load(PROJECT);
    const answer = deferred<PiExtensionConfigResponse>();
    let sent: PiExtensionPackageInstall | undefined;
    installImpl = (input) => {
      sent = input;
      return answer.promise;
    };
    const install = store().installPackage('pi-lens', PROJECT);
    expect(store().pending[installKey('pi-lens')]).toBe(true);
    expect(await store().installPackage('pi-lens', PROJECT)).toMatchObject({ ok: false });
    const installed = { id: 'pkg-lens', source: 'npm:pi-lens', scope: 'project' as const, kind: 'npm' as const, installed: true, filtered: false };
    answer.resolve({ ...projectView([inProject('inherit')]), packages: [installed] });
    expect(await install).toEqual({ ok: true, deferred: false });
    expect(sent).toEqual({ name: 'pi-lens', scope: 'project', directory: PROJECT });
    expect(store().entries[PROJECT]?.config?.packages).toEqual([installed]);
    expect(store().pending[installKey('pi-lens')]).toBeUndefined();

    installImpl = async (input) => {
      sent = input;
      return globalView();
    };
    await store().installPackage('pi-web-access');
    expect(sent).toEqual({ name: 'pi-web-access', scope: 'user' });
  });

  test('a failed install changes nothing and reads the list again', async () => {
    await store().load();
    let reads = 0;
    readImpl = async () => {
      reads += 1;
      return globalView();
    };
    const failure = new Error('npm failed');
    installImpl = async () => {
      throw failure;
    };
    const result = await store().installPackage('pi-lens');
    expect(result).toEqual({ ok: false, error: failure });
    expect(store().entries['']?.config?.packages).toHaveLength(1);
    expect(store().pending[installKey('pi-lens')]).toBeUndefined();
    await Promise.resolve();
    expect(reads).toBe(1);
  });

  test('an update is pending on the package and passes its folder', async () => {
    await store().load(PROJECT);
    const answer = deferred<PiExtensionConfigResponse>();
    let sent: [string, string | undefined] | undefined;
    updateImpl = (id, directory) => {
      sent = [id, directory];
      return answer.promise;
    };
    const update = store().updatePackage('pkg-a', PROJECT);
    expect(store().pending['pkg-a']).toBe(true);
    answer.resolve({ ...projectView([inProject('inherit')]), deferred: true });
    expect(await update).toEqual({ ok: true, deferred: true });
    expect(sent).toEqual(['pkg-a', PROJECT]);
    expect(store().pending['pkg-a']).toBeUndefined();
  });

  test('invalidate ages every view and keeps its list, so the next load reads again', async () => {
    await store().load();
    readImpl = async () => projectView([inProject('inherit')]);
    await store().load(PROJECT);
    let reads = 0;
    readImpl = async () => {
      reads += 1;
      return { ...globalView(), replaced: [{ kind: 'plugin', id: 'subagents', by: { id: 'ext-modes', name: 'modes.ts' } }] };
    };
    store().invalidate();
    expect(store().entries['']?.loadedAt).toBe(0);
    expect(store().entries[PROJECT]?.loadedAt).toBe(0);
    expect(store().entries['']?.status).toBe('ready');
    expect(itemOf()).toEqual(modes());
    await store().load();
    expect(reads).toBe(1);
    expect(store().entries['']?.config?.replaced).toEqual([
      { kind: 'plugin', id: 'subagents', by: { id: 'ext-modes', name: 'modes.ts' } },
    ]);
  });

  test('a runtime switch drops the lists and late answers', async () => {
    await store().load();
    const answer = deferred<PiExtensionConfigResponse>();
    writeImpl = () => answer.promise;
    const write = store().setGlobal('ext-modes', false);
    runtimeKey = 'runtime-2';
    store().resetForRuntimeSwitch();
    answer.resolve(globalView([modes({ global: false })]));
    await write;
    expect(store().entries).toEqual({});
    expect(store().pending).toEqual({});
  });
});
