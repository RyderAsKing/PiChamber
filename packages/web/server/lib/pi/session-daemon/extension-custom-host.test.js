import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExtensionCustomHost, normalizeCustomViewport } from './extension-custom-host.js';
import { MAX_CUSTOM_LINE_CHARS, projectCustomFrame, projectCustomSurface, projectCustomSurfaces } from '../extension-protocol.js';

const SESSION = 'session-1';
const CURSOR = '\x1b_pi:c\x07';

const flushPromises = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};
const DATABASES = ['PostgreSQL', 'SQLite', 'ClickHouse', 'DuckDB', 'MySQL', 'Redis'];

/** A list component like Pi's SelectList: arrows move, Enter picks, Escape cancels. */
const listComponent = (items, done, extra = {}) => {
  let selected = 0;
  return {
    focused: false,
    render: (width) => items.map((item, index) => `${index === selected ? '>' : ' '} ${item}`.padEnd(width).slice(0, width)),
    handleInput: (data) => {
      if (data === '\x1b[B') selected = Math.min(items.length - 1, selected + 1);
      else if (data === '\x1b[A') selected = Math.max(0, selected - 1);
      else if (data === '\r') done(items[selected]);
      else if (data === '\x1b') done(undefined);
    },
    invalidate: vi.fn(),
    dispose: vi.fn(),
    ...extra,
  };
};

const createHarness = (overrides = {}) => {
  const events = [];
  const transient = [];
  const pending = [];
  const errors = [];
  const settled = [];
  const host = createExtensionCustomHost({
    publish: (event, payload, sessionId) => events.push({ event, payload, sessionId }),
    publishTransient: (event, payload, sessionId) => transient.push({ event, payload, sessionId }),
    pendingInput: {
      open: (entry) => pending.push({ op: 'open', ...entry }),
      close: (sessionId, requestId) => pending.push({ op: 'close', sessionId, requestId }),
    },
    directoryForSession: () => '/repo',
    theme: { fg: (_name, text) => text },
    describeOrigin: () => 'question',
    onSettled: (sessionId) => settled.push(sessionId),
    onError: (sessionId, stage, error) => errors.push({ sessionId, stage, message: String(error?.message ?? error) }),
    ...overrides,
  });
  const frames = (surfaceId) => transient.filter((entry) => entry.event === 'extension.custom.frame' && entry.payload.surfaceId === surfaceId);
  const lastMeta = (surfaceId) => events.filter((entry) => entry.event === 'extension.custom' && entry.payload.surfaceId === surfaceId).at(-1)?.payload;
  const opened = () => events.filter((entry) => entry.event === 'extension.custom').map((entry) => entry.payload.surfaceId);
  return { host, events, transient, pending, errors, settled, frames, lastMeta, opened };
};

describe('normalizeCustomViewport', () => {
  it('clamps sizes and defaults the screen to the column width', () => {
    expect(normalizeCustomViewport({ columns: 5, rows: 500 })).toEqual({ columns: 20, screenColumns: 20, rows: 80 });
    expect(normalizeCustomViewport({ columns: 90.7, rows: 30, screenColumns: 1000 })).toEqual({ columns: 90, screenColumns: 400, rows: 30 });
    expect(normalizeCustomViewport({ columns: 'wide', rows: 30 })).toBeUndefined();
    expect(normalizeCustomViewport(null)).toBeUndefined();
  });
});

