import * as React from 'react';

import { AnsiLink, AnsiText } from '@/components/chat/AnsiText';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { parseAnsiSegments, renderSegmentStyle, safeHyperlink } from '@/lib/pi/ansi';
import type { PiExtensionSurfaceLineCells } from '@/lib/pi/protocol';
import type { PiExtensionSurfaceState } from '@/lib/pi/reducers/customSurfaceReducers';
import { bracketedPaste, encodeTerminalKey } from '@/lib/pi/terminal-keys';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { useSessionRunningCommand } from '@/sync/sync-context';
import { abortCurrentOperation } from '@/sync/session-actions';
import { cn } from '@/lib/utils';
import { useDeviceInfo } from '@/lib/device';
import {
  MAX_SURFACE_INPUT_CHARS,
  claimSurfaceSize,
  closeSurface,
  closedElsewhere,
  focusSurface,
  refreshSurface,
  reportSurfaceViewport,
  resetSurfaceViewport,
  sendSurfaceInput,
} from './surfaceTransport';
import {
  NO_STACK_ANCHORS,
  groupPanels,
  isShownOverlay,
  nextStackAnchors,
  panelLabel,
  titleTabSpot,
  type OverlayStackGroup,
  type StackAnchor,
} from './overlayStacks';
import { SurfaceKeyBar } from './SurfaceKeyBar';
import { fitScale, useBoxMetrics } from './useFitScale';
import { useSurfacePointer } from './useSurfacePointer';
import { blockRunStyle, hasBlocks, isBlockRun, splitBlockRuns } from './blockGlyphs';

/**
 * Pi `ctx.ui.custom()` surfaces in the chat pane (plan: docs/plans/pi-extension-custom.md).
 *
 * - Inline surfaces take the composer's place, as Pi swaps its editor for the
 *   component. The chat input stays mounted, hidden, so its draft survives.
 * - Overlays sit where Pi's own layout puts them on a "screen" the size of the
 *   chat pane, so edge-anchored panels use the space beside the chat column on
 *   wide windows and overlap it on narrow ones.
 * - Only an overlay that owns the keyboard dims the pane.
 * - Two or more panels one command opened with `tui.showOverlay` share one
 *   tab stack at the front panel's Pi position; a tab focuses its panel.
 *
 * The daemon renders; this file draws lines on a fixed cell grid and sends keys.
 */

const LINE_HEIGHT = 18;
/** Inset of the overlay screen inside the chat pane, in px. */
const SCREEN_PAD = 12;
/** Horizontal padding of the inline card body (px-3 on each side). */
const INLINE_PAD_X = 24;
/** Rows a touch screen keeps free under overlays for the key bar. */
const KEY_BAR_ROWS = 3;
const MONO = 'font-mono text-[13px] leading-[18px] [font-variant-ligatures:none]';

const EMPTY: PiExtensionSurfaceState[] = [];

/** The session's surfaces in the order they opened. */
const useSessionSurfaceMap = (sessionId: string | null | undefined) => usePiSessionSnapshot(
  (state) => (sessionId ? state.reducer.bySession.get(sessionId)?.extensionSurfaces : undefined),
  Object.is,
  sessionId ? `session:${sessionId}` : '*',
  sessionId ?? '',
);

const useSessionSurfaces = (sessionId: string | null | undefined): PiExtensionSurfaceState[] => {
  const surfaces = useSessionSurfaceMap(sessionId);
  return React.useMemo(
    () => (surfaces ? [...surfaces.values()].sort((a, b) => a.z - b.z) : EMPTY),
    [surfaces],
  );
};

/** An agent turn is running (a command running on its own is not one: Stop cannot end it). */
const useSessionBusy = (sessionId: string): boolean => usePiSessionSnapshot(
  (state) => {
    const session = state.reducer.bySession.get(sessionId);
    return (session?.lifecycle === 'busy' && !session.runningCommand) || session?.lifecycle === 'retry';
  },
  Object.is,
  `session:${sessionId}`,
  sessionId,
);

const focusSurfaceElement = (surfaceId: string): void => {
  document.querySelector<HTMLElement>(`[data-extension-surface="${CSS.escape(surfaceId)}"]`)?.focus({ preventScroll: true });
};

/** Hands focus back to the composer when it went nowhere (the focused surface unmounted). */
const focusComposerIfOrphaned = (): void => {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    // A leaving overlay (aria-hidden while it animates out) still holds focus.
    if (active && active !== document.body && !active.closest('[aria-hidden="true"]')) return;
    document
      .querySelector<HTMLElement>('[data-chat-input="true"] [contenteditable="true"], .chat-input-column textarea')
      ?.focus();
  });
};

// ------------------------------------------------------------------ lines

const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

/**
 * One terminal line on a fixed cell grid. Graphemes Pi counts as two cells
 * (emoji, CJK) get a 2ch box and zero-width ones none, so borders after them
 * stay aligned whatever width the font draws them at. Block elements
 * (`▀▄█`) fill their cells as in a terminal (`blockGlyphs.ts`).
 */
