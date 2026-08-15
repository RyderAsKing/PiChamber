const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Compact turn duration for a session row: `7s`, `1m 23s`, `1h 2m`.
 *
 * Seconds are dropped past an hour so the label cannot outgrow the row's
 * metadata slot, and the unit suffixes are translated rather than concatenated
 * so locales that place or spell them differently stay correct.
 */
export const formatSessionActivityDuration = (durationMs: number): string => {
  const total = Math.max(0, durationMs);

  if (total < MINUTE_MS) {
    return `${Math.floor(total / SECOND_MS)}s`;
  }
  if (total < HOUR_MS) {
    return `${Math.floor(total / MINUTE_MS)}m ${Math.floor((total % MINUTE_MS) / SECOND_MS)}s`;
  }
  return `${Math.floor(total / HOUR_MS)}h ${Math.floor((total % HOUR_MS) / MINUTE_MS)}m`;
};
