const PERF_HUD_STORAGE_KEY = 'pichamber_perf_hud';

type PerfHudListener = () => void;

const listeners = new Set<PerfHudListener>();

const readStoredHudEnabled = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(PERF_HUD_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

let hudEnabled = readStoredHudEnabled();
let queryParamApplied = false;

const notify = (): void => {
  for (const listener of listeners) listener();
};

export const getPerfHudStorageKey = (): string => PERF_HUD_STORAGE_KEY;

export const isPerfHudEnabled = (): boolean => hudEnabled;

export const subscribePerfHudEnabled = (listener: PerfHudListener): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const setPerfHudEnabled = (enabled: boolean): void => {
  const changed = hudEnabled !== enabled;
  hudEnabled = enabled;
  if (typeof window !== 'undefined') {
    try {
      if (enabled) window.localStorage.setItem(PERF_HUD_STORAGE_KEY, '1');
      else window.localStorage.removeItem(PERF_HUD_STORAGE_KEY);
    } catch {
      // ignore storage failures in diagnostics helper
    }
  }
  if (changed) notify();
};

export const applyPerfHudQueryParam = (search?: string): boolean => {
  if (typeof window === 'undefined' && search === undefined) return false;
  const params = new URLSearchParams(search ?? window.location.search);
  const value = params.get('perf');
  if (value === '1') {
    setPerfHudEnabled(true);
    return true;
  }
  if (value === '0') {
    setPerfHudEnabled(false);
    return true;
  }
  return false;
};

export const applyPerfHudQueryParamOnce = (search?: string): boolean => {
  if (queryParamApplied) return false;
  queryParamApplied = true;
  return applyPerfHudQueryParam(search);
};

export const resetPerfHudQueryParamGate = (): void => {
  queryParamApplied = false;
};
