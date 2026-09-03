import React from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { copyTextToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import {
  applyPerfHudQueryParamOnce,
  isPerfHudEnabled,
  setPerfHudEnabled,
  subscribePerfHudEnabled,
} from '@/lib/perf/perfFlags';
import { startPerfHudRuntime } from '@/lib/perf/perfHudRuntime';
import {
  formatHudNumber,
  PERF_HUD_FRAME_BUDGET_MS,
  PERF_HUD_LONG_FRAME_MS,
  type PerfHudSnapshot,
} from '@/lib/perf/perfHudStats';

declare global {
  interface Window {
    __pichamberPerfHud?: {
      setEnabled: (enabled: boolean) => void;
      isEnabled: () => boolean;
      getSnapshot: () => PerfHudSnapshot;
    };
  }
}

const emptySnapshot = (): PerfHudSnapshot => ({
  capturedAt: 0,
  fps: 0,
  frameMs: { last: 0, p95: 0 },
  longTasks: { count: 0, lastMs: 0, totalMs: 0 },
  heapUsedMb: null,
  stream: [],
  sync: [],
  sessionLoadEvents: 0,
});

let latestSnapshot: PerfHudSnapshot = emptySnapshot();

const usePerfHudEnabled = (): boolean => {
  return React.useSyncExternalStore(subscribePerfHudEnabled, isPerfHudEnabled, () => false);
};

const frameTone = (p95Ms: number): string => {
  if (p95Ms >= PERF_HUD_LONG_FRAME_MS) return 'var(--status-error)';
  if (p95Ms >= PERF_HUD_FRAME_BUDGET_MS) return 'var(--status-warning)';
  return 'var(--surface-foreground)';
};

const writeText = (node: HTMLElement | null, value: string): void => {
  if (node && node.textContent !== value) node.textContent = value;
};

const formatCounters = (snapshot: PerfHudSnapshot): string => {
  const rows = [
    ...snapshot.stream.map((entry) => `${entry.metric}  ${entry.value}`),
    ...snapshot.sync.map((entry) => `${entry.metric}  ${entry.value}`),
  ];
  if (snapshot.sessionLoadEvents > 0) {
    rows.push(`session-load.events  ${snapshot.sessionLoadEvents}`);
  }
  return rows.length > 0 ? rows.join('\n') : 'no counters yet';
};

const PERF_HUD_EDGE_MARGIN_PX = 8;

type PerfHudPosition = {
  left: number;
  top: number;
};

type PerfHudDrag = PerfHudPosition & {
  pointerId: number;
  offsetX: number;
  offsetY: number;
  originLeft: number;
  originTop: number;
  width: number;
  height: number;
};

const clampPerfHudPosition = (
  left: number,
  top: number,
  width: number,
  height: number,
): PerfHudPosition => {
  if (typeof window === 'undefined') return { left, top };

  const viewport = window.visualViewport;
  const viewportLeft = viewport?.offsetLeft ?? 0;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportWidth = viewport?.width || window.innerWidth;
  const viewportHeight = viewport?.height || window.innerHeight;
  const minLeft = viewportLeft + PERF_HUD_EDGE_MARGIN_PX;
  const minTop = viewportTop + PERF_HUD_EDGE_MARGIN_PX;
  const maxLeft = Math.max(minLeft, viewportLeft + viewportWidth - width - PERF_HUD_EDGE_MARGIN_PX);
  const maxTop = Math.max(minTop, viewportTop + viewportHeight - height - PERF_HUD_EDGE_MARGIN_PX);

  return {
    left: Math.round(Math.min(Math.max(left, minLeft), maxLeft)),
    top: Math.round(Math.min(Math.max(top, minTop), maxTop)),
  };
};

const applyPerfHudPosition = (panel: HTMLElement, position: PerfHudPosition): void => {
  panel.style.left = `${position.left}px`;
  panel.style.top = `${position.top}px`;
  panel.style.right = 'auto';
  panel.style.transform = 'none';
};

const PerfHudPanel: React.FC = () => {
  const [collapsed, setCollapsed] = React.useState(false);
  const [position, setPosition] = React.useState<PerfHudPosition | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const panelRef = React.useRef<HTMLElement>(null);
  const dragRef = React.useRef<PerfHudDrag | null>(null);
  const fpsRef = React.useRef<HTMLSpanElement>(null);
  const lastRef = React.useRef<HTMLSpanElement>(null);
  const p95Ref = React.useRef<HTMLSpanElement>(null);
  const longRef = React.useRef<HTMLSpanElement>(null);
  const heapRef = React.useRef<HTMLSpanElement>(null);
  const countersRef = React.useRef<HTMLPreElement>(null);
  const snapshotRef = React.useRef(latestSnapshot);

  const runtimeRef = React.useRef<ReturnType<typeof startPerfHudRuntime> | null>(null);

  const constrainPosition = React.useCallback((currentPosition: PerfHudPosition): void => {
    const panel = panelRef.current;
    if (!panel || dragRef.current) return;

    const rect = panel.getBoundingClientRect();
    const nextPosition = clampPerfHudPosition(
      currentPosition.left,
      currentPosition.top,
      rect.width,
      rect.height,
    );
    if (
      nextPosition.left === currentPosition.left &&
      nextPosition.top === currentPosition.top
    ) {
      return;
    }

    applyPerfHudPosition(panel, nextPosition);
    setPosition(nextPosition);
  }, []);

  React.useLayoutEffect(() => {
    if (position) constrainPosition(position);
  }, [collapsed, constrainPosition, position]);

  React.useEffect(() => {
    if (!position || typeof window === 'undefined') return;

    const handleViewportResize = (): void => {
      constrainPosition(position);
    };
    const viewport = window.visualViewport;
    window.addEventListener('resize', handleViewportResize);
    viewport?.addEventListener('resize', handleViewportResize);
    return () => {
      window.removeEventListener('resize', handleViewportResize);
      viewport?.removeEventListener('resize', handleViewportResize);
    };
  }, [constrainPosition, position]);

  const handlePointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || dragRef.current) return;
    const panel = panelRef.current;
    if (!panel) return;

    const rect = panel.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      originLeft: rect.left,
      originTop: rect.top,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    setIsDragging(true);
    event.preventDefault();
  }, []);

  const handlePointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const nextPosition = clampPerfHudPosition(
      event.clientX - drag.offsetX,
      event.clientY - drag.offsetY,
      drag.width,
      drag.height,
    );
    if (nextPosition.left === drag.left && nextPosition.top === drag.top) return;

    drag.left = nextPosition.left;
    drag.top = nextPosition.top;
    panelRef.current?.style.setProperty(
      'transform',
      `translate3d(${nextPosition.left - drag.originLeft}px, ${nextPosition.top - drag.originTop}px, 0)`,
    );
    if (event.cancelable) event.preventDefault();
  }, []);

  const finishPointer = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>, cancelled: boolean): void => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      const panel = panelRef.current;
      const rect = panel?.getBoundingClientRect();
      const finalPosition = cancelled
        ? { left: drag.originLeft, top: drag.originTop }
        : clampPerfHudPosition(
            event.clientX - drag.offsetX,
            event.clientY - drag.offsetY,
            rect?.width ?? drag.width,
            rect?.height ?? drag.height,
          );
      dragRef.current = null;
      if (panel) {
        if (cancelled) {
          panel.style.transform = 'none';
        } else {
          applyPerfHudPosition(panel, finalPosition);
        }
      }
      setIsDragging(false);
      if (!cancelled) setPosition(finalPosition);
      try {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      } catch {
        // ignore
      }
    },
    [],
  );

  React.useEffect(() => {
    return () => {
      dragRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const paint = (snapshot: PerfHudSnapshot): void => {
      latestSnapshot = snapshot;
      snapshotRef.current = snapshot;
      writeText(fpsRef.current, formatHudNumber(snapshot.fps, 0));
      writeText(lastRef.current, `${formatHudNumber(snapshot.frameMs.last)}ms`);
      writeText(p95Ref.current, `${formatHudNumber(snapshot.frameMs.p95)}ms`);
      if (p95Ref.current) p95Ref.current.style.color = frameTone(snapshot.frameMs.p95);
      writeText(
        longRef.current,
        `${snapshot.longTasks.count} / ${formatHudNumber(snapshot.longTasks.lastMs, 0)}ms`,
      );
      writeText(
        heapRef.current,
        snapshot.heapUsedMb == null ? '—' : `${formatHudNumber(snapshot.heapUsedMb, 0)}MB`,
      );
      writeText(countersRef.current, formatCounters(snapshot));
    };
    const runtime = startPerfHudRuntime(paint);
    runtimeRef.current = runtime;
    return () => {
      runtime.stop();
      runtimeRef.current = null;
    };
  }, []);

  const handleCopy = React.useCallback(() => {
    void copyTextToClipboard(`${JSON.stringify(snapshotRef.current, null, 2)}\n`);
  }, []);

  const handleReset = React.useCallback(() => {
    runtimeRef.current?.reset();
  }, []);

  return (
    <aside
      ref={panelRef}
      role="complementary"
      aria-label="Performance overlay"
      className="pointer-events-auto fixed z-[300] w-[18.5rem] max-w-[calc(100vw-1.5rem)] rounded-lg border border-border bg-[var(--surface-elevated)] text-foreground [contain:layout_style]"
      style={{
        ...(position
          ? {
              left: `${position.left}px`,
              top: `${position.top}px`,
              right: 'auto',
            }
          : {
              top: 'calc(0.5rem + env(safe-area-inset-top, 0px))',
              right: 'calc(0.5rem + env(safe-area-inset-right, 0px))',
            }),
        transform: 'none',
      }}
    >
      <div className="flex items-center gap-1 px-2 py-1">
        <div
          className={cn(
            'flex min-w-0 flex-1 cursor-grab touch-none select-none items-center gap-1',
            isDragging ? 'cursor-grabbing' : 'active:cursor-grabbing',
          )}
          title="Drag to move performance overlay"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={(event) => finishPointer(event, false)}
          onPointerCancel={(event) => finishPointer(event, true)}
          onLostPointerCapture={(event) => finishPointer(event, true)}
        >
          <Icon name="draggable" className="size-3.5 text-muted-foreground" />
          <p className="min-w-0 flex-1 typography-micro font-medium">Performance</p>
        </div>
        <Button
          variant="ghost"
          size="xs"
          aria-label="Copy performance snapshot"
          onClick={handleCopy}
        >
          <Icon name="file-copy" className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          aria-label="Reset performance counters"
          onClick={handleReset}
        >
          <Icon name="refresh" className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          aria-label={collapsed ? 'Expand performance overlay' : 'Collapse performance overlay'}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <Icon name={collapsed ? 'arrow-down-s' : 'arrow-up-s'} className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          aria-label="Turn off performance overlay"
          onClick={() => setPerfHudEnabled(false)}
        >
          <Icon name="close" className="size-3.5" />
        </Button>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-2 pb-2 font-mono typography-micro tabular-nums text-muted-foreground">
        <span>FPS</span>
        <span ref={fpsRef} className="text-right text-foreground">0</span>
        <span>Frame</span>
        <span ref={lastRef} className="text-right text-foreground">0.0ms</span>
        <span>p95</span>
        <span ref={p95Ref} className="text-right">0.0ms</span>
        <span>Long</span>
        <span ref={longRef} className="text-right text-foreground">0 / 0ms</span>
        <span>Heap</span>
        <span ref={heapRef} className="text-right text-foreground">—</span>
      </div>
      {collapsed ? null : (
        <pre
          ref={countersRef}
          className="max-h-40 overflow-auto border-t border-border px-2 py-1.5 font-mono typography-micro text-muted-foreground whitespace-pre-wrap"
        >
          no counters yet
        </pre>
      )}
    </aside>
  );
};

export const PerfHudHost: React.FC = () => {
  const enabled = usePerfHudEnabled();
  React.useLayoutEffect(() => {
    applyPerfHudQueryParamOnce();
  }, []);
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.__pichamberPerfHud = {
      setEnabled: setPerfHudEnabled,
      isEnabled: isPerfHudEnabled,
      getSnapshot: () => latestSnapshot,
    };
    return () => {
      delete window.__pichamberPerfHud;
    };
  }, []);
  if (!enabled || typeof document === 'undefined' || !document.body) return null;
  return createPortal(<PerfHudPanel />, document.body);
};
