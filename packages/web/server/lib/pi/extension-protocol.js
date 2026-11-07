export const MAX_EXTENSION_APP_HTML_CHARS = 200_000;
const MAX_EXTENSION_FORM_FIELDS = 12;
const MAX_EXTENSION_FORM_OPTIONS = 20;

const FORM_FIELD_TYPES = new Set(['text', 'textarea', 'number', 'select', 'checkbox']);

/**
 * Normalize extension-authored form descriptors at both sides of the private
 * daemon IPC seam. Keeping this in one module prevents the daemon bridge and
 * public route projection from accepting different field shapes.
 */
export const sanitizeExtensionFormFields = (fields) => {
  if (!Array.isArray(fields)) return [];
  return fields.slice(0, MAX_EXTENSION_FORM_FIELDS).flatMap((field) => {
    if (!field || typeof field !== 'object') return [];
    const id = typeof field.id === 'string' ? field.id.slice(0, 128) : '';
    const label = typeof field.label === 'string' ? field.label.slice(0, 256) : '';
    if (!id || !label) return [];
    return [{
      id,
      label,
      type: FORM_FIELD_TYPES.has(field.type) ? field.type : 'text',
      ...(field.required === true ? { required: true } : {}),
      ...(typeof field.placeholder === 'string' ? { placeholder: field.placeholder.slice(0, 256) } : {}),
      ...(Array.isArray(field.options)
        ? {
            options: field.options
              .filter((option) => typeof option === 'string')
              .map((option) => option.slice(0, 256))
              .slice(0, MAX_EXTENSION_FORM_OPTIONS),
          }
        : {}),
      ...(typeof field.initial === 'string' ? { initial: field.initial.slice(0, 2_000) } : {}),
      ...(Number.isFinite(field.min) ? { min: field.min } : {}),
      ...(Number.isFinite(field.max) ? { max: field.max } : {}),
    }];
  });
};

/** Validate a form answer against the exact descriptor sent to the client. */
export const validateExtensionFormValues = (fields, values) => {
  if (!Array.isArray(fields) || !values || typeof values !== 'object' || Array.isArray(values)) return false;
  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  for (const key of Object.keys(values)) if (!fieldsById.has(key)) return false;
  for (const field of fields) {
    const value = values[field.id];
    if (field.required === true && (typeof value !== 'string' || value.length === 0)) return false;
    if (value === undefined || value.length === 0) continue;
    if (typeof value !== 'string') return false;
    if (field.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) return false;
      if (typeof field.min === 'number' && number < field.min) return false;
      if (typeof field.max === 'number' && number > field.max) return false;
    } else if (field.type === 'select' && !field.options?.includes(value)) {
      return false;
    } else if (field.type === 'checkbox' && value !== 'true' && value !== 'false') {
      return false;
    }
  }
  return true;
};

// ---------------------------------------------------------------- custom()
//
// Public shapes for `ctx.ui.custom()` surfaces (extension-custom-host.js).
// Routes re-apply these bounds to every event and snapshot, so a malformed
// daemon payload is dropped instead of reaching browsers.

export const MAX_CUSTOM_FRAME_LINES = 200;
/**
 * UTF-16 code units in one frame line, escape sequences included. A cell in
 * 24-bit colour with its own foreground and background (pi-doom's half
 * blocks) costs about 40, so this fits such a line about 400 cells wide.
 */
export const MAX_CUSTOM_LINE_CHARS = 16_384;
/** One input request: at most this many items (keys or pastes)... */
export const MAX_CUSTOM_INPUT_ITEMS = 256;
/** ...and this many characters (UTF-16 code units) across all of them. */
export const MAX_CUSTOM_INPUT_CHARS = 64 * 1024;

/** True for a valid `extensions.custom.input` item list. */
export const isValidCustomInputItems = (items) => {
  if (!Array.isArray(items) || items.length > MAX_CUSTOM_INPUT_ITEMS) return false;
  let total = 0;
  for (const item of items) {
    if (typeof item !== 'string' || item.length === 0) return false;
    total += item.length;
    if (total > MAX_CUSTOM_INPUT_CHARS) return false;
  }
  return true;
};
const CUSTOM_SURFACE_DISMISS_REASONS = Object.freeze([
  'done', 'cancelled', 'session-closed', 'reload', 'daemon-stopped',
]);
const MAX_CUSTOM_SURFACE_ID_CHARS = 128;
const MAX_CUSTOM_CELL = 400;

const isCustomSurfaceId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_CUSTOM_SURFACE_ID_CHARS;
const isCell = (value, max = MAX_CUSTOM_CELL) => Number.isSafeInteger(value) && value >= 0 && value <= max;

