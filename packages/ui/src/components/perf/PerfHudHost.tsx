import React from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { copyTextToClipboard } from '@/lib/clipboard';
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

const PerfHudPanel: React.FC = () => {
  const [collapsed, setCollapsed] = React.useState(false);
  const fpsRef = React.useRef<HTMLSpanElement>(null);
  const lastRef = React.useRef<HTMLSpanElement>(null);
  const p95Ref = React.useRef<HTMLSpanElement>(null);
  const longRef = React.useRef<HTMLSpanElement>(null);
  const heapRef = React.useRef<HTMLSpanElement>(null);
  const countersRef = React.useRef<HTMLPreElement>(null);
  const snapshotRef = React.useRef(latestSnapshot);

  const runtimeRef = React.useRef<ReturnType<typeof startPerfHudRuntime> | null>(null);

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
      role="complementary"
      aria-label="Performance overlay"
      className="pointer-events-auto fixed z-[300] w-[18.5rem] max-w-[calc(100vw-1.5rem)] rounded-lg border border-border bg-[var(--surface-elevated)] text-foreground [contain:layout_style]"
      style={{
        top: 'calc(0.5rem + env(safe-area-inset-top, 0px))',
        right: 'calc(0.5rem + env(safe-area-inset-right, 0px))',
      }}
    >
      <div className="flex items-center gap-1 px-2 py-1">
        <p className="min-w-0 flex-1 typography-micro font-medium">Performance</p>
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
