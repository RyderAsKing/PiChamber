/**
 * UI-owned navigation state for conversation revert.
 *
 * Pi's `navigateTree` moves the active leaf only (in-memory until next
 * append). The server returns `navigation` metadata; the client keeps a
 * small ephemeral record so the dock, redo, and composer can work without
 * depending on the legacy `session.revert.messageID` contract (which the
 * Pi path never sets) and without comparing random entry IDs via `<` / `>`.
 *
 * Keyed by `runtimeKey:sessionId` so a runtime switch or session deletion
 * clears the right scope. Fetch failure must not synthesize an empty
 * abandoned branch.
 */

import { create } from 'zustand';

import type { PiNavigationMeta } from '@/lib/pi/protocol';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

export type RevertAbandonedRecord = {
  id: string;
  role: 'user' | 'assistant';
  /** Single-line text preview for the dock. */
  preview: string;
};

export type RevertNavigationEntry = {
  sessionId: string;
  runtimeKey: string;
  targetEntryId: string;
  previousLeafId: string | null;
  newLeafId: string | null;
  editorText?: string;
  abandoned: RevertAbandonedRecord[];
  createdAt: number;
};

type RevertNavigationStoreState = {
  byKey: Map<string, RevertNavigationEntry>;
  setEntry: (entry: RevertNavigationEntry) => void;
  clearForSession: (sessionId: string) => void;
  clearAll: () => void;
  clearForRuntime: (runtimeKey: string) => void;
};

const makeKey = (runtimeKey: string, sessionId: string): string => `${runtimeKey}::${sessionId}`;

export const useRevertNavigationStore = create<RevertNavigationStoreState>((set) => ({
  byKey: new Map(),

  setEntry: (entry) =>
    set((state) => {
      const next = new Map(state.byKey);
      next.set(makeKey(entry.runtimeKey, entry.sessionId), entry);
      return { byKey: next };
    }),

  clearForSession: (sessionId) =>
    set((state) => {
      const next = new Map(state.byKey);
      let changed = false;
      for (const key of next.keys()) {
        if (key.endsWith(`::${sessionId}`)) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? { byKey: next } : state;
    }),

  clearAll: () => set({ byKey: new Map() }),

  clearForRuntime: (runtimeKey) =>
    set((state) => {
      const prefix = `${runtimeKey}::`;
      const next = new Map(state.byKey);
      let changed = false;
      for (const key of next.keys()) {
        if (key.startsWith(prefix)) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? { byKey: next } : state;
    }),
}));

// Wire runtime switches to clearing stale keys. The subscription is
// established once at module import time — the store is global.
if (typeof window !== 'undefined') {
  subscribeRuntimeEndpointChanged((detail) => {
    if (detail.runtimeKey !== detail.previousRuntimeKey && detail.previousRuntimeKey) {
      useRevertNavigationStore.getState().clearForRuntime(detail.previousRuntimeKey);
    }
    // If runtimeKey changed to a new value, old entries keyed under the
    // previous key are already cleared; entries for the new runtime remain
    // (none yet) — no extra work.
  });
}

export const setRevertNavigation = (
  sessionId: string,
  navigation: PiNavigationMeta,
  abandoned: RevertAbandonedRecord[],
): void => {
  const runtimeKey = getRuntimeKey();
  useRevertNavigationStore.getState().setEntry({
    sessionId,
    runtimeKey,
    targetEntryId: navigation.targetEntryId,
    previousLeafId: navigation.previousLeafId,
    newLeafId: navigation.newLeafId,
    ...(navigation.editorText !== undefined ? { editorText: navigation.editorText } : {}),
    abandoned,
    createdAt: Date.now(),
  });
};

export const clearRevertNavigation = (sessionId: string): void => {
  useRevertNavigationStore.getState().clearForSession(sessionId);
};

export const clearAllRevertNavigations = (): void => {
  useRevertNavigationStore.getState().clearAll();
};

export const getRevertNavigation = (sessionId: string): RevertNavigationEntry | undefined => {
  const runtimeKey = getRuntimeKey();
  return useRevertNavigationStore.getState().byKey.get(makeKey(runtimeKey, sessionId));
};

export const getRevertNavigationForRuntime = (
  sessionId: string,
  runtimeKey: string,
): RevertNavigationEntry | undefined => {
  return useRevertNavigationStore.getState().byKey.get(makeKey(runtimeKey, sessionId));
};

/** Hook that subscribes to the entry for `sessionId` on the current runtime. */
export const useRevertNavigation = (sessionId: string | null): RevertNavigationEntry | undefined => {
  return useRevertNavigationStore((state) => {
    if (!sessionId) return undefined;
    return state.byKey.get(makeKey(getRuntimeKey(), sessionId));
  });
};