describe('createExtensionCustomHost', () => {
  // The first custom() loads pi-tui from the installed SDK.
  beforeAll(async () => {
    const harness = createHarness();
    const result = harness.host.open(SESSION, (_t, _th, _kb, done) => listComponent(['warm'], done));
    await vi.waitFor(() => expect(harness.opened()).toHaveLength(1));
    harness.host.clear(SESSION);
    await result;
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows an inline surface, routes keys, and resolves done() with the result', async () => {
    const harness = createHarness();
    const result = harness.host.open(SESSION, (_tui, _theme, keybindings, done) => {
      expect(typeof keybindings?.matches).toBe('function');
      return listComponent(DATABASES, done);
    }, { blocked: { kind: 'question', message: 'Pick a database' } });
    await flushPromises();
    const [surfaceId] = harness.opened();
    expect(harness.lastMeta(surfaceId)).toMatchObject({
      mode: 'inline', capturing: true, focused: true, title: 'question', blocked: { kind: 'question', message: 'Pick a database' },
    });
    expect(harness.pending).toEqual([{ op: 'open', sessionId: SESSION, directory: '/repo', requestId: surfaceId, kind: 'input' }]);
    const first = harness.frames(surfaceId)[0].payload;
    expect(first.lines).toHaveLength(6);
    expect(first.lines[0].startsWith('> PostgreSQL')).toBe(true);
    expect(first.columns).toBe(100);

    expect(harness.host.input({ sessionId: SESSION, surfaceId, clientId: 'a', items: ['\x1b[B'] })).toEqual({ accepted: true });
    vi.advanceTimersByTime(40);
    const patch = harness.frames(surfaceId).at(-1).payload;
    expect(patch.base).toBe(first.version);
    expect(patch.changes.map((change) => change.index)).toEqual([0, 1]);

    harness.host.input({ sessionId: SESSION, surfaceId, clientId: 'a', items: ['\r'] });
    await expect(result).resolves.toBe('SQLite');
    expect(harness.events.at(-1)).toMatchObject({ event: 'extension.custom.dismiss', payload: { surfaceId, reason: 'done' } });
    expect(harness.pending.at(-1)).toEqual({ op: 'close', sessionId: SESSION, requestId: surfaceId });
    expect(harness.host.hasOpenSurfaces(SESSION)).toBe(false);
    expect(harness.settled).toEqual([SESSION]);
  });

  it('draws a key at once after a quiet spell and holds busy redraws to 33 ms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const harness = createHarness();
    void harness.host.open(SESSION, (_tui, _theme, _kb, done) => listComponent(DATABASES, done));
    await flushPromises();
    const [surfaceId] = harness.opened();
    const count = () => harness.frames(surfaceId).length;
    vi.advanceTimersByTime(100);
    const quiet = count();

    harness.host.input({ sessionId: SESSION, surfaceId, clientId: 'a', items: ['\x1b[B'] });
    vi.advanceTimersByTime(0);
    expect(count()).toBe(quiet + 1);

    // 10 ms after that draw: waits for the rest of the 33 ms.
    vi.advanceTimersByTime(10);
    harness.host.input({ sessionId: SESSION, surfaceId, clientId: 'a', items: ['\x1b[B'] });
    vi.advanceTimersByTime(22);
    expect(count()).toBe(quiet + 1);
    vi.advanceTimersByTime(1);
    expect(count()).toBe(quiet + 2);
  });

  it('maps permission prompts to approval and Close to undefined', async () => {
    const harness = createHarness();
    let component;
    const result = harness.host.open(SESSION, (_tui, _theme, _kb, done) => {
      component = listComponent(['Allow', 'Deny'], done);
      return component;
    }, { blocked: { kind: 'permission', message: 'Run rm?' } });
    await flushPromises();
    const [surfaceId] = harness.opened();
    expect(harness.pending[0].kind).toBe('approval');
    expect(harness.host.close({ sessionId: SESSION, surfaceId })).toEqual({ closed: true });
    await expect(result).resolves.toBeUndefined();
    expect(component.dispose).toHaveBeenCalledOnce();
    expect(harness.events.at(-1).payload).toEqual({ surfaceId, reason: 'done' });
    expect(harness.host.close({ sessionId: SESSION, surfaceId })).toEqual({ closed: false });
    expect(harness.host.input({ sessionId: SESSION, surfaceId, items: ['x'] })).toEqual({ accepted: false });
  });

  describe('Close (the Esc button)', () => {
    const dismissals = (harness) => harness.events
      .filter((entry) => entry.event === 'extension.custom.dismiss')
      .map((entry) => entry.payload);

    /**
     * An extension like pi-btw: it keeps its own "open" flag, clears it only
     * when its component's Esc handler calls done() (after an await), and
     * refuses to open again while the flag is set. Its overlay is
     * non-capturing and takes focus through its handle.
     */
    const btwExtension = (host) => {
      // `streaming`: a side answer is running. Like pi-btw, the first Esc
      // then only starts aborting it and says "press Esc again to dismiss".
      const ext = { open: false, handle: null, result: null, streaming: false, aborting: false };
      ext.run = () => {
        if (ext.open) {
          ext.handle?.focus();
          return false;
        }
        ext.open = true;
        ext.result = host.open(SESSION, (_tui, _theme, _kb, done) => ({
          render: () => [ext.aborting ? 'Aborted. Press Esc again to dismiss.' : 'btw'],
          handleInput: (data) => {
            if (data !== '\x1b') return;
            if (ext.streaming && !ext.aborting) {
              ext.aborting = true;
              return;
            }
            void Promise.resolve().then(() => {
              ext.open = false;
              done();
            });
          },
          dispose: vi.fn(),
        }), {
          overlay: true,
          overlayOptions: { nonCapturing: true, anchor: 'top-center', width: '78%' },
          onHandle: (handle) => {
            ext.handle = handle;
            handle.focus();
          },
        });
        return true;
      };
      return ext;
    };

    it('presses Esc, so an extension that tracks its overlay closes it and can open it again', async () => {
      const harness = createHarness();
      const btw = btwExtension(harness.host);
      expect(btw.run()).toBe(true);
      await flushPromises();
      const [surfaceId] = harness.opened();

      expect(harness.host.close({ sessionId: SESSION, surfaceId, clientId: 'a' })).toEqual({ closed: true });
      await flushPromises();
      await expect(btw.result).resolves.toBeUndefined();
      expect(btw.open).toBe(false);
      // The extension closed it on its own key, as Esc in Pi's terminal would.
      expect(dismissals(harness)).toEqual([{ surfaceId, reason: 'done' }]);
      expect(harness.host.hasOpenSurfaces(SESSION)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);

      expect(btw.run()).toBe(true);
      await flushPromises();
      expect(new Set(harness.opened().filter((id) => id !== surfaceId)).size).toBe(1);
      expect(harness.host.hasOpenSurfaces(SESSION)).toBe(true);
    });

    it('presses Esc once per click: an Esc that only stopped work leaves the overlay to the next click', async () => {
      const harness = createHarness();
      const btw = btwExtension(harness.host);
      btw.run();
      await flushPromises();
      const [surfaceId] = harness.opened();
      btw.streaming = true;

      harness.host.close({ sessionId: SESSION, surfaceId });
      await flushPromises();
      expect(btw.aborting).toBe(true);
      // The extension's own "press Esc again" stays on screen; nothing else
      // happens until the user presses again.
      vi.advanceTimersByTime(5000);
      await flushPromises();
      expect(btw.open).toBe(true);
      expect(harness.host.hasOpenSurfaces(SESSION)).toBe(true);
      expect(harness.frames(surfaceId).at(-1).payload.lines[0]).toContain('Press Esc again');
      expect(vi.getTimerCount()).toBe(0);

      harness.host.close({ sessionId: SESSION, surfaceId });
      await expect(btw.result).resolves.toBeUndefined();
      expect(btw.open).toBe(false);
      expect(dismissals(harness)).toEqual([{ surfaceId, reason: 'done' }]);
    });

    it('presses Esc on an overlay that does not hold focus', async () => {
      const harness = createHarness();
      const btw = btwExtension(harness.host);
      btw.run();
      await flushPromises();
      const [surfaceId] = harness.opened();
      btw.handle.unfocus();
      expect(btw.handle.isFocused()).toBe(false);

      harness.host.close({ sessionId: SESSION, surfaceId });
      await flushPromises();
      expect(btw.open).toBe(false);
      expect(harness.host.hasOpenSurfaces(SESSION)).toBe(false);
    });

    it('leaves open a component that ignores Esc, as Pi would', async () => {
      const harness = createHarness();
      const handleInput = vi.fn();
      const dispose = vi.fn();
      void harness.host.open(SESSION, () => ({ render: () => ['stubborn'], handleInput, dispose }));
      await flushPromises();
      const [surfaceId] = harness.opened();

      expect(harness.host.close({ sessionId: SESSION, surfaceId })).toEqual({ closed: true });
      expect(handleInput).toHaveBeenCalledExactlyOnceWith('\x1b');
      vi.advanceTimersByTime(5000);
      expect(handleInput).toHaveBeenCalledOnce();
      expect(harness.host.hasOpenSurfaces(SESSION)).toBe(true);
      expect(dispose).not.toHaveBeenCalled();
      expect(dismissals(harness)).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);

      // Each press is one more Esc.
      harness.host.close({ sessionId: SESSION, surfaceId });
      expect(handleInput).toHaveBeenCalledTimes(2);
    });

    it('closes a component without handleInput, or whose Esc throws, at once', async () => {
      const harness = createHarness();
      const plain = harness.host.open(SESSION, () => ({ render: () => ['plain'] }));
      await flushPromises();
      harness.host.close({ sessionId: SESSION, surfaceId: harness.opened()[0] });
      await expect(plain).resolves.toBeUndefined();

      const throwing = harness.host.open(SESSION, () => ({
        render: () => ['throws'],
        handleInput: () => {
          throw new Error('esc boom');
        },
      }));
      await flushPromises();
      harness.host.close({ sessionId: SESSION, surfaceId: harness.opened().at(-1) });
      await expect(throwing).resolves.toBeUndefined();
      expect(harness.errors).toEqual([{ sessionId: SESSION, stage: 'input', message: 'esc boom' }]);
      expect(dismissals(harness).map((entry) => entry.reason)).toEqual(['cancelled', 'cancelled']);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('sends the next press to a confirmation the first one opened', async () => {
      const harness = createHarness();
      const editorKeys = [];
      const confirmKeys = [];
      void harness.host.open(SESSION, (tui) => ({
        render: () => ['editor'],
        handleInput: (data) => {
          editorKeys.push(data);
          // Esc asks before discarding; the confirmation hides on Esc.
          if (data === '\x1b') {
            const confirm = tui.showOverlay({
              render: () => ['Discard?'],
              handleInput: (key) => {
                confirmKeys.push(key);
                if (key === '\x1b') confirm.hide();
              },
            }, { anchor: 'center', width: 20 });
          }
        },
      }), { overlay: true });
      await flushPromises();
      const [surfaceId] = harness.opened();

      harness.host.close({ sessionId: SESSION, surfaceId });
      const confirmId = harness.opened().at(-1);
      expect(confirmId).not.toBe(surfaceId);
      expect(harness.lastMeta(confirmId)).toMatchObject({ parentId: surfaceId, focused: true });
      vi.advanceTimersByTime(5000);
      expect(harness.host.hasOpenSurfaces(SESSION)).toBe(true);
      expect(confirmKeys).toEqual([]);

      // The next press goes where a key typed now would: the confirmation.
      harness.host.close({ sessionId: SESSION, surfaceId });
      expect(confirmKeys).toEqual(['\x1b']);
      expect(editorKeys).toEqual(['\x1b']);
      expect(dismissals(harness)).toEqual([{ surfaceId: confirmId, reason: 'done' }]);
      // Only the redraw after the key; Close itself leaves no timer.
      vi.advanceTimersByTime(100);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('presses Esc on a nested panel without touching its parent', async () => {
      const harness = createHarness();
      let tuiRef;
      const result = harness.host.open(SESSION, (tui, _theme, _kb, done) => {
        tuiRef = tui;
        return listComponent(['parent'], done);
      }, { overlay: true });
      await flushPromises();
      const [parentId] = harness.opened();

      // A panel that closes itself on Esc, as Pi panels do.
      const panelHandle = tuiRef.showOverlay({
        render: () => ['panel'],
        handleInput: (data) => {
          if (data === '\x1b') panelHandle.hide();
        },
      }, { anchor: 'top-left', width: 10 });
      const panelId = harness.opened().at(-1);
      expect(harness.host.close({ sessionId: SESSION, surfaceId: panelId })).toEqual({ closed: true });
      expect(dismissals(harness)).toEqual([{ surfaceId: panelId, reason: 'done' }]);

      // The parent never saw the Esc and is still open.
      expect(harness.host.hasOpenSurfaces(SESSION)).toBe(true);
      harness.host.input({ sessionId: SESSION, surfaceId: parentId, items: ['\r'] });
      await expect(result).resolves.toBe('parent');
    });
  });

  it('rejects when the factory throws and shows nothing', async () => {
    const harness = createHarness();
    await expect(harness.host.open(SESSION, () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(harness.opened()).toEqual([]);
    expect(harness.errors).toEqual([{ sessionId: SESSION, stage: 'factory', message: 'boom' }]);
    expect(harness.pending).toEqual([]);
  });

  it('never shows a component whose factory already called done()', async () => {
    const harness = createHarness();
    const dispose = vi.fn();
    await expect(harness.host.open(SESSION, (_tui, _theme, _kb, done) => {
      done('early');
      return { render: () => ['x'], dispose };
    })).resolves.toBe('early');
    expect(harness.opened()).toEqual([]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('closes a component whose render throws', async () => {
    const harness = createHarness();
    const result = harness.host.open(SESSION, () => ({ render: () => { throw new Error('bad render'); } }));
    await flushPromises();
    await expect(result).resolves.toBeUndefined();
    expect(harness.errors[0]).toMatchObject({ stage: 'render', message: 'bad render' });
    expect(harness.host.hasOpenSurfaces(SESSION)).toBe(false);
  });

  it('ends every surface on session close, reload, and daemon stop', async () => {
    const harness = createHarness();
    const first = harness.host.open(SESSION, (_t, _th, _kb, done) => listComponent(['a'], done));
    const second = harness.host.open('session-2', (_t, _th, _kb, done) => listComponent(['b'], done));
    await flushPromises();
    harness.host.clear(SESSION, 'reload');
    await expect(first).resolves.toBeUndefined();
    expect(harness.events.filter((entry) => entry.event === 'extension.custom.dismiss').map((entry) => entry.payload.reason)).toEqual(['reload']);
    harness.host.clear(undefined, 'daemon-stopped');
    await expect(second).resolves.toBeUndefined();
    expect(harness.events.filter((entry) => entry.event === 'extension.custom.dismiss').map((entry) => entry.payload.reason)).toEqual(['reload', 'daemon-stopped']);
  });

  it('extracts the cursor of the focused surface and strips private markers', async () => {
    const harness = createHarness();
    void harness.host.open(SESSION, () => ({
      focused: false,
      render: () => [`name: ab${CURSOR}\x1b_pi:fc\x07c\x1b_pi:/fc\x07`, '日本 ok'],
      handleInput: () => {},
    }));
    await flushPromises();
    const [surfaceId] = harness.opened();
    const frame = harness.frames(surfaceId)[0].payload;
    expect(frame.cursor).toEqual({ row: 0, col: 8 });
    expect(frame.lines[0]).toBe('name: ab\x1b[7mc\x1b[27m');
    expect(frame.cells).toEqual({ 1: { 0: 2, 1: 2 } });
  });

  it('lays out overlays on the screen with Pi rules and falls back to the component width', async () => {
    const harness = createHarness();
    void harness.host.open(SESSION, () => ({ width: 30, render: (width) => [`${'x'.repeat(width + 10)}`, 'y'] }), { overlay: true });
    await flushPromises();
    const [surfaceId] = harness.opened();
    const frame = harness.frames(surfaceId)[0].payload;
    // 140 x 30 screen, centred 30-wide box of two lines.
    expect(frame.layout).toEqual({ row: 14, col: 55, width: 30, height: 2 });
    expect(frame.lines[0]).toBe('x'.repeat(30));
  });

  it('uses the screen for edge-anchored overlays and re-evaluates function options', async () => {
    const harness = createHarness();
    let calls = 0;
    void harness.host.open(SESSION, () => ({ render: () => ['side'] }), {
      overlay: true,
      overlayOptions: () => {
        calls += 1;
        return { anchor: 'right-center', width: '25%', minWidth: 30, margin: { right: 1 }, visible: (columns) => columns >= 100 };
      },
    });
    await flushPromises();
    const [surfaceId] = harness.opened();
    let frame = harness.frames(surfaceId)[0].payload;
    expect(frame.layout).toMatchObject({ col: 140 - 1 - 35, width: 35 });
    expect(frame.visible).toBe(true);
    expect(calls).toBeGreaterThan(1);

    harness.host.reportViewport({ sessionId: SESSION, clientId: 'phone', viewport: { columns: 44, rows: 40, screenColumns: 46 } });
    vi.advanceTimersByTime(200);
    frame = harness.frames(surfaceId).at(-1).payload;
    expect(frame.visible).toBe(false);
    expect(frame.screenColumns).toBe(46);
    // Hidden by `visible()`: no focus, and keys are dropped. It is still
    // open, so the answer is not the one that makes a client drop it.
    expect(harness.lastMeta(surfaceId).focused).toBe(false);
    expect(harness.host.input({ sessionId: SESSION, surfaceId, items: ['x'] })).toEqual({ accepted: true, delivered: false });
  });

  it('keeps non-capturing overlays out of focus and pending input', async () => {
    const harness = createHarness();
    void harness.host.open(SESSION, () => ({ render: () => ['ci'], handleInput: vi.fn() }), {
      overlay: true,
      overlayOptions: { nonCapturing: true, anchor: 'top-right', width: 20 },
    });
    await flushPromises();
    const [surfaceId] = harness.opened();
    expect(harness.lastMeta(surfaceId)).toMatchObject({ capturing: false, focused: false });
    expect(harness.pending).toEqual([]);
    expect(harness.host.input({ sessionId: SESSION, surfaceId, items: ['x'] })).toEqual({ accepted: true, delivered: false });
    expect(harness.host.hasOpenSurfaces(SESSION)).toBe(true);
  });

  it('gives nested overlays and handles Pi semantics', async () => {
    const harness = createHarness();
    let handle;
    let nestedHandle;
    let tuiRef;
    const result = harness.host.open(SESSION, (tui, _theme, _kb, done) => {
      tuiRef = tui;
      return listComponent(['a'], done);
    }, { overlay: true, onHandle: (value) => { handle = value; } });
    await flushPromises();
    const [parentId] = harness.opened();
    expect(handle.isFocused()).toBe(true);
    expect(handle.getBounds()).toMatchObject({ width: 80, height: 1 });
    expect(tuiRef.terminal.columns).toBe(140);
    expect(() => tuiRef.stop()).toThrow();

    nestedHandle = tuiRef.showOverlay(listComponent(['nested'], () => {}), { anchor: 'top-left', width: 10 });
    const nestedId = harness.opened().at(-1);
    expect(harness.lastMeta(nestedId)).toMatchObject({ parentId, focused: true });
    // Keys for the parent go to its focused nested overlay.
    expect(harness.host.input({ sessionId: SESSION, surfaceId: parentId, items: ['\x1b[B'] })).toEqual({ accepted: true });
    expect(harness.lastMeta(nestedId).focused).toBe(true);

    nestedHandle.setHidden(true);
    expect(harness.lastMeta(nestedId)).toMatchObject({ hidden: true, focused: false });
    expect(handle.isFocused()).toBe(true);

    handle.focus();
    nestedHandle.hide();
    expect(harness.events.at(-1)).toMatchObject({ event: 'extension.custom.dismiss', payload: { surfaceId: nestedId } });

    harness.host.input({ sessionId: SESSION, surfaceId: parentId, items: ['\r'] });
    await expect(result).resolves.toBe('a');
  });

  it('adopts overlays a factory shows before its own surface exists', async () => {
    // Pi's /overlay-focus demo: the controller's constructor shows its panels.
    const harness = createHarness();
    const panelKeys = vi.fn();
    const panelHandles = [];
    let finishController;
    const result = harness.host.open(SESSION, (tui, _theme, _kb, done) => {
      for (const label of ['alpha', 'beta']) {
        const panel = { render: () => [label], handleInput: panelKeys, invalidate: vi.fn(), dispose: vi.fn() };
        panelHandles.push(tui.showOverlay(panel, { nonCapturing: true, anchor: 'top-left', width: 12 }));
      }
      finishController = done;
      return listComponent(['controller'], done);
    }, { overlay: true });
    await flushPromises();
    const [alphaId, betaId, controllerId] = harness.opened();
    expect(harness.lastMeta(alphaId)).toMatchObject({ parentId: controllerId });
    expect(harness.lastMeta(betaId)).toMatchObject({ parentId: controllerId });

    // Keys sent to the controller reach the panel it focused.
    panelHandles[0].focus();
    expect(harness.host.input({ sessionId: SESSION, surfaceId: controllerId, items: ['x'] })).toEqual({ accepted: true });
    expect(panelKeys).toHaveBeenCalledWith('x');

    // Esc from Close goes there too, as a typed Esc would.
    harness.host.close({ sessionId: SESSION, surfaceId: controllerId });
    expect(panelKeys).toHaveBeenLastCalledWith('\x1b');

    // Ending the controller takes its panels along.
    finishController(undefined);
    await expect(result).resolves.toBeUndefined();
    const dismissed = harness.events.filter((entry) => entry.event === 'extension.custom.dismiss').map((entry) => entry.payload.surfaceId);
    expect(dismissed).toEqual(expect.arrayContaining([alphaId, betaId, controllerId]));
    expect(harness.host.hasOpenSurfaces(SESSION)).toBe(false);
  });

  it('focuses a panel picked in the browser tab stack, as handle.focus() would', async () => {
    const harness = createHarness();
    const keys = { alpha: vi.fn(), beta: vi.fn() };
    const handles = {};
    let controllerRenders = 0;
    void harness.host.open(SESSION, (tui, _theme, _kb, done) => {
      for (const label of ['alpha', 'beta']) {
        const panel = { render: () => [label], handleInput: keys[label], invalidate: vi.fn() };
        handles[label] = tui.showOverlay(panel, { nonCapturing: true, width: 12 });
      }
      return listComponent(['controller'], done, {
        render: (width) => {
          controllerRenders += 1;
          return [`focus: ${handles.beta.isFocused() ? 'beta' : 'other'}`.padEnd(width).slice(0, width)];
        },
      });
    }, { overlay: true });
    await flushPromises();
    const [alphaId, betaId, controllerId] = [...new Set(harness.opened())];

    const before = controllerRenders;
    expect(harness.host.focus({ sessionId: SESSION, surfaceId: betaId, clientId: 'desk' })).toEqual({ focused: true });
    expect(handles.beta.isFocused()).toBe(true);
    expect(harness.lastMeta(betaId)).toMatchObject({ focused: true });
    expect(harness.lastMeta(betaId).z).toBeGreaterThan(harness.lastMeta(alphaId).z);
    // The controller redraws, since it reads isFocused() while rendering.
    await vi.advanceTimersByTimeAsync(50);
    expect(controllerRenders).toBeGreaterThan(before);
    harness.host.input({ sessionId: SESSION, surfaceId: controllerId, items: ['k'] });
    expect(keys.beta).toHaveBeenCalledWith('k');
    expect(keys.alpha).not.toHaveBeenCalled();

    // Only nested panels are tabs; the command's own overlay is not.
    expect(harness.host.focus({ sessionId: SESSION, surfaceId: controllerId })).toEqual({ focused: false });
    handles.alpha.setHidden(true);
    expect(harness.host.focus({ sessionId: SESSION, surfaceId: alphaId })).toEqual({ focused: false });
    expect(harness.host.focus({ sessionId: SESSION, surfaceId: 'custom-missing' })).toEqual({ focused: false });
  });

  it('never lets a factory without a surface touch other overlays or leave its own behind', async () => {
    const harness = createHarness();
    void harness.host.open(SESSION, () => ({ render: () => ['other'], handleInput: vi.fn() }), { overlay: true });
    await flushPromises();
    const [otherId] = harness.opened();

    // hideOverlay() from a constructor has nothing of its own to hide.
    const failing = harness.host.open(SESSION, (tui) => {
      tui.hideOverlay();
      tui.showOverlay({ render: () => ['orphan'], invalidate: vi.fn() }, { width: 10 });
      throw new Error('factory failed');
    });
    await expect(failing).rejects.toThrow('factory failed');
    // Focus changes re-publish metadata, so take the last new id.
    const orphanId = [...new Set(harness.opened())].at(-1);
    const dismissed = harness.events.filter((entry) => entry.event === 'extension.custom.dismiss').map((entry) => entry.payload.surfaceId);
    expect(dismissed).toEqual([orphanId]);
    expect(orphanId).not.toBe(otherId);
    expect(harness.host.hasOpenSurfaces(SESSION)).toBe(true);
  });

  it('never shows an overlay a command opens after it ended', async () => {
    // An extension may keep its tui and call showOverlay from a timer after
    // done(). The overlay would point at a removed parent: unreachable, and
    // focusing it walked a parent chain that never ends.
    const harness = createHarness();
    let tuiRef;
    let finish;
    const result = harness.host.open(SESSION, (tui, _theme, _kb, done) => {
      tuiRef = tui;
      finish = done;
      return listComponent(['a'], done);
    }, { overlay: true });
    await flushPromises();
    finish('a');
    await expect(result).resolves.toBe('a');
    const before = harness.opened().length;

    const late = tuiRef.showOverlay({ render: () => ['late'], invalidate: vi.fn() }, { width: 10 });
    expect(harness.opened()).toHaveLength(before);
    expect(late.isFocused()).toBe(false);
    expect(harness.host.hasOpenSurfaces(SESSION)).toBe(false);

    // The same for a factory that called done() while it was constructing.
    let early;
    await harness.host.open(SESSION, (tui, _theme, _kb, done) => {
      done('early');
      early = tui;
      return listComponent(['b'], done);
    });
    early.showOverlay({ render: () => ['late'], invalidate: vi.fn() }, { width: 10 });
    expect(harness.opened()).toHaveLength(before);
    expect(harness.host.hasOpenSurfaces(SESSION)).toBe(false);
  });

  it('lets one client drive the size: the last one that acted', async () => {
    const harness = createHarness();
    void harness.host.open(SESSION, (_t, _th, _kb, done) => listComponent(['a'], done));
    await flushPromises();
    const [surfaceId] = harness.opened();
    const { host } = harness;
    host.reportViewport({ sessionId: SESSION, clientId: 'desk', viewport: { columns: 120, rows: 40, screenColumns: 200 } });
    host.reportViewport({ sessionId: SESSION, clientId: 'phone', viewport: { columns: 44, rows: 30, screenColumns: 46 } });
    vi.advanceTimersByTime(200);
    expect(harness.frames(surfaceId).at(-1).payload.columns).toBe(120);
    // Periodic reports from a non-driver change nothing.
    host.reportViewport({ sessionId: SESSION, clientId: 'phone', viewport: { columns: 45, rows: 30, screenColumns: 47 } });
    vi.advanceTimersByTime(200);
    expect(harness.frames(surfaceId).at(-1).payload.columns).toBe(120);
    // Typing on the phone makes it the driver.
    host.input({ sessionId: SESSION, surfaceId, clientId: 'phone', viewport: { columns: 44, rows: 30, screenColumns: 46 }, items: ['\x1b[B'] });
    vi.advanceTimersByTime(200);
    const frame = harness.frames(surfaceId).at(-1).payload;
    expect(frame.columns).toBe(44);
    expect(frame.lines).toBeDefined();
  });

  it('gives the size to the client whose prompt opened the surface', async () => {
    let opener;
    const harness = createHarness({ openerClientFor: () => opener });
    const { host } = harness;
    // Earlier surface: the desktop drives.
    opener = 'desk';
    void host.open(SESSION, (_t, _th, _kb, done) => listComponent(['a'], done));
    await flushPromises();
    const [first] = harness.opened();
    host.reportViewport({ sessionId: SESSION, clientId: 'desk', viewport: { columns: 120, rows: 40, screenColumns: 200 } });
    host.reportViewport({ sessionId: SESSION, clientId: 'phone', viewport: { columns: 44, rows: 30, screenColumns: 46 } });
    vi.advanceTimersByTime(200);
    expect(harness.frames(first).at(-1).payload.columns).toBe(120);
    host.close({ sessionId: SESSION, surfaceId: first, clientId: 'desk' });

    // The phone sent the next prompt: its surface is drawn at the phone's size.
    opener = 'phone';
    void host.open(SESSION, (_t, _th, _kb, done) => listComponent(['b'], done));
    await flushPromises();
    const second = harness.opened().at(-1);
    vi.advanceTimersByTime(200);
    expect(harness.frames(second).at(-1).payload.columns).toBe(44);

    // An opener that has not reported yet takes over on its first report,
    // even after another client reported first.
    host.close({ sessionId: SESSION, surfaceId: second, clientId: 'phone' });
    opener = 'tablet';
    void host.open(SESSION, (_t, _th, _kb, done) => listComponent(['c'], done));
    await flushPromises();
    const third = harness.opened().at(-1);
    host.reportViewport({ sessionId: SESSION, clientId: 'desk', viewport: { columns: 120, rows: 40, screenColumns: 200 } });
    host.reportViewport({ sessionId: SESSION, clientId: 'tablet', viewport: { columns: 80, rows: 30, screenColumns: 90 } });
    vi.advanceTimersByTime(200);
    expect(harness.frames(third).at(-1).payload.columns).toBe(80);
  });

  it('never lets a throwing overlayOptions() escape into a timer', async () => {
    const harness = createHarness();
    let broken = false;
    void harness.host.open(SESSION, (_t, _th, _kb, done) => listComponent(['a', 'b'], done), {
      overlay: true,
      overlayOptions: () => {
        if (broken) throw new Error('options boom');
        return { anchor: 'center', width: 30 };
      },
    });
    await flushPromises();
    const [surfaceId] = harness.opened();
    broken = true;
    harness.host.input({ sessionId: SESSION, surfaceId, clientId: 'a', items: ['\x1b[B'] });
    expect(() => vi.advanceTimersByTime(40)).not.toThrow();
    harness.host.reportViewport({ sessionId: SESSION, clientId: 'a', viewport: { columns: 60, rows: 30, screenColumns: 80 }, claim: true });
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    // The last options it returned still place the overlay.
    expect(harness.frames(surfaceId).at(-1).payload.layout.width).toBe(30);
    expect(harness.host.hasOpenSurfaces(SESSION)).toBe(true);
    expect(harness.errors.filter((error) => error.stage === 'overlayOptions')).toHaveLength(1);
  });

  it('keeps a surface whose options throw from the second call open and closable', async () => {
    const harness = createHarness();
    let calls = 0;
    const result = harness.host.open(SESSION, (_t, _th, _kb, done) => listComponent(['a'], done), {
      overlay: true,
      overlayOptions: () => {
        calls += 1;
        if (calls > 1) throw new Error('second call');
        return { width: 20 };
      },
    });
    await flushPromises();
    const [surfaceId] = harness.opened();
    expect(calls).toBeGreaterThan(1);
    expect(harness.frames(surfaceId).at(-1).payload.layout.width).toBe(20);
    expect(harness.host.close({ sessionId: SESSION, surfaceId, clientId: 'a' })).toEqual({ closed: true });
    await expect(result).resolves.toBeUndefined();
    expect(harness.host.hasOpenSurfaces(SESSION)).toBe(false);
    expect(harness.pending.map((entry) => entry.op)).toEqual(['open', 'close']);
  });

  it('rejects and cleans up when adding the first surface throws', async () => {
    const harness = createHarness({
      // Publishing the surface fails once: the surface is already in state.
      publish: () => {
        throw new Error('publish failed');
      },
    });
    const result = harness.host.open(SESSION, (_t, _th, _kb, done) => listComponent(['a'], done));
    await expect(result).rejects.toThrow('publish failed');
    expect(harness.host.hasOpenSurfaces(SESSION)).toBe(false);
    expect(harness.pending.map((entry) => entry.op)).toEqual(['open', 'close']);
  });

  it('shows nothing when an async factory resolves after its session closed', async () => {
    const harness = createHarness();
    let release;
    const component = listComponent(['a'], () => {});
    const result = harness.host.open(SESSION, () => new Promise((resolve) => {
      release = () => resolve(component);
    }));
    await flushPromises();
    harness.host.clear(SESSION, 'session-closed');
    release();
    await expect(result).resolves.toBeUndefined();
    expect(component.dispose).toHaveBeenCalled();
    expect(harness.opened()).toEqual([]);
    expect(harness.pending).toEqual([]);
    expect(harness.host.hasOpenSurfaces(SESSION)).toBe(false);
  });

  it('routes SGR mouse reports as pi-tui events: press, click counts, drag, wheel', async () => {
    const harness = createHarness();
    const seen = [];
    const handleInput = vi.fn();
    void harness.host.open(SESSION, () => ({
      render: (width) => ['one', 'two', 'three'].map((line) => line.padEnd(width).slice(0, width)),
      handleInput,
      handleMouse: (event) => {
        seen.push(event);
        return { handled: true };
      },
    }));
    await flushPromises();
    const [surfaceId] = harness.opened();
    const send = (...items) => harness.host.input({ sessionId: SESSION, surfaceId, clientId: 'a', items });
    const pick = (event) => [event.type, event.button, event.x, event.y, event.clickCount ?? event.wheelDelta];

    // Press and release on one cell: release, then a click. Twice: count 2.
    expect(send('\x1b[<0;3;2M', '\x1b[<0;3;2m')).toEqual({ accepted: true });
    send('\x1b[<0;3;2M', '\x1b[<0;3;2m');
    expect(seen.map(pick)).toEqual([
      ['press', 'left', 2, 1, undefined], ['release', 'left', 2, 1, undefined], ['click', 'left', 2, 1, 1],
      ['press', 'left', 2, 1, undefined], ['release', 'left', 2, 1, undefined], ['click', 'left', 2, 1, 2],
    ]);
    // The event carries the size the component rendered at and modifiers.
    expect(seen[0]).toMatchObject({ width: 100, height: 3, screenX: 2, screenY: 1, shift: false, alt: false, ctrl: false });

    // A drag to another cell is no click.
    seen.length = 0;
    send('\x1b[<0;1;1M', '\x1b[<32;4;1M', '\x1b[<0;4;1m');
    expect(seen.map(pick)).toEqual([['press', 'left', 0, 0, undefined], ['drag', 'left', 3, 0, undefined], ['release', 'left', 3, 0, undefined]]);

    // Wheel steps, right button with Shift and Ctrl.
    seen.length = 0;
    send('\x1b[<65;2;3M', '\x1b[<64;2;3M', '\x1b[<22;1;1M');
    expect(seen.map(pick)).toEqual([['wheel', 'none', 1, 2, 1], ['wheel', 'none', 1, 2, -1], ['press', 'right', 0, 0, undefined]]);
    expect(seen[2]).toMatchObject({ shift: true, ctrl: true, alt: false });

    // Mouse reports never reach handleInput, even malformed ones.
    send('\x1b[<0;x;1M');
    expect(handleInput).not.toHaveBeenCalled();
  });

  it('forwards clicks through a Pi Container to the child under the pointer', async () => {
    const sdkEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const requireFromSdk = createRequire(join(dirname(dirname(sdkEntry)), 'package.json'));
    const { Container } = await import(pathToFileURL(requireFromSdk.resolve('@earendil-works/pi-tui')).href);
    const harness = createHarness();
    const hits = [];
    const row = (name) => ({
      render: (width) => [name.padEnd(width).slice(0, width)],
      handleMouse: (event) => {
        hits.push([name, event.type, event.y]);
        return event.type === 'press' ? { focus: true } : { handled: true };
      },
      invalidate: () => {},
    });
    const result = harness.host.open(SESSION, (_tui, _theme, _kb, done) => {
      const container = new Container();
      container.addChild(row('first'));
      container.addChild(row('second'));
      container.handleInput = (data) => { if (data === '\r') done('picked'); };
      return container;
    });
    await flushPromises();
    const [surfaceId] = harness.opened();
    harness.host.input({ sessionId: SESSION, surfaceId, clientId: 'a', items: ['\x1b[<0;2;2M', '\x1b[<0;2;2m'] });
    // Local to the second child: its own row 0.
    expect(hits).toEqual([['second', 'press', 0], ['second', 'release', 0], ['second', 'click', 0]]);
    // Focus stays with the container that routes keys, as in Pi.
    harness.host.input({ sessionId: SESSION, surfaceId, clientId: 'a', items: ['\r'] });
    await expect(result).resolves.toBe('picked');
  });

  it('sends the mouse to non-capturing overlays and lets them take focus', async () => {
    const harness = createHarness();
    const seen = [];
    void harness.host.open(SESSION, () => ({
      render: () => ['ci passing'],
      handleInput: vi.fn(),
      handleMouse: (event) => {
        seen.push(event.type);
        return event.type === 'press' ? { focus: true } : undefined;
      },
    }), { overlay: true, overlayOptions: { nonCapturing: true, anchor: 'top-right', width: 20 } });
    await flushPromises();
    const [surfaceId] = harness.opened();
    expect(harness.lastMeta(surfaceId)).toMatchObject({ focused: false });
    expect(harness.host.input({ sessionId: SESSION, surfaceId, items: ['\x1b[<0;1;1M'] })).toEqual({ accepted: true });
    expect(seen).toEqual(['press']);
    expect(harness.lastMeta(surfaceId)).toMatchObject({ focused: true });
    // Focused, it takes keys, as Pi's TUI hands keys to the focused component.
    expect(harness.host.input({ sessionId: SESSION, surfaceId, items: ['x'] })).toEqual({ accepted: true });
  });

  it('gives keys to a non-capturing overlay only while it holds focus', async () => {
    const harness = createHarness();
    const keys = vi.fn();
    let handle;
    void harness.host.open(SESSION, () => ({ render: () => ['side chat'], handleInput: keys }), {
      overlay: true,
      overlayOptions: { nonCapturing: true, anchor: 'top-center', width: 30 },
      // pi-btw's pattern: a non-capturing modal that focuses itself.
      onHandle: (value) => {
        handle = value;
        value.focus();
      },
    });
    await flushPromises();
    const [surfaceId] = harness.opened();
    expect(harness.lastMeta(surfaceId)).toMatchObject({ capturing: false, focused: true });
    expect(harness.pending).toEqual([]);
    expect(harness.host.input({ sessionId: SESSION, surfaceId, items: ['h', 'i'] })).toEqual({ accepted: true });
    expect(keys.mock.calls).toEqual([['h'], ['i']]);

    handle.unfocus();
    expect(harness.lastMeta(surfaceId).focused).toBe(false);
    expect(harness.host.input({ sessionId: SESSION, surfaceId, items: ['x'] })).toEqual({ accepted: true, delivered: false });
    expect(keys).toHaveBeenCalledTimes(2);
  });

  it('gives focus to a non-capturing overlay that takes keys when pressed', async () => {
    const harness = createHarness();
    const keys = vi.fn();
    void harness.host.open(SESSION, () => ({ render: () => ['side chat'], handleInput: keys }), {
      overlay: true,
      overlayOptions: { nonCapturing: true, anchor: 'top-center', width: 30 },
    });
    void harness.host.open(SESSION, () => ({ render: () => ['ci passing'] }), {
      overlay: true,
      overlayOptions: { nonCapturing: true, anchor: 'top-right', width: 20 },
    });
    await flushPromises();
    const [chatId, panelId] = harness.opened();
    expect(harness.lastMeta(chatId).focused).toBe(false);
    // A view-only panel has no keys to take, so a press leaves focus alone.
    harness.host.input({ sessionId: SESSION, surfaceId: panelId, items: ['\x1b[<0;1;1M', '\x1b[<0;1;1m'] });
    expect(harness.lastMeta(panelId).focused).toBe(false);
    harness.host.input({ sessionId: SESSION, surfaceId: chatId, items: ['\x1b[<0;2;1M', '\x1b[<0;2;1m'] });
    expect(harness.lastMeta(chatId).focused).toBe(true);
    expect(harness.host.input({ sessionId: SESSION, surfaceId: chatId, items: ['a'] })).toEqual({ accepted: true });
    expect(keys).toHaveBeenCalledWith('a');
  });

  it('caps a long line without leaving half an escape sequence', async () => {
    const harness = createHarness();
    // pi-doom's half blocks: 24-bit foreground and background on every cell.
    const cell = (index) => `\x1b[38;2;${index % 256};12;34m\x1b[48;2;56;${index % 256};78m\u2580`;
    const line = Array.from({ length: 600 }, (_value, index) => cell(index)).join('') + '\x1b[0m';
    void harness.host.open(SESSION, () => ({ render: () => [line] }));
    await flushPromises();
    const [surfaceId] = harness.opened();
    const [shown] = harness.frames(surfaceId)[0].payload.lines;
    expect(line.length).toBeGreaterThan(MAX_CUSTOM_LINE_CHARS);
    expect(shown.length).toBeLessThanOrEqual(MAX_CUSTOM_LINE_CHARS);
    expect(line.startsWith(shown)).toBe(true);
    // The cut lands between sequences: what is left is whole cells.
    expect(shown.endsWith('\u2580') || shown.endsWith('m')).toBe(true);
    expect(shown.replace(/\x1b\[[0-9;]*m/g, '')).toMatch(/^\u2580+$/);
  });

  it('keeps a batch of keys with the surface it was sent to', async () => {
    const harness = createHarness();
    const below = vi.fn();
    void harness.host.open(SESSION, () => ({ render: () => ['below'], handleInput: below }));
    await flushPromises();
    const confirm = harness.host.open(SESSION, (_t, _th, _kb, done) => listComponent(['Yes'], done));
    await flushPromises();
    const top = harness.opened().at(-1);
    // Enter confirms and closes the top surface; the keys after it must not
    // land in the surface below.
    harness.host.input({ sessionId: SESSION, surfaceId: top, clientId: 'a', items: ['\r', 'x', 'y'] });
    await expect(confirm).resolves.toBe('Yes');
    expect(below).not.toHaveBeenCalled();
  });

  it('snapshots and keyframes carry full frames that survive public projection', async () => {
    const harness = createHarness();
    void harness.host.open(SESSION, (_t, _th, _kb, done) => listComponent(DATABASES, done));
    await flushPromises();
    const [surfaceId] = harness.opened();
    harness.host.input({ sessionId: SESSION, surfaceId, items: ['\x1b[B'] });
    vi.advanceTimersByTime(40);
    const snapshot = harness.host.snapshot(SESSION);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].frame.version).toBe(2);
    const projected = projectCustomSurfaces(snapshot);
    expect(projected[0].frame.lines).toEqual(snapshot[0].frame.lines);
    expect(projected[0]).toMatchObject({ surfaceId, mode: 'inline', focused: true });
    const keyframes = harness.host.keyframes(SESSION);
    expect(keyframes).toHaveLength(1);
    expect(projectCustomFrame(keyframes[0].payload)?.lines).toHaveLength(6);
    expect(harness.host.snapshot('other')).toBeUndefined();
    const patch = harness.frames(surfaceId).at(-1).payload;
    expect(projectCustomFrame(patch)?.changes).toHaveLength(2);
    expect(projectCustomFrame({ ...patch, base: patch.version })).toBeNull();
    expect(projectCustomSurface({ surfaceId, mode: 'floating', z: 1 })).toBeNull();
  });
});
