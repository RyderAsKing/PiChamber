import { afterEach, describe, expect, test } from 'bun:test';

import { isPerfHudEnabled, setPerfHudEnabled } from './perfFlags';
import { startPerfHudRuntime } from './perfHudRuntime';
import { getStreamPerfSnapshot, resetStreamPerf, streamPerfCount } from '@/stores/utils/streamDebug';
import {
  countSyncPerformance,
  getSyncPerformanceDiagnostics,
  setSyncPerformanceDiagnosticsEnabled,
} from '@/sync/performance-diagnostics';

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

const installWindow = () => {
  const storage = buildMemoryStorage();
  const originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window: unknown }).window = {
    localStorage: storage,
  };
  return {
    restore() {
      (globalThis as { window: unknown }).window = originalWindow;
    },
  };
};

describe('perf HUD counter gating', () => {
  afterEach(() => {
    setPerfHudEnabled(false);
    setSyncPerformanceDiagnosticsEnabled(false);
    resetStreamPerf();
  });

  test('HUD enablement records stream and sync counters without the CLI flags', () => {
    const env = installWindow();
    try {
      expect(isPerfHudEnabled()).toBe(false);
      streamPerfCount('ui.message_list.render');
      countSyncPerformance('reducerEvents');
      expect(getStreamPerfSnapshot().entries).toEqual([]);
      expect(getSyncPerformanceDiagnostics()).toBe(null);

      setPerfHudEnabled(true);
      streamPerfCount('ui.message_list.render');
      countSyncPerformance('reducerEvents');
      expect(getStreamPerfSnapshot().enabled).toBe(true);
      expect(getStreamPerfSnapshot().entries[0]?.metric).toBe('ui.message_list.render');
      expect(getSyncPerformanceDiagnostics()?.reducerEvents).toBe(1);
    } finally {
      env.restore();
    }
  });

  test('runtime stop cancels the frame loop', () => {
    let frames = 0;
    const pending = { callback: undefined as FrameRequestCallback | undefined };
    const runtime = startPerfHudRuntime(() => undefined, {
      now: () => 0,
      requestFrame: (callback) => {
        frames += 1;
        pending.callback = callback;
        return frames;
      },
      cancelFrame: () => {
        pending.callback = undefined;
      },
      observeLongTasks: () => () => undefined,
      readHeapUsedBytes: () => null,
      getStreamSnapshot: () => ({
        enabled: false,
        startedAt: null,
        lastUpdatedAt: null,
        durationMs: 0,
        entries: [],
      }),
      getSyncSnapshot: () => null,
      getSessionLoadEventCount: () => 0,
    });
    expect(frames).toBe(1);
    const scheduled = pending.callback;
    expect(scheduled).toBeDefined();
    runtime.stop();
    scheduled?.(0);
    expect(frames).toBe(1);
  });
});
