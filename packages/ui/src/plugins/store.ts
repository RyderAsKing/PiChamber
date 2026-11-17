import { create } from 'zustand';

import { piClient } from '@/lib/pi/client';
import type { PiPluginStateValue, PiPluginView } from '@/lib/pi/protocol';
import { getRuntimeKey } from '@/lib/runtime-switch';

/**
 * Plugin list per directory, as the server resolves it. `''` holds the
 * global view (no directory). See `DOCUMENTATION.md` for the contract.
 */
export interface PluginsEntry {
  /** `null` until the first successful read. Kept when a later read fails. */
  plugins: PiPluginView[] | null;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  loadedAt: number;
}

interface PluginsStore {
  entries: Record<string, PluginsEntry>;
  /** Writes in flight, keyed `id` (enable) or `id\nkey` (state). */
  pending: Record<string, true>;
  load: (directory?: string | null, options?: { force?: boolean }) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<boolean>;
  setState: (id: string, key: string, value: PiPluginStateValue, directory?: string | null) => Promise<boolean>;
  resetForRuntimeSwitch: () => void;
}

/** A read newer than this is reused instead of fetched again. */
const FRESH_MS = 5_000;

const keyFor = (directory?: string | null): string => directory?.trim() ?? '';

const errorMessage = (error: unknown): string => (
  error instanceof Error && error.message ? error.message : 'Could not reach the server.'
);

let generation = 0;
let writeSeq = 0;
const inFlight = new Map<string, Promise<void>>();
/** Highest write sequence started per plugin; reads older than it keep local state. */
const lastWriteByPlugin = new Map<string, number>();

const replacePlugin = (
  entries: Record<string, PluginsEntry>,
  directoryKey: string | null,
  id: string,
  update: (plugin: PiPluginView, entryKey: string) => PiPluginView,
): Record<string, PluginsEntry> => {
  let changed = false;
  const next: Record<string, PluginsEntry> = {};
  for (const [entryKey, entry] of Object.entries(entries)) {
    if ((directoryKey !== null && entryKey !== directoryKey) || !entry.plugins) {
      next[entryKey] = entry;
      continue;
    }
    let entryChanged = false;
    const plugins = entry.plugins.map((plugin) => {
      if (plugin.id !== id) return plugin;
      const updated = update(plugin, entryKey);
      if (updated !== plugin) entryChanged = true;
      return updated;
    });
    next[entryKey] = entryChanged ? { ...entry, plugins } : entry;
    changed ||= entryChanged;
  }
  return changed ? next : entries;
};

/**
 * A failed write is rolled back to what this page last knew, which may be
 * older than the server (another tab, or the write landed before it failed).
 * Read every loaded folder again so the server decides.
 */
const reloadAfterFailedWrite = (writeGeneration: number, runtimeKey: string): void => {
  if (writeGeneration !== generation || getRuntimeKey() !== runtimeKey) return;
  const { entries, load } = usePluginsStore.getState();
  for (const entryKey of Object.keys(entries)) void load(entryKey || null, { force: true });
};

