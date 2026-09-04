import React from 'react';
import { cn } from '@/lib/utils';

/* ─────────────────────────────────────────────────────────
 * Pixel-grid loader for long-running work (Dots variant).
 *
 * 3x3 chevron wavefront driving right; the 650ms cycle is
 * shorter than the sweep, so two fronts are always in flight.
 * Cells are circular (Dots). Grid animates opacity only
 * (compositor-friendly).
 *
 * Paired with a shimmering label and a live elapsed timer
 * in mono tabular figures when text is present. Sidebar rows
 * pass text={null} so they render the compact grid only with
 * no timer or re-renders. Reduced motion freezes the grid and label to
 * their static dim state; the timer still ticks.
 *
 * NOTE: the label shimmer animates background-position, which
 * is non-composited (see theme-system animation contract).
 * It is intentionally kept per request and is bounded to the
 * single main-chat status line; sidebar indicators render
 * grid-only with no shimmer.
 * ───────────────────────────────────────────────────────── */

const CHEVRON_DELAYS_MS: ReadonlyArray<number> = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3);
  const c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

const GRID_CYCLE_MS = 650;

function LoaderGrid({ compact = false }: { compact?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={
        compact
          ? "grid shrink-0 grid-cols-[repeat(3,3px)] gap-[1px]"
          : "grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]"
      }
    >
      {CHEVRON_DELAYS_MS.map((delay, index) => (
        <span
          key={index}
          className={compact
            ? "pixel-loader-cell size-[3px] rounded-full bg-current"
            : "pixel-loader-cell size-[4px] rounded-full bg-current"}
          style={{
            opacity: 0.15,
            animation: `pixel-on ${GRID_CYCLE_MS}ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}

function useElapsed(enabled: boolean, startedAt?: number | null) {
  const [tick, setTick] = React.useState(0);
  // Pinned origin: the authoritative turn start when provided, so remounts
  // (and background-throttled intervals) never reset or undercount — the
  // same contract as the tool-call timers. Falls back to mount time, which
  // preserves every existing caller that omits `startedAt`.
  const [mountAt] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setTick((d) => d + 1), 100);
    return () => clearInterval(t);
  }, [enabled]);
  void tick;
  const origin = startedAt ?? mountAt;
  const total = Math.max(0, (Date.now() - origin) / 1000);
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

export interface AgentThinkingLoaderProps {
  text?: string | null;
  className?: string;
  variant?: 'inline' | 'badge' | 'full';
  /** Deprecated: old braille-frame selector, ignored by the pixel-grid loader. */
  animationType?: 'spinner' | 'wave' | 'matrix';
  /** Deprecated: old frame interval, ignored (grid runs on CSS, timer on 100ms). */
  speedMs?: number;
  showText?: boolean;
  /** Show the live elapsed timer next to the label. Defaults to true when text is shown. */
  showElapsed?: boolean;
  /** Animate the label when a live phase replaces it. */
  animateText?: boolean;
  /**
   * Authoritative turn start (unix ms, local clock — see
   * `useSessionActivityStartedAt`). Pins the elapsed counter so remounts
   * continue it instead of restarting. Omitted callers keep mount-relative
   * timing exactly as before.
   */
  startedAt?: number | null;
}

export const AgentThinkingLoader: React.FC<AgentThinkingLoaderProps> = ({
  text = 'Thinking',
  className,
  variant = 'inline',
  showText = true,
  showElapsed = true,
  animateText = false,
  startedAt = null,
}) => {
  const hasText = showText && text != null && text !== '';
  const elapsed = useElapsed(hasText && showElapsed, startedAt);
  // Grid-only usages (sidebar rows) render compact so the 3x3 fits dense row
  // chrome; labeled usages (main chat) keep the full-size grid.

  const labelEl = hasText ? (
    <span
      key={animateText ? text : undefined}
      className={cn(
        'pixel-loader-label min-w-0 truncate whitespace-nowrap bg-clip-text typography-markdown font-medium text-transparent',
        animateText && 'agent-thinking-label-enter',
      )}
      style={{
        backgroundImage:
          'linear-gradient(90deg, var(--muted-foreground) 35%, var(--foreground) 50%, var(--muted-foreground) 65%)',
        backgroundSize: '200% 100%',
        animation: animateText ? undefined : 'shimmer-text 1.4s linear infinite',
      }}
    >
      {text}
    </span>
  ) : null;
  const elapsedEl =
    hasText && showElapsed ? (
      <span className="shrink-0 whitespace-nowrap font-mono typography-code text-muted-foreground tabular-nums">{elapsed}</span>
    ) : null;

  if (variant === 'badge') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-normal',
          'bg-primary/10 text-primary border border-primary/20',
          'transition-opacity duration-300',
          className,
        )}
        role="status"
        aria-live="polite"
      >
        <LoaderGrid compact={!hasText} />
        {labelEl}
        {elapsedEl}
      </span>
    );
  }

  if (variant === 'full') {
    return (
      <div
        className={cn(
          'flex items-center gap-2.5 rounded-lg border border-primary/25 bg-primary/5 px-3 py-1.5 text-sm text-foreground',
          className,
        )}
        role="status"
        aria-live="polite"
      >
        <LoaderGrid compact={!hasText} />
        {labelEl}
        {elapsedEl}
      </div>
    );
  }

  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-2.5', className)}
      role="status"
      aria-live="polite"
    >
      <LoaderGrid compact={!hasText} />
      {labelEl}
      {elapsedEl}
    </span>
  );
};
