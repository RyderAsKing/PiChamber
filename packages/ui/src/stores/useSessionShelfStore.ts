import { create } from 'zustand';

import { piClient } from '@/lib/pi/client';
import type { PiSessionShelfEntry, PiSessionShelfInput } from '@/lib/pi/protocol';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { applyShelfPatch } from '@/lib/sessionShelf';

export type SessionShelfPatch = Omit<PiSessionShelfInput, 'sessionId'>;

type ShelfStatus = 'idle' | 'loading' | 'ready' | 'failed';

type SessionShelfState = {
  /** Runtime the entries belong to; a runtime switch resets them. */
  runtimeKey: string | null;
  entries: Record<string, PiSessionShelfEntry>;
  /**
   * `failed` keeps the previous entries: a failed read is not an empty shelf.
   * Before the first successful read the sidebar falls back to auto-settle
   * only, which needs no stored state.
   */
  status: ShelfStatus;
  load: () => Promise<void>;
  /**
   * Apply a settle/snooze change now and confirm it with the server. On
   * failure the entry rolls back (unless a newer change replaced it) and the
   * error is rethrown for the caller to report.
   */
  update: (sessionId: string, patch: SessionShelfPatch, directory?: string) => Promise<void>;
};

// Per-session mutation revisions: a read that started before a local change
// must not overwrite it when it lands.
let revision = 0;
const mutatedAt = new Map<string, number>();
let loadGeneration = 0;

const withEntry = (
  entries: Record<string, PiSessionShelfEntry>,
  sessionId: string,
  entry: PiSessionShelfEntry | null | undefined,
): Record<string, PiSessionShelfEntry> => {
  const next = { ...entries };
  if (entry) next[sessionId] = entry;
  else delete next[sessionId];
  return next;
};

const resetForRuntime = (runtimeKey: string) => {
  mutatedAt.clear();
  loadGeneration += 1;
  useSessionShelfStore.setState({ runtimeKey, entries: {}, status: 'idle' });
};

export const useSessionShelfStore = create<SessionShelfState>((set, get) => ({
  runtimeKey: null,
  entries: {},
  status: 'idle',

  load: async () => {
    const runtimeKey = getRuntimeKey();
    if (get().runtimeKey !== runtimeKey) resetForRuntime(runtimeKey);
    const generation = ++loadGeneration;
    const startRevision = revision;
    if (get().status !== 'ready') set({ status: 'loading' });
    try {
      const { sessions } = await piClient.getSessionShelf({ runtimeKey });
      if (generation !== loadGeneration || getRuntimeKey() !== runtimeKey) return;
      // Keep local changes made while the read was in flight.
      const current = get().entries;
      const next: Record<string, PiSessionShelfEntry> = { ...sessions };
      for (const [sessionId, at] of mutatedAt) {
        if (at <= startRevision) continue;
        if (current[sessionId]) next[sessionId] = current[sessionId];
        else delete next[sessionId];
      }
      set({ entries: next, status: 'ready' });
    } catch (error) {
      if (generation !== loadGeneration || getRuntimeKey() !== runtimeKey) return;
      set({ status: 'failed' });
      console.warn('[session-shelf] could not read the session shelf', error);
    }
  },

  update: async (sessionId, patch, directory) => {
    const runtimeKey = getRuntimeKey();
    if (get().runtimeKey !== runtimeKey) resetForRuntime(runtimeKey);
    const previous = get().entries[sessionId];
    const mine = ++revision;
    mutatedAt.set(sessionId, mine);
    set({ entries: withEntry(get().entries, sessionId, applyShelfPatch(previous, patch, Date.now())) });
    try {
      const entry = await piClient.setSessionShelf({ sessionId, ...patch }, { runtimeKey, ...(directory ? { directory } : {}) });
      if (getRuntimeKey() !== runtimeKey || mutatedAt.get(sessionId) !== mine) return;
      set({ entries: withEntry(get().entries, sessionId, entry) });
    } catch (error) {
      if (getRuntimeKey() === runtimeKey && mutatedAt.get(sessionId) === mine) {
        set({ entries: withEntry(get().entries, sessionId, previous) });
      }
      throw error;
    }
  },
}));
