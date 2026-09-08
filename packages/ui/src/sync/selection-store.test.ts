import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { LegacyParseResult } from './selection-store';

// Controllable disk backing the canonical key. The retired legacy key is read
// via raw window.localStorage (tri-state), so the same Map backs both.
const disk = new Map<string, string>();
let configState: Record<string, unknown> = {};
let asyncCanonicalReads = false;
let canonicalReadResolvers: Array<() => void> = [];
let canonicalReadRejects = false;
let legacyReadThrows = false;

const rawStorage = {
  getItem: (key: string) => {
    if (key === 'context-store' && legacyReadThrows) {
      throw new Error('underlying storage failure');
    }
    return disk.get(key) ?? null;
  },
  setItem: (key: string, value: string) => {
    disk.set(key, value);
  },
  removeItem: (key: string) => {
    disk.delete(key);
  },
  clear: () => {
    disk.clear();
  },
  key: (index: number) => Array.from(disk.keys())[index] ?? null,
  get length() {
    return disk.size;
  },
} as Storage;

// Legacy migration prefers the raw window key in browsers; without a window
// (bun tests, SSR) it falls back to the mocked safeStorage below, which
// shares this same controllable disk and can still throw to model failure.

mock.module('@/stores/utils/safeStorage', () => ({
  getSafeStorage: () => rawStorage,
  getDeferredSafeStorage: () => rawStorage,
  createDeferredSafeJSONStorage: () => ({
    getItem: (name: string) => {
      const raw = rawStorage.getItem(name);
      if (raw === null) return null;
      if (canonicalReadRejects) {
        return Promise.reject(new Error('canonical read failed'));
      }
      if (asyncCanonicalReads) {
        return new Promise((resolve) => {
          canonicalReadResolvers.push(() => {
            try {
              resolve(JSON.parse(raw));
            } catch {
              resolve(null);
            }
          });
        });
      }
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    setItem: (name: string, value: unknown) => {
      rawStorage.setItem(name, JSON.stringify(value));
    },
    removeItem: (name: string) => {
      rawStorage.removeItem(name);
    },
  }),
}));

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: {
    getState: () => configState,
  },
}));

mock.module('@/sync/sync-refs', () => ({
  getSyncSessions: () => [],
  getAllSyncSessions: () => [],
  getSyncSessionDirectory: () => null,
  getActiveSyncSessions: () => [],
  getSyncMessages: () => [],
  getSyncParts: () => [],
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      sendMessage: async () => undefined,
      sessionAbortFlags: new Map(),
    }),
  },
}));

const selectionModule = await import('./selection-store');
const {
  useSelectionStore,
  parseLegacyContextStorePayload,
  SELECTION_STORE_KEY,
  SELECTION_STORE_VERSION,
  LEGACY_CONTEXT_STORE_KEY,
  CONTEXT_STORE_MIGRATION_VERSION,
  __clearSelectionDirtyForTests,
} = selectionModule;
const { resolveSessionSendConfig } = await import('@/hooks/useQueuedMessageAutoSend');

const flushAsyncReads = () => {
  const resolvers = canonicalReadResolvers;
  canonicalReadResolvers = [];
  for (const resolve of resolvers) resolve();
};

const resetStore = () => {
  __clearSelectionDirtyForTests();
  useSelectionStore.setState({
    sessionModelSelections: new Map(),
    sessionAgentSelections: new Map(),
    sessionAgentModelSelections: new Map(),
    sessionAgentModelVariantSelections: new Map(),
    lastUsedProvider: null,
    hasHydrated: false,
    contextStoreMigrationVersion: undefined,
    clearedVariantKeys: [],
  });
};

/**
 * Wipe in-memory state without touching disk, simulating a process restart.
 * Plain `setState` would persist the emptied maps and clobber the snapshot
 * under test, so the disk image is restored after the reset write lands.
 */
const resetMemoryOnly = () => {
  const snapshot = new Map(disk);
  const restore = () => {
    disk.clear();
    for (const [key, value] of snapshot) disk.set(key, value);
  };
  resetStore();
  restore();
  // Re-arm the pre-hydration gate; its persist write carries no new maps.
  useSelectionStore.setState({ hasHydrated: false });
  restore();
};

