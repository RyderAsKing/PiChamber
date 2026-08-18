import { getStreamPerfSnapshot, resetStreamPerf } from '@/stores/utils/streamDebug';
import {
  getSyncPerformanceDiagnostics,
  resetSyncPerformanceDiagnostics,
} from '@/sync/performance-diagnostics';
import {
  getSessionLoadPerformanceEventCount,
  resetSessionLoadPerformanceEvents,
} from '@/sync/session-load-performance';
import {
  createFrameStats,
  heapBytesToMb,
  selectTopCounters,
  type PerfHudSnapshot,
} from './perfHudStats';

const PERF_HUD_UPDATE_MS = 250;

type MemoryPerformance = Performance & {
  memory?: { usedJSHeapSize: number };
};

type PerfHudRuntimeDeps = {
  now?: () => number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
  observeLongTasks?: (onLongTask: (durationMs: number) => void) => () => void;
  readHeapUsedBytes?: () => number | null;
  getStreamSnapshot?: typeof getStreamPerfSnapshot;
  getSyncSnapshot?: typeof getSyncPerformanceDiagnostics;
  getSessionLoadEventCount?: typeof getSessionLoadPerformanceEventCount;
};

const defaultNow = (): number => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

const defaultReadHeapUsedBytes = (): number | null => {
  if (typeof performance === 'undefined') return null;
  const used = (performance as MemoryPerformance).memory?.usedJSHeapSize;
  return typeof used === 'number' && Number.isFinite(used) ? used : null;
};

const defaultObserveLongTasks = (onLongTask: (durationMs: number) => void): (() => void) => {
  if (typeof PerformanceObserver === 'undefined') return () => undefined;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (typeof entry.duration === 'number' && entry.duration > 0) {
          onLongTask(entry.duration);
        }
      }
    });
    observer.observe({ type: 'longtask', buffered: true });
    return () => observer.disconnect();
  } catch {
    return () => undefined;
  }
};

export const buildPerfHudSnapshot = (
  vitals: Omit<PerfHudSnapshot, 'capturedAt' | 'stream' | 'sync' | 'sessionLoadEvents'>,
  deps: Pick<PerfHudRuntimeDeps, 'getStreamSnapshot' | 'getSyncSnapshot' | 'getSessionLoadEventCount'> = {},
): PerfHudSnapshot => {
  const streamSnapshot = (deps.getStreamSnapshot ?? getStreamPerfSnapshot)();
  const syncSnapshot = (deps.getSyncSnapshot ?? getSyncPerformanceDiagnostics)();
  const sessionLoadEvents = (deps.getSessionLoadEventCount ?? getSessionLoadPerformanceEventCount)();

  const stream = selectTopCounters(
    streamSnapshot.entries.map((entry) => ({ metric: entry.metric, value: entry.count })),
  );
  const sync = selectTopCounters(
    Object.entries(syncSnapshot ?? {}).map(([metric, value]) => ({
      metric: `sync.${metric}`,
      value: typeof value === 'number' ? value : 0,
    })),
  );

  return {
    ...vitals,
    capturedAt: Date.now(),
    stream,
    sync,
    sessionLoadEvents,
  };
};

type PerfHudRuntimeHandle = {
  stop: () => void;
  reset: () => void;
};

export const startPerfHudRuntime = (
  onUpdate: (snapshot: PerfHudSnapshot) => void,
  deps: PerfHudRuntimeDeps = {},
): PerfHudRuntimeHandle => {
  const now = deps.now ?? defaultNow;
  const requestFrame = deps.requestFrame ?? ((callback) => window.requestAnimationFrame(callback));
  const cancelFrame = deps.cancelFrame ?? ((id) => window.cancelAnimationFrame(id));
  const observeLongTasks = deps.observeLongTasks ?? defaultObserveLongTasks;
  const readHeapUsedBytes = deps.readHeapUsedBytes ?? defaultReadHeapUsedBytes;
  const frames = createFrameStats();
  let longTaskCount = 0;
  let lastLongTaskMs = 0;
  let longTaskTotalMs = 0;
  let lastPublishAt = 0;
  let frameId = 0;
  let stopped = false;

  const stopLongTasks = observeLongTasks((durationMs) => {
    longTaskCount += 1;
    lastLongTaskMs = durationMs;
    longTaskTotalMs += durationMs;
  });

  const publish = (at: number): void => {
    const frame = frames.snapshot();
    onUpdate(buildPerfHudSnapshot({
      fps: frame.fps,
      frameMs: { last: frame.lastMs, p95: frame.p95Ms },
      longTasks: { count: longTaskCount, lastMs: lastLongTaskMs, totalMs: longTaskTotalMs },
      heapUsedMb: heapBytesToMb(readHeapUsedBytes()),
    }, deps));
    lastPublishAt = at;
  };

  const tick = (timestamp: number): void => {
    if (stopped) return;
    const at = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : now();
    frames.sample(at);
    if (lastPublishAt === 0 || at - lastPublishAt >= PERF_HUD_UPDATE_MS) {
      publish(at);
    }
    frameId = requestFrame(tick);
  };

  frameId = requestFrame(tick);

  return {
    stop() {
      stopped = true;
      cancelFrame(frameId);
      stopLongTasks();
      frames.reset();
    },
    reset() {
      frames.reset();
      longTaskCount = 0;
      lastLongTaskMs = 0;
      longTaskTotalMs = 0;
      resetPerfHudCounters();
      publish(now());
    },
  };
};

const resetPerfHudCounters = (): void => {
  resetStreamPerf();
  resetSyncPerformanceDiagnostics();
  resetSessionLoadPerformanceEvents();
};
