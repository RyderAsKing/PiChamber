import type {
  PiExtensionSurfaceDismissEvent,
  PiExtensionSurfaceFrame,
  PiExtensionSurfaceFullFrame,
  PiExtensionSurfaceLayout,
  PiExtensionSurfaceLineCells,
  PiExtensionSurfaceMeta,
  PiExtensionSurfaceSnapshot,
} from '../protocol';
import type { PiSessionId } from '../types';
import type { PiReducerSessionState, PiReducerState } from './reducerTypes';

/** The current frame of a `ctx.ui.custom()` surface. */
export interface PiExtensionSurfaceLiveFrame {
  version: number;
  lines: string[];
  /** Wide cells per line, `undefined` for lines without any. */
  cells: Array<PiExtensionSurfaceLineCells | undefined>;
  cursor: { row: number; col: number } | null;
  layout: PiExtensionSurfaceLayout | null;
  visible: boolean;
  columns: number;
  screenColumns: number;
  rows: number;
}

/** A surface in reducer state: metadata plus its latest frame. */
export interface PiExtensionSurfaceState extends PiExtensionSurfaceMeta {
  frame: PiExtensionSurfaceLiveFrame | null;
  /**
   * Set when a patch did not apply to the frame held here (a missed live
   * frame). The UI asks for a full frame; the next full frame clears it.
   */
  stale?: boolean;
}

const metaOf = (value: PiExtensionSurfaceMeta): PiExtensionSurfaceMeta => ({
  surfaceId: value.surfaceId,
  ...(value.parentId ? { parentId: value.parentId } : {}),
  title: value.title,
  mode: value.mode,
  capturing: value.capturing,
  hidden: value.hidden,
  focused: value.focused,
  z: value.z,
  ...(value.blocked ? { blocked: { ...value.blocked } } : {}),
});

const fullFrameOf = (frame: PiExtensionSurfaceFullFrame): PiExtensionSurfaceLiveFrame => ({
  version: frame.version,
  lines: frame.lines,
  cells: frame.lines.map((_line, index) => frame.cells?.[index]),
  cursor: frame.cursor,
  layout: frame.layout,
  visible: frame.visible,
  columns: frame.columns,
  screenColumns: frame.screenColumns,
  rows: frame.rows,
});

const isFullFrame = (frame: PiExtensionSurfaceFrame): frame is PiExtensionSurfaceFullFrame => (
  Array.isArray((frame as { lines?: unknown }).lines)
);

/** Surfaces from a snapshot or session detail; `undefined` when none are open. */
export const surfacesFromSnapshot = (
  entries: PiExtensionSurfaceSnapshot[] | undefined,
): Map<string, PiExtensionSurfaceState> | undefined => {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const surfaces = new Map<string, PiExtensionSurfaceState>();
  for (const entry of entries) {
    if (typeof entry?.surfaceId !== 'string' || entry.surfaceId.length === 0) continue;
    const frame = entry.frame && entry.frame.surfaceId === entry.surfaceId && isFullFrame(entry.frame)
      ? fullFrameOf(entry.frame)
      : null;
    surfaces.set(entry.surfaceId, { ...metaOf(entry), frame });
  }
  return surfaces.size > 0 ? surfaces : undefined;
};

const writeSurface = (session: PiReducerSessionState, surface: PiExtensionSurfaceState): void => {
  const surfaces = new Map(session.extensionSurfaces ?? []);
  surfaces.set(surface.surfaceId, surface);
  session.extensionSurfaces = surfaces;
};

export const reduceExtensionSurface = (
  session: PiReducerSessionState,
  payload: PiExtensionSurfaceMeta,
): void => {
  const current = session.extensionSurfaces?.get(payload.surfaceId);
  writeSurface(session, { ...metaOf(payload), frame: current?.frame ?? null, ...(current?.stale ? { stale: true } : {}) });
};

/**
 * Applies a full frame or a patch. A patch whose `base` is not the frame
 * held here marks the surface stale instead of drawing a wrong frame.
 * Frames for surfaces this client does not know are ignored: metadata
 * always arrives first, live or from the snapshot.
 */
export const reduceExtensionSurfaceFrame = (
  session: PiReducerSessionState,
  frame: PiExtensionSurfaceFrame,
): void => {
  const current = session.extensionSurfaces?.get(frame.surfaceId);
  if (!current) return;
  if (current.frame && frame.version <= current.frame.version) return;
  if (isFullFrame(frame)) {
    writeSurface(session, { ...current, frame: fullFrameOf(frame), stale: false });
    return;
  }
  if (!current.frame || current.frame.version !== frame.base) {
    if (!current.stale) writeSurface(session, { ...current, stale: true });
    return;
  }
  const lines = current.frame.lines.slice(0, frame.length);
  const cells = current.frame.cells.slice(0, frame.length);
  while (lines.length < frame.length) {
    lines.push('');
    cells.push(undefined);
  }
  for (const change of frame.changes) {
    lines[change.index] = change.line;
    cells[change.index] = change.cells;
  }
  writeSurface(session, {
    ...current,
    frame: {
      version: frame.version,
      lines,
      cells,
      cursor: frame.cursor,
      layout: frame.layout,
      visible: frame.visible,
      columns: frame.columns,
      screenColumns: frame.screenColumns,
      rows: frame.rows,
    },
    stale: false,
  });
};

export const reduceExtensionSurfaceDismiss = (
  session: PiReducerSessionState,
  payload: PiExtensionSurfaceDismissEvent['payload'],
): void => {
  if (!session.extensionSurfaces?.has(payload.surfaceId)) return;
  const surfaces = new Map(session.extensionSurfaces);
  surfaces.delete(payload.surfaceId);
  if (surfaces.size === 0) delete session.extensionSurfaces;
  else session.extensionSurfaces = surfaces;
};

/**
 * Drops a surface the server reported as not open (a missed dismiss).
 * Returns the same state when there is nothing to drop.
 */
export const dropExtensionSurface = (
  state: PiReducerState,
  sessionId: PiSessionId,
  surfaceId: string,
): PiReducerState => {
  const session = state.bySession.get(sessionId);
  if (!session?.extensionSurfaces?.has(surfaceId)) return state;
  const nextSession: PiReducerSessionState = { ...session };
  reduceExtensionSurfaceDismiss(nextSession, { surfaceId, reason: 'cancelled' });
  return {
    bySession: new Map(state.bySession).set(sessionId, nextSession),
    lastSequence: new Map(state.lastSequence),
  };
};