export const usePluginsStore = create<PluginsStore>()((set, get) => ({
  entries: {},
  pending: {},

  load: async (directory, options) => {
    const entryKey = keyFor(directory);
    const existing = get().entries[entryKey];
    if (!options?.force && existing?.status === 'ready' && Date.now() - existing.loadedAt < FRESH_MS) {
      return;
    }
    const running = inFlight.get(entryKey);
    if (running) return running;

    const runtimeKey = getRuntimeKey();
    const loadGeneration = generation;
    const seqAtStart = writeSeq;
    set((state) => ({
      entries: {
        ...state.entries,
        [entryKey]: {
          plugins: state.entries[entryKey]?.plugins ?? null,
          status: 'loading',
          error: null,
          loadedAt: state.entries[entryKey]?.loadedAt ?? 0,
        },
      },
    }));

    const request = (async () => {
      try {
        const response = await piClient.listPlugins(entryKey || undefined, { runtimeKey });
        if (loadGeneration !== generation || getRuntimeKey() !== runtimeKey) return;
        set((state) => {
          const current = state.entries[entryKey]?.plugins ?? null;
          // A write that started after this read keeps its local value.
          const plugins = response.plugins.map((plugin) => {
            const local = current?.find((item) => item.id === plugin.id);
            const touched = (lastWriteByPlugin.get(plugin.id) ?? 0) > seqAtStart;
            return local && touched ? local : plugin;
          });
          return {
            entries: {
              ...state.entries,
              [entryKey]: { plugins, status: 'ready', error: null, loadedAt: Date.now() },
            },
          };
        });
      } catch (error) {
        if (loadGeneration !== generation || getRuntimeKey() !== runtimeKey) return;
        set((state) => ({
          entries: {
            ...state.entries,
            [entryKey]: {
              plugins: state.entries[entryKey]?.plugins ?? null,
              status: 'error',
              error: errorMessage(error),
              loadedAt: state.entries[entryKey]?.loadedAt ?? 0,
            },
          },
        }));
      } finally {
        if (loadGeneration === generation) inFlight.delete(entryKey);
      }
    })();
    inFlight.set(entryKey, request);
    return request;
  },

  setEnabled: async (id, enabled) => {
    const pendingKey = id;
    if (get().pending[pendingKey]) return false;
    const runtimeKey = getRuntimeKey();
    const writeGeneration = generation;
    const seq = ++writeSeq;
    lastWriteByPlugin.set(id, seq);
    const previous = new Map<string, boolean>();

    set((state) => ({
      pending: { ...state.pending, [pendingKey]: true },
      entries: replacePlugin(state.entries, null, id, (plugin, entryKey) => {
        previous.set(entryKey, plugin.enabled);
        return plugin.enabled === enabled ? plugin : { ...plugin, enabled };
      }),
    }));

    const settle = (ok: boolean, view?: PiPluginView) => {
      if (writeGeneration !== generation || getRuntimeKey() !== runtimeKey) return;
      set((state) => {
        const pending = { ...state.pending };
        delete pending[pendingKey];
        const entries = replacePlugin(state.entries, null, id, (plugin, entryKey) => {
          if (ok && view) return { ...plugin, enabled: view.enabled, impact: view.impact, impactError: view.impactError };
          // Roll back only while nothing newer changed it.
          if (lastWriteByPlugin.get(id) !== seq || plugin.enabled !== enabled) return plugin;
          const before = previous.get(entryKey);
          return before === undefined ? plugin : { ...plugin, enabled: before };
        });
        return { pending, entries };
      });
    };

    try {
      const view = await piClient.setPluginEnabled(id, enabled, { runtimeKey });
      settle(true, view);
      return true;
    } catch {
      settle(false);
      reloadAfterFailedWrite(writeGeneration, runtimeKey);
      return false;
    }
  },

  setState: async (id, key, value, directory) => {
    const pendingKey = `${id}\n${key}`;
    if (get().pending[pendingKey]) return false;
    const runtimeKey = getRuntimeKey();
    const writeGeneration = generation;
    const seq = ++writeSeq;
    lastWriteByPlugin.set(id, seq);
    const directoryKey = keyFor(directory);

    const anyView = Object.values(get().entries)
      .flatMap((entry) => entry.plugins ?? [])
      .find((plugin) => plugin.id === id);
    const field = anyView?.stateSchema[key];
    if (!field) return false;
    // A project value changes one directory; a global value shows everywhere
    // that has no project value of its own, which only the server knows, so
    // other directories are read again once the write lands.
    const scopeKey = field.scope === 'project' ? directoryKey : null;
    if (field.scope === 'project' && !directoryKey) return false;
    const previous = new Map<string, PiPluginStateValue | undefined>();

    set((state) => ({
      pending: { ...state.pending, [pendingKey]: true },
      entries: replacePlugin(state.entries, scopeKey ?? directoryKey, id, (plugin, entryKey) => {
        previous.set(entryKey, plugin.state[key]);
        return plugin.state[key] === value ? plugin : { ...plugin, state: { ...plugin.state, [key]: value } };
      }),
    }));

    const settle = (view?: PiPluginView) => {
      if (writeGeneration !== generation || getRuntimeKey() !== runtimeKey) return;
      set((state) => {
        const pending = { ...state.pending };
        delete pending[pendingKey];
        let entries = state.entries;
        if (view) {
          entries = replacePlugin(entries, directoryKey, id, () => view);
          if (!scopeKey) {
            // Mark the other directories stale so their next read refetches.
            const stale: Record<string, PluginsEntry> = {};
            for (const [entryKey, entry] of Object.entries(entries)) {
              stale[entryKey] = entryKey === directoryKey ? entry : { ...entry, loadedAt: 0 };
            }
            entries = stale;
          }
        } else {
          entries = replacePlugin(entries, scopeKey ?? directoryKey, id, (plugin, entryKey) => {
            if (lastWriteByPlugin.get(id) !== seq || plugin.state[key] !== value) return plugin;
            const before = previous.get(entryKey);
            if (before === undefined) return plugin;
            return { ...plugin, state: { ...plugin.state, [key]: before } };
          });
        }
        return { pending, entries };
      });
    };

    try {
      const view = await piClient.setPluginState(
        id,
        { key, value, ...(directoryKey ? { directory: directoryKey } : {}) },
        { runtimeKey },
      );
      settle(view);
      if (!scopeKey && writeGeneration === generation && getRuntimeKey() === runtimeKey) {
        // Other folders show the new global value unless they have their own;
        // read them again so an open composer or page updates now.
        for (const entryKey of Object.keys(get().entries)) {
          if (entryKey !== directoryKey) void get().load(entryKey || null, { force: true });
        }
      }
      return true;
    } catch {
      settle();
      reloadAfterFailedWrite(writeGeneration, runtimeKey);
      return false;
    }
  },

  resetForRuntimeSwitch: () => {
    generation += 1;
    inFlight.clear();
    lastWriteByPlugin.clear();
    set({ entries: {}, pending: {} });
  },
}));

const EMPTY_PLUGINS: PiPluginView[] = [];

/** Plugins for a directory, or `[]` before the first read. */
export const selectPlugins = (directory?: string | null) => (state: PluginsStore): PiPluginView[] => (
  state.entries[keyFor(directory)]?.plugins ?? EMPTY_PLUGINS
);
