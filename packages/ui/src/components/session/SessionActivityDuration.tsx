import React from 'react';
import { cn } from '@/lib/utils';
import { useDurationTickerNow } from '@/hooks/useDurationTicker';
import {
  useSessionActivityStartedAt,
  useSessionSettledDurationMs,
} from '@/sync/session-activity-timing';
import { formatSessionActivityDuration } from './sessionActivityDurationFormat';

/** One update per second: the readout is the animation, at 1 fps instead of 60. */
const TICK_MS = 1000;

/**
 * Elapsed time of a session's current turn, or of the turn that just finished.
 * Colored to match the row's status dot in each state, so the pair reads as one
 * indicator rather than two.
 *
 * Deliberately a leaf. The tick re-renders this span alone rather than the
 * session row around it, which is what makes a live counter cheaper than the
 * spinner it replaced — that spinner repainted a composited layer per row every
 * frame for as long as the session ran.
 */
export const SessionActivityDuration: React.FC<{
  sessionId: string;
  /** Turn still running (`busy` or `retry`); false renders the settled total. */
  running: boolean;
  className?: string;
}> = ({ sessionId, running, className }) => {
  const startedAt = useSessionActivityStartedAt(sessionId);
  const settledMs = useSessionSettledDurationMs(sessionId);
  const now = useDurationTickerNow(running, TICK_MS);

  const durationMs = running ? Math.max(0, now - (startedAt ?? now)) : settledMs;
  if (durationMs === undefined) return null;

  const label = formatSessionActivityDuration(durationMs);
  const description = running
    ? `Active for ${label}`
    : `Last turn took ${label}`;

  return (
    <span
      className={cn(
        'shrink-0 tabular-nums',
        // The readout wears its dot's color, so the row reads as one signal:
        // primary while the turn runs, info once it is waiting to be read.
        running ? 'text-primary' : 'text-[var(--status-info)]',
        className,
      )}
      aria-label={description}
      title={description}
    >
      {label}
    </span>
  );
};
