export const resolveTurnDurationMs = ({
  startedAt,
  completedAt,
  durationMs,
}: {
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}): number | null => {
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
    return durationMs;
  }

  if (
    typeof startedAt === 'number'
    && typeof completedAt === 'number'
    && Number.isFinite(startedAt)
    && Number.isFinite(completedAt)
    && completedAt >= startedAt
  ) {
    return completedAt - startedAt;
  }

  return null;
};

export const formatTurnDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0.1, durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
};