const CellLine: React.FC<{ line: string; cells: PiExtensionSurfaceLineCells | undefined }> = React.memo(({ line, cells }) => {
  if (line === '') return ' ';
  const grid = cells && graphemes ? cells : undefined;
  if (!grid && !hasBlocks(line)) return <AnsiText text={line} links />;
  let index = 0;
  return (
    <>
      {parseAnsiSegments(line).map((segment, segmentIndex) => {
        const style = renderSegmentStyle(segment);
        const href = safeHyperlink(segment.href);
        // One block element in one colour (each of pi-doom's cells): the
        // segment's own span draws the fill.
        if (!href && isBlockRun(segment.text)) {
          index += segment.text.length;
          return <span key={segmentIndex} style={blockRunStyle(segment.text, style, LINE_HEIGHT)}>{segment.text}</span>;
        }
        const parts: React.ReactNode[] = [];
        const pushText = (text: string) => {
          for (const run of splitBlockRuns(text)) {
            parts.push(run.block
              ? <span key={`block-${parts.length}`} style={blockRunStyle(run.text, style, LINE_HEIGHT)}>{run.text}</span>
              : run.text);
          }
        };
        if (!grid || !graphemes) {
          pushText(segment.text);
        } else {
          let run = '';
          for (const { segment: grapheme } of graphemes.segment(segment.text)) {
            const width = grid[index++] ?? 1;
            if (width === 1) {
              run += grapheme;
              continue;
            }
            if (run) pushText(run);
            run = '';
            parts.push(
              <span
                key={index}
                className="inline-block overflow-hidden text-center align-top"
                style={{ width: `${width}ch`, height: LINE_HEIGHT }}
              >
                {width === 0 ? null : grapheme}
              </span>,
            );
          }
          if (run) pushText(run);
        }
        if (href) return <AnsiLink key={segmentIndex} segment={segment} href={href}>{parts}</AnsiLink>;
        return (
          <span key={segmentIndex} style={style}>
            {parts}
          </span>
        );
      })}
    </>
  );
});
CellLine.displayName = 'CellLine';

const TerminalLines: React.FC<{
  sessionId: string;
  surface: PiExtensionSurfaceState;
  /** Leave swipes to the browser: the box around the lines scrolls. */
  nativeTouchScroll?: boolean;
  /** CSS zoom this surface is drawn at (`fitScale`), here or on an ancestor. */
  scale?: number;
  /** Apply `scale` on this element (inline); overlays zoom their whole box. */
  zoomSelf?: boolean;
}> = ({ sessionId, surface, nativeTouchScroll = false, scale = 1, zoomSelf = false }) => {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const probe = React.useRef<HTMLSpanElement | null>(null);
  const frame = surface.frame;
  // A non-capturing overlay takes keys while it holds focus (it called
  // `handle.focus()`), as in Pi; otherwise it is view-only.
  const interactive = surface.capturing || surface.focused;
  const pointer = useSurfacePointer({
    ref,
    measureCell: () => (probe.current?.getBoundingClientRect().width ?? 0) / 10,
    columns: frame?.columns ?? 0,
    rows: frame?.lines.length ?? 0,
    lineHeight: LINE_HEIGHT * scale,
    nativeTouchScroll,
    send: (item) => sendSurfaceInput(sessionId, surface.surfaceId, [item]),
    onPress: () => {
      if (interactive) ref.current?.focus({ preventScroll: true });
    },
  });

  // The daemon moves key focus (open, close, a nested overlay); follow it.
  React.useEffect(() => {
    if (!surface.focused || !interactive || !ref.current) return;
    if (ref.current.contains(document.activeElement)) return;
    // Arrowing through a tab stack moves the daemon's focus; keep the tab.
    if (document.activeElement?.closest('[data-extension-tabs]')) return;
    ref.current.focus({ preventScroll: true });
  }, [surface.focused, interactive]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'c' && (window.getSelection()?.toString() ?? '') !== '') return;
    if (mod && event.key.toLowerCase() === 'v') return; // onPaste
    const data = encodeTerminalKey(event);
    if (data === null) return;
    event.preventDefault();
    event.stopPropagation();
    sendSurfaceInput(sessionId, surface.surfaceId, [data]);
  };

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    const item = bracketedPaste(text);
    if (item.length > MAX_SURFACE_INPUT_CHARS) {
      toast.error('That paste is too long for the extension (64 KB at most).');
      return;
    }
    sendSurfaceInput(sessionId, surface.surfaceId, [item]);
  };

  return (
    <div
      ref={ref}
      data-extension-surface={surface.surfaceId}
      role="application"
      aria-label={`Extension: ${surface.title}`}
      tabIndex={interactive ? 0 : -1}
      onKeyDown={interactive ? onKeyDown : undefined}
      onPaste={interactive ? onPaste : undefined}
      onPointerDown={(event) => {
        // A tap or click makes this device's width the one the extension draws at.
        claimSurfaceSize(sessionId);
        pointer.onPointerDown(event);
      }}
      onPointerMove={pointer.onPointerMove}
      onPointerUp={pointer.onPointerUp}
      onPointerCancel={pointer.onPointerCancel}
      onMouseDown={pointer.onMouseDown}
      style={{ touchAction: pointer.touchAction, ...(zoomSelf && scale !== 1 ? { zoom: scale } : {}) }}
      className={cn('relative whitespace-pre text-foreground outline-none', MONO)}
    >
      <span ref={probe} aria-hidden className="invisible absolute left-0 top-0">0000000000</span>
      {(frame?.lines ?? []).map((line, index) => (
        <div key={index} style={{ height: LINE_HEIGHT }}>
          <CellLine line={line} cells={frame?.cells[index]} />
        </div>
      ))}
      {frame?.cursor && surface.focused ? (
        <span
          aria-hidden
          className="pointer-events-none absolute bg-foreground/70"
          style={{
            left: `${frame.cursor.col}ch`,
            top: frame.cursor.row * LINE_HEIGHT + 1,
            width: '1ch',
            height: LINE_HEIGHT - 2,
          }}
        />
      ) : null}
    </div>
  );
};

