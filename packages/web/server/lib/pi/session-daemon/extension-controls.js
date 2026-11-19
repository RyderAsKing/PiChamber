// Composer controls declared by Pi extensions.
//
// A plain Pi extension puts a control in PiChamber's composer by emitting
// `pichamber:composer` on Pi's shared extension event bus (`pi.events`). The
// Pi CLI has no listener, so the same extension keeps working there through
// its own slash commands. Each control names the extension's own commands; a
// click in PiChamber runs one of them as if it had been typed, and the
// extension reports its new value by emitting again. The extension stays the
// only source of truth for the value.
//
//   pi.events.emit('pichamber:composer', {
//     id: 'mode', kind: 'cycle', label: 'Mode', value: 'balance',
//     options: [{ value: 'economy', label: 'Economy', command: 'economy' }, ...],
//   });
//   pi.events.emit('pichamber:composer', { id: 'mode', remove: true });
//
// Kinds: `toggle` (`value: boolean`, `command` flips it), `cycle` (`value`,
// 2 to 12 `options`, each with its own command), `action` (`command` only).

// Command names and arguments follow the rule every extension surface shares.
import { parseExtensionCommandText } from '../extension-commands.js';

export const COMPOSER_CONTROL_EVENT = 'pichamber:composer';

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ICON_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const KINDS = new Set(['toggle', 'cycle', 'action']);
export const MAX_CONTROLS_PER_SESSION = 16;
const MAX_OPTIONS = 12;
const MAX_PENDING = 64;

const cleanText = (value, max) => (typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  : '');

/**
 * Validate one `pichamber:composer` payload. Returns the control,
 * `{ id, remove: true }`, or null when the payload is not usable (it is then
 * ignored, like a malformed status).
 */
export const parseComposerControl = (raw) => {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return null;
  const id = raw.id;
  // `remove: true` is the documented form; `removed: true` (what panels and
  // app surfaces took first) is accepted as well.
  if (raw.remove === true || raw.removed === true) return { id, remove: true };
  if (!KINDS.has(raw.kind)) return null;
  const label = cleanText(raw.label, 40);
  if (!label) return null;
  const description = cleanText(raw.description, 200);
  const common = {
    id,
    kind: raw.kind,
    label,
    ...(description ? { description } : {}),
    ...(typeof raw.icon === 'string' && ICON_PATTERN.test(raw.icon) ? { icon: raw.icon } : {}),
  };
  if (raw.kind === 'cycle') {
    if (!Array.isArray(raw.options)) return null;
    const options = [];
    for (const option of raw.options.slice(0, MAX_OPTIONS)) {
      const value = cleanText(option?.value, 40);
      const optionLabel = cleanText(option?.label, 40) || value;
      const command = parseExtensionCommandText(option?.command);
      if (!value || !command || options.some((existing) => existing.value === value)) return null;
      options.push({ value, label: optionLabel, command });
    }
    if (options.length < 2) return null;
    const value = typeof raw.value === 'string' && options.some((option) => option.value === raw.value) ? raw.value : undefined;
    return { ...common, options, ...(value !== undefined ? { value } : {}) };
  }
  const command = parseExtensionCommandText(raw.command);
  if (!command) return null;
  if (raw.kind === 'toggle') return { ...common, command, value: raw.value === true };
  return { ...common, command };
};

/**
 * Per-session control state, kept for snapshots and reconnects like extension
 * statuses. `publish(sessionId, payload)` sends `extension.control` live.
 */
export const createComposerControls = ({ publish }) => {
  const bySession = new Map();

  const set = (sessionId, raw) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
    const control = parseComposerControl(raw);
    if (!control) return false;
    const controls = bySession.get(sessionId) ?? new Map();
    if (control.remove) {
      if (!controls.delete(control.id)) return false;
      if (controls.size === 0) bySession.delete(sessionId);
      publish(sessionId, { id: control.id, removed: true });
      return true;
    }
    // A session keeps its first 16 controls; another one is ignored.
    if (!controls.has(control.id) && controls.size >= MAX_CONTROLS_PER_SESSION) return false;
    controls.set(control.id, control);
    bySession.set(sessionId, controls);
    publish(sessionId, { control });
    return true;
  };

  /** Drop a session's controls, telling clients each one is gone. */
  const clear = (sessionId) => {
    const controls = bySession.get(sessionId);
    if (!controls) return;
    bySession.delete(sessionId);
    for (const id of controls.keys()) publish(sessionId, { id, removed: true });
  };

  const snapshot = (sessionId) => {
    const controls = bySession.get(sessionId);
    return controls?.size ? [...controls.values()] : undefined;
  };

  /**
   * The command a click asks for. `value` is the value the client wants:
   * `true`/`false` for a toggle, an option value for a cycle, nothing for an
   * action. A value the control already has needs no command (`{ command:
   * null }`), so a repeated click cannot flip a toggle twice.
   */
  const resolve = (sessionId, id, value) => {
    const control = bySession.get(sessionId)?.get(id);
    if (!control) return { error: 'CONTROL_NOT_FOUND' };
    if (control.kind === 'action') return { control, command: control.command };
    if (control.kind === 'toggle') {
      if (typeof value !== 'boolean') return { error: 'INVALID_ARGUMENT' };
      return { control, command: value === control.value ? null : control.command };
    }
    const option = control.options.find((candidate) => candidate.value === value);
    if (!option) return { error: 'INVALID_ARGUMENT' };
    return { control, command: value === control.value ? null : option.command };
  };

  const sessionIds = () => [...bySession.keys()];

  return { set, clear, snapshot, resolve, sessionIds };
};

/**
 * The extension factory that listens on a runtime's event bus. One runtime
 * hosts one session; the id is known from `session_start`, which reaches
 * this factory after the user's extensions (Pi loads factories last), so
 * controls emitted before it are held until then.
 */
const COMPOSER_CONTROLS_EXTENSION_NAME = 'pichamber:composer-controls';

/** Pi labels a named factory `<inline:name>`; this one is not listed as an extension. */
export const isComposerControlsExtensionPath = (extensionPath) => extensionPath === `<inline:${COMPOSER_CONTROLS_EXTENSION_NAME}>`;

export const createComposerControlsExtension = (onControl) => ({
  name: COMPOSER_CONTROLS_EXTENSION_NAME,
  hidden: true,
  factory: (pi) => {
    let sessionId;
    const pending = [];
    pi.events?.on?.(COMPOSER_CONTROL_EVENT, (data) => {
      if (sessionId) onControl(sessionId, data);
      else if (pending.length < MAX_PENDING) pending.push(data);
    });
    pi.on?.('session_start', (_event, ctx) => {
      const id = ctx?.sessionManager?.getSessionId?.();
      if (typeof id !== 'string' || id.length === 0) return;
      sessionId = id;
      for (const data of pending.splice(0)) onControl(sessionId, data);
    });
  },
});
