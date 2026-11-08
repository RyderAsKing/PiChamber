import * as React from 'react';

import { encodeMouseReport, type TerminalMouseAction } from '@/lib/pi/terminal-keys';

/** Surface size in cells and the px size of one cell. */
interface SurfaceGrid {
  columns: number;
  rows: number;
  cellWidth: number;
  lineHeight: number;
}

/** The cell under a point, clamped to the surface (pi-tui clamps too). */
export const cellAt = (
  grid: SurfaceGrid,
  origin: { left: number; top: number },
  clientX: number,
  clientY: number,
): { col: number; row: number } => ({
  col: Math.min(Math.max(Math.floor((clientX - origin.left) / Math.max(grid.cellWidth, 1)), 0), Math.max(grid.columns - 1, 0)),
  row: Math.min(Math.max(Math.floor((clientY - origin.top) / grid.lineHeight), 0), Math.max(grid.rows - 1, 0)),
});

/** Most wheel steps one browser wheel event or touch move sends. */
const MAX_WHEEL_STEPS = 5;
/** Px a finger moves before a touch is a swipe, not a tap. */
const SWIPE_SLOP = 10;

/**
 * Wheel lines for a browser wheel event, carrying the fractional rest so a
 * trackpad's small deltas still add up to steps. Positive scrolls down.
 */
export const wheelSteps = (
  event: { deltaY: number; deltaMode: number },
  rest: number,
  lineHeight: number,
  rows: number,
): { steps: number; rest: number } => {
  const lines = event.deltaMode === 1 ? event.deltaY : event.deltaMode === 2 ? event.deltaY * rows : event.deltaY / lineHeight;
  const total = rest + lines;
  const whole = Math.trunc(total);
  const steps = Math.max(-MAX_WHEEL_STEPS, Math.min(MAX_WHEEL_STEPS, whole));
  return { steps, rest: whole === 0 ? total : 0 };
};

interface MouseGesture {
  kind: 'mouse';
  pointerId: number;
  button: number;
  col: number;
  row: number;
  grid: SurfaceGrid;
  origin: { left: number; top: number };
}

interface TouchGesture {
  kind: 'touch';
  pointerId: number;
  startX: number;
  startY: number;
  lastY: number;
  swiping: boolean;
  /** Px of finger travel not yet sent as a wheel step. */
  rest: number;
  cell: { col: number; row: number };
}

type Modifiers = { shiftKey: boolean; altKey: boolean; ctrlKey: boolean };
const NO_MODIFIERS: Modifiers = { shiftKey: false, altKey: false, ctrlKey: false };

/**
 * Pointer input for a `ctx.ui.custom()` surface, sent as SGR reports (pi-tui's
 * alt-screen mouse).
 *
 * - Mouse and pen: press, drag with a button held, release and the wheel.
 *   Moves without a button are not sent, as pi-tui's default button-motion
 *   tracking. Shift+drag and links keep the browser's selection and links.
 * - Touch: a tap is a left press and release (the host adds the click); a
 *   vertical swipe is the wheel, finger up scrolling down as on a page. With
 *   `nativeTouchScroll` swipes are left to the browser, for a surface whose
 *   box scrolls.
 */
