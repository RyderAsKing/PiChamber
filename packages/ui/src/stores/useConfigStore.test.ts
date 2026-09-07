/* eslint-disable */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const DIRECTORY = '/workspace/project';
const OTHER_DIRECTORY = '/workspace/other';
const STORAGE_KEY = 'config-store';

let storage = new Map<string, string>();
let liveProviderId = 'live';
let liveProviderIdsByDirectory = new Map<string, string>();
let liveProviderVariants: Record<string, Record<string, unknown>> | undefined;
let getProvidersCalls = 0;
let getConfigCalls = 0;
let withDirectoryCalls: Array<string | null> = [];
let currentFetchDirectory: string | null = DIRECTORY;
let projects = [
  { id: 'project', path: DIRECTORY, label: 'Project' },
  { id: 'other', path: OTHER_DIRECTORY, label: 'Other' },
];
let configListener: ((event: { scopes: string[]; source?: string; timestamp: number }) => void | Promise<void>) | null = null;

const makeStorage = (): Storage => ({
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => {
    storage.clear();
  },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() {
    return storage.size;
  },
}) as Storage;

const provider = (id: string, modelId = `${id}-model`, variants?: Record<string, Record<string, unknown>>) => ({
  id,
  name: id,
  source: 'config' as const,
  env: [],
  options: {},
  models: [
    {
      id: modelId,
      name: modelId,
      providerID: id,
      api: { id: 'chat', url: '', npm: '' },
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 0, output: 0 },
      options: {},
      release_date: '',
      status: 'active' as const,
      headers: {},
      attachment: false,
      reasoning: Boolean(variants),
      temperature: true,
      tool_call: true,
      ...(variants ? { thinkingLevels: Object.keys(variants) } : {}),
    },
  ],
});

const providerResponse = (id: string, modelId = `${id}-model`, variants?: Record<string, Record<string, unknown>>) => ({
  id,
  name: id,
  source: 'config' as const,
  env: [],
  options: {},
  models: {
    [modelId]: {
      id: modelId,
      name: modelId,
      providerID: id,
      api: { id: 'chat', url: '', npm: '' },
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 0, output: 0 },
      options: {},
      release_date: '',
      status: 'active' as const,
      headers: {},
      attachment: false,
      reasoning: Boolean(variants),
      temperature: true,
      tool_call: true,
      ...(variants ? { thinkingLevels: Object.keys(variants) } : {}),
    },
  },
});


const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

mock.module('@/stores/utils/safeStorage', () => ({
  getDeferredSafeStorage: () => makeStorage(),
  getSafeStorage: () => makeStorage(),
  createDeferredSafeJSONStorage: () => {
    const testStorage = makeStorage();
    return {
      getItem: (name: string) => {
        const value = testStorage.getItem(name);
        return value === null ? null : JSON.parse(value);
      },
      setItem: (name: string, value: unknown) => {
        testStorage.setItem(name, JSON.stringify(value));
      },
      removeItem: (name: string) => {
        testStorage.removeItem(name);
      },
    };
  },
}));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      activeProjectId: projects[0]?.id ?? null,
      projects,
    }),
  },
}));

mock.module('@/lib/pi/client', () => ({
  PiRequestError: class PiRequestError extends Error {
    code: string;
    constructor(code: string, message?: string) {
      super(message ?? code);
      this.code = code;
    }
  },
  piClient: {
    setDirectory: mock(() => undefined),
    health: mock(async () => ({ state: 'ready', protocolVersion: 1, capabilities: [] })),
    listProviders: mock(async () => {
      getProvidersCalls += 1;
      const id = liveProviderId;
      return {
        providers: [{
          id,
          label: id,
          authenticated: true,
          models: [{
            id: `${id}-model`,
            label: `${id}-model`,
            providerId: id,
            supportsThinking: true,
            thinkingLevels: liveProviderVariants ? Object.keys(liveProviderVariants) : [],
          }],
        }],
        default: { providerId: id, modelId: `${id}-model` },
      };
    }),
  },
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => new Response(JSON.stringify({}), {
    headers: { 'Content-Type': 'application/json' },
  })),
}));

mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: mock(async () => undefined),
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
  measureStartupTrace: mock(async (_name: string, callback: () => Promise<unknown>) => callback()),
}));

mock.module('@/lib/configSync', () => ({
  emitConfigChange: mock(() => undefined),
  scopeMatches: mock((event: { scopes: string[] }, scope: string) => event.scopes.includes('all') || event.scopes.includes(scope)),
  subscribeToConfigChanges: mock((listener: typeof configListener) => {
    configListener = listener;
    return () => {
      if (configListener === listener) {
        configListener = null;
      }
    };
  }),
}));

// Sync-refs stub for config-store tests. The remaining exports mirror the real
// stub's surface so unrelated importers keep working.

mock.module('@/sync/sync-refs', () => ({
  setSyncRefs: () => {},
  getDirectoryState: () => undefined,
  getSyncSessions: () => [],
  getAllSyncSessions: () => [],
  getAllSyncSessionMap: () => new Map(),
  getSyncSessionDirectory: () => null,
  getSyncMessages: () => [],
  getSyncSessionMaterializationStatus: () => 'ready',
  getSyncParts: () => [],
  resolveSessionDirectory: () => null,
  resolveSessionDirectoryFromSources: () => null,
  refetchSessionMessages: async () => {},
  unrevertSessionAction: async () => {},
  forkFromMessageAction: async () => {},
}));

const { useConfigStore } = await import('./useConfigStore');
const { useSelectionStore } = await import('@/sync/selection-store');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { getRuntimeKey } = await import('@/lib/runtime-switch');

// Write the current v2 worktree-project envelope (the legacy key is consumed
// once and then removed by the store's migration path).
const setWorktreeProjectMap = (entries: Record<string, string>): void => {
  storage.set('oc.worktreeProjectMap.v2', JSON.stringify({
    version: 2,
    legacyClaimed: true,
    runtimes: { [getRuntimeKey() || 'default']: { updatedAt: Date.now(), entries } },
  }));
};