/** `{ graphemeIndex: width }` for one line, or `undefined`. */
const projectLineCells = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  let out;
  for (const [key, width] of Object.entries(value)) {
    const index = Number(key);
    if (!isCell(index, MAX_CUSTOM_LINE_CHARS) || !isCell(width, 4)) continue;
    (out ??= {})[index] = width;
  }
  return out;
};

const projectCursor = (value) => (value && isCell(value.row, MAX_CUSTOM_FRAME_LINES) && isCell(value.col)
  ? { row: value.row, col: value.col }
  : null);

const projectLayout = (value) => (value && isCell(value.row) && isCell(value.col) && isCell(value.width) && isCell(value.height, MAX_CUSTOM_FRAME_LINES)
  ? { row: value.row, col: value.col, width: value.width, height: value.height }
  : null);

const isFrameLine = (line) => typeof line === 'string' && line.length <= MAX_CUSTOM_LINE_CHARS;

/** A full frame or a patch; `null` when malformed. */
export const projectCustomFrame = (value) => {
  if (!value || typeof value !== 'object' || !isCustomSurfaceId(value.surfaceId)) return null;
  if (!Number.isSafeInteger(value.version) || value.version < 1) return null;
  if (!isCell(value.length, MAX_CUSTOM_FRAME_LINES)) return null;
  if (!isCell(value.columns) || !isCell(value.screenColumns) || !isCell(value.rows)) return null;
  const common = {
    surfaceId: value.surfaceId,
    version: value.version,
    length: value.length,
    cursor: projectCursor(value.cursor),
    layout: projectLayout(value.layout),
    visible: value.visible !== false,
    columns: value.columns,
    screenColumns: value.screenColumns,
    rows: value.rows,
  };
  if (Array.isArray(value.lines)) {
    if (value.lines.length !== value.length || !value.lines.every(isFrameLine)) return null;
    let cells;
    if (value.cells && typeof value.cells === 'object' && !Array.isArray(value.cells)) {
      for (const [key, lineCells] of Object.entries(value.cells)) {
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) continue;
        const projected = projectLineCells(lineCells);
        if (projected) (cells ??= {})[index] = projected;
      }
    }
    return { ...common, lines: [...value.lines], ...(cells ? { cells } : {}) };
  }
  if (!Number.isSafeInteger(value.base) || value.base < 1 || value.base >= value.version) return null;
  if (!Array.isArray(value.changes) || value.changes.length > MAX_CUSTOM_FRAME_LINES) return null;
  const changes = [];
  for (const change of value.changes) {
    if (!change || !Number.isSafeInteger(change.index) || change.index < 0 || change.index >= value.length) return null;
    if (!isFrameLine(change.line)) return null;
    const cells = projectLineCells(change.cells);
    changes.push({ index: change.index, line: change.line, ...(cells ? { cells } : {}) });
  }
  return { ...common, base: value.base, changes };
};

/** Surface metadata (`extension.custom`); `null` when malformed. */
export const projectCustomSurface = (value) => {
  if (!value || typeof value !== 'object' || !isCustomSurfaceId(value.surfaceId)) return null;
  if (value.mode !== 'inline' && value.mode !== 'overlay') return null;
  if (!Number.isSafeInteger(value.z) || value.z < 0) return null;
  const title = typeof value.title === 'string'
    ? value.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 128)
    : '';
  const blocked = value.blocked && ['permission', 'question', 'auth'].includes(value.blocked.kind)
    ? {
      kind: value.blocked.kind,
      message: typeof value.blocked.message === 'string' ? value.blocked.message.slice(0, 256) : '',
    }
    : undefined;
  return {
    surfaceId: value.surfaceId,
    ...(isCustomSurfaceId(value.parentId) ? { parentId: value.parentId } : {}),
    title: title || 'Extension',
    mode: value.mode,
    capturing: value.capturing === true,
    hidden: value.hidden === true,
    focused: value.focused === true,
    z: value.z,
    ...(blocked ? { blocked } : {}),
  };
};

/** A dismiss event payload; `null` when malformed. */
export const projectCustomDismiss = (value) => {
  if (!value || !isCustomSurfaceId(value.surfaceId)) return null;
  if (!CUSTOM_SURFACE_DISMISS_REASONS.includes(value.reason)) return null;
  return { surfaceId: value.surfaceId, reason: value.reason };
};

/** Snapshot surface stack: metadata plus each surface's full frame. */
export const projectCustomSurfaces = (value) => {
  if (!Array.isArray(value)) return undefined;
  const surfaces = [];
  for (const entry of value.slice(0, 32)) {
    const meta = projectCustomSurface(entry);
    if (!meta) continue;
    const frame = entry.frame ? projectCustomFrame(entry.frame) : null;
    surfaces.push({ ...meta, ...(frame?.lines && frame.surfaceId === meta.surfaceId ? { frame } : {}) });
  }
  return surfaces;
};
