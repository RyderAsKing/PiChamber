export const formatTurnDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0.1, durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
};