export const useSurfacePointer = (options: {
  ref: React.RefObject<HTMLDivElement | null>;
  /** Measures one cell's width in px. */
  measureCell: () => number;
  columns: number;
  rows: number;
  lineHeight: number;
  nativeTouchScroll?: boolean;
  send: (item: string) => void;
  /** Called on a press or tap the extension gets, before it is sent. */
  onPress?: () => void;
}) => {
  const latest = React.useRef(options);
  latest.current = options;
  const gesture = React.useRef<MouseGesture | TouchGesture | null>(null);
  const wheelRest = React.useRef(0);

  const report = (action: TerminalMouseAction, button: number, cell: { col: number; row: number }, event: Modifiers) => {
    latest.current.send(encodeMouseReport({ action, button, ...cell, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey }));
  };

  const wheel = (steps: number, cell: { col: number; row: number }, event: Modifiers) => {
    for (let index = 0; index < Math.abs(steps); index += 1) {
      report(steps < 0 ? 'wheel-up' : 'wheel-down', 0, cell, event);
    }
  };

  const grid = (): SurfaceGrid => ({
    columns: latest.current.columns,
    rows: latest.current.rows,
    cellWidth: latest.current.measureCell(),
    lineHeight: latest.current.lineHeight,
  });

  const empty = () => latest.current.rows === 0 || latest.current.columns === 0;
  const onLink = (event: React.SyntheticEvent) => event.target instanceof Element && event.target.closest('a[href]') !== null;
  const takesMouse = (event: React.PointerEvent | React.MouseEvent): boolean => (
    !event.shiftKey && event.button <= 2 && !empty() && !onLink(event)
  );

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = latest.current.ref.current;
    if (!element || gesture.current) return;
    if (event.pointerType === 'touch') {
      if (empty() || onLink(event)) return;
      const rect = element.getBoundingClientRect();
      gesture.current = {
        kind: 'touch',
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastY: event.clientY,
        swiping: false,
        rest: 0,
        cell: cellAt(grid(), { left: rect.left, top: rect.top }, event.clientX, event.clientY),
      };
      return;
    }
    if (!takesMouse(event)) return;
    const rect = element.getBoundingClientRect();
    const origin = { left: rect.left, top: rect.top };
    const surfaceGrid = grid();
    const cell = cellAt(surfaceGrid, origin, event.clientX, event.clientY);
    gesture.current = { kind: 'mouse', pointerId: event.pointerId, button: event.button, ...cell, grid: surfaceGrid, origin };
    element.setPointerCapture?.(event.pointerId);
    latest.current.onPress?.();
    report('press', event.button, cell, event);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.kind === 'touch') {
      if (!current.swiping) {
        if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < SWIPE_SLOP) return;
        if (latest.current.nativeTouchScroll) {
          gesture.current = null;
          return;
        }
        current.swiping = true;
      }
      const travel = current.rest + current.lastY - event.clientY;
      current.lastY = event.clientY;
      const whole = Math.trunc(travel / latest.current.lineHeight);
      current.rest = travel - whole * latest.current.lineHeight;
      wheel(Math.max(-MAX_WHEEL_STEPS, Math.min(MAX_WHEEL_STEPS, whole)), current.cell, NO_MODIFIERS);
      return;
    }
    const cell = cellAt(current.grid, current.origin, event.clientX, event.clientY);
    if (cell.col === current.col && cell.row === current.row) return;
    current.col = cell.col;
    current.row = cell.row;
    report('drag', current.button, cell, event);
  };

  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (current.kind === 'touch') {
      // A cancelled touch (the browser took it) and a swipe are no tap.
      if (event.type !== 'pointerup' || current.swiping) return;
      latest.current.onPress?.();
      report('press', 0, current.cell, NO_MODIFIERS);
      report('release', 0, current.cell, NO_MODIFIERS);
      return;
    }
    const cell = event.type === 'pointercancel' ? current : cellAt(current.grid, current.origin, event.clientX, event.clientY);
    report('release', current.button, { col: cell.col, row: cell.row }, event);
  };

  // Keep the browser from starting a text selection under a press the
  // extension gets. Focus moves by hand (onPress) since this blocks it too.
  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (takesMouse(event)) event.preventDefault();
  };

  // React's wheel listener is passive; this one must stop the page scrolling.
  const wheelHelpers = React.useRef({ wheel, grid, empty });
  wheelHelpers.current = { wheel, grid, empty };
  React.useEffect(() => {
    const element = options.ref.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const { wheel, grid, empty } = wheelHelpers.current;
      if (event.shiftKey || event.deltaY === 0 || empty()) return;
      event.preventDefault();
      const { steps, rest } = wheelSteps(event, wheelRest.current, latest.current.lineHeight, latest.current.rows);
      wheelRest.current = rest;
      if (steps === 0) return;
      const rect = element.getBoundingClientRect();
      wheel(steps, cellAt(grid(), { left: rect.left, top: rect.top }, event.clientX, event.clientY), event);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
    // The listener reads refs, so it stays for the element's life.
  }, [options.ref]);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: end,
    onPointerCancel: end,
    onMouseDown,
    /** Swipes are the wheel unless the surface's box scrolls natively. */
    touchAction: options.nativeTouchScroll ? 'pan-y' : 'none',
  } as const;
};