const seedDisk = (entries: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(entries)) {
    disk.set(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
};

const legacyEnvelope = (state: Record<string, unknown>) => ({ state, version: 0 });
const canonicalEnvelope = (state: Record<string, unknown>) => ({ state, version: SELECTION_STORE_VERSION });

const readCanonicalDisk = (): Record<string, unknown> | null => {
  const raw = disk.get(SELECTION_STORE_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as Record<string, unknown>;
};

describe('legacy context-store payload parsing', () => {
  test('missing key is distinct from malformed', () => {
    expect(parseLegacyContextStorePayload(null).status).toBe('missing');
    expect(parseLegacyContextStorePayload('{not-json').status).toBe('failed');
    expect(parseLegacyContextStorePayload('{not-json').failed).toBe(true);
  });

  test('array container is malformed, not empty success', () => {
    const parsed = parseLegacyContextStorePayload('[]');
    expect(parsed.status).toBe('failed');
    expect(parsed.failed).toBe(true);
    expect(parsed.data.models.size).toBe(0);
  });

  test('empty envelope parses as ok with empty maps', () => {
    const parsed = parseLegacyContextStorePayload(JSON.stringify({ state: {} }));
    expect(parsed.status).toBe('ok');
    expect(parsed.failed).toBe(false);
    expect(parsed.data.models.size).toBe(0);
  });

  test('malformed slices preserve good slices but block the marker', () => {
    const parsed: LegacyParseResult = parseLegacyContextStorePayload(JSON.stringify({
      state: {
        sessionModelSelections: [['s1', { providerId: 'p', modelId: 'm' }]],
        sessionAgentSelections: 'oops-not-an-array',
      },
    }));
    expect(parsed.status).toBe('failed');
    expect(parsed.failed).toBe(true);
    expect(parsed.data.models.get('s1')).toEqual({ providerId: 'p', modelId: 'm' });
    expect(parsed.data.agents.size).toBe(0);
  });
});

describe('selection-store canonical migration', () => {
  beforeEach(() => {
    disk.clear();
    configState = {};
    asyncCanonicalReads = false;
    canonicalReadResolvers = [];
    canonicalReadRejects = false;
    legacyReadThrows = false;
    resetStore();
    // Reset writes an empty snapshot; drop it so each test seeds explicitly.
    disk.clear();
  });

  test('canonical values win over legacy conflicts and legacy fills gaps', async () => {
    seedDisk({
      [SELECTION_STORE_KEY]: canonicalEnvelope({
        sessionModelSelections: [['s-conflict', { providerId: 'canon-p', modelId: 'canon-m' }]],
        sessionAgentSelections: [['s-conflict', 'canon-agent']],
        sessionAgentModelSelections: [],
        sessionAgentModelVariantSelections: [],
        lastUsedProvider: null,
      }),
      [LEGACY_CONTEXT_STORE_KEY]: legacyEnvelope({
        sessionModelSelections: [
          ['s-conflict', { providerId: 'legacy-p', modelId: 'legacy-m' }],
          ['s-gap', { providerId: 'legacy-p', modelId: 'legacy-m' }],
        ],
        sessionAgentSelections: [['s-gap', 'legacy-agent']],
        sessionAgentModelSelections: [],
        sessionAgentModelVariantSelections: [],
        currentAgentContext: [['s-ctx', 'ctx-agent']],
      }),
    });
    await useSelectionStore.persist.rehydrate();

    const state = useSelectionStore.getState();
    expect(state.sessionModelSelections.get('s-conflict')).toEqual({ providerId: 'canon-p', modelId: 'canon-m' });
    expect(state.sessionModelSelections.get('s-gap')).toEqual({ providerId: 'legacy-p', modelId: 'legacy-m' });
    expect(state.sessionAgentSelections.get('s-conflict')).toBe('canon-agent');
    expect(state.sessionAgentSelections.get('s-gap')).toBe('legacy-agent');
    // currentAgentContext is a fallback for missing agent selections only.
    expect(state.sessionAgentSelections.get('s-ctx')).toBe('ctx-agent');
    expect(state.contextStoreMigrationVersion).toBe(CONTEXT_STORE_MIGRATION_VERSION);
    expect(state.hasHydrated).toBe(true);
  });

  test('malformed legacy preserves canonical and does not mark migration complete', async () => {
    const legacyRaw = JSON.stringify({
      state: {
        sessionModelSelections: [['s-good', { providerId: 'p', modelId: 'm' }]],
        sessionAgentSelections: 'oops',
      },
    });
    seedDisk({
      [SELECTION_STORE_KEY]: canonicalEnvelope({
        sessionModelSelections: [['s-canon', { providerId: 'c', modelId: 'c' }]],
        sessionAgentSelections: [],
        sessionAgentModelSelections: [],
        sessionAgentModelVariantSelections: [],
        lastUsedProvider: null,
      }),
      [LEGACY_CONTEXT_STORE_KEY]: legacyRaw,
    });
    await useSelectionStore.persist.rehydrate();

    const state = useSelectionStore.getState();
    expect(state.sessionModelSelections.get('s-canon')).toEqual({ providerId: 'c', modelId: 'c' });
    expect(state.sessionModelSelections.get('s-good')).toEqual({ providerId: 'p', modelId: 'm' });
    expect(state.contextStoreMigrationVersion).toBe(undefined);
    // The legacy raw key stays untouched for a later retry.
    expect(disk.get(LEGACY_CONTEXT_STORE_KEY)).toBe(legacyRaw);
  });

  test('underlying legacy storage failure is not missing and blocks completion', async () => {
    seedDisk({
      [SELECTION_STORE_KEY]: canonicalEnvelope({
        sessionModelSelections: [['s-canon', { providerId: 'c', modelId: 'c' }]],
        sessionAgentSelections: [],
        sessionAgentModelSelections: [],
        sessionAgentModelVariantSelections: [],
        lastUsedProvider: null,
      }),
      [LEGACY_CONTEXT_STORE_KEY]: legacyEnvelope({
        sessionModelSelections: [['s-legacy', { providerId: 'p', modelId: 'm' }]],
        sessionAgentSelections: [],
        sessionAgentModelSelections: [],
        sessionAgentModelVariantSelections: [],
        currentAgentContext: [],
      }),
    });
    legacyReadThrows = true;
    await useSelectionStore.persist.rehydrate();
    legacyReadThrows = false;

    const state = useSelectionStore.getState();
    // Failure cannot look like a missing key: no legacy import, no marker.
    expect(state.sessionModelSelections.get('s-canon')).toEqual({ providerId: 'c', modelId: 'c' });
    expect(state.sessionModelSelections.get('s-legacy')).toBe(undefined);
    expect(state.contextStoreMigrationVersion).toBe(undefined);
    expect(state.hasHydrated).toBe(true);
  });

  test('malformed canonical root blocks completion without erasing good legacy', async () => {
    seedDisk({
      [SELECTION_STORE_KEY]: canonicalEnvelope({
        sessionModelSelections: 'oops-not-an-array',
        sessionAgentSelections: [],
        sessionAgentModelSelections: [],
        sessionAgentModelVariantSelections: [],
        lastUsedProvider: null,
      }),
      [LEGACY_CONTEXT_STORE_KEY]: legacyEnvelope({
        sessionModelSelections: [['s-good', { providerId: 'p', modelId: 'm' }]],
        sessionAgentSelections: [],
        sessionAgentModelSelections: [],
        sessionAgentModelVariantSelections: [],
        currentAgentContext: [],
      }),
    });
    await useSelectionStore.persist.rehydrate();

    const state = useSelectionStore.getState();
    expect(state.sessionModelSelections.get('s-good')).toEqual({ providerId: 'p', modelId: 'm' });
    expect(state.contextStoreMigrationVersion).toBe(undefined);
  });

  test('unreadable legacy payload preserves current state and retries later', async () => {
    seedDisk({
      [SELECTION_STORE_KEY]: canonicalEnvelope({
        sessionModelSelections: [],
        sessionAgentSelections: [],
        sessionAgentModelSelections: [],
        sessionAgentModelVariantSelections: [],
        lastUsedProvider: null,
      }),
      [LEGACY_CONTEXT_STORE_KEY]: '{not-json',
    });
    await useSelectionStore.persist.rehydrate();

    const state = useSelectionStore.getState();
    expect(state.hasHydrated).toBe(true);
    expect(state.contextStoreMigrationVersion).toBe(undefined);
    expect(disk.get(LEGACY_CONTEXT_STORE_KEY)).toBe('{not-json');
  });

  test('missing legacy marks migration complete without erasing canonical', async () => {
    seedDisk({
      [SELECTION_STORE_KEY]: canonicalEnvelope({
        sessionModelSelections: [['s1', { providerId: 'p', modelId: 'm' }]],
        sessionAgentSelections: [],
        sessionAgentModelSelections: [],
        sessionAgentModelVariantSelections: [],
        lastUsedProvider: { providerID: 'p', modelID: 'm' },
      }),
    });
    await useSelectionStore.persist.rehydrate();

    const state = useSelectionStore.getState();
    expect(state.sessionModelSelections.get('s1')).toEqual({ providerId: 'p', modelId: 'm' });
    expect(state.lastUsedProvider).toEqual({ providerID: 'p', modelID: 'm' });
    expect(state.contextStoreMigrationVersion).toBe(CONTEXT_STORE_MIGRATION_VERSION);
  });

  test('imports more than 150 legacy sessions without truncation', async () => {
    const models: Array<[string, { providerId: string; modelId: string }]> = [];
    for (let i = 0; i < 200; i += 1) {
      models.push([`s-${i}`, { providerId: 'p', modelId: `m-${i}` }]);
    }
    seedDisk({
      [LEGACY_CONTEXT_STORE_KEY]: legacyEnvelope({
        sessionModelSelections: models,
        sessionAgentSelections: [],
        sessionAgentModelSelections: [],
        sessionAgentModelVariantSelections: [],
        currentAgentContext: [],
      }),
    });
    await useSelectionStore.persist.rehydrate();

    const state = useSelectionStore.getState();
    expect(state.sessionModelSelections.size).toBe(200);
    expect(state.sessionModelSelections.get('s-199')).toEqual({ providerId: 'p', modelId: 'm-199' });

    // A later save persists the full union, not a 150-session snapshot.
    useSelectionStore.getState().saveSessionModelSelection('s-new', 'p', 'm-new');
    const persisted = readCanonicalDisk()?.state as Record<string, unknown>;
    expect((persisted.sessionModelSelections as unknown[]).length).toBe(201);
  });

  test('variants round-trip through persistence', async () => {
    await useSelectionStore.persist.rehydrate();
    useSelectionStore.getState().saveAgentModelVariantForSession('s1', 'agent', 'p', 'm', 'high');
    expect(useSelectionStore.getState().getAgentModelVariantForSession('s1', 'agent', 'p', 'm')).toBe('high');

    const persisted = readCanonicalDisk()?.state as Record<string, unknown>;
    expect(JSON.stringify(persisted)).toContain('high');

    resetMemoryOnly();
    await useSelectionStore.persist.rehydrate();
    expect(useSelectionStore.getState().getAgentModelVariantForSession('s1', 'agent', 'p', 'm')).toBe('high');
  });

  test('explicit variant clears survive reload and are not resurrected from legacy', async () => {
    seedDisk({
      [LEGACY_CONTEXT_STORE_KEY]: legacyEnvelope({
        sessionModelSelections: [],
        sessionAgentSelections: [],
        sessionAgentModelSelections: [],
        sessionAgentModelVariantSelections: [
          ['s1', [['agent', [['p/m', 'legacy-variant']]]]],
        ],
        currentAgentContext: [],
      }),
    });
    await useSelectionStore.persist.rehydrate();
    expect(useSelectionStore.getState().getAgentModelVariantForSession('s1', 'agent', 'p', 'm')).toBe('legacy-variant');

    useSelectionStore.getState().saveAgentModelVariantForSession('s1', 'agent', 'p', 'm', undefined);
    expect(useSelectionStore.getState().getAgentModelVariantForSession('s1', 'agent', 'p', 'm')).toBe(undefined);

    resetMemoryOnly();
    await useSelectionStore.persist.rehydrate();
    // Migration is complete, so the legacy backup is not a live fallback and
    // the cleared entry stays absent.
    expect(useSelectionStore.getState().getAgentModelVariantForSession('s1', 'agent', 'p', 'm')).toBe(undefined);
  });

  test('incomplete migration: clear survives reload via durable tombstone', async () => {
    // Good legacy variant plus a malformed sibling slice: the import keeps the
    // good variant but must not mark migration complete.
    seedDisk({
      [LEGACY_CONTEXT_STORE_KEY]: legacyEnvelope({
        sessionModelSelections: [],
        sessionAgentSelections: 'oops-not-an-array',
        sessionAgentModelSelections: [],
        sessionAgentModelVariantSelections: [
          ['s1', [['agent', [['p/m', 'legacy-variant']]]]],
        ],
        currentAgentContext: [],
      }),
    });
    await useSelectionStore.persist.rehydrate();
    expect(useSelectionStore.getState().getAgentModelVariantForSession('s1', 'agent', 'p', 'm')).toBe('legacy-variant');
    expect(useSelectionStore.getState().contextStoreMigrationVersion).toBe(undefined);

    // User clears the imported variant before migration can complete.
    useSelectionStore.getState().saveAgentModelVariantForSession('s1', 'agent', 'p', 'm', undefined);
    expect(useSelectionStore.getState().getAgentModelVariantForSession('s1', 'agent', 'p', 'm')).toBe(undefined);

    resetMemoryOnly();
    await useSelectionStore.persist.rehydrate();
    // Without a durable tombstone the legacy backup would reimport the variant.
    expect(useSelectionStore.getState().getAgentModelVariantForSession('s1', 'agent', 'p', 'm')).toBe(undefined);
    expect(useSelectionStore.getState().contextStoreMigrationVersion).toBe(undefined);
  });

  test('live writes during async hydrate win, including explicit clears', async () => {
    seedDisk({
      [SELECTION_STORE_KEY]: canonicalEnvelope({
        sessionModelSelections: [['s1', { providerId: 'old-p', modelId: 'old-m' }]],
        sessionAgentSelections: [],
        sessionAgentModelSelections: [],
        sessionAgentModelVariantSelections: [
          ['s1', [['agent', [['p/m', 'persisted-variant']]]]],
        ],
        lastUsedProvider: null,
      }),
      [LEGACY_CONTEXT_STORE_KEY]: legacyEnvelope({
        sessionModelSelections: [['s-legacy', { providerId: 'lp', modelId: 'lm' }]],
        sessionAgentSelections: [],
        sessionAgentModelSelections: [],
        sessionAgentModelVariantSelections: [],
        currentAgentContext: [],
      }),
    });
    asyncCanonicalReads = true;
    const rehydratePromise = useSelectionStore.persist.rehydrate();

    // User acts while the canonical read is still in flight.
    useSelectionStore.getState().saveSessionModelSelection('s1', 'live-p', 'live-m');
    useSelectionStore.getState().saveAgentModelVariantForSession('s1', 'agent', 'p', 'm', undefined);

    flushAsyncReads();
    await rehydratePromise;
    asyncCanonicalReads = false;

    const state = useSelectionStore.getState();
    expect(state.sessionModelSelections.get('s1')).toEqual({ providerId: 'live-p', modelId: 'live-m' });
    expect(state.sessionModelSelections.get('s-legacy')).toEqual({ providerId: 'lp', modelId: 'lm' });
    expect(state.getAgentModelVariantForSession('s1', 'agent', 'p', 'm')).toBe(undefined);
    expect(state.hasHydrated).toBe(true);
  });

  test('repeated rehydrate without new writes does not resurrect stale entries', async () => {
    seedDisk({
      [SELECTION_STORE_KEY]: canonicalEnvelope({
        sessionModelSelections: [['s1', { providerId: 'old-p', modelId: 'old-m' }]],
        sessionAgentSelections: [],
        sessionAgentModelSelections: [],
        sessionAgentModelVariantSelections: [],
        lastUsedProvider: null,
        contextStoreMigrationVersion: CONTEXT_STORE_MIGRATION_VERSION,
      }),
    });
    await useSelectionStore.persist.rehydrate();
    expect(useSelectionStore.getState().sessionModelSelections.get('s1')).toEqual({ providerId: 'old-p', modelId: 'old-m' });

    // Canonical advances externally; in-memory is now stale with no new writes.
    seedDisk({
      [SELECTION_STORE_KEY]: canonicalEnvelope({
        sessionModelSelections: [['s1', { providerId: 'new-p', modelId: 'new-m' }]],
        sessionAgentSelections: [],
        sessionAgentModelSelections: [],
        sessionAgentModelVariantSelections: [],
        lastUsedProvider: null,
        contextStoreMigrationVersion: CONTEXT_STORE_MIGRATION_VERSION,
      }),
    });
    await useSelectionStore.persist.rehydrate();
    expect(useSelectionStore.getState().sessionModelSelections.get('s1')).toEqual({ providerId: 'new-p', modelId: 'new-m' });
  });

  test('rejected hydrate keeps the gate closed and preserves intent', async () => {
    // Seed a canonical snapshot so the read path actually hits storage, then
    // fail the read. Zustand never calls merge or onFinishHydration on
    // storage failure, so the gate stays closed and intent survives.
    seedDisk({
      [SELECTION_STORE_KEY]: canonicalEnvelope({
        sessionModelSelections: [['s-old', { providerId: 'old-p', modelId: 'old-m' }]],
        sessionAgentSelections: [],
        sessionAgentModelSelections: [],
        sessionAgentModelVariantSelections: [],
        lastUsedProvider: null,
      }),
    });
    // Live intent while the read is unavailable.
    useSelectionStore.getState().saveSessionModelSelection('s-live', 'live-p', 'live-m');
    useSelectionStore.setState({ hasHydrated: false });

    canonicalReadRejects = true;
    await useSelectionStore.persist.rehydrate();
    canonicalReadRejects = false;

    expect(useSelectionStore.getState().hasHydrated).toBe(false);
    expect(useSelectionStore.getState().sessionModelSelections.get('s-live')).toEqual({ providerId: 'live-p', modelId: 'live-m' });
    expect(useSelectionStore.getState().contextStoreMigrationVersion).toBe(undefined);
  });

  test('hydration gate starts closed and opens after rehydrate', async () => {
    expect(useSelectionStore.getState().hasHydrated).toBe(false);
    await useSelectionStore.persist.rehydrate();
    expect(useSelectionStore.getState().hasHydrated).toBe(true);
  });
});

describe('queued send-config resolution against the canonical store', () => {
  beforeEach(() => {
    disk.clear();
    resetStore();
    disk.clear();
    configState = {};
  });

  test('agent model beats session model beats config beats last-used provider', () => {
    useSelectionStore.setState({
      sessionModelSelections: new Map([['s1', { providerId: 'session-p', modelId: 'session-m' }]]),
      sessionAgentSelections: new Map([['s1', 'agent']]),
      sessionAgentModelSelections: new Map([['s1', new Map([['agent', { providerId: 'agent-p', modelId: 'agent-m' }]])]]),
      sessionAgentModelVariantSelections: new Map([['s1', new Map([['agent', new Map([['agent-p/agent-m', 'high']])]])]]),
      lastUsedProvider: { providerID: 'last-p', modelID: 'last-m' },
    });
    configState = { currentProviderId: 'config-p', currentModelId: 'config-m' };

    expect(resolveSessionSendConfig('s1')).toEqual({
      providerID: 'agent-p',
      modelID: 'agent-m',
      agent: 'agent',
      variant: 'high',
    });

    // Without an agent-specific model the session model wins over config.
    useSelectionStore.setState({
      sessionAgentModelSelections: new Map(),
      sessionAgentModelVariantSelections: new Map(),
    });
    expect(resolveSessionSendConfig('s1')).toEqual({
      providerID: 'session-p',
      modelID: 'session-m',
      agent: 'agent',
      variant: undefined,
    });

    // Without any session preference the live config wins over last-used.
    useSelectionStore.setState({
      sessionModelSelections: new Map(),
      sessionAgentSelections: new Map(),
    });
    expect(resolveSessionSendConfig('s1')).toEqual({
      providerID: 'config-p',
      modelID: 'config-m',
      agent: undefined,
      variant: undefined,
    });

    // Last-used provider is the final fallback.
    configState = {};
    expect(resolveSessionSendConfig('s1')).toEqual({
      providerID: 'last-p',
      modelID: 'last-m',
      agent: undefined,
      variant: undefined,
    });
  });
});
