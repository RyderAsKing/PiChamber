// Hosts Pi `ctx.ui.custom()` components for PiChamber sessions.
//
// Components render on the daemon exactly as Pi would render them; browsers
// receive the rendered lines and send keys back. One module owns the whole
// surface lifetime: factory, focus, overlay layout, input, terminal size,
// frames, and every way a surface can end (docs/plans/pi-extension-custom.md).
//
// Pi has one terminal; PiChamber has two sizes. Inline surfaces replace the
// composer and render at the composer column width. Overlays lay out on the
// "screen", the whole chat pane, with Pi's own `resolveOverlayLayout`, so an
// edge-anchored overlay can use the empty space beside the chat column.
// `tui.terminal` reports the screen, as it does in Pi.
//
// Several devices can watch one session, each with its own size. One client
// drives the size: the last one that acted (typed, clicked, focused, closed,
// or claimed on open); before anyone acts, the first one that reports. Other
// clients' sizes are kept but ignored, so idle screens never make the layout
// flap between sizes.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import { MAX_CUSTOM_FRAME_LINES, MAX_CUSTOM_INPUT_CHARS, MAX_CUSTOM_INPUT_ITEMS, MAX_CUSTOM_LINE_CHARS } from '../extension-protocol.js';

const MAX_SURFACES_PER_SESSION = 16;
const MAX_FRAME_LINES = MAX_CUSTOM_FRAME_LINES;
const MAX_LINE_CHARS = MAX_CUSTOM_LINE_CHARS;
const MAX_TITLE_CHARS = 128;
const MAX_BLOCKED_MESSAGE_CHARS = 256;
const MAX_CLIENTS_PER_SESSION = 16;
const MAX_INPUT_ITEMS = MAX_CUSTOM_INPUT_ITEMS;
const MAX_INPUT_CHARS = MAX_CUSTOM_INPUT_CHARS;
const FRAME_INTERVAL_MS = 33;
const SIZE_SETTLE_MS = 150;
/**
 * How long Close waits for a component to end itself after the Esc it sends
 * (Pi components close on their own keys; an async Esc handler needs a few
 * ticks) before it ends the surface anyway.
 */
const CLOSE_GRACE_MS = 300;

const CUSTOM_VIEWPORT_LIMITS = Object.freeze({
  columns: [20, 200],
  screenColumns: [20, 400],
  rows: [10, 80],
});
const DEFAULT_CUSTOM_VIEWPORT = Object.freeze({ columns: 100, screenColumns: 140, rows: 30 });

const clampInt = (value, [min, max]) => Math.max(min, Math.min(max, Math.floor(value)));

/** Clamped viewport, or `undefined` when the value is not a viewport. */
export const normalizeCustomViewport = (value) => {
  if (!value || typeof value !== 'object') return undefined;
  const { columns, rows } = value;
  if (!Number.isFinite(columns) || !Number.isFinite(rows)) return undefined;
  const screenColumns = Number.isFinite(value.screenColumns) ? value.screenColumns : columns;
  return {
    columns: clampInt(columns, CUSTOM_VIEWPORT_LIMITS.columns),
    screenColumns: clampInt(screenColumns, CUSTOM_VIEWPORT_LIMITS.screenColumns),
    rows: clampInt(rows, CUSTOM_VIEWPORT_LIMITS.rows),
  };
};

// Pi's TUI classes are not all exported from the package index: the overlay
// layout lives on `TuiBase` and the app keybindings in the SDK's
// `core/keybindings.js`. Both are loaded from the installed SDK so they are
// the same module instances the SDK and extensions use.
let piTuiPromise;
const loadPiTui = () => {
  piTuiPromise ??= (async () => {
    const sdkEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const sdkDist = dirname(sdkEntry);
    const requireFromSdk = createRequire(join(dirname(sdkDist), 'package.json'));
    const tuiEntry = requireFromSdk.resolve('@earendil-works/pi-tui');
    const [tuiIndex, tuiModule, keybindingsModule] = await Promise.all([
      import(pathToFileURL(tuiEntry).href),
      import(pathToFileURL(join(dirname(tuiEntry), 'tui.js')).href),
      import(pathToFileURL(join(sdkDist, 'core', 'keybindings.js')).href),
    ]);
    return {
      visibleWidth: tuiIndex.visibleWidth,
      sliceByColumn: tuiIndex.sliceByColumn,
      setKeybindings: tuiIndex.setKeybindings,
      cursorMarker: tuiModule.CURSOR_MARKER,
      fakeCursorStart: tuiModule.FAKE_CURSOR_START,
      fakeCursorEnd: tuiModule.FAKE_CURSOR_END,
      resolveOverlayLayout: (options, height, columns, rows) => tuiModule.TuiBase.prototype.resolveOverlayLayout
        .call(tuiModule.TuiBase.prototype, options, height, columns, rows),
      dispatchMouseEvent: tuiModule.dispatchMouseEvent,
      retargetMouseEvent: tuiModule.retargetMouseEvent,
      KeybindingsManager: keybindingsModule.KeybindingsManager,
    };
  })();
  piTuiPromise.catch(() => {
    piTuiPromise = undefined;
  });
  return piTuiPromise;
};