describe('useConfigStore provider persistence', () => {
  beforeEach(() => {
    storage = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: makeStorage(),
    });
    liveProviderId = 'live';
    liveProviderIdsByDirectory = new Map<string, string>();
    liveProviderVariants = undefined;
    getProvidersCalls = 0;
    getConfigCalls = 0;
    withDirectoryCalls = [];
    currentFetchDirectory = DIRECTORY;
    projects = [
      { id: 'project', path: DIRECTORY, label: 'Project' },
      { id: 'other', path: OTHER_DIRECTORY, label: 'Other' },
    ];
    useSelectionStore.setState({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
      sessionAgentModelSelections: new Map(),
      lastUsedProvider: null,
    });
    useSessionUIStore.setState({ currentSessionId: null });
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      directoryScoped: {},
      providers: [],
      defaultProviders: {},
      currentProviderId: '',
      currentModelId: '',
      currentVariant: undefined,
      selectedProviderId: '',
      selectionSource: 'auto',
      isConnected: true,
      isInitialized: false,
    });
  });

  test('loads providers into the global scope before the first project is added', async () => {
    projects = [];
    useConfigStore.setState({
      activeDirectoryKey: '__global__',
      isConnected: false,
      hasEverConnected: false,
      isInitialized: false,
    });

    await useConfigStore.getState().initializeApp();

    const state = useConfigStore.getState();
    expect(getProvidersCalls).toBe(1);
    expect(state.isInitialized).toBe(true);
    expect(state.providers.map((entry) => entry.id)).toEqual(['live']);
    expect(state.currentProviderId).toBe('live');
    expect(state.currentModelId).toBe('live-model');
    expect(state.directoryScoped.__global__?.providers.map((entry) => entry.id)).toEqual(['live']);
  });

  test('hydrates persisted provider snapshots for instant paint, then refreshes to live data', async () => {
    storage.set(STORAGE_KEY, JSON.stringify({
      state: {
        activeDirectoryKey: DIRECTORY,
        directoryScoped: {
          [DIRECTORY]: {
            providers: [provider('stale')],
            agents: [{ name: 'build', mode: 'primary' }],
            currentProviderId: 'stale',
            currentModelId: 'stale-model',
            currentAgentName: 'build',
            selectedProviderId: 'stale',
            defaultProviders: { default: 'stale' },
          },
          [OTHER_DIRECTORY]: {
            providers: [provider('other-stale')],
            agents: [{ name: 'review', mode: 'primary' }],
            currentProviderId: 'other-stale',
            currentModelId: 'other-stale-model',
            currentAgentName: 'review',
            selectedProviderId: 'other-stale',
            defaultProviders: { default: 'other-stale' },
          },
        },
        currentProviderId: 'stale',
        currentModelId: 'stale-model',
        selectedProviderId: 'stale',
        defaultProviders: { default: 'stale' },
      },
      version: 0,
    }));

    await useConfigStore.persist.rehydrate();

    // Stale-while-revalidate: the persisted snapshot is hydrated as-is so the
    // pickers can paint instantly on cold start, instead of being stripped to empty.
    // Legacy generic-agent fields in the fixture above are stripped and never restored:
    // the config-level agent registry is retired (the daemon exposes no agent list
    // endpoint), so those values are discarded even when older blobs hold non-empty data.
    const hydrated = useConfigStore.getState();
    expect(hydrated.providers.map((entry) => entry.id)).toEqual(['stale']);
    expect(hydrated.defaultProviders).toEqual({ default: 'stale' });
    expect(hydrated.directoryScoped[DIRECTORY]?.providers.map((entry) => entry.id)).toEqual(['stale']);
    expect(hydrated.directoryScoped[DIRECTORY]?.defaultProviders).toEqual({ default: 'stale' });
    expect((hydrated.directoryScoped[DIRECTORY] as unknown as Record<string, unknown>)?.agents).toBe(undefined);
    expect((hydrated.directoryScoped[DIRECTORY] as unknown as Record<string, unknown>)?.currentAgentName).toBe(undefined);
    expect(hydrated.directoryScoped[OTHER_DIRECTORY]?.providers.map((entry) => entry.id)).toEqual(['other-stale']);

    liveProviderId = 'fresh';
    await hydrated.initializeApp();

    const reloaded = useConfigStore.getState();
    expect(getProvidersCalls).toBe(1);
    expect(reloaded.providers.map((entry) => entry.id)).toEqual(['fresh']);
    expect(reloaded.directoryScoped[DIRECTORY]?.providers.map((entry) => entry.id)).toEqual(['fresh']);
    expect(reloaded.currentProviderId).toBe('fresh');
    expect(reloaded.currentModelId).toBe('fresh-model');
  });

  test('provider config events refresh all known directory provider caches immediately', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      providers: [provider('active-stale')],
      defaultProviders: { default: 'active-stale' },
      currentProviderId: 'active-stale',
      currentModelId: 'active-stale-model',
      selectedProviderId: 'active-stale',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('active-stale')],
          currentProviderId: 'active-stale',
          currentModelId: 'active-stale-model',
          selectedProviderId: 'active-stale',
          defaultProviders: { default: 'active-stale' },
        },
        [OTHER_DIRECTORY]: {
          providers: [provider('inactive-cached')],
          currentProviderId: 'inactive-cached',
          currentModelId: 'inactive-cached-model',
          selectedProviderId: 'inactive-cached',
          defaultProviders: { default: 'inactive-cached' },
        },
      },
    });

    liveProviderIdsByDirectory = new Map([
      [DIRECTORY, 'active-live'],
      [OTHER_DIRECTORY, 'inactive-live'],
    ]);
    expect(configListener).not.toBeNull();
    await configListener?.({ scopes: ['providers'], timestamp: Date.now() });

    const state = useConfigStore.getState();
    expect(getProvidersCalls).toBe(2);
    expect(state.directoryScoped[DIRECTORY]?.providers.map((entry) => entry.id)).toEqual(['live']);
    expect(state.directoryScoped[OTHER_DIRECTORY]?.providers.map((entry) => entry.id)).toEqual(['live']);
    expect(state.directoryScoped[OTHER_DIRECTORY]?.defaultProviders).toEqual({ live: 'live-model' });
  });

  test('provider reload preserves a valid current variant', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      currentProviderId: 'live',
      currentModelId: 'live-model',
      currentVariant: 'low',
      selectedProviderId: 'live',
      settingsDefaultVariant: 'high',
      directoryScoped: {},
    });

    liveProviderId = 'live';
    liveProviderVariants = { low: {}, high: {} };
    await useConfigStore.getState().loadProviders({ source: 'test:variant' });

    const state = useConfigStore.getState();
    expect(state.currentProviderId).toBe('live');
    expect(state.currentModelId).toBe('live-model');
    expect(state.currentVariant).toBe('low');
  });

  test('provider reload preserves the add-provider sentinel selection', async () => {
    // The user has opened the "Add provider" form, which sets selectedProviderId
    // to the sentinel. A background provider refresh must not navigate them away
    // (and discard their unsaved input) just because the sentinel is not a real
    // provider id. See issue #1765.
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      currentProviderId: 'live',
      currentModelId: 'live-model',
      selectedProviderId: '__add_provider__',
      directoryScoped: {},
    });

    liveProviderId = 'live';
    await useConfigStore.getState().loadProviders({ source: 'test:add-provider' });

    expect(useConfigStore.getState().selectedProviderId).toBe('__add_provider__');
  });

  test('add-provider sentinel is not persisted as a stable provider selection', async () => {
    useConfigStore.setState({
      activeDirectoryKey: DIRECTORY,
      currentProviderId: 'live',
      currentModelId: 'live-model',
      selectedProviderId: '__add_provider__',
      directoryScoped: {
        [DIRECTORY]: {
          providers: [provider('live')],
          currentProviderId: 'live',
          currentModelId: 'live-model',
          selectedProviderId: '__add_provider__',
          defaultProviders: { default: 'live' },
        },
      },
    });

    const persisted = JSON.parse(storage.get(STORAGE_KEY) ?? '{}');
    expect(persisted.state.selectedProviderId).toBe('');
    expect(persisted.state.directoryScoped[DIRECTORY].selectedProviderId).toBe('');
  });

  test('manual provider/model/thinking prefs survive hydrate, directory switch, and cache reset', async () => {
    // Regression for the legacy generic-agent removal: stripping `agents` /
    // `currentAgentName` / `agentModelSelections` / `runtimeDefault*` must never
    // erase live provider/model/thinking selections, and per-session preference
    // maps in the selection store must stay untouched by config lifecycle ops.
    const sessionId = 'ses-regression-prefs';
    useSelectionStore.getState().saveSessionModelSelection(sessionId, 'live', 'live-model');

    storage.set(STORAGE_KEY, JSON.stringify({
      state: {
        activeDirectoryKey: DIRECTORY,
        directoryScoped: {
          [DIRECTORY]: {
            providers: [provider('live', 'live-model', { low: {}, high: {} })],
            agents: [{ name: 'build', mode: 'primary' }],
            currentProviderId: 'live',
            currentModelId: 'live-model',
            currentVariant: 'low',
            currentAgentName: 'build',
            selectedProviderId: 'live',
            agentModelSelections: { build: { providerId: 'live', modelId: 'live-model' } },
            defaultProviders: { live: 'live-model' },
            runtimeDefaultAgent: 'build',
            runtimeDefaultModel: 'live/live-model',
            selectionSource: 'manual',
          },
          [OTHER_DIRECTORY]: {
            providers: [provider('other', 'other-model')],
            currentProviderId: 'other',
            currentModelId: 'other-model',
            selectedProviderId: 'other',
            defaultProviders: { other: 'other-model' },
            selectionSource: 'manual',
          },
        },
        providers: [provider('live', 'live-model', { low: {}, high: {} })],
        currentProviderId: 'live',
        currentModelId: 'live-model',
        currentVariant: 'low',
        selectedProviderId: 'live',
        selectionSource: 'manual',
        defaultProviders: { live: 'live-model' },
      },
      version: 0,
    }));

    await useConfigStore.persist.rehydrate();

    // Hydrate keeps live selections and drops only legacy agent keys.
    const hydrated = useConfigStore.getState();
    expect(hydrated.currentProviderId).toBe('live');
    expect(hydrated.currentModelId).toBe('live-model');
    expect(hydrated.currentVariant).toBe('low');
    expect(hydrated.selectedProviderId).toBe('live');
    expect(hydrated.selectionSource).toBe('manual');
    expect(hydrated.directoryScoped[DIRECTORY]?.currentProviderId).toBe('live');
    expect(hydrated.directoryScoped[DIRECTORY]?.currentModelId).toBe('live-model');
    expect(hydrated.directoryScoped[DIRECTORY]?.currentVariant).toBe('low');
    expect((hydrated.directoryScoped[DIRECTORY] as unknown as Record<string, unknown>)?.agents).toBe(undefined);
    expect((hydrated.directoryScoped[DIRECTORY] as unknown as Record<string, unknown>)?.currentAgentName).toBe(undefined);
    expect((hydrated.directoryScoped[DIRECTORY] as unknown as Record<string, unknown>)?.agentModelSelections).toBe(undefined);
    expect(useSelectionStore.getState().getSessionModelSelection(sessionId)).toEqual({ providerId: 'live', modelId: 'live-model' });

    // Directory switch restores the other scope without erasing either scope.
    useConfigStore.setState({ isConnected: false });
    await useConfigStore.getState().activateDirectory(OTHER_DIRECTORY);
    const otherActive = useConfigStore.getState();
    expect(otherActive.activeDirectoryKey).toBe(OTHER_DIRECTORY);
    expect(otherActive.currentProviderId).toBe('other');
    expect(otherActive.currentModelId).toBe('other-model');
    expect(otherActive.selectedProviderId).toBe('other');

    await useConfigStore.getState().activateDirectory(DIRECTORY);
    const backActive = useConfigStore.getState();
    expect(backActive.activeDirectoryKey).toBe(DIRECTORY);
    expect(backActive.currentProviderId).toBe('live');
    expect(backActive.currentModelId).toBe('live-model');
    expect(backActive.currentVariant).toBe('low');
    expect(backActive.selectedProviderId).toBe('live');
    expect(useSelectionStore.getState().getSessionModelSelection(sessionId)).toEqual({ providerId: 'live', modelId: 'live-model' });

    // Cache reset clears provider payloads but preserves live selections.
    useConfigStore.getState().invalidateProviderCache();
    const afterReset = useConfigStore.getState();
    expect(afterReset.providers).toEqual([]);
    expect(afterReset.currentProviderId).toBe('live');
    expect(afterReset.currentModelId).toBe('live-model');
    expect(afterReset.currentVariant).toBe('low');
    expect(afterReset.selectedProviderId).toBe('live');
    expect(afterReset.directoryScoped[DIRECTORY]?.providers).toEqual([]);
    expect(afterReset.directoryScoped[DIRECTORY]?.currentProviderId).toBe('live');
    expect(afterReset.directoryScoped[DIRECTORY]?.currentModelId).toBe('live-model');
    expect(afterReset.directoryScoped[DIRECTORY]?.currentVariant).toBe('low');
    expect(useSelectionStore.getState().getSessionModelSelection(sessionId)).toEqual({ providerId: 'live', modelId: 'live-model' });

    // Loader refresh with matching live data preserves the manual triple.
    useConfigStore.setState({ isConnected: true });
    liveProviderId = 'live';
    liveProviderVariants = { low: {}, high: {} };
    await useConfigStore.getState().loadProviders({ directory: DIRECTORY, source: 'test:regression-prefs' });
    const afterReload = useConfigStore.getState();
    expect(afterReload.currentProviderId).toBe('live');
    expect(afterReload.currentModelId).toBe('live-model');
    expect(afterReload.currentVariant).toBe('low');
    expect(useSelectionStore.getState().getSessionModelSelection(sessionId)).toEqual({ providerId: 'live', modelId: 'live-model' });
  });

  test('strips root-level legacy agent fields from a persisted blob without an active snapshot', async () => {
    // Regression for the merge-spread path: `{ ...currentState, ...persistedState }`
    // keeps top-level legacy keys even when the directory snapshot path
    // early-returns, so root stripping must happen before that return.
    storage.set(STORAGE_KEY, JSON.stringify({
      state: {
        activeDirectoryKey: DIRECTORY,
        directoryScoped: {},
        providers: [provider('live', 'live-model', { low: {}, high: {} })],
        currentProviderId: 'live',
        currentModelId: 'live-model',
        currentVariant: 'low',
        selectedProviderId: 'live',
        selectionSource: 'manual',
        defaultProviders: { live: 'live-model' },
        agents: [{ name: 'build', mode: 'primary' }],
        currentAgentName: 'build',
        agentModelSelections: { build: { providerId: 'live', modelId: 'live-model' } },
        runtimeDefaultAgent: 'build',
        runtimeDefaultModel: 'live/live-model',
      },
      version: 0,
    }));

    await useConfigStore.persist.rehydrate();

    const hydrated = useConfigStore.getState() as unknown as Record<string, unknown>;
    expect(hydrated.currentProviderId).toBe('live');
    expect(hydrated.currentModelId).toBe('live-model');
    expect(hydrated.currentVariant).toBe('low');
    expect(hydrated.selectedProviderId).toBe('live');
    expect(hydrated.selectionSource).toBe('manual');
    expect(hydrated.defaultProviders).toEqual({ live: 'live-model' });
    expect(hydrated.agents).toBe(undefined);
    expect(hydrated.currentAgentName).toBe(undefined);
    expect(hydrated.agentModelSelections).toBe(undefined);
    expect(hydrated.runtimeDefaultAgent).toBe(undefined);
    expect(hydrated.runtimeDefaultModel).toBe(undefined);
  });

  test('strips directory-scoped legacy fields while preserving selections without mutating inputs', async () => {
    const { hydrateActiveDirectorySnapshot } = await import('./config/configTypes');
    const directorySnapshot = {
      providers: [provider('live', 'live-model', { low: {}, high: {} })],
      currentProviderId: 'live',
      currentModelId: 'live-model',
      currentVariant: 'low',
      selectedProviderId: 'live',
      defaultProviders: { live: 'live-model' },
      selectionSource: 'manual' as const,
      agents: [{ name: 'build', mode: 'primary' }],
      currentAgentName: 'build',
      agentModelSelections: { build: { providerId: 'live', modelId: 'live-model' } },
      runtimeDefaultAgent: 'build',
      runtimeDefaultModel: 'live/live-model',
    };
    const merged = {
      activeDirectoryKey: DIRECTORY,
      directoryScoped: { [DIRECTORY]: directorySnapshot },
      providers: [] as ReturnType<typeof provider>[],
      defaultProviders: {} as Record<string, string>,
      agents: [{ name: 'build', mode: 'primary' }],
      currentAgentName: 'build',
      agentModelSelections: { build: { providerId: 'live', modelId: 'live-model' } },
      runtimeDefaultAgent: 'build',
      runtimeDefaultModel: 'live/live-model',
    };

    const result = hydrateActiveDirectorySnapshot(merged as unknown as Parameters<typeof hydrateActiveDirectorySnapshot>[0]);
    const resultRecord = result as unknown as Record<string, unknown>;
    const resultScoped = (resultRecord.directoryScoped as Record<string, Record<string, unknown>>)[DIRECTORY];

    // Valid provider/model/thinking selections survive on the cleaned snapshot.
    expect(resultScoped.currentProviderId).toBe('live');
    expect(resultScoped.currentModelId).toBe('live-model');
    expect(resultScoped.currentVariant).toBe('low');
    expect(resultScoped.selectedProviderId).toBe('live');
    expect(resultScoped.selectionSource).toBe('manual');
    expect(resultScoped.defaultProviders).toEqual({ live: 'live-model' });
    expect((resultScoped.providers as unknown[]).length).toBe(1);
    expect(resultRecord.agents).toBe(undefined);
    expect(resultRecord.currentAgentName).toBe(undefined);
    expect(resultRecord.agentModelSelections).toBe(undefined);
    expect(resultRecord.runtimeDefaultAgent).toBe(undefined);
    expect(resultRecord.runtimeDefaultModel).toBe(undefined);
    expect(resultScoped.agents).toBe(undefined);
    expect(resultScoped.currentAgentName).toBe(undefined);
    expect(resultScoped.agentModelSelections).toBe(undefined);
    expect(resultScoped.runtimeDefaultAgent).toBe(undefined);
    expect(resultScoped.runtimeDefaultModel).toBe(undefined);

    // Caller-owned inputs are left untouched and never reused by reference.
    expect((directorySnapshot as unknown as Record<string, unknown>).agents).toEqual([{ name: 'build', mode: 'primary' }]);
    expect((directorySnapshot as unknown as Record<string, unknown>).currentAgentName).toBe('build');
    expect((merged as unknown as Record<string, unknown>).agents).toEqual([{ name: 'build', mode: 'primary' }]);
    expect(resultScoped).not.toBe(directorySnapshot);

    // Early return without an active key still strips root legacy keys.
    const noKeyInput = {
      providers: [provider('live', 'live-model', { low: {}, high: {} })],
      currentProviderId: 'live',
      currentModelId: 'live-model',
      currentVariant: 'low',
      selectedProviderId: 'live',
      defaultProviders: { live: 'live-model' },
      agents: [{ name: 'build', mode: 'primary' }],
      currentAgentName: 'build',
      agentModelSelections: { build: { providerId: 'live', modelId: 'live-model' } },
      runtimeDefaultAgent: 'build',
      runtimeDefaultModel: 'live/live-model',
    };
    const noKeyResult = hydrateActiveDirectorySnapshot(noKeyInput as unknown as Parameters<typeof hydrateActiveDirectorySnapshot>[0]) as unknown as Record<string, unknown>;
    expect(noKeyResult.currentProviderId).toBe('live');
    expect(noKeyResult.currentModelId).toBe('live-model');
    expect(noKeyResult.currentVariant).toBe('low');
    expect(noKeyResult.agents).toBe(undefined);
    expect(noKeyResult.currentAgentName).toBe(undefined);
    expect(noKeyResult.agentModelSelections).toBe(undefined);
    expect(noKeyResult.runtimeDefaultAgent).toBe(undefined);
    expect(noKeyResult.runtimeDefaultModel).toBe(undefined);
    expect((noKeyInput as unknown as Record<string, unknown>).agents).toEqual([{ name: 'build', mode: 'primary' }]);
  });

});
