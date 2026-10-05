import { useUIStore } from '@/stores/useUIStore';
import { flushPendingSettings, updateDesktopSettings } from '@/lib/persistence';
import type { DesktopSettings } from '@/lib/desktop';
import {
  areModelRefsEqual,
  areRecentEffortsEqual,
  areStringArraysEqual,
} from '@/lib/persistence/settingsEquality';

type ModelPrefsSlice = Pick<
  DesktopSettings,
  'favoriteModels' | 'hiddenModels' | 'collapsedModelProviders' | 'recentModels' | 'recentAgents' | 'recentEfforts'
>;

type UIState = ReturnType<typeof useUIStore.getState>;

// Only fields that changed are written. The server replaces each field it
// receives, so sending the whole slice whenever one field changed (for
// example `recentModels` after a send) let a window holding an older copy of
// `hiddenModels` or `favoriteModels` overwrite newer preferences saved by
// another client. Writes go straight to `updateDesktopSettings`, which owns
// debouncing, runtime-owner draining, and the pending-write guard that keeps
// `refreshDesktopSettings` from reverting a change that has not been sent.
const diffModelPrefs = (state: UIState, prevState: UIState): ModelPrefsSlice => {
  const diff: ModelPrefsSlice = {};
  if (!areModelRefsEqual(state.favoriteModels, prevState.favoriteModels)) {
    diff.favoriteModels = state.favoriteModels;
  }
  if (!areModelRefsEqual(state.hiddenModels, prevState.hiddenModels)) {
    diff.hiddenModels = state.hiddenModels;
  }
  if (!areStringArraysEqual(state.collapsedModelProviders, prevState.collapsedModelProviders)) {
    diff.collapsedModelProviders = state.collapsedModelProviders;
  }
  if (!areModelRefsEqual(state.recentModels, prevState.recentModels)) {
    diff.recentModels = state.recentModels;
  }
  if (!areStringArraysEqual(state.recentAgents, prevState.recentAgents)) {
    diff.recentAgents = state.recentAgents;
  }
  if (!areRecentEffortsEqual(state.recentEfforts, prevState.recentEfforts)) {
    diff.recentEfforts = state.recentEfforts;
  }
  return diff;
};

export const startModelPrefsAutoSave = () => {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const unsubscribe = useUIStore.subscribe((state, prevState) => {
    const diff = diffModelPrefs(state, prevState);
    if (Object.keys(diff).length === 0) {
      return;
    }
    void updateDesktopSettings(diff).catch(() => {});
  });

  return () => {
    unsubscribe();
    flushPendingSettings();
  };
};
