const CURSOR_PROBE_INTERVAL_MS = 80;
// Chrome answers a wheel event only after the page has handled it, which on
// a busy page takes longer than a trackpad waits between events. Wheel
// movement that arrives meanwhile is added up and sent as one event, so
// scrolling never falls behind the person's hand.
const MAX_WHEEL_DELTA = 10_000;
const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const BUTTON_BITS = { left: 1, right: 2, middle: 4 };

const modifierMask = (modifiers) => {
  if (!modifiers || typeof modifiers !== 'object') return 0;
  let mask = 0;
  for (const [name, bit] of Object.entries(MODIFIER_BITS)) {
    if (modifiers[name] === true) mask |= bit;
  }
  return mask;
};

const clampWheel = (value) => Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, value));

/**
 * Editing commands for keyboard shortcuts. Headless Chrome on Linux does not
 * map Cmd shortcuts (a Mac client) or copy/cut to editing commands, so they
 * are sent explicitly. Ctrl+Z and Ctrl+A already work there; adding commands
 * for them too would apply undo twice.
 */
export const editingCommandsForKey = ({ key, modifiers }) => {
  if (typeof key !== 'string' || key.length !== 1) return [];
  const lower = key.toLowerCase();
  const meta = modifiers?.meta === true;
  const ctrl = modifiers?.ctrl === true;
  if (!meta && !ctrl) return [];
  if (lower === 'c') return ['copy'];
  if (lower === 'x') return ['cut'];
  if (!meta) return [];
  if (lower === 'a') return ['selectAll'];
  if (lower === 'z') return [modifiers?.shift === true ? 'redo' : 'undo'];
  return [];
};

/**
 * Mouse, wheel, and keyboard input for one page. Mouse moves and wheel
 * movement never wait for Chrome: while one is on its way, newer moves
 * replace it and newer wheel movement is added up. Any other input first
 * waits for them.
 *
 * Each viewer's pressed buttons and keys are remembered, so a viewer that
 * disconnects mid-drag or mid-shortcut does not leave them held down.
 */