/**
 * Presses Esc for the extension, Pi's key for closing. It does what Esc does
 * in Pi's terminal, so an extension that asks first, or only stops work on
 * the first Esc, stays open until the next press.
 */
const EscButton: React.FC<{ sessionId: string; surface: PiExtensionSurfaceState }> = ({ sessionId, surface }) => {
  const press = (button: HTMLButtonElement) => {
    closeSurface(sessionId, surface.surfaceId);
    // Pressed from the keyboard: give the keys back to the surface at once.
    // Keys typed now queue behind the Esc, and a confirmation the Esc opens
    // takes focus from the surface when it arrives.
    if (document.activeElement !== button) return;
    const element = document.querySelector<HTMLElement>(`[data-extension-surface="${CSS.escape(surface.surfaceId)}"]`);
    if (element && element.tabIndex >= 0) focusSurfaceElement(surface.surfaceId);
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="shrink-0 px-1.5 font-sans text-muted-foreground hover:text-foreground"
      aria-label={`Press Esc in ${surface.title}`}
      title="Press Esc"
      // A click keeps focus (and the keys) where it is.
      onPointerDown={(event) => event.preventDefault()}
      onClick={(event) => press(event.currentTarget)}
    >
      Esc
    </Button>
  );
};

/** Asks for full frames when a missed patch left a surface stale. */
const useRefreshStale = (sessionId: string, surfaces: PiExtensionSurfaceState[]): void => {
  const staleIds = surfaces.filter((surface) => surface.stale).map((surface) => surface.surfaceId).join('\u0000');
  React.useEffect(() => {
    if (!staleIds) return;
    for (const surfaceId of staleIds.split('\u0000')) refreshSurface(sessionId, surfaceId);
  }, [sessionId, staleIds]);
};

// ------------------------------------------------------------------ sizing

/**
 * Reports this tab's terminal size: inline columns from the composer column,
 * the overlay screen from the whole chat pane. The daemon sizes surfaces for
 * the client that last acted.
 */