const OTHER_APC = /\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;
/** An escape sequence that is whole at the start of a string: CSI, OSC/APC/DCS with its terminator, or a two-byte escape. */
const WHOLE_ESCAPE = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]_P^X][^\x07\x1b]*(?:\x07|\x1b\\)|[ -OQ-WYZ\\`-~])/;

/**
 * A line cut to the frame cap. The cut never leaves half an escape sequence
 * behind, since the browser would show its tail as text.
 */
const capLine = (text) => {
  if (text.length <= MAX_LINE_CHARS) return text;
  let cut = text.slice(0, MAX_LINE_CHARS);
  const escape = cut.lastIndexOf('\x1b');
  if (escape !== -1 && !WHOLE_ESCAPE.test(cut.slice(escape))) cut = cut.slice(0, escape);
  // Nor half a surrogate pair.
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};
// SGR mouse report, as a terminal sends it in mouse mode: ESC [ < button ;
// column ; row, then M (press or motion) or m (release); cells are 1-based.
const SGR_MOUSE = /^\x1b\[<(\d{1,3});(\d{1,4});(\d{1,4})([Mm])$/;
const MOUSE_BUTTONS = Object.freeze(['left', 'middle', 'right', 'none']);
// Pi's double-click window (pi-tui `DOUBLE_CLICK_INTERVAL_MS`).
const DOUBLE_CLICK_MS = 500;
// The same escapes the browser's `parseAnsiSegments` drops (CSI, OSC, APC,
// DCS/SOS/PM strings, and two-character escapes), so grapheme indices in
// `cells` match the text the browser draws.
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])/g;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Browsers draw emoji and CJK at whatever width the font gives them; Pi
// counts them as two cells (or zero). The frame carries Pi's width for every
// grapheme that is not one cell wide, keyed by grapheme index, so the browser
// can draw fixed cell boxes and keep borders aligned.
const wideCellsFor = (line, visibleWidth) => {
  const plain = line.replace(ANSI, '');
  if (/^[\x20-\x7e]*$/.test(plain)) return undefined;
  let cells;
  let index = 0;
  for (const { segment } of graphemes.segment(plain)) {
    const width = visibleWidth(segment);
    if (width !== 1) (cells ??= {})[index] = width;
    index += 1;
  }
  return cells;
};

const sameLayout = (a, b) => (a === b) || (a && b && a.row === b.row && a.col === b.col && a.width === b.width && a.height === b.height);
const sameCursor = (a, b) => (a === b) || (a && b && a.row === b.row && a.col === b.col);
const sameCells = (a, b) => (a === b) || (a && b && JSON.stringify(a) === JSON.stringify(b));

/** Pi `blocked.kind` to the pending-input kind the sidebar and alerts use. */
const pendingKindFor = (blocked) => (blocked?.kind === 'permission' ? 'approval' : 'input');

const normalizeBlocked = (blocked) => {
  if (!blocked || typeof blocked !== 'object') return undefined;
  const kind = ['permission', 'question', 'auth'].includes(blocked.kind) ? blocked.kind : undefined;
  if (!kind) return undefined;
  const message = typeof blocked.message === 'string'
    ? blocked.message.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_BLOCKED_MESSAGE_CHARS)
    : '';
  return { kind, message };
};

const terminalOnlyError = () => new Error('PiChamber sessions do not hand the terminal to extensions.');

/**
 * Creates the per-daemon `custom()` host. Dependencies are injected so the
 * session daemon keeps thin call sites and tests can drive it directly.
 */
export const createExtensionCustomHost = ({
  publish,
  publishTransient = publish,
  pendingInput,
  directoryForSession,
  redactLine = (line) => line,
  theme,
  agentDir,
  describeOrigin = () => undefined,
  /** The client that sent the session's latest prompt, which opened the surface. */
  openerClientFor = () => undefined,
  onSettled = () => {},
  onError = () => {},
  loadTui = loadPiTui,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) => {
  /** sessionId -> session state */
  const sessions = new Map();
  let keybindings;
  let tui;

  const ensureTui = async () => {
    if (tui) return tui;
    const loaded = await loadTui();
    if (!keybindings && loaded.KeybindingsManager) {
      try {
        keybindings = agentDir ? loaded.KeybindingsManager.create(agentDir) : new loaded.KeybindingsManager();
      } catch {
        keybindings = new loaded.KeybindingsManager();
      }
      // pi-tui components (SelectList, Input, Editor) read the process-wide
      // keybindings, as they do under Pi's interactive mode.
      try {
        loaded.setKeybindings?.(keybindings);
      } catch {
        // A missing global setter only loses user remaps.
      }
    }
    tui = loaded;
    return tui;
  };

  const stateFor = (sessionId) => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        surfaces: [],
        focus: null,
        viewport: { ...DEFAULT_CUSTOM_VIEWPORT },
        clients: new Map(),
        driver: null,
        opener: null,
        sizeTimer: undefined,
        renderTimer: undefined,
        lastFlushAt: 0,
        dirty: new Set(),
        z: 0,
        // The pointer gesture in progress (press target or capture), and the
        // last click, for click counts.
        mouse: null,
        lastClick: null,
      };
      sessions.set(sessionId, state);
    }
    return state;
  };

  const dropStateIfEmpty = (state) => {
    if (state.surfaces.length > 0) return;
    if (state.renderTimer) clearTimer(state.renderTimer);
    if (state.sizeTimer) clearTimer(state.sizeTimer);
    // The driver and client sizes outlive surfaces only while something is
    // open; the next surface starts from the last applied viewport.
    state.renderTimer = undefined;
    state.sizeTimer = undefined;
    state.dirty.clear();
    state.focus = null;
    state.opener = null;
  };

  const findSurface = (state, surfaceId) => state?.surfaces.find((surface) => surface.id === surfaceId);

  /**
   * The overlay options, called fresh like Pi does. An options function
   * that throws keeps the last options it returned: the extension's error
   * must never escape into a render timer, where it would end the daemon.
   */
  const resolveOptions = (surface) => {
    if (typeof surface.options !== 'function') {
      return surface.options && typeof surface.options === 'object' ? surface.options : undefined;
    }
    try {
      const value = surface.options();
      surface.lastOptions = value && typeof value === 'object' ? value : undefined;
    } catch (error) {
      if (!surface.optionsFailed) onError(surface.sessionId, 'overlayOptions', error);
      surface.optionsFailed = true;
    }
    return surface.lastOptions;
  };

  const isVisibleAt = (state, surface) => {
    if (surface.hidden) return false;
    if (!surface.overlay) return true;
    const visible = resolveOptions(surface)?.visible;
    if (typeof visible !== 'function') return true;
    try {
      return visible(state.viewport.screenColumns, state.viewport.rows) !== false;
    } catch {
      return true;
    }
  };

  // ---------------------------------------------------------------- focus

  const setComponentFocused = (component, focused) => {
    if (!component || typeof component !== 'object' || !('focused' in component)) return;
    try {
      component.focused = focused;
    } catch {
      // A read-only focus flag only loses the cursor.
    }
  };

  /** Topmost visible capturing overlay, else the top inline surface. */
  const topFocusable = (state, except) => {
    let best = null;
    for (const surface of state.surfaces) {
      if (surface === except || !surface.overlay || !surface.capturing || !isVisibleAt(state, surface)) continue;
      if (!best || surface.z > best.z) best = surface;
    }
    if (best) return best;
    for (let index = state.surfaces.length - 1; index >= 0; index -= 1) {
      const surface = state.surfaces[index];
      if (surface !== except && !surface.overlay) return surface;
    }
    return null;
  };

  const publishMeta = (state, surface) => {
    publish('extension.custom', projectMeta(state, surface), state.sessionId, directoryForSession(state.sessionId));
  };

  const focusSurface = (state, surface, component = surface?.component) => {
    const previous = state.focus;
    if (previous?.surface === surface && previous?.component === component) return;
    if (previous) setComponentFocused(previous.component, false);
    state.focus = surface ? { surface, component } : null;
    if (surface) setComponentFocused(component, true);
    // Focus moves the cursor, so both surfaces render again.
    if (previous?.surface && previous.surface !== surface && state.surfaces.includes(previous.surface)) {
      publishMeta(state, previous.surface);
      scheduleRender(state, previous.surface);
    }
    if (surface && previous?.surface !== surface) {
      publishMeta(state, surface);
    }
    if (surface) scheduleRender(state, surface);
  };

  // ---------------------------------------------------------------- frames

  const projectMeta = (state, surface) => ({
    surfaceId: surface.id,
    ...(surface.parentId ? { parentId: surface.parentId } : {}),
    title: surface.title,
    mode: surface.overlay ? 'overlay' : 'inline',
    capturing: surface.capturing,
    hidden: surface.hidden,
    focused: state.focus?.surface === surface,
    z: surface.z,
    ...(surface.blocked ? { blocked: { ...surface.blocked } } : {}),
  });

  const renderSurface = (state, surface) => {
    const { visibleWidth, sliceByColumn, cursorMarker, fakeCursorStart, fakeCursorEnd, resolveOverlayLayout } = tui;
    const { columns, screenColumns, rows } = state.viewport;
    const options = surface.overlay ? (resolveOptions(surface) ?? (Number.isFinite(surface.component?.width) ? { width: surface.component.width } : undefined)) : undefined;
    const sizing = surface.overlay ? resolveOverlayLayout(options, 0, screenColumns, rows) : undefined;
    const width = surface.overlay ? Math.max(1, sizing.width) : columns;
    let raw;
    try {
      raw = surface.component.render(width);
    } catch (error) {
      onError(state.sessionId, 'render', error);
      // A component that cannot render is closed, never left half-shown.
      // Deferred so a failure during open still finds its owner.
      queueMicrotask(() => {
        if (!state.surfaces.includes(surface)) return;
        if (surface.settle) surface.settle('cancelled');
        else removeSurface(state, surface, 'cancelled');
      });
      return null;
    }
    let lines = Array.isArray(raw) ? raw : [];
    if (sizing?.maxHeight !== undefined && lines.length > sizing.maxHeight) lines = lines.slice(0, sizing.maxHeight);
    lines = lines.slice(0, MAX_FRAME_LINES);
    let cursor = null;
    const focusedHere = state.focus?.surface === surface;
    lines = lines.map((line, row) => {
      let text = capLine(String(line ?? ''));
      const marker = text.indexOf(cursorMarker);
      if (marker !== -1) {
        if (focusedHere && !cursor) cursor = { row, col: visibleWidth(text.slice(0, marker)) };
        text = text.split(cursorMarker).join('');
      }
      // Fake cursors (unfocused editors) become reverse video, as Pi draws
      // them; every other private APC marker is dropped.
      text = text.split(fakeCursorStart).join('\x1b[7m').split(fakeCursorEnd).join('\x1b[27m').replace(OTHER_APC, '');
      // Pi cuts overlay lines to the declared width before compositing.
      if (surface.overlay && visibleWidth(text) > width) text = sliceByColumn(text, 0, width, true);
      return redactLine(text);
    });
    const cells = lines.map((line) => wideCellsFor(line, visibleWidth));
    const layout = surface.overlay
      ? (() => {
        const placed = resolveOverlayLayout(options, lines.length, screenColumns, rows);
        return { row: placed.row, col: placed.col, width, height: lines.length };
      })()
      : null;
    return {
      lines,
      cells,
      cursor,
      layout,
      visible: isVisibleAt(state, surface),
      columns: width,
      screenColumns,
      rows,
    };
  };

  /** Full frame payload for a surface's current frame. */
  const fullFrame = (surface) => {
    const frame = surface.frame;
    const cells = {};
    let hasCells = false;
    frame.cells.forEach((value, index) => {
      if (value) {
        cells[index] = value;
        hasCells = true;
      }
    });
    return {
      surfaceId: surface.id,
      version: frame.version,
      length: frame.lines.length,
      lines: [...frame.lines],
      ...(hasCells ? { cells } : {}),
      cursor: frame.cursor,
      layout: frame.layout,
      visible: frame.visible,
      columns: frame.columns,
      screenColumns: frame.screenColumns,
      rows: frame.rows,
    };
  };

  const flushSurface = (state, surface, { forceFull = false } = {}) => {
    const next = renderSurface(state, surface);
    if (!next) return;
    const previous = surface.frame;
    const sameShape = previous
      && previous.columns === next.columns
      && previous.screenColumns === next.screenColumns
      && previous.rows === next.rows;
    const changes = [];
    if (previous) {
      for (let index = 0; index < next.lines.length; index += 1) {
        if (previous.lines[index] !== next.lines[index] || !sameCells(previous.cells[index], next.cells[index])) {
          changes.push(index);
        }
      }
    }
    const unchanged = previous
      && sameShape
      && changes.length === 0
      && previous.lines.length === next.lines.length
      && sameCursor(previous.cursor, next.cursor)
      && sameLayout(previous.layout, next.layout)
      && previous.visible === next.visible;
    if (unchanged && !forceFull) return;
    const version = (previous?.version ?? 0) + 1;
    surface.frame = { ...next, version };
    const directory = directoryForSession(state.sessionId);
    if (!previous || forceFull || !sameShape || changes.length * 2 > next.lines.length) {
      publishTransient('extension.custom.frame', fullFrame(surface), state.sessionId, directory);
      return;
    }
    publishTransient('extension.custom.frame', {
      surfaceId: surface.id,
      version,
      base: previous.version,
      length: next.lines.length,
      changes: changes.map((index) => ({
        index,
        line: next.lines[index],
        ...(next.cells[index] ? { cells: next.cells[index] } : {}),
      })),
      cursor: next.cursor,
      layout: next.layout,
      visible: next.visible,
      columns: next.columns,
      screenColumns: next.screenColumns,
      rows: next.rows,
    }, state.sessionId, directory);
  };

  /** Closes a surface that failed, as one whose render throws. */
  const failSurface = (state, surface, stage, error) => {
    onError(state.sessionId, stage, error);
    if (!state.surfaces.includes(surface)) return;
    if (surface.settle) surface.settle('cancelled');
    else removeSurface(state, surface, 'cancelled');
  };

  /** Renders and publishes one surface; a failure closes it, never throws. */
  const safeFlushSurface = (state, surface, options) => {
    try {
      flushSurface(state, surface, options);
    } catch (error) {
      failSurface(state, surface, 'render', error);
    }
  };

  const flush = (state) => {
    state.renderTimer = undefined;
    state.lastFlushAt = Date.now();
    const dirty = [...state.dirty];
    state.dirty.clear();
    for (const surface of dirty) {
      if (state.surfaces.includes(surface)) safeFlushSurface(state, surface);
    }
  };

  function scheduleRender(state, surface) {
    if (!state.surfaces.includes(surface)) return;
    state.dirty.add(surface);
    if (state.renderTimer) return;
    // The first change after a quiet spell draws on the next tick, so a key
    // shows at once; changes within 33 ms of the last draw wait out the rest
    // of it, so an animating component still sends about 30 frames a second.
    // Changes made in one turn (a batch of keys) still share one draw.
    const sinceLast = Date.now() - (state.lastFlushAt ?? 0);
    state.renderTimer = setTimer(() => flush(state), Math.max(0, FRAME_INTERVAL_MS - sinceLast));
  }

  const scheduleAll = (state) => {
    for (const surface of state.surfaces) scheduleRender(state, surface);
  };

  // ---------------------------------------------------------------- surfaces

  const removeSurface = (state, surface, givenReason) => {
    const index = state.surfaces.indexOf(surface);
    if (index === -1) return false;
    if (surface.closeTimer !== undefined) {
      clearTimer(surface.closeTimer);
      surface.closeTimer = undefined;
    }
    // A component that ends itself on the Esc a Close sent it still ends
    // by the host Close: clients read `cancelled` as exactly that.
    const reason = surface.closing && givenReason === 'done' ? 'cancelled' : givenReason;
    // Nested overlays a component opened go with it.
    for (const child of state.surfaces.filter((candidate) => candidate.parentId === surface.id)) {
      removeSurface(state, child, reason);
    }
    state.surfaces.splice(state.surfaces.indexOf(surface), 1);
    state.dirty.delete(surface);
    if (surface.pendingRegistered) {
      surface.pendingRegistered = false;
      try {
        pendingInput?.close(state.sessionId, surface.id);
      } catch {
        // Pending-input bookkeeping never blocks closing a surface.
      }
    }
    publish('extension.custom.dismiss', { surfaceId: surface.id, reason }, state.sessionId, directoryForSession(state.sessionId));
    if (state.focus?.surface === surface) {
      setComponentFocused(state.focus.component, false);
      state.focus = null;
      const next = topFocusable(state);
      if (next) focusSurface(state, next);
    }
    dropStateIfEmpty(state);
    return true;
  };

  const disposeComponent = (component) => {
    try {
      component?.dispose?.();
    } catch {
      // Pi ignores dispose errors too.
    }
  };

  /** True when `candidate` is `root` or an overlay nested under it. */
  const isWithin = (state, candidate, root) => {
    for (let current = candidate, depth = 0; current && depth <= state.surfaces.length; depth += 1) {
      if (current === root) return true;
      current = current.parentId ? state.surfaces.find((surface) => surface.id === current.parentId) : undefined;
    }
    return false;
  };

  /**
   * Keys reach a capturing surface, or a non-capturing one while it or an
   * overlay it opened holds focus: in Pi `nonCapturing` only keeps an
   * overlay from taking focus when shown, and `handle.focus()` (or a click
   * the component answers with `focus`) gives it the keys.
   */
  const takesKeys = (state, surface) => (
    surface.capturing || (state.focus?.surface != null && isWithin(state, state.focus.surface, surface))
  );

  /**
   * Overlays one `custom()` call opened through `tui.showOverlay`: children
   * of its surface, or, while its factory still runs, the ones it showed so
   * far. Never another call's overlays.
   */
  const ownedOverlays = (state, owner) => state.surfaces.filter((surface) => (
    owner.surface ? surface.parentId === owner.surface.id : owner.early.includes(surface)
  ));

  /**
   * A factory may show overlays from its constructor, before its own surface
   * exists (Pi's overlay focus demo does). They belong to that surface: its
   * Close and its end take them along, and keys sent to it reach them.
   */
  const adoptEarlyOverlays = (state, owner) => {
    for (const surface of owner.early.splice(0)) {
      if (!state.surfaces.includes(surface)) continue;
      surface.parentId = owner.surface.id;
      if (surface.pendingRegistered) {
        surface.pendingRegistered = false;
        try {
          pendingInput?.close(state.sessionId, surface.id);
        } catch {
          // Pending-input bookkeeping never blocks showing a surface.
        }
      }
      publishMeta(state, surface);
    }
  };

  /** Removes overlays a factory showed when its own surface never opens. */
  const dropEarlyOverlays = (state, owner, reason) => {
    for (const surface of owner.early.splice(0)) removeSurface(state, surface, reason);
  };

  /** False once `clear()` dropped this state (the session closed or reloaded). */
  const isLive = (state) => sessions.get(state.sessionId) === state;

  const addSurface = (state, fields) => {
    if (!isLive(state)) throw new Error('The session closed before the extension surface opened.');
    state.z += 1;
    const surface = {
      sessionId: state.sessionId,
      id: `custom-${randomUUID()}`,
      parentId: fields.parentId ?? null,
      component: fields.component,
      overlay: fields.overlay,
      options: fields.options,
      title: fields.title,
      blocked: fields.blocked,
      capturing: true,
      hidden: false,
      z: state.z,
      frame: null,
      settle: fields.settle ?? null,
      pendingRegistered: false,
      // Set once Close sent Esc; the timer ends the surface if it stays.
      closing: false,
      closeTimer: undefined,
    };
    // Through resolveOptions, so these options are the fallback if a later
    // call throws.
    surface.capturing = !(surface.overlay && resolveOptions(surface)?.nonCapturing === true);
    state.surfaces.push(surface);
    if (surface.capturing && !surface.parentId) {
      try {
        pendingInput?.open({
          sessionId: state.sessionId,
          directory: directoryForSession(state.sessionId),
          requestId: surface.id,
          kind: pendingKindFor(surface.blocked),
        });
        surface.pendingRegistered = true;
      } catch {
        // Pending-input bookkeeping never blocks showing a surface.
      }
    }
    try {
      // Focusing publishes the surface; otherwise publish it here.
      if (surface.capturing && isVisibleAt(state, surface)) focusSurface(state, surface);
      else publishMeta(state, surface);
      flushSurface(state, surface);
    } catch (error) {
      // Never leave a surface half-open: it would hold its pending-input
      // entry and block idle disposal with nothing able to close it.
      removeSurface(state, surface, 'cancelled');
      throw error;
    }
    return surface;
  };

  const makeHandle = (state, surface) => ({
    hide: () => {
      if (!state.surfaces.includes(surface)) return;
      if (surface.settle) {
        // Pi removes a hidden custom() overlay but leaves its promise to
        // `done()`. Keep the record so `done()` still settles it, and let
        // the user close it from the pending strip.
        surface.hidden = true;
        if (state.focus?.surface === surface) focusSurface(state, topFocusable(state, surface));
        publishMeta(state, surface);
        scheduleRender(state, surface);
        return;
      }
      removeSurface(state, surface, 'done');
    },
    setHidden: (hidden) => {
      const next = Boolean(hidden);
      if (surface.hidden === next || !state.surfaces.includes(surface)) return;
      surface.hidden = next;
      if (next && state.focus?.surface === surface) focusSurface(state, topFocusable(state, surface));
      if (!next && surface.capturing && isVisibleAt(state, surface)) {
        state.z += 1;
        surface.z = state.z;
        focusSurface(state, surface);
      }
      publishMeta(state, surface);
      scheduleRender(state, surface);
    },
    isHidden: () => surface.hidden,
    focus: () => {
      if (!state.surfaces.includes(surface) || !isVisibleAt(state, surface)) return;
      state.z += 1;
      surface.z = state.z;
      focusSurface(state, surface);
      publishMeta(state, surface);
    },
    unfocus: (options) => {
      if (state.focus?.surface !== surface) return;
      const target = options?.target;
      const owner = target ? state.surfaces.find((candidate) => candidate.component === target) : undefined;
      focusSurface(state, owner ?? topFocusable(state, surface));
    },
    isFocused: () => state.focus?.surface === surface,
    getBounds: () => {
      const layout = surface.frame?.layout;
      return layout ? { ...layout } : undefined;
    },
  });

  /** The TUI handed to factories. `owner` is filled once the surface exists. */
  const createTui = (state, owner, title) => {
    const terminal = {
      get columns() {
        return state.viewport.screenColumns;
      },
      get rows() {
        return state.viewport.rows;
      },
      kittyProtocolActive: false,
      write: () => {},
    };
    const stub = {
      terminal,
      mode: 'regular',
      children: [],
      fullRedraws: 0,
      requestRender: () => {
        if (owner.surface) scheduleRender(state, owner.surface);
        for (const surface of ownedOverlays(state, owner)) scheduleRender(state, surface);
      },
      setFocus: (component) => {
        if (!component) {
          focusSurface(state, null);
          return;
        }
        const target = state.surfaces.find((surface) => surface.component === component);
        if (target) {
          focusSurface(state, target);
          return;
        }
        // A child component of this surface, such as an Input inside a
        // Container: keys go to it directly, as in Pi.
        if (owner.surface) focusSurface(state, owner.surface, component);
      },
      getFocusedComponent: () => state.focus?.component ?? null,
      showOverlay: (component, options) => {
        // After the session closed, or after this command ended (an
        // extension may keep its tui and call this from a timer), a late
        // overlay is never shown: its parent is gone. The handle stays
        // callable as one for a removed overlay.
        if (!isLive(state) || owner.settled) return makeHandle(state, { hidden: false, frame: null });
        const surface = addSurface(state, {
          component,
          overlay: true,
          options,
          title,
          parentId: owner.surface?.id ?? null,
        });
        // Shown by the factory before its own surface exists; adopted by
        // that surface once it opens (see adoptEarlyOverlays).
        if (!owner.surface) owner.early.push(surface);
        return makeHandle(state, surface);
      },
      hideOverlay: () => {
        const nested = ownedOverlays(state, owner).sort((a, b) => b.z - a.z)[0];
        if (nested) removeSurface(state, nested, 'done');
      },
      hasOverlay: () => state.surfaces.some((surface) => surface.overlay && isVisibleAt(state, surface)),
      addChild: () => {},
      removeChild: () => {},
      clear: () => {},
      invalidate: () => {},
      render: () => [],
      getShowHardwareCursor: () => false,
      setShowHardwareCursor: () => {},
      getClearOnShrink: () => false,
      setClearOnShrink: () => {},
      addInputListener: () => () => {},
      removeInputListener: () => {},
      onTerminalColorSchemeChange: () => () => {},
      setTerminalColorSchemeNotifications: () => {},
      queryTerminalBackgroundColor: async () => undefined,
      queryTerminalColorScheme: async () => undefined,
      // D1: the terminal is never handed to an extension.
      stop: () => {
        throw terminalOnlyError();
      },
      start: () => {
        throw terminalOnlyError();
      },
    };
    return stub;
  };

  // ---------------------------------------------------------------- custom()

  /** `ctx.ui.custom()` for one session. */
  const open = async (sessionId, factory, options) => {
    if (typeof factory !== 'function') return undefined;
    await ensureTui();
    const state = stateFor(sessionId);
    const topLevel = state.surfaces.filter((surface) => surface.settle).length;
    if (topLevel >= MAX_SURFACES_PER_SESSION) {
      throw new Error('Too many extension surfaces are open in this session.');
    }
    const origin = describeOrigin(sessionId);
    const title = typeof origin === 'string' && origin.trim().length > 0
      ? origin.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TITLE_CHARS)
      : 'Extension';
    const owner = { surface: null, early: [], settled: false };
    return new Promise((resolve, reject) => {
      let component;
      const finish = (result, reason) => {
        if (owner.settled) return;
        owner.settled = true;
        const surface = owner.surface;
        if (surface) removeSurface(state, surface, reason);
        else dropEarlyOverlays(state, owner, reason);
        disposeComponent(component);
        resolve(result);
        onSettled(sessionId);
      };
      const done = (result) => finish(result, 'done');
      const stub = createTui(state, owner, title);
      Promise.resolve()
        .then(() => factory(stub, theme, keybindings, done))
        .then((created) => {
          component = created;
          // done() called during construction: Pi never shows the component.
          if (owner.settled) {
            disposeComponent(component);
            return;
          }
          // The session closed or reloaded while an async factory ran: its
          // state is gone, so the surface would be unreachable. Resolve as
          // the session closing would have.
          if (!component || typeof component.render !== 'function' || !isLive(state)) {
            owner.settled = true;
            if (isLive(state)) dropEarlyOverlays(state, owner, 'cancelled');
            if (component && !isLive(state)) disposeComponent(component);
            resolve(undefined);
            onSettled(sessionId);
            return;
          }
          const overlay = options?.overlay === true;
          const overlayOptions = overlay ? options?.overlayOptions : undefined;
          preferOpener(state);
          owner.surface = addSurface(state, {
            component,
            overlay,
            // Pi falls back to the component's own width without options.
            options: overlayOptions ?? (overlay && Number.isFinite(component.width) ? { width: component.width } : undefined),
            title,
            blocked: normalizeBlocked(options?.blocked),
            settle: (reason) => finish(undefined, reason),
          });
          adoptEarlyOverlays(state, owner);
          if (overlay && typeof options?.onHandle === 'function') {
            try {
              options.onHandle(makeHandle(state, owner.surface));
            } catch (error) {
              onError(sessionId, 'onHandle', error);
            }
          }
        })
        .catch((error) => {
          if (owner.settled) return;
          owner.settled = true;
          if (owner.surface) removeSurface(state, owner.surface, 'cancelled');
          else dropEarlyOverlays(state, owner, 'cancelled');
          onError(sessionId, 'factory', error);
          reject(error);
          onSettled(sessionId);
        });
    });
  };

  // ---------------------------------------------------------------- size

  const applyViewport = (state) => {
    if (state.sizeTimer) clearTimer(state.sizeTimer);
    state.sizeTimer = setTimer(() => {
      state.sizeTimer = undefined;
      try {
        resizeTo(state);
      } catch (error) {
        // Unreachable in practice (extension calls are guarded); a timer
        // callback must still never throw into the daemon process.
        onError(state.sessionId, 'resize', error);
      }
    }, SIZE_SETTLE_MS);
  };

  /** Applies the driver's viewport once it settled. */
  const resizeTo = (state) => {
    const next = state.driver ? state.clients.get(state.driver) : undefined;
    if (!next) return;
    const current = state.viewport;
    if (next.columns === current.columns && next.screenColumns === current.screenColumns && next.rows === current.rows) return;
    state.viewport = { ...next };
    for (const surface of state.surfaces) {
      try {
        surface.component.invalidate?.();
      } catch {
        // A failing invalidate still renders at the new size.
      }
    }
    // `visible()` can change with the size; focus follows what is shown.
    if (state.focus?.surface && !isVisibleAt(state, state.focus.surface)) focusSurface(state, topFocusable(state));
    else if (!state.focus) {
      const next = topFocusable(state);
      if (next) focusSurface(state, next);
    }
    scheduleAll(state);
  };

  const recordClient = (state, clientId, viewport, claim) => {
    if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 128) return;
    const normalized = normalizeCustomViewport(viewport);
    if (normalized) {
      state.clients.delete(clientId);
      state.clients.set(clientId, normalized);
      while (state.clients.size > MAX_CLIENTS_PER_SESSION) {
        const oldest = state.clients.keys().next().value;
        state.clients.delete(oldest);
        if (state.driver === oldest) state.driver = null;
      }
    }
    // The client whose prompt opened the surface drives once it reports
    // its size, unless another client acted first.
    if (claim || !state.driver || state.opener === clientId) {
      if (state.clients.has(clientId)) {
        state.driver = clientId;
        state.opener = null;
      }
    }
    if (state.driver === clientId) applyViewport(state);
  };

  /**
   * A new top-level surface is drawn at the size of the client that sent
   * the prompt that opened it: the device that ran the command sees it at
   * its own width. Its size applies now if known, else when it reports.
   */
  const preferOpener = (state) => {
    const opener = openerClientFor(state.sessionId);
    if (typeof opener !== 'string' || opener.length === 0 || opener.length > 128) return;
    if (state.clients.has(opener)) {
      state.opener = null;
      if (state.driver !== opener) {
        state.driver = opener;
        applyViewport(state);
      }
      return;
    }
    state.opener = opener;
  };

  // ------------------------------------------------------------------ mouse

  /**
   * A pi-tui mouse event for a surface. Coordinates are cells local to the
   * surface's frame, which is also its "screen": the browser reports them
   * per surface. The width is the one the component last rendered at, which
   * containers compare against their recorded child layout.
   */
  const mouseEvent = (surface, type, code, x, y, extra = {}) => ({
    type,
    button: type === 'wheel' ? 'none' : MOUSE_BUTTONS[code & 3],
    x,
    y,
    screenX: x,
    screenY: y,
    width: Math.max(1, surface.frame?.columns ?? 1),
    height: Math.max(1, surface.frame?.lines.length ?? 1),
    shift: (code & 4) !== 0,
    alt: (code & 8) !== 0,
    ctrl: (code & 16) !== 0,
    ...extra,
  });

  const clickCount = (state, component, x, y) => {
    const now = Date.now();
    const previous = state.lastClick;
    const count = previous && now - previous.at <= DOUBLE_CLICK_MS && previous.component === component
      && previous.x === x && previous.y === y
      ? (previous.count % 3) + 1
      : 1;
    state.lastClick = { at: now, count, component, x, y };
    return count;
  };

  /**
   * Applies a component's answer as pi-tui does: `focus` gives it the keys
   * (an overlay's own component, as Pi keeps overlays as focus owners),
   * `capture` routes the rest of the gesture to it. Returns whether to
   * render.
   */
  const applyMouseResult = (state, surface, event, result) => {
    let focusChanged = false;
    if (result.focus) {
      const component = surface.overlay ? surface.component : (result.focusTarget ?? result.target?.component ?? surface.component);
      focusChanged = state.focus?.surface !== surface || state.focus?.component !== component;
      focusSurface(state, surface, component);
    }
    if (result.capture && state.mouse?.surface === surface) state.mouse.capture = result.target;
    return result.render ?? (focusChanged || event.type === 'press' || event.type === 'click'
      || event.type === 'drag' || event.type === 'wheel');
  };

  /**
   * One SGR mouse report for a surface, routed the way pi-tui's
   * alternate-screen TUI routes it: a press goes to the component under the
   * pointer, which keeps the rest of the gesture; a release on the press
   * cell adds a click with its count; wheel steps carry `wheelDelta`.
   */
  const mouseItem = (state, surface, match) => {
    const code = Number(match[1]);
    const x = Math.max(0, Number(match[2]) - 1);
    const y = Math.max(0, Number(match[3]) - 1);
    const release = match[4] === 'm';
    const dispatch = (event, target) => {
      try {
        return target
          ? tui.dispatchMouseEvent(target.component, tui.retargetMouseEvent(event, target))
          : tui.dispatchMouseEvent(surface.component, event);
      } catch (error) {
        onError(state.sessionId, 'mouse', error);
        return undefined;
      }
    };
    if (state.mouse && (state.mouse.surface !== surface || !state.surfaces.includes(state.mouse.surface))) state.mouse = null;
    let render = false;
    if (code & 64) {
      if (release) return;
      const event = mouseEvent(surface, 'wheel', code, x, y, { wheelDelta: code & 1 ? 1 : -1 });
      const result = dispatch(event);
      if (result) render = applyMouseResult(state, surface, event, result);
    } else {
      const motion = (code & 32) !== 0;
      const type = release ? 'release' : motion ? (MOUSE_BUTTONS[code & 3] === 'none' ? 'move' : 'drag') : 'press';
      const event = mouseEvent(surface, type, code, x, y);
      const gesture = state.mouse;
      const target = gesture ? (gesture.capture ?? gesture.pressTarget) : undefined;
      if (gesture && target) {
        if (x !== gesture.x || y !== gesture.y) {
          gesture.moved = true;
          state.lastClick = null;
        }
        const result = dispatch(event, target);
        if (result) render = applyMouseResult(state, surface, event, result);
        if (release) {
          if (!gesture.moved && state.surfaces.includes(surface)) {
            const click = mouseEvent(surface, 'click', code, x, y, { clickCount: clickCount(state, target.component, x, y) });
            const clickResult = dispatch(click, target);
            if (clickResult) render = applyMouseResult(state, surface, click, clickResult) || render;
          }
          state.mouse = null;
        }
      } else {
        const result = dispatch(event);
        if (result) {
          if (type === 'press') state.mouse = { surface, pressTarget: result.target, capture: undefined, x, y, moved: false };
          render = applyMouseResult(state, surface, event, result);
        }
      }
    }
    // PiChamber sends no extension shortcuts (Pi's way back into a side
    // panel such as pi-btw's), so a press on a non-capturing overlay that
    // takes keys gives it focus when its component did not take it.
    if (!release && !(code & 96) && surface.overlay && !surface.capturing && typeof surface.component?.handleInput === 'function'
      && state.surfaces.includes(surface) && isVisibleAt(state, surface) && !takesKeys(state, surface)) {
      state.z += 1;
      surface.z = state.z;
      focusSurface(state, surface);
      publishMeta(state, surface);
      render = true;
    }
    if (render && state.surfaces.includes(surface)) scheduleRender(state, surface);
  };

  // ---------------------------------------------------------------- commands

  /**
   * Keys and mouse reports from a client. Items are terminal byte sequences,
   * one key, one bracketed paste or one SGR mouse report each, already split
   * the way Pi's stdin buffer splits. Keys go to a capturing surface, which
   * takes focus first, as a click does in Pi; mouse reports go to any shown
   * surface and move focus only when the component asks for it.
   */
  const input = ({ sessionId, surfaceId, clientId, viewport, items } = {}) => {
    const state = sessions.get(sessionId);
    const surface = findSurface(state, surfaceId);
    if (!surface) return { accepted: false };
    recordClient(state, clientId, viewport, true);
    if (!Array.isArray(items) || items.length === 0) return { accepted: true };
    const hasMouse = items.some((item) => typeof item === 'string' && item.startsWith('\x1b[<'));
    // The surface is open but takes no input right now (hidden at the
    // driver's size, or non-capturing without focus and this is not the
    // mouse): drop it, as Pi's TUI would. It is still open, so this is not
    // the "not open" answer that makes a client drop the surface.
    if (!isVisibleAt(state, surface) || (!takesKeys(state, surface) && !hasMouse)) return { accepted: true, delivered: false };
    let total = 0;
    let focused = false;
    for (const item of items.slice(0, MAX_INPUT_ITEMS)) {
      if (typeof item !== 'string' || item.length === 0) continue;
      total += item.length;
      if (total > MAX_INPUT_CHARS) break;
      if (!state.surfaces.includes(surface)) break;
      if (item.startsWith('\x1b[<')) {
        // Pi's TUI never hands a mouse report to handleInput, even one it
        // cannot parse.
        const match = SGR_MOUSE.exec(item);
        if (match) mouseItem(state, surface, match);
        continue;
      }
      if (!takesKeys(state, surface)) continue;
      // Keys for a surface whose child component or nested overlay holds
      // focus go there; any other surface takes focus first.
      if (!focused) {
        focused = true;
        const focusedSurface = state.focus?.surface;
        if (focusedSurface !== surface && focusedSurface?.parentId !== surface.id) focusSurface(state, surface);
      }
      const target = state.focus?.component;
      const owner = state.focus?.surface;
      if (!target || !owner || !state.surfaces.includes(owner)) break;
      // Keys typed at this surface stay with it and the overlays it opened.
      // Once a key closed it (Enter on a confirm), the rest of the batch is
      // dropped rather than landing in whatever surface took focus next.
      if (!isWithin(state, owner, surface)) break;
      try {
        target.handleInput?.(item);
      } catch (error) {
        onError(sessionId, 'input', error);
      }
      // Pi's TUI renders after every key it hands to a component.
      if (state.surfaces.includes(owner)) scheduleRender(state, owner);
    }
    return { accepted: true };
  };

  /** A client's viewport. `claim` makes it the driver (open or focus). */
  const reportViewport = ({ sessionId, clientId, viewport, claim } = {}) => {
    const state = sessions.get(sessionId);
    if (!state || state.surfaces.length === 0) return { accepted: false };
    recordClient(state, clientId, viewport, claim === true);
    return { accepted: true };
  };

  const forceClose = (state, surface) => {
    if (!state.surfaces.includes(surface)) return;
    if (surface.settle) surface.settle('cancelled');
    else removeSurface(state, surface, 'cancelled');
  };

  /**
   * The host Close button. Pi has none: components end on their own keys,
   * and extensions that keep a handle to their overlay (pi-btw) track it
   * open until their Esc handler runs. So Close first hands the surface's
   * component an Esc, whether or not it holds focus, as a key typed at it
   * would reach it (its focused child component when it holds focus). If the
   * surface is still open `CLOSE_GRACE_MS` later (Esc ignored, or used for
   * a confirmation), it ends as before: `custom()` resolves `undefined` and
   * nested overlays go with it. A second Close while it waits changes
   * nothing; a surface that ends in the meantime takes its timer along.
   */
  const close = ({ sessionId, surfaceId, clientId, viewport } = {}) => {
    const state = sessions.get(sessionId);
    const surface = findSurface(state, surfaceId);
    if (!surface) return { closed: false };
    recordClient(state, clientId, viewport, true);
    if (surface.closing) return { closed: true };
    surface.closing = true;
    const target = state.focus?.surface === surface ? state.focus.component : surface.component;
    if (typeof target?.handleInput !== 'function') {
      forceClose(state, surface);
      return { closed: true };
    }
    try {
      target.handleInput('\x1b');
    } catch (error) {
      onError(sessionId, 'input', error);
      forceClose(state, surface);
      return { closed: true };
    }
    if (!state.surfaces.includes(surface)) return { closed: true };
    // Pi's TUI renders after every key it hands to a component.
    scheduleRender(state, surface);
    surface.closeTimer = setTimer(() => {
      surface.closeTimer = undefined;
      forceClose(state, surface);
    }, CLOSE_GRACE_MS);
    return { closed: true };
  };

  /**
   * Brings a panel a command opened with `tui.showOverlay` to the front and
   * gives it the keys, as `handle.focus()` would: the browser's tab stack
   * calls this when the user picks a tab. Only nested overlays are offered
   * as tabs, so only they are accepted. The panel's family redraws, since
   * extensions read `isFocused()` while rendering.
   */
  const focus = ({ sessionId, surfaceId, clientId, viewport } = {}) => {
    const state = sessions.get(sessionId);
    const surface = findSurface(state, surfaceId);
    if (!surface || !surface.overlay || !surface.parentId || !isVisibleAt(state, surface)) return { focused: false };
    recordClient(state, clientId, viewport, true);
    state.z += 1;
    surface.z = state.z;
    focusSurface(state, surface);
    publishMeta(state, surface);
    // Bounded, and stops at a missing parent, so a broken chain cannot hang
    // the daemon.
    let root = surface;
    for (let depth = 0; root.parentId && depth <= state.surfaces.length; depth += 1) {
      const parent = state.surfaces.find((candidate) => candidate.id === root.parentId);
      if (!parent) break;
      root = parent;
    }
    for (const candidate of state.surfaces) {
      if (candidate === root || isWithin(state, candidate, root)) scheduleRender(state, candidate);
    }
    return { focused: true };
  };

  /** Publishes full frames again, for a client that missed a patch. */
  const refresh = ({ sessionId, surfaceId } = {}) => {
    const state = sessions.get(sessionId);
    if (!state) return { refreshed: false };
    let refreshed = false;
    for (const surface of state.surfaces) {
      if (surfaceId && surface.id !== surfaceId) continue;
      if (!surface.frame) continue;
      publishTransient('extension.custom.frame', fullFrame(surface), sessionId, directoryForSession(sessionId));
      refreshed = true;
    }
    return { refreshed };
  };

  /** Ends every surface of a session (or all sessions) with `reason`. */
  const clear = (sessionId, reason = 'session-closed') => {
    const targets = sessionId ? [sessions.get(sessionId)].filter(Boolean) : [...sessions.values()];
    for (const state of targets) {
      for (const surface of [...state.surfaces].reverse()) {
        if (!state.surfaces.includes(surface)) continue;
        if (surface.settle) surface.settle(reason);
        else removeSurface(state, surface, reason);
      }
      if (state.renderTimer) clearTimer(state.renderTimer);
      if (state.sizeTimer) clearTimer(state.sizeTimer);
      sessions.delete(state.sessionId);
    }
  };

  /** Surface stack with full frames, for snapshots and `sessions.open`. */
  const snapshot = (sessionId) => {
    const state = sessions.get(sessionId);
    if (!state || state.surfaces.length === 0) return undefined;
    return state.surfaces.map((surface) => ({
      ...projectMeta(state, surface),
      ...(surface.frame ? { frame: fullFrame(surface) } : {}),
    }));
  };

  /** Current full frames, written to a client that attached by replay. */
  const keyframes = (sessionId) => {
    const out = [];
    for (const state of sessions.values()) {
      if (sessionId && state.sessionId !== sessionId) continue;
      for (const surface of state.surfaces) {
        if (surface.frame) out.push({ sessionId: state.sessionId, payload: fullFrame(surface) });
      }
    }
    return out;
  };

  const hasOpenSurfaces = (sessionId) => (sessions.get(sessionId)?.surfaces.length ?? 0) > 0;

  return {
    open,
    input,
    reportViewport,
    close,
    focus,
    refresh,
    clear,
    snapshot,
    keyframes,
    hasOpenSurfaces,
  };
};
