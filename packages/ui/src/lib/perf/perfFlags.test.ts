import { afterEach, describe, expect, test } from 'bun:test';

import {
  applyPerfHudQueryParam,
  applyPerfHudQueryParamOnce,
  getPerfHudStorageKey,
  isPerfHudEnabled,
  resetPerfHudQueryParamGate,
  setPerfHudEnabled,
} from './perfFlags';

const buildMemoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => map.clear(),
  };
};

const installWindow = (search = '') => {
  const storage = buildMemoryStorage();
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window: unknown }).window = {
    localStorage: storage,
    location: { search },
  };
  return {
    storage,
    restore() {
      (globalThis as { window: unknown }).window = originalWindow;
    },
  };
};

describe('perfFlags', () => {
  afterEach(() => {
    setPerfHudEnabled(false);
    resetPerfHudQueryParamGate();
  });

  test('persists the HUD flag in localStorage without touching other keys', () => {
    const env = installWindow();
    try {
      setPerfHudEnabled(true);
      expect(isPerfHudEnabled()).toBe(true);
      expect(env.storage.getItem(getPerfHudStorageKey())).toBe('1');
      expect(env.storage.getItem('pichamber_stream_perf')).toBe(null);

      setPerfHudEnabled(false);
      expect(isPerfHudEnabled()).toBe(false);
      expect(env.storage.getItem(getPerfHudStorageKey())).toBe(null);
    } finally {
      env.restore();
    }
  });

  test('applies ?perf=1 and ?perf=0', () => {
    const env = installWindow();
    try {
      expect(applyPerfHudQueryParam('?perf=1')).toBe(true);
      expect(isPerfHudEnabled()).toBe(true);
      expect(applyPerfHudQueryParam('?tab=chat&perf=0')).toBe(true);
      expect(isPerfHudEnabled()).toBe(false);
      expect(applyPerfHudQueryParam('?tab=chat')).toBe(false);
    } finally {
      env.restore();
    }
  });

  test('applies the query param only once per page load', () => {
    const env = installWindow();
    try {
      expect(applyPerfHudQueryParamOnce('?perf=1')).toBe(true);
      setPerfHudEnabled(false);
      expect(applyPerfHudQueryParamOnce('?perf=1')).toBe(false);
      expect(isPerfHudEnabled()).toBe(false);
    } finally {
      env.restore();
    }
  });
});