const SurfaceSizeProbe: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const probe = React.useRef<HTMLSpanElement | null>(null);
  // Overlays on a touch screen leave room for the key bar under them.
  const reservedRows = useDeviceInfo().hasTouchOnlyPointer ? KEY_BAR_ROWS : 0;

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const pane = element.closest<HTMLElement>('[data-composer-bound]');
    const measure = () => {
      const cell = (probe.current?.getBoundingClientRect().width ?? 0) / 10;
      if (!(cell > 0) || !pane) return;
      reportSurfaceViewport(sessionId, {
        columns: Math.floor(element.clientWidth / cell),
        screenColumns: Math.floor((pane.clientWidth - 2 * SCREEN_PAD) / cell),
        rows: Math.max(1, Math.floor((pane.clientHeight - 2 * SCREEN_PAD) / LINE_HEIGHT) - reservedRows),
      });
    };
    // The daemon forgets clients once every surface closes.
    resetSurfaceViewport(sessionId);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (pane) observer.observe(pane);
    return () => observer.disconnect();
  }, [sessionId, reservedRows]);

  // Same horizontal inset as the inline card body (border plus px-3).
  // Positioned out of the flow: as a flex item, even at zero height, it
  // would take the composer bar's gap and lift everything above it.
  return (
    <div aria-hidden className="chat-input-column pointer-events-none absolute inset-x-0 top-0 h-0 overflow-hidden">
      <div className="mx-px px-3">
        <div ref={ref} className="relative w-full">
          <span ref={probe} className={cn('invisible absolute', MONO)}>
            0000000000
          </span>
        </div>
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ composer slot

/** Whether a box's content is taller than the box, so it scrolls. */
const useScrollsVertically = (ref: React.RefObject<HTMLElement | null>): boolean => {
  const [scrolls, setScrolls] = React.useState(false);
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const check = () => setScrolls(element.scrollHeight > element.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [ref]);
  return scrolls;
};

/**
 * The tallest an inline card's body may grow: the chat pane less the card's
 * header and footer and the column's bottom padding. Extensions size
 * themselves to the terminal height the size probe reports (the pane, as Pi
 * reports the whole terminal), so anything that fits that fits here; only
 * taller content scrolls. `undefined` until measured.
 */
const useInlineBodyMaxHeight = (
  card: React.RefObject<HTMLElement | null>,
  body: React.RefObject<HTMLElement | null>,
): number | undefined => {
  const [maxHeight, setMaxHeight] = React.useState<number | undefined>(undefined);
  React.useLayoutEffect(() => {
    const cardElement = card.current;
    const bodyElement = body.current;
    const pane = cardElement?.closest<HTMLElement>('[data-composer-bound]');
    if (!cardElement || !bodyElement || !pane) return;
    const measure = () => {
      const chrome = cardElement.offsetHeight - bodyElement.offsetHeight;
      const column = cardElement.parentElement;
      const bottom = column ? Number.parseFloat(getComputedStyle(column).paddingBottom) || 0 : 0;
      setMaxHeight(Math.max(4 * LINE_HEIGHT, Math.floor(pane.clientHeight - chrome - bottom - SCREEN_PAD)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    observer.observe(cardElement);
    return () => observer.disconnect();
  }, [card, body]);
  return maxHeight;
};

const InlineSurface: React.FC<{ sessionId: string; surface: PiExtensionSurfaceState; below: number }> = ({
  sessionId,
  surface,
  below,
}) => {
  const busy = useSessionBusy(sessionId);
  const { hasTouchOnlyPointer } = useDeviceInfo();
  const card = React.useRef<HTMLDivElement | null>(null);
  const body = React.useRef<HTMLDivElement | null>(null);
  const probe = React.useRef<HTMLSpanElement | null>(null);
  const bodyMaxHeight = useInlineBodyMaxHeight(card, body);
  const scrolls = useScrollsVertically(body);
  // Drawn for a wider device that is driving the size: shrink to fit.
  const metrics = useBoxMetrics(body, probe);
  const scale = metrics.cell > 0 && surface.frame
    ? fitScale({ width: surface.frame.columns * metrics.cell }, { width: metrics.width - INLINE_PAD_X })
    : 1;
  return (
    <div className="chat-input-column pb-3">
      <div
        ref={card}
        role="dialog"
        aria-label={`Extension: ${surface.title}`}
        className="pi-surface-rise overflow-hidden rounded-xl border border-border/80 bg-card shadow-md"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border/40 px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <Icon name="plug-2" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="shrink-0 typography-ui-label font-medium text-foreground">{surface.title}</span>
            {surface.blocked?.message ? (
              <span className="truncate typography-meta text-muted-foreground">{surface.blocked.message}</span>
            ) : null}
            {below > 0 ? (
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 typography-micro text-muted-foreground">
                {below === 1 ? '1 more below' : `${below} more below`}
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {busy ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="gap-1 text-muted-foreground hover:text-foreground"
                onClick={() => abortCurrentOperation(sessionId)}
              >
                <Icon name="stop" className="size-3.5" />
                Stop
              </Button>
            ) : null}
            <EscButton sessionId={sessionId} surface={surface} />
          </div>
        </div>
        <div ref={body} className="relative overflow-auto px-3 py-2" style={{ maxHeight: bodyMaxHeight ?? '60vh' }}>
          <TerminalLines sessionId={sessionId} surface={surface} nativeTouchScroll={scrolls} scale={scale} zoomSelf />
          <span ref={probe} aria-hidden className={cn('invisible absolute left-0 top-0', MONO)}>0000000000</span>
        </div>
        {hasTouchOnlyPointer && surface.capturing ? (
          <SurfaceKeyBar sessionId={sessionId} surfaceId={surface.surfaceId} className="border-t border-border/40 px-3 py-1.5" />
        ) : (
          <div className="border-t border-border/40 px-3 py-1.5 typography-micro text-muted-foreground">
            Keys go to the extension. Your draft is kept when it closes.
          </div>
        )}
      </div>
    </div>
  );
};

/** Overlays open but not drawn: hidden by the extension, or too big for this window. */
const UnshownOverlays: React.FC<{ sessionId: string; surfaces: PiExtensionSurfaceState[] }> = ({ sessionId, surfaces }) => {
  // Pi gives keys back to the editor while an overlay is hidden, but input
  // still waits for the running command, so say where messages go.
  const commandRunning = useSessionRunningCommand(sessionId) !== null;
  if (surfaces.length === 0) return null;
  return (
    <div className="chat-input-column mb-2 flex flex-col gap-1">
      {surfaces.map((surface) => (
        <div
          key={surface.surfaceId}
          className="flex items-center justify-between gap-2 rounded-lg bg-[var(--surface-muted)] px-3 py-1"
        >
          <span className="min-w-0 typography-meta text-muted-foreground [text-wrap:pretty]">
            {surface.hidden
              ? `${surface.title} is hidden by the extension.`
              : `${surface.title} is hidden because the screen is too narrow.`}
            {commandRunning ? ' New messages wait until it closes.' : null}
          </span>
          <EscButton sessionId={sessionId} surface={surface} />
        </div>
      ))}
    </div>
  );
};

/**
 * Wraps the chat input. While an inline surface is open it takes the
 * composer's place; the input stays mounted (hidden) so its draft, focus
 * history and editor state survive.
 */
/** Says so when another device closes a surface this session showed here. */
const useClosedElsewhereToast = (sessionId: string | null | undefined): void => {
  React.useEffect(() => {
    if (!sessionId) return;
    return getPiSessionStore().subscribeExtensionSurfaceDismissals((dismissal) => {
      if (dismissal.sessionId !== sessionId || !closedElsewhere(dismissal)) return;
      toast.info(`${dismissal.surface.title} was closed on another device.`, {
        id: `extension-surface-closed:${dismissal.surface.surfaceId}`,
      });
    });
  }, [sessionId]);
};

export const ExtensionSurfaceComposer: React.FC<{ sessionId: string | null | undefined; children: React.ReactNode }> = ({
  sessionId,
  children,
}) => {
  useClosedElsewhereToast(sessionId);
  const surfaces = useSessionSurfaces(sessionId);
  const inline = surfaces.filter((surface) => surface.mode === 'inline' && !surface.hidden);
  const top = inline.at(-1) ?? null;
  const unshown = surfaces.filter((surface) => (
    surface.mode === 'overlay' && !surface.parentId && (surface.hidden || surface.frame?.visible === false)
  ));
  // The chat input fades back in when an inline surface closes, not when the
  // user switches to a session without one (the input is never remounted).
  const [returning, setReturning] = React.useState(false);
  const [seen, setSeen] = React.useState({ sessionId, hasTop: Boolean(top) });
  if (seen.sessionId !== sessionId || seen.hasTop !== Boolean(top)) {
    setSeen({ sessionId, hasTop: Boolean(top) });
    if (seen.sessionId === sessionId && !top) setReturning(true);
  }

  React.useEffect(() => {
    if (returning) focusComposerIfOrphaned();
  }, [returning]);

  useRefreshStale(sessionId ?? '', sessionId ? surfaces : EMPTY);

  return (
    <>
      {sessionId && surfaces.length > 0 ? <SurfaceSizeProbe sessionId={sessionId} /> : null}
      {sessionId ? <UnshownOverlays sessionId={sessionId} surfaces={unshown} /> : null}
      {sessionId && top ? <InlineSurface key={top.surfaceId} sessionId={sessionId} surface={top} below={inline.length - 1} /> : null}
      <div
        hidden={Boolean(top)}
        className={returning && !top ? 'pi-surface-fade' : undefined}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) setReturning(false);
        }}
      >
        {children}
      </div>
    </>
  );
};

// ------------------------------------------------------------------ overlay layer

/** Px each card behind the front one shows above it. */
const STACK_PEEK = 8;
/** Cards drawn behind the front one; more panels only add tabs. */
const STACK_DEPTH = 2;
/** Px of PiChamber's surface around an overlay's cells: 4 px padding and a 1 px border. */
const OVERLAY_FRAME = 5;
/** Px the title tab needs beside a box, less the screen's own inset. */
const TITLE_TAB_SPACE = 28 - SCREEN_PAD;
/** The raised surface every overlay sits on; stacked cards behind use it too. */
const OVERLAY_SURFACE = 'rounded-lg border border-border/80 bg-card shadow-md';

/**
 * Pi's overlay box: exactly width x height cells, on a raised surface of
 * PiChamber's own. In a terminal an overlay is just cells over the screen;
 * here a component that draws no border of its own (many do) would read as
 * loose text over the chat, so every overlay gets the same edge, just
 * outside its cells.
 */
const OverlayBox: React.FC<{ sessionId: string; surface: PiExtensionSurfaceState; scale: number }> = ({ sessionId, surface, scale }) => {
  const layout = surface.frame?.layout ?? { row: 0, col: 0, width: 40, height: 1 };
  return (
    <div className={cn(OVERLAY_SURFACE, 'max-w-full p-1')} style={scale !== 1 ? { zoom: scale } : undefined}>
      <div
        className="relative overflow-hidden"
        style={{ width: `${layout.width}ch`, maxWidth: '100%', height: layout.height * LINE_HEIGHT }}
      >
        <TerminalLines sessionId={sessionId} surface={surface} scale={scale} />
      </div>
    </div>
  );
};

/**
 * Puts a box at the daemon's cell position, kept inside this pane (surface
 * edge included) while a narrower client waits for its redraw.
 */
const placementStyle = (layout: { row: number; col: number; width: number; height: number }): React.CSSProperties => ({
  left: `max(0px, min(${layout.col}ch, 100% - ${layout.width}ch - ${2 * OVERLAY_FRAME}px))`,
  top: `max(0px, min(${layout.row * LINE_HEIGHT}px, 100% - ${layout.height * LINE_HEIGHT + 2 * OVERLAY_FRAME}px))`,
  maxWidth: '100%',
});

/**
 * Panels one command opened, as tabs over a stack of cards. The stack stays
 * where it first appeared (`anchor`), so neither picking a tab nor closing
 * a panel moves it; the front card is the focused panel (or the one Pi
 * would draw on top) at its own size, and cards behind show only their
 * edge. A tab focuses its panel, as `handle.focus()` would, and keys keep
 * going where they went. Once one panel is left it keeps the spot, without
 * tabs.
 */
const OverlayStack: React.FC<{
  sessionId: string;
  title: string;
  members: PiExtensionSurfaceState[];
  front: PiExtensionSurfaceState;
  anchor: StackAnchor;
  onPicked: () => void;
  scaleFor: (surface: PiExtensionSurfaceState) => number;
}> = ({ sessionId, title, members, front, anchor, onPicked, scaleFor }) => {
  const size = front.frame?.layout ?? { row: 0, col: 0, width: 40, height: 1 };
  const layout = { row: anchor.row, col: anchor.col, width: size.width, height: size.height };
  const tabbed = members.length > 1;
  const behind = Math.min(STACK_DEPTH, members.length - 1);
  const tabsBelow = layout.row < 3;
  return (
    <div role="group" aria-label={`${title} panels`} className={cn('absolute isolate pointer-events-auto', MONO)} style={placementStyle(layout)}>
      {tabbed ? (
        <div
          role="tablist"
          aria-label={`${title} panels`}
          data-extension-tabs
          onKeyDown={(event) => {
            const current = members.findIndex((member) => member.surfaceId === front.surfaceId);
            const next = event.key === 'ArrowRight' ? (current + 1) % members.length
              : event.key === 'ArrowLeft' ? (current - 1 + members.length) % members.length
                : event.key === 'Home' ? 0
                  : event.key === 'End' ? members.length - 1
                    : null;
            if (next === null) return;
            event.preventDefault();
            event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
            if (next !== current) void focusSurface(sessionId, members[next]!.surfaceId);
          }}
          className="absolute left-0 flex max-w-[calc(100vw-2rem)] items-center gap-1 overflow-x-auto rounded-md bg-card p-0.5 font-sans"
          style={tabsBelow ? { top: 'calc(100% + 4px)' } : { bottom: `calc(100% + ${behind * STACK_PEEK + 4}px)` }}
        >
          {members.map((member, index) => {
            const selected = member.surfaceId === front.surfaceId;
            return (
              <Button
                key={member.surfaceId}
                type="button"
                variant="chip"
                size="xs"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className={cn('shrink-0', selected && 'bg-interactive-selection text-interactive-selection-foreground')}
                // Keep key focus on the overlay that owns the keyboard.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onPicked();
                  if (!selected || !member.focused) void focusSurface(sessionId, member.surfaceId);
                }}
              >
                {panelLabel(member, index)}
              </Button>
            );
          })}
        </div>
      ) : null}
      {Array.from({ length: behind }, (_, index) => {
        const depth = index + 1;
        return (
          <div
            key={depth}
            aria-hidden
            className={cn('absolute inset-0', OVERLAY_SURFACE)}
            style={{
              zIndex: -depth,
              transform: `translateY(-${depth * STACK_PEEK}px) scale(${1 - depth * 0.04})`,
              transformOrigin: 'top center',
            }}
          />
        );
      })}
      <div
        key={front.surfaceId}
        role={tabbed ? 'tabpanel' : 'dialog'}
        aria-label={`Extension: ${title}, ${panelLabel(front, members.indexOf(front))}`}
        className="pi-surface-pop"
      >
        <OverlayBox sessionId={sessionId} surface={front} scale={scaleFor(front)} />
      </div>
    </div>
  );
};

