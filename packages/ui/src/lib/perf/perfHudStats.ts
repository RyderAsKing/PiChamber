const PERF_HUD_SAMPLE_WINDOW_MS = 1_000;
const PERF_HUD_TOP_COUNTERS = 6;
export const PERF_HUD_FRAME_BUDGET_MS = 16.7;
export const PERF_HUD_LONG_FRAME_MS = 50;

type FrameStatsSnapshot = {
  fps: number;
  lastMs: number;
  p95Ms: number;
  samples: number;
};

export type PerfHudCounter = {
  metric: string;
  value: number;
};

type PerfHudVitals = {
  fps: number;
  frameMs: { last: number; p95: number };
  longTasks: { count: number; lastMs: number; totalMs: number };
  heapUsedMb: number | null;
};

export type PerfHudSnapshot = PerfHudVitals & {
  capturedAt: number;
  stream: PerfHudCounter[];
  sync: PerfHudCounter[];
  sessionLoadEvents: number;
};

export const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? 0;
};

export const createFrameStats = (windowMs = PERF_HUD_SAMPLE_WINDOW_MS) => {
  const times: number[] = [];
  const deltas: number[] = [];
  let lastTime = 0;
  let hasLast = false;

  const trim = (now: number): void => {
    const cutoff = now - windowMs;
    while (times.length > 0 && (times[0] ?? 0) < cutoff) {
      times.shift();
      deltas.shift();
    }
  };

  return {
    reset(): void {
      times.length = 0;
      deltas.length = 0;
      lastTime = 0;
      hasLast = false;
    },
    sample(now: number): void {
      if (hasLast) {
        times.push(now);
        deltas.push(now - lastTime);
        trim(now);
      }
      lastTime = now;
      hasLast = true;
    },
    snapshot(): FrameStatsSnapshot {
      if (deltas.length === 0 || times.length < 1) {
        return { fps: 0, lastMs: 0, p95Ms: 0, samples: 0 };
      }
      const span = (times[times.length - 1] ?? 0) - (times[0] ?? 0);
      const fps = span > 0 ? (1000 * (times.length - 1)) / span : 0;
      return {
        fps,
        lastMs: deltas[deltas.length - 1] ?? 0,
        p95Ms: percentile(deltas, 95),
        samples: deltas.length,
      };
    },
  };
};

export const selectTopCounters = (
  entries: ReadonlyArray<{ metric: string; value: number }>,
  limit = PERF_HUD_TOP_COUNTERS,
): PerfHudCounter[] => {
  return entries
    .filter((entry) => entry.value > 0 && Number.isFinite(entry.value))
    .sort((a, b) => b.value - a.value || a.metric.localeCompare(b.metric))
    .slice(0, limit)
    .map((entry) => ({ metric: entry.metric, value: entry.value }));
};

export const formatHudNumber = (value: number, digits = 1): string => {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
};

export const heapBytesToMb = (bytes: number | null | undefined): number | null => {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  return bytes / (1024 * 1024);
};
