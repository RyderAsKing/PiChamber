import { create } from 'zustand';

import { piClient } from '@/lib/pi/client';
import type { PiPluginStateValue } from '@/lib/pi/protocol';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { usePluginsStore } from './store';

/**
 * Composer switches: a session's own plugin values, layered over the
 * defaults the plugins store holds. A session keeps a value only while it
 * differs from the default; switching back clears it. See `DOCUMENTATION.md`.
 */
export type PluginOverrides = Record<string, Record<string, PiPluginStateValue>>;

interface PluginSessionEntry {
  /** `null` until the first successful read. Kept when a later read fails. */
  overrides: PluginOverrides | null;
  status: 'loading' | 'ready' | 'error';
  loadedAt: number;
}

/** Switches flipped in a new-session draft, applied once the session exists. */
interface PluginDraft {
  draftId: string;
  overrides: PluginOverrides;
}

interface PluginSessionStore {
  sessions: Record<string, PluginSessionEntry>;
  draft: PluginDraft | null;
  /** Writes in flight, keyed `sessionId\nid\nkey`. */
  pending: Record<string, true>;
  load: (sessionId: string, options?: { force?: boolean }) => Promise<void>;
  /**
   * Set one session's value. `settingsValue` is what Settings resolves for
   * the session's folder: a value equal to it is cleared instead of stored.
   */
  set: (sessionId: string, id: string, key: string, value: PiPluginStateValue, settingsValue: PiPluginStateValue | undefined) => Promise<boolean>;
  /** The same for a draft; nothing is written until the session exists. */
  setDraft: (draftId: string, id: string, key: string, value: PiPluginStateValue, settingsValue: PiPluginStateValue | undefined) => void;
  /**
   * Write a draft's switches to the session created from it and forget the
   * draft. Resolves the switches that could not be written.
   */
  applyDraft: (draftId: string, sessionId: string) => Promise<Array<{ id: string; key: string }>>;
  resetForRuntimeSwitch: () => void;
}

const FRESH_MS = 5_000;

let generation = 0;
let writeSeq = 0;
const inFlight = new Map<string, Promise<void>>();
/**
 * Per session, the latest write sequence for each `id\nkey`. A read that
 * started before a key's write keeps the local value for that key only.
 */
const writesBySession = new Map<string, Map<string, number>>();

const pendingKey = (sessionId: string, id: string, key: string) => `${sessionId}\n${id}\n${key}`;
const valueKey = (id: string, key: string) => `${id}\n${key}`;

const noteWrite = (sessionId: string, id: string, key: string, seq: number) => {
  let writes = writesBySession.get(sessionId);
  if (!writes) {
    writes = new Map();
    writesBySession.set(sessionId, writes);
  }
  writes.set(valueKey(id, key), seq);
};

const isLatestWrite = (sessionId: string, id: string, key: string, seq: number) => (
  writesBySession.get(sessionId)?.get(valueKey(id, key)) === seq
);

const valueOf = (overrides: PluginOverrides | null | undefined, id: string, key: string) => overrides?.[id]?.[key];

/**
 * The server's values, except for keys written locally after `sinceSeq`:
 * those keep their local value until their own answer lands.
 */
const mergeRead = (sessionId: string, server: PluginOverrides, local: PluginOverrides | null, sinceSeq: number): PluginOverrides => {
  let merged = server;
  for (const [compound, seq] of writesBySession.get(sessionId) ?? []) {
    if (seq <= sinceSeq) continue;
    const [id, key] = compound.split('\n');
    merged = withOverride(merged, id, key, valueOf(local, id, key));
  }
  return merged;
};

/** `overrides` with one value set, or removed when `value` is undefined. */
export const withOverride = (
  overrides: PluginOverrides,
  id: string,
  key: string,
  value: PiPluginStateValue | undefined,
): PluginOverrides => {
  const values = { ...(overrides[id] ?? {}) };
  if (value === undefined) delete values[key];
  else values[key] = value;
  const next = { ...overrides };
  if (Object.keys(values).length > 0) next[id] = values;
  else delete next[id];
  return next;
};