/** Keeps each stack's first spot across renders (see `nextStackAnchors`). */
const useStackAnchors = (groups: OverlayStackGroup[]): ReadonlyMap<string, StackAnchor> => {
  const [anchors, setAnchors] = React.useState(NO_STACK_ANCHORS);
  const next = nextStackAnchors(anchors, groups);
  if (next !== anchors) setAnchors(next);
  return next;
};

/** Overlays that just stopped showing, kept mounted for their exit animation. */
const useLeaving = (current: PiExtensionSurfaceState[]) => {
  const [previous, setPrevious] = React.useState(current);
  const [leaving, setLeaving] = React.useState<PiExtensionSurfaceState[]>([]);
  if (previous !== current) {
    const ids = new Set(current.map((surface) => surface.surfaceId));
    const gone = previous.filter((surface) => !ids.has(surface.surfaceId));
    setPrevious(current);
    if (gone.length > 0 || leaving.some((surface) => ids.has(surface.surfaceId))) {
      setLeaving([...leaving.filter((surface) => !ids.has(surface.surfaceId)), ...gone]);
    }
  }
  const finish = React.useCallback((surfaceId: string) => {
    setLeaving((list) => list.filter((surface) => surface.surfaceId !== surfaceId));
  }, []);
  return { leaving, finish };
};

