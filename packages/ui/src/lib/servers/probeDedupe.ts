/**
 * Shared per-host probe deduper: concurrent probe cycles (the switcher and
 * the servers page both probe on open) share one in-flight probe per host
 * instead of firing parallel probes. No polling lives here — callers keep
 * their existing probe-on-open cadence; this only collapses overlap.
 */

export type ProbeDeduper = <T>(key: string, run: () => Promise<T>) => Promise<T>;

export const createProbeDeduper = (): ProbeDeduper => {
  const inflight = new Map<string, Promise<unknown>>();
  return <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const existing = inflight.get(key);
    if (existing) return existing as Promise<T>;
    const task = run().finally(() => {
      if (inflight.get(key) === task) inflight.delete(key);
    });
    inflight.set(key, task);
    return task;
  };
};

/** Process-wide deduper shared by every desktop server surface. */
export const sharedProbeDeduper = createProbeDeduper();
