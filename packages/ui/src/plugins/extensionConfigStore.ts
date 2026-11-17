import { create } from 'zustand';

import { piClient } from '@/lib/pi/client';
import type {
  PiExtensionConfigItem,
  PiExtensionConfigResponse,
  PiExtensionOverrideState,
} from '@/lib/pi/protocol';
import { getRuntimeKey } from '@/lib/runtime-switch';

/**
 * Pi's extensions and packages per directory, as the server resolves them.
 * `''` holds the global view (no directory, project settings left out); a
 * directory key holds that project's view. See `DOCUMENTATION.md`.
 */
export interface ExtensionConfigEntry {
  /** `null` until the first successful read. Kept when a later read fails. */
  config: PiExtensionConfigResponse | null;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  loadedAt: number;
}

export type ExtensionConfigWriteResult =
  /** `deferred`: saved, and it applies once the running sessions are idle. */
  | { ok: true; deferred: boolean }
  | { ok: false; error: unknown };

interface ExtensionConfigStore {
  entries: Record<string, ExtensionConfigEntry>;
  /** Writes in flight, keyed by extension or package id. */
  pending: Record<string, true>;
  load: (directory?: string | null, options?: { force?: boolean }) => Promise<void>;
  /** Turn an extension on or off in global settings. */
  setGlobal: (id: string, enabled: boolean) => Promise<ExtensionConfigWriteResult>;
  /**
   * Turn an extension on or off in one project. The server stores a choice
   * for the project only when it differs from what the project gets anyway.
   */
  setProjectEnabled: (id: string, enabled: boolean, directory: string) => Promise<ExtensionConfigWriteResult>;
  /** Set one project's own choice for an extension. */
  setProjectState: (id: string, state: PiExtensionOverrideState, directory: string) => Promise<ExtensionConfigWriteResult>;
  /** Remove a package; a project's package needs its `directory`. */
  removePackage: (id: string, directory?: string | null) => Promise<ExtensionConfigWriteResult>;
  /**
   * Age every view so the shown ones are read again. For a change made
   * elsewhere that moves what Pi loads, such as a plugin's switch.
   */
  invalidate: () => void;
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
/** Highest write sequence started per directory key; a read older than it is dropped. */
const lastWriteByEntry = new Map<string, number>();

const withoutDeferred = (response: PiExtensionConfigResponse): PiExtensionConfigResponse => {
  if (response.deferred === undefined) return response;
  const config = { ...response };
  delete config.deferred;
  return config;
};

/** The server answers a write with the list for the view it was made from. */
const answersView = (response: PiExtensionConfigResponse, entryKey: string): boolean => (
  response.project.available === Boolean(entryKey)
);

const replaceItem = (
  entry: ExtensionConfigEntry | undefined,
  id: string,
  update: (item: PiExtensionConfigItem) => PiExtensionConfigItem,
): ExtensionConfigEntry | undefined => {
  if (!entry?.config) return entry;
  let changed = false;
  const extensions = entry.config.extensions.map((item) => {
    if (item.id !== id) return item;
    const updated = update(item);
    if (updated !== item) changed = true;
    return updated;
  });
  return changed ? { ...entry, config: { ...entry.config, extensions } } : entry;
};

export const useExtensionConfigStore = create<ExtensionConfigStore>()((set, get) => {
  const isCurrent = (writeGeneration: number, runtimeKey: string): boolean => (
    writeGeneration === generation && getRuntimeKey() === runtimeKey
  );

  /**
   * Store a write's answer for `entryKey`, and age every other view: a global
   * change shows in each project, and a project's change can move what a
   * package loads, so they are read again when next shown.
   */
  const applyWriteAnswer = (entryKey: string, seq: number, response: PiExtensionConfigResponse): void => {
    const usable = answersView(response, entryKey) && lastWriteByEntry.get(entryKey) === seq;
    set((state) => {
      const entries: Record<string, ExtensionConfigEntry> = {};
      for (const [key, entry] of Object.entries(state.entries)) {
        entries[key] = key === entryKey ? entry : { ...entry, loadedAt: 0 };
      }
      if (usable) {
        entries[entryKey] = { config: withoutDeferred(response), status: 'ready', error: null, loadedAt: Date.now() };
      }
      return { entries };
    });
    if (!usable && lastWriteByEntry.get(entryKey) === seq) void reloadAfterWrite(entryKey);
  };

  /** Read `entryKey` again, after any read already running (it may predate the write). */
  const reloadAfterWrite = async (entryKey: string): Promise<void> => {
    const running = inFlight.get(entryKey);
    if (running) await running;
    await get().load(entryKey || null, { force: true });
  };

  const clearPending = (id: string): void => {
    set((state) => {
      if (!state.pending[id]) return state;
      const pending = { ...state.pending };
      delete pending[id];
      return { pending };
    });
  };

  /**
   * One optimistic item write: show `next` at once, then take the server's
   * list, or put the item back and read the list again when it fails.
   */
  const writeItem = async (
    id: string,
    entryKey: string,
    next: (item: PiExtensionConfigItem) => PiExtensionConfigItem,
    send: (runtimeKey: string) => Promise<PiExtensionConfigResponse>,
  ): Promise<ExtensionConfigWriteResult> => {
    if (get().pending[id]) return { ok: false, error: new Error('A change to this extension is still saving.') };
    const runtimeKey = getRuntimeKey();
    const writeGeneration = generation;
    const seq = ++writeSeq;
    lastWriteByEntry.set(entryKey, seq);
    let before: PiExtensionConfigItem | undefined;

    set((state) => {
      const entry = replaceItem(state.entries[entryKey], id, (item) => {
        before = item;
        return next(item);
      });
      return {
        pending: { ...state.pending, [id]: true as const },
        entries: entry ? { ...state.entries, [entryKey]: entry } : state.entries,
      };
    });

    try {
      const response = await send(runtimeKey);
      if (!isCurrent(writeGeneration, runtimeKey)) return { ok: true, deferred: response.deferred === true };
      applyWriteAnswer(entryKey, seq, response);
      clearPending(id);
      return { ok: true, deferred: response.deferred === true };
    } catch (error) {
      if (!isCurrent(writeGeneration, runtimeKey)) return { ok: false, error };
      set((state) => {
        const previous = before;
        const entry = previous
          ? replaceItem(state.entries[entryKey], id, () => previous)
          : state.entries[entryKey];
        return entry ? { entries: { ...state.entries, [entryKey]: entry } } : state;
      });
      clearPending(id);
      // The write may have landed before it failed; the server decides.
      void reloadAfterWrite(entryKey);
      return { ok: false, error };
    }
  };

  return {
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
            config: state.entries[entryKey]?.config ?? null,
            status: 'loading',
            error: null,
            loadedAt: state.entries[entryKey]?.loadedAt ?? 0,
          },
        },
      }));

      const request = (async () => {
        try {
          const response = await piClient.getExtensionConfig(entryKey || undefined, { runtimeKey });
          if (loadGeneration !== generation || getRuntimeKey() !== runtimeKey) return;
          set((state) => {
            const current = state.entries[entryKey];
            // A write that started after this read answers with a newer list.
            const overtaken = (lastWriteByEntry.get(entryKey) ?? 0) > seqAtStart && Boolean(current?.config);
            return {
              entries: {
                ...state.entries,
                [entryKey]: overtaken && current
                  ? { ...current, status: 'ready', error: null }
                  : { config: withoutDeferred(response), status: 'ready', error: null, loadedAt: Date.now() },
              },
            };
          });
        } catch (error) {
          if (loadGeneration !== generation || getRuntimeKey() !== runtimeKey) return;
          set((state) => ({
            entries: {
              ...state.entries,
              [entryKey]: {
                config: state.entries[entryKey]?.config ?? null,
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

    setGlobal: (id, enabled) => writeItem(
      id,
      '',
      (item) => (item.global === enabled ? item : { ...item, global: enabled }),
      (runtimeKey) => piClient.setExtensionConfig(id, { scope: 'global', enabled }, { runtimeKey }),
    ),

    setProjectEnabled: (id, enabled, directory) => {
      const entryKey = keyFor(directory);
      if (!entryKey) return Promise.resolve({ ok: false, error: new Error('A project setting needs a project.') });
      return writeItem(
        id,
        entryKey,
        (item) => {
          if (!item.project || item.project.enabled === enabled) return item;
          // A guess until the answer arrives: the server decides the override.
          const state: PiExtensionOverrideState = enabled === item.project.inherited ? 'inherit' : enabled ? 'load' : 'unload';
          return { ...item, project: { ...item.project, state, enabled } };
        },
        (runtimeKey) => piClient.setExtensionConfig(id, { scope: 'project', enabled, directory: entryKey }, { runtimeKey }),
      );
    },

    setProjectState: (id, state, directory) => {
      const entryKey = keyFor(directory);
      if (!entryKey) return Promise.resolve({ ok: false, error: new Error('A project setting needs a project.') });
      return writeItem(
        id,
        entryKey,
        (item) => {
          if (!item.project || item.project.state === state) return item;
          const enabled = state === 'inherit' ? item.project.inherited : state === 'load';
          return { ...item, project: { ...item.project, state, enabled } };
        },
        (runtimeKey) => piClient.setExtensionConfig(id, { scope: 'project', state, directory: entryKey }, { runtimeKey }),
      );
    },

    removePackage: async (id, directory) => {
      if (get().pending[id]) return { ok: false, error: new Error('This package is already being removed.') };
      const entryKey = keyFor(directory);
      const runtimeKey = getRuntimeKey();
      const writeGeneration = generation;
      const seq = ++writeSeq;
      lastWriteByEntry.set(entryKey, seq);
      set((state) => ({ pending: { ...state.pending, [id]: true as const } }));
      try {
        const response = await piClient.removeExtensionPackage(id, entryKey || undefined, { runtimeKey });
        if (!isCurrent(writeGeneration, runtimeKey)) return { ok: true, deferred: response.deferred === true };
        applyWriteAnswer(entryKey, seq, response);
        clearPending(id);
        return { ok: true, deferred: response.deferred === true };
      } catch (error) {
        if (!isCurrent(writeGeneration, runtimeKey)) return { ok: false, error };
        clearPending(id);
        // A removal can stop half way (files gone, settings entry kept).
        void reloadAfterWrite(entryKey);
        return { ok: false, error };
      }
    },

    invalidate: () => {
      set((state) => {
        const entries: Record<string, ExtensionConfigEntry> = {};
        for (const [key, entry] of Object.entries(state.entries)) entries[key] = { ...entry, loadedAt: 0 };
        return { entries };
      });
    },

    resetForRuntimeSwitch: () => {
      generation += 1;
      inFlight.clear();
      lastWriteByEntry.clear();
      set({ entries: {}, pending: {} });
    },
  };
});