/**
 * Overlays on the chat pane, placed by the daemon with Pi's overlay layout.
 * Render inside the `[data-composer-bound]` pane, which must be positioned.
 */
export const ExtensionSurfaceOverlays: React.FC<{ sessionId: string | null | undefined }> = ({ sessionId }) => {
  const surfaceMap = useSessionSurfaceMap(sessionId);
  const surfaces = useSessionSurfaces(sessionId);
  const overlays = React.useMemo(() => surfaces.filter(isShownOverlay), [surfaces]);
  const groups = React.useMemo(
    () => groupPanels(overlays, surfaceMap ? [...surfaceMap.keys()] : []),
    [overlays, surfaceMap],
  );
  const anchors = useStackAnchors(groups);
  // Two or more panels make a stack; a stack keeps its spot down to one.
  const stacks = React.useMemo(
    () => groups.flatMap((group) => {
      const anchor = anchors.get(group.parentId);
      return anchor ? [{ ...group, anchor }] : [];
    }),
    [groups, anchors],
  );
  const stackedIds = React.useMemo(
    () => new Set(stacks.flatMap((stack) => stack.members.map((member) => member.surfaceId))),
    [stacks],
  );
  const { leaving: allLeaving, finish } = useLeaving(overlays);
  // A panel leaving a stack goes with no exit animation: animating it at
  // its own Pi position would flash it somewhere it was never drawn.
  const wasStacked = React.useRef<Set<string>>(new Set());
  const leaving = allLeaving.filter((surface) => !wasStacked.current.has(surface.surfaceId));
  const droppedIds = allLeaving.filter((surface) => wasStacked.current.has(surface.surfaceId)).map((surface) => surface.surfaceId).join('\u0000');
  React.useEffect(() => {
    wasStacked.current = stackedIds;
  }, [stackedIds]);
  React.useEffect(() => {
    if (!droppedIds) return;
    for (const surfaceId of droppedIds.split('\u0000')) finish(surfaceId);
  }, [droppedIds, finish]);
  const topCapturingId = overlays.filter((surface) => surface.capturing).at(-1)?.surfaceId ?? null;
  const hadCapturing = React.useRef(false);
  React.useEffect(() => {
    if (topCapturingId) hadCapturing.current = true;
    else if (hadCapturing.current) {
      hadCapturing.current = false;
      focusComposerIfOrphaned();
    }
  }, [topCapturingId]);

  // A capturing overlay owns the keyboard, as in Pi: the chat input gets no
  // keys until it closes. Other code focuses the composer on its own (after
  // a send, on session switch), so any focus that lands elsewhere in this
  // session's pane is handed back. Focus outside the pane (sidebar, dialogs)
  // is left alone, and so is an extension dialog (confirm, select) in the
  // pane's prompt dock: the overlay's own code may be waiting on it.
  const keyOwnerId = (
    overlays.find((surface) => surface.capturing && surface.focused)
    ?? overlays.filter((surface) => surface.capturing).at(-1)
  )?.surfaceId ?? null;
  const layerRef = React.useRef<HTMLDivElement | null>(null);
  const { hasTouchOnlyPointer } = useDeviceInfo();
  // An overlay laid out on a bigger screen than this pane (another device
  // drives the size) is drawn smaller, whole, instead of cropped.
  const screenRef = React.useRef<HTMLDivElement | null>(null);
  const screenProbe = React.useRef<HTMLSpanElement | null>(null);
  const screen = useBoxMetrics(screenRef, screenProbe, overlays.length > 0 || leaving.length > 0);
  const scaleFor = (surface: PiExtensionSurfaceState): number => {
    const layout = surface.frame?.layout;
    if (!layout || !(screen.cell > 0)) return 1;
    return fitScale(
      { width: layout.width * screen.cell + 2 * OVERLAY_FRAME, height: layout.height * LINE_HEIGHT + 2 * OVERLAY_FRAME },
      { width: screen.width, height: screen.height },
    );
  };
  React.useEffect(() => {
    const layer = layerRef.current;
    const pane = layer?.closest<HTMLElement>('[data-composer-bound]');
    if (!keyOwnerId || !layer || !pane) return;
    const inPromptDock = (node: Node | null) => (
      node instanceof Element && node.closest('[data-extension-prompt-dock]') !== null
    );
    const claim = () => {
      if (inPromptDock(document.activeElement)) return;
      // A keyboard user arrowing through a tab stack keeps the tab.
      if (document.activeElement?.closest('[data-extension-tabs]')) return;
      focusSurfaceElement(keyOwnerId);
    };
    const frame = requestAnimationFrame(claim);
    // When the dialog answers it unmounts with focus inside, and focus falls
    // to the body without a focusin. Watch the pane only while a dialog holds
    // focus, and hand focus back to the overlay once it is gone.
    let dialogWatch: MutationObserver | null = null;
    const stopDialogWatch = () => {
      dialogWatch?.disconnect();
      dialogWatch = null;
    };
    const watchDialog = () => {
      if (dialogWatch) return;
      dialogWatch = new MutationObserver(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        stopDialogWatch();
        claim();
      });
      dialogWatch.observe(pane, { childList: true, subtree: true });
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !pane.contains(target) || layer.contains(target)) {
        stopDialogWatch();
        return;
      }
      if (inPromptDock(target)) {
        watchDialog();
        return;
      }
      stopDialogWatch();
      claim();
    };
    if (inPromptDock(document.activeElement)) watchDialog();
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      cancelAnimationFrame(frame);
      stopDialogWatch();
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, [keyOwnerId]);

  // A non-capturing overlay that took focus itself (`handle.focus()`, as a
  // side chat does) gets the keyboard too, but does not own the pane: it
  // takes focus back from code that moves it (the composer refocusing after
  // the send that opened it) until the user clicks somewhere else in the
  // pane. When it closes or lets go with focus inside, the composer gets
  // focus back.
  const softOwnerId = keyOwnerId ? null : overlays.find((surface) => !surface.capturing && surface.focused)?.surfaceId ?? null;
  const lastSoftOwner = React.useRef<string | null>(null);
  React.useEffect(() => {
    const previous = lastSoftOwner.current;
    lastSoftOwner.current = softOwnerId;
    if (softOwnerId || !previous) return;
    // Still shown but unfocused, it takes no keys: leave it for the composer.
    if (document.activeElement?.getAttribute('data-extension-surface') === previous) (document.activeElement as HTMLElement).blur();
    focusComposerIfOrphaned();
  }, [softOwnerId]);
  React.useEffect(() => {
    const layer = layerRef.current;
    const pane = layer?.closest<HTMLElement>('[data-composer-bound]');
    if (!softOwnerId || !layer || !pane) return;
    let userMovedFocus = false;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !layer.contains(event.target)) userMovedFocus = true;
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (userMovedFocus || !(target instanceof Node) || !pane.contains(target) || layer.contains(target)) return;
      if (target instanceof Element && target.closest('[data-extension-prompt-dock]')) return;
      focusSurfaceElement(softOwnerId);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
    };
  }, [softOwnerId]);

  if (!sessionId || (overlays.length === 0 && leaving.length === 0)) return null;

  // Pi draws overlays without dimming (a terminal cannot). Here an overlay
  // that owns the keyboard dims this session's pane, since the chat is not
  // usable until it closes. A click outside hands focus back to it and makes
  // this tab set the size: on a device narrower than the one drawing the
  // overlay, the overlay then redraws to fit (or shows its notice).
  const topCapturing = overlays.filter((surface) => surface.capturing).at(-1) ?? null;
  // The key bar types to the overlay that owns the keyboard, else to a
  // focused non-capturing one.
  const keyBarTargetId = keyOwnerId ?? softOwnerId;
  const keyBarShown = hasTouchOnlyPointer && keyBarTargetId !== null;
  // Title tabs stay clear of the key bar at the bottom of the pane.
  const tabScreenHeight = screen.height - (keyBarShown ? KEY_BAR_ROWS * LINE_HEIGHT : 0);
  const shown = [
    ...overlays.map((surface) => ({ surface, isLeaving: false })),
    // A leaving copy never takes focus or keys.
    ...leaving.map((surface) => ({ surface: { ...surface, focused: false, capturing: false }, isLeaving: true })),
  ];

  return (
    <div ref={layerRef} className="pointer-events-none absolute inset-0 z-30">
      {topCapturing ? (
        <div
          aria-hidden
          className="pi-surface-fade pointer-events-auto absolute inset-0 bg-background/60"
          onMouseDown={(event) => {
            event.preventDefault();
            claimSurfaceSize(sessionId);
            if (keyOwnerId) focusSurfaceElement(keyOwnerId);
          }}
        />
      ) : null}
      <div className="absolute inset-0" style={{ padding: SCREEN_PAD }}>
        <div ref={screenRef} className="relative h-full">
          <span ref={screenProbe} aria-hidden className={cn('invisible absolute left-0 top-0', MONO)}>0000000000</span>
          {shown.map(({ surface, isLeaving }) => {
            const layout = surface.frame?.layout ?? { row: 0, col: 0, width: 40, height: 1 };
            if (!isLeaving && stackedIds.has(surface.surfaceId)) {
              // A stack draws once, where its topmost panel would.
              const stack = stacks.find((group) => group.members.includes(surface));
              if (!stack || stack.members.some((member) => member.z > surface.z)) return null;
              const parentTitle = surfaceMap?.get(stack.parentId)?.title ?? surface.title;
              return (
                <OverlayStack
                  key={`stack-${stack.parentId}`}
                  sessionId={sessionId}
                  title={parentTitle}
                  members={stack.members}
                  front={stack.front}
                  anchor={stack.anchor}
                  onPicked={() => {
                    if (keyOwnerId) focusSurfaceElement(keyOwnerId);
                  }}
                  scaleFor={scaleFor}
                />
              );
            }
            return (
              <div
                key={surface.surfaceId}
                role="dialog"
                aria-label={`Extension: ${surface.title}`}
                aria-hidden={isLeaving || undefined}
                className={cn(
                  'absolute',
                  MONO,
                  isLeaving ? 'pi-surface-out pointer-events-none' : 'pi-surface-pop pointer-events-auto',
                )}
                // The daemon places the box on the driving client's screen.
                // Kept inside this pane, with the Esc tab in reach, while
                // a narrower client waits for its redraw.
                style={placementStyle(layout)}
                onAnimationEnd={isLeaving
                  ? (event) => {
                    if (event.target === event.currentTarget) finish(surface.surfaceId);
                  }
                  : undefined}
              >
                {/* The title tab sits above the box, or below it at the top
                    edge. Only the command's own overlay has one: closing it
                    closes the panels it opened with tui.showOverlay, and Pi
                    draws no chrome around those. */}
                {surface.parentId ? null : (
                  <div
                    className={cn(
                      'absolute flex items-center gap-0.5 rounded-md bg-card pl-2 font-sans',
                      {
                        above: 'right-0 -top-7',
                        below: 'right-0 -bottom-7',
                        // A box as tall as the pane: over its own top corner.
                        inside: 'right-1 top-1 z-10 shadow-sm',
                      }[titleTabSpot({
                        top: layout.row * LINE_HEIGHT,
                        layoutHeight: layout.height * LINE_HEIGHT + 2 * OVERLAY_FRAME,
                        height: (layout.height * LINE_HEIGHT + 2 * OVERLAY_FRAME) * scaleFor(surface),
                      }, tabScreenHeight, TITLE_TAB_SPACE)],
                    )}
                  >
                    <span className="typography-micro text-muted-foreground">{surface.title}</span>
                    <EscButton sessionId={sessionId} surface={surface} />
                  </div>
                )}
                {/* Exactly the width x height cells Pi composites, on
                    PiChamber's raised surface. */}
                <OverlayBox sessionId={sessionId} surface={surface} scale={scaleFor(surface)} />
              </div>
            );
          })}
        </div>
      </div>
      {keyBarShown && keyBarTargetId ? (
        <div className="pointer-events-auto absolute inset-x-0 bottom-0 flex justify-center" style={{ padding: SCREEN_PAD }}>
          <SurfaceKeyBar sessionId={sessionId} surfaceId={keyBarTargetId} className={cn(OVERLAY_SURFACE, 'max-w-full p-1')} />
        </div>
      ) : null}
    </div>
  );
};