export const createTabInput = ({ onInput, onScroll = () => {}, cursorAt, onCursor, takeCopy, onCopied }) => {
  let send = null;
  let closed = false;
  let pendingMove = null;
  let moveInFlight = false;
  const pendingWheels = [];
  let wheelDispatch = null;
  let lastCursorProbe = 0;
  let cursorTimer = null;

  const dispatch = (method, params) => (send ? send(method, params).catch(() => {}) : Promise.resolve());

  const probeCursor = (x, y) => {
    const wait = CURSOR_PROBE_INTERVAL_MS - (Date.now() - lastCursorProbe);
    clearTimeout(cursorTimer);
    if (wait > 0) {
      cursorTimer = setTimeout(() => probeCursor(x, y), wait);
      cursorTimer.unref?.();
      return;
    }
    lastCursorProbe = Date.now();
    void cursorAt(x, y).then((cursor) => {
      if (!closed && typeof cursor === 'string') onCursor(cursor);
    }, () => {});
  };

  const dispatchMove = async () => {
    if (moveInFlight || !pendingMove) return;
    const move = pendingMove;
    pendingMove = null;
    moveInFlight = true;
    // A failed move is superseded by the next one.
    await dispatch('Input.dispatchMouseEvent', move);
    moveInFlight = false;
    if (pendingMove) void dispatchMove();
    else probeCursor(move.x, move.y);
  };

  const flushMove = async () => {
    if (!pendingMove) return;
    const move = pendingMove;
    pendingMove = null;
    await dispatch('Input.dispatchMouseEvent', move);
  };

  const deliverWheel = async () => {
    while (pendingWheels.length > 0) await dispatch('Input.dispatchMouseEvent', pendingWheels.shift());
    wheelDispatch = null;
  };

  const queueWheel = (event) => {
    const last = pendingWheels.at(-1);
    // Different modifiers (a pinch is ctrl+wheel) start a new event.
    if (last && last.modifiers === event.modifiers) {
      pendingWheels[pendingWheels.length - 1] = {
        ...event,
        deltaX: clampWheel(last.deltaX + event.deltaX),
        deltaY: clampWheel(last.deltaY + event.deltaY),
      };
    } else {
      pendingWheels.push(event);
    }
    wheelDispatch ??= deliverWheel();
  };

  /** Waits until all wheel movement so far has reached the page. */
  const flushWheel = async () => {
    while (wheelDispatch) await wheelDispatch;
  };

  const pressedOf = (viewer) => {
    viewer.pressed ??= { buttons: new Map(), keys: new Map() };
    return viewer.pressed;
  };

  const handleMouse = async (message, viewer = {}) => {
    onInput();
    const x = Number(message.x);
    const y = Number(message.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const modifiers = modifierMask(message.modifiers);
    const button = ['left', 'middle', 'right'].includes(message.button) ? message.button : 'none';
    const buttons = Number.isInteger(message.buttons) ? message.buttons : 0;
    if (message.action === 'move') {
      pendingMove = { type: 'mouseMoved', x, y, modifiers, button, buttons };
      void dispatchMove();
      return;
    }
    await flushMove();
    if (message.action === 'wheel') {
      onScroll();
      queueWheel({ type: 'mouseWheel', x, y, deltaX: clampWheel(Number(message.deltaX) || 0), deltaY: clampWheel(Number(message.deltaY) || 0), modifiers });
      return;
    }
    await flushWheel();
    if (message.action !== 'down' && message.action !== 'up') return;
    const down = message.action === 'down';
    if (button !== 'none') {
      if (down) pressedOf(viewer).buttons.set(button, { x, y });
      else pressedOf(viewer).buttons.delete(button);
    }
    await dispatch('Input.dispatchMouseEvent', {
      type: down ? 'mousePressed' : 'mouseReleased',
      x,
      y,
      modifiers,
      button,
      buttons: buttons || (down ? BUTTON_BITS[button] || 0 : 0),
      clickCount: Math.max(1, Math.min(3, Number(message.clickCount) || 1)),
    });
  };

  const handleKey = async (message, viewer = {}) => {
    onInput();
    if (message.action !== 'down' && message.action !== 'up') return;
    const key = typeof message.key === 'string' ? message.key.slice(0, 32) : '';
    if (!key) return;
    const down = message.action === 'down';
    const modifiers = modifierMask(message.modifiers);
    const code = typeof message.code === 'string' ? message.code.slice(0, 32) : '';
    const keyCode = Number.isInteger(message.keyCode) ? message.keyCode : 0;
    const shortcut = message.modifiers?.ctrl === true || message.modifiers?.meta === true || message.modifiers?.alt === true;
    let text = '';
    if (down && !shortcut) {
      if (key === 'Enter') text = '\r';
      else if (key.length === 1) text = key;
    }
    const params = {
      type: !down ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
      autoRepeat: message.repeat === true,
      location: Number.isInteger(message.location) ? message.location : 0,
    };
    if (text) {
      params.text = text;
      params.unmodifiedText = text;
    }
    const commands = down ? editingCommandsForKey({ key, modifiers: message.modifiers }) : [];
    if (commands.length > 0) params.commands = commands;
    if (down) pressedOf(viewer).keys.set(code || key, { key, code, keyCode });
    else pressedOf(viewer).keys.delete(code || key);
    await flushMove();
    const copies = commands.includes('copy') || commands.includes('cut');
    // Drop anything recorded earlier, so only this key's copy is reported.
    if (copies) await takeCopy().catch(() => '');
    await dispatch('Input.dispatchKeyEvent', params);
    if (!copies) return;
    const copied = await takeCopy().catch(() => '');
    if (typeof copied === 'string' && copied) onCopied(copied);
  };

  return {
    bind(nextSend) {
      send = nextSend;
      pendingMove = null;
      pendingWheels.length = 0;
    },

    handleMouse,
    handleKey,

    async insertText(text) {
      onInput();
      if (typeof text !== 'string' || !text) return;
      await flushMove();
      await dispatch('Input.insertText', { text: text.slice(0, 1_000_000) });
    },

    /** Lets go of everything a disconnecting viewer still holds down. */
    async releaseViewer(viewer) {
      const pressed = viewer.pressed;
      if (!pressed) return;
      viewer.pressed = null;
      for (const { key, code, keyCode } of pressed.keys.values()) {
        await dispatch('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
      }
      for (const [button, { x, y }] of pressed.buttons) {
        await dispatch('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
      }
    },

    close() {
      closed = true;
      clearTimeout(cursorTimer);
      send = null;
    },
  };
};