export const usePluginSessionStore = create<PluginSessionStore>()((set, get) => ({
  sessions: {},
  draft: null,
  pending: {},

  load: async (sessionId, options) => {
    const existing = get().sessions[sessionId];
    if (!options?.force && existing?.status === 'ready' && Date.now() - existing.loadedAt < FRESH_MS) return;
    const running = inFlight.get(sessionId);
    if (running) return running;

    const runtimeKey = getRuntimeKey();
    const loadGeneration = generation;
    const seqAtStart = writeSeq;
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          overrides: state.sessions[sessionId]?.overrides ?? null,
          status: 'loading',
          loadedAt: state.sessions[sessionId]?.loadedAt ?? 0,
        },
      },
    }));

    const request = (async () => {
      try {
        const response = await piClient.getPluginSessionState(sessionId, { runtimeKey });
        if (loadGeneration !== generation || getRuntimeKey() !== runtimeKey) return;
        set((state) => {
          const overrides = mergeRead(sessionId, response.overrides, state.sessions[sessionId]?.overrides ?? null, seqAtStart);
          return {
            sessions: { ...state.sessions, [sessionId]: { overrides, status: 'ready', loadedAt: Date.now() } },
          };
        });
      } catch {
        if (loadGeneration !== generation || getRuntimeKey() !== runtimeKey) return;
        set((state) => ({
          sessions: {
            ...state.sessions,
            [sessionId]: {
              overrides: state.sessions[sessionId]?.overrides ?? null,
              status: 'error',
              loadedAt: state.sessions[sessionId]?.loadedAt ?? 0,
            },
          },
        }));
      } finally {
        if (loadGeneration === generation) inFlight.delete(sessionId);
      }
    })();
    inFlight.set(sessionId, request);
    return request;
  },

  set: async (sessionId, id, key, value, settingsValue) => {
    const writeKey = pendingKey(sessionId, id, key);
    if (get().pending[writeKey]) return false;
    const runtimeKey = getRuntimeKey();
    const writeGeneration = generation;
    const seq = ++writeSeq;
    noteWrite(sessionId, id, key, seq);
    const stored = value === settingsValue ? undefined : value;
    const before = valueOf(get().sessions[sessionId]?.overrides, id, key);

    set((state) => {
      const entry = state.sessions[sessionId];
      return {
        pending: { ...state.pending, [writeKey]: true },
        sessions: {
          ...state.sessions,
          [sessionId]: {
            overrides: withOverride(entry?.overrides ?? {}, id, key, stored),
            status: entry?.status ?? 'ready',
            loadedAt: entry?.loadedAt ?? 0,
          },
        },
      };
    });

    const settle = (result: { overrides: Record<string, PiPluginStateValue> } | null) => {
      if (writeGeneration !== generation || getRuntimeKey() !== runtimeKey) return;
      set((state) => {
        const pending = { ...state.pending };
        delete pending[writeKey];
        const entry = state.sessions[sessionId];
        if (!entry?.overrides) return { pending };
        // Only this key changes here: the answer is authoritative for it
        // unless a newer write of the same key already replaced it, and a
        // failure rolls it back on the same condition.
        if (!isLatestWrite(sessionId, id, key, seq)) return { pending };
        const next = result ? result.overrides[key] : before;
        const overrides = withOverride(entry.overrides, id, key, next);
        return { pending, sessions: { ...state.sessions, [sessionId]: { ...entry, overrides } } };
      });
    };

    try {
      const result = await piClient.setPluginSessionState(id, sessionId, { key, value: stored ?? null }, { runtimeKey });
      settle(result);
      return true;
    } catch {
      settle(null);
      return false;
    }
  },

  setDraft: (draftId, id, key, value, settingsValue) => {
    set((state) => {
      // Only the open draft's switches are kept.
      const current = state.draft?.draftId === draftId ? state.draft.overrides : {};
      return { draft: { draftId, overrides: withOverride(current, id, key, value === settingsValue ? undefined : value) } };
    });
  },

  applyDraft: async (draftId, sessionId) => {
    const draft = get().draft;
    if (!draft || draft.draftId !== draftId) return [];
    const writes = Object.entries(draft.overrides).flatMap(([id, values]) => (
      Object.entries(values).map(([key, value]) => ({ id, key, value }))
    ));
    if (writes.length === 0) {
      set({ draft: null });
      return [];
    }
    const runtimeKey = getRuntimeKey();
    const writeGeneration = generation;
    const seq = ++writeSeq;
    for (const { id, key } of writes) noteWrite(sessionId, id, key, seq);
    // The new session shows the draft's switches at once; each answer then
    // settles its own key, and a write that fails is taken back.
    set((state) => {
      let overrides = state.sessions[sessionId]?.overrides ?? {};
      for (const { id, key, value } of writes) overrides = withOverride(overrides, id, key, value);
      return {
        draft: null,
        sessions: { ...state.sessions, [sessionId]: { overrides, status: 'ready', loadedAt: 0 } },
      };
    });
    const results = await Promise.all(writes.map(async ({ id, key, value }) => {
      try {
        const answer = await piClient.setPluginSessionState(id, sessionId, { key, value }, { runtimeKey });
        return { id, key, ok: true as const, value: answer.overrides[key] };
      } catch {
        return { id, key, ok: false as const, value: undefined };
      }
    }));
    if (writeGeneration === generation && getRuntimeKey() === runtimeKey) {
      set((state) => {
        const entry = state.sessions[sessionId];
        if (!entry?.overrides) return {};
        let overrides = entry.overrides;
        for (const result of results) {
          if (isLatestWrite(sessionId, result.id, result.key, seq)) overrides = withOverride(overrides, result.id, result.key, result.value);
        }
        return { sessions: { ...state.sessions, [sessionId]: { ...entry, overrides } } };
      });
    }
    return results.filter((result) => !result.ok).map(({ id, key }) => ({ id, key }));
  },

  resetForRuntimeSwitch: () => {
    generation += 1;
    inFlight.clear();
    writesBySession.clear();
    set({ sessions: {}, draft: null, pending: {} });
  },
}));

const EMPTY_OVERRIDES: PluginOverrides = {};

/**
 * The overrides the composer shows: a session's (`{}` when it has none, and
 * before its first read, which `selectComposerOverridesKnown` tells apart),
 * or the open draft's.
 */
export const selectComposerOverrides = (target: ComposerTarget) => (state: PluginSessionStore): PluginOverrides => {
  if (target.kind === 'session') return state.sessions[target.sessionId]?.overrides ?? EMPTY_OVERRIDES;
  if (target.kind === 'draft') return state.draft?.draftId === target.draftId ? state.draft.overrides : EMPTY_OVERRIDES;
  return EMPTY_OVERRIDES;
};

/**
 * Whether the composer knows the target's overrides. A session's are unknown
 * until its first successful read: the defaults drawn meanwhile are a guess,
 * so its switches take no clicks until then. A draft's live only here.
 */
export const selectComposerOverridesKnown = (target: ComposerTarget) => (state: PluginSessionStore): boolean => (
  target.kind !== 'session' || state.sessions[target.sessionId]?.overrides != null
);

/** What a composer switch changes: a session, a new-session draft, or nothing yet. */
export type ComposerTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'draft'; draftId: string }
  | { kind: 'none' };

/** The composer label of a plugin switch, from any folder's plugin list. */
const switchLabel = (id: string, key: string): string => {
  for (const entry of Object.values(usePluginsStore.getState().entries)) {
    const plugin = entry.plugins?.find((candidate) => candidate.id === id);
    const toggle = plugin?.contributes.composerToggles?.find((candidate) => candidate.state === key);
    if (toggle) return toggle.label;
    if (plugin) return plugin.name;
  }
  return id;
};

/**
 * Write a draft's switches to the session created from it, telling the user
 * which ones did not save (the session then uses their defaults).
 */
export const applyDraftSwitches = async (draftId: string, sessionId: string): Promise<void> => {
  const failed = await usePluginSessionStore.getState().applyDraft(draftId, sessionId);
  if (failed.length === 0) return;
  const labels = [...new Set(failed.map(({ id, key }) => switchLabel(id, key)))];
  const { toast } = await import('sonner');
  toast.error(`Could not save ${labels.join(' and ')} for this session`, {
    description: 'It uses the default instead.',
  });
};
