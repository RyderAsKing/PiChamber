import dns from 'node:dns';
import net from 'node:net';

import { isServerNetworkHost } from '../security/server-network-host.js';

// Chrome sends a new screencast frame only after the previous one is acked.
// Acking no sooner than these caps the stream near 60 frames per second
// while someone is using the page and 30 otherwise, so a page that animates
// on its own does not keep the server busy at the full rate.
const ACTIVE_ACK_INTERVAL_MS = 16;
const IDLE_ACK_INTERVAL_MS = 33;
const ACTIVE_AFTER_INPUT_MS = 1_000;
// Frames a viewer may have unacknowledged before it only keeps the latest.
const VIEWER_MAX_INFLIGHT_FRAMES = 2;
const SCREENCAST_QUALITY = 70;
const MAX_DEVICE_SCALE_FACTOR = 2;
const MIN_VIEWPORT = 100;
const MAX_VIEWPORT = 4096;
const CURSOR_PROBE_INTERVAL_MS = 80;
const ISOLATED_WORLD = 'pichamber-server-browser';
const PAGE_SWAP_WAIT_MS = 3_000;
// A page's load waits this long for the server-network check of its name.
const NAME_CHECK_TIMEOUT_MS = 5_000;
const NOT_ATTACHED = /Not attached to an active page/i;

const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

const modifierMask = (modifiers) => {
  if (!modifiers || typeof modifiers !== 'object') return 0;
  let mask = 0;
  for (const [name, bit] of Object.entries(MODIFIER_BITS)) {
    if (modifiers[name] === true) mask |= bit;
  }
  return mask;
};

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

/** Only these addresses may be typed into the server browser. */
export const normalizeServerBrowserUrl = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'about:blank') return 'about:blank';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
};

const hostOf = (value) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname;
  } catch {
    return null;
  }
};

const UA_PLATFORMS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/**
 * The user agent pages see: the running Chrome's own, without "Headless".
 * Many sites refuse or degrade for HeadlessChrome. Returns `null` when the
 * version reports no headless marker.
 */
export const pageUserAgent = (version, platform = process.platform) => {
  const product = String(version?.product || '');
  const userAgent = String(version?.userAgent || '');
  if (!/HeadlessChrome\//.test(userAgent)) return null;
  const fullVersion = /\/([\d.]+)$/.exec(product)?.[1] || /HeadlessChrome\/([\d.]+)/.exec(userAgent)?.[1] || '';
  const major = fullVersion.split('.')[0] || '';
  return {
    userAgent: userAgent.replace('HeadlessChrome/', 'Chrome/'),
    userAgentMetadata: {
      brands: [{ brand: 'Chromium', version: major }, { brand: 'Not.A/Brand', version: '99' }],
      fullVersionList: [{ brand: 'Chromium', version: fullVersion }, { brand: 'Not.A/Brand', version: '99.0.0.0' }],
      fullVersion,
      platform: UA_PLATFORMS[platform] || 'Linux',
      platformVersion: '',
      architecture: '',
      model: '',
      mobile: false,
    },
  };
};

/**
 * Whether a page load to `url` must be refused because it would reach the
 * server's own network from a public page. `from` is the address that caused
 * the load: the page showing, or the page that redirected. Loads the person
 * asked for (typed, back, forward, reload) pass `from = null`.
 */
export const isBlockedServerNetworkLoad = ({ url, from }) => {
  const host = hostOf(url);
  if (!host || !isServerNetworkHost(host)) return false;
  if (from === null) return false;
  const fromHost = hostOf(from);
  // A load from about:blank, data: or a local page is not a public page.
  if (!fromHost) return false;
  return !isServerNetworkHost(fromHost);
};

const isPublicPage = (url) => {
  const host = url === null ? null : hostOf(url);
  return Boolean(host) && !isServerNetworkHost(host);
};

const lookupAll = (host) => dns.promises.lookup(host, { all: true });

// Document requests carry no fragment; history entries and typed addresses may.
const sameDocument = (a, b) => typeof a === 'string' && typeof b === 'string' && a.split('#')[0] === b.split('#')[0];

// Runs in an isolated world: the page's own scripts cannot see or alter it.
const ELEMENT_METADATA_FUNCTION = `function (x, y) {
  let element = document.elementFromPoint(x, y);
  while (element && element.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  if (!element) return null;
  const cssEscape = (value) => { try { return CSS.escape(value); } catch { return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'); } };
  const selectorPart = (node) => {
    const tag = node.tagName.toLowerCase();
    if (node.id) return tag + '#' + cssEscape(node.id);
    const className = String(node.className || '').trim().split(/\\s+/).filter(Boolean).slice(0, 3).map((part) => '.' + cssEscape(part)).join('');
    return tag + className;
  };
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const ancestry = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && ancestry.length < 8) {
    ancestry.unshift({ tag: current.tagName.toLowerCase(), id: current.id || undefined, className: typeof current.className === 'string' ? current.className : undefined, selectorPart: selectorPart(current) });
    current = current.parentElement;
  }
  const attributes = {};
  for (const attr of Array.from(element.attributes || []).slice(0, 16)) attributes[attr.name] = attr.value.slice(0, 300);
  const path = ancestry.map((entry) => entry.selectorPart).join(' > ');
  return {
    frame: 'top',
    tag: element.tagName.toLowerCase(),
    text: String(element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
    selector: element.id ? '#' + cssEscape(element.id) : path,
    path,
    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    attributes,
    computedStyle: { display: style.display, position: style.position, fontWeight: style.fontWeight, fontSize: style.fontSize, lineHeight: style.lineHeight, fontFamily: style.fontFamily, color: style.color, backgroundColor: style.backgroundColor, zIndex: style.zIndex },
    ancestry,
  };
}`;

const CURSOR_FUNCTION = `function (x, y) {
  const element = document.elementFromPoint(x, y);
  if (!element) return 'default';
  const cursor = getComputedStyle(element).cursor;
  if (cursor && cursor !== 'auto' && !cursor.startsWith('url(')) return cursor.split(',').pop().trim();
  if (element.closest('a[href], button, [role="button"], summary, label[for]')) return 'pointer';
  if (element.isContentEditable || element.tagName === 'TEXTAREA') return 'text';
  if (element.tagName === 'INPUT' && !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/.test(element.type)) return 'text';
  return 'default';
}`;

const SELECTION_TEXT_FUNCTION = `function () {
  const active = document.activeElement;
  if (active && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && /^(text|search|url|tel|email|number)?$/.test(active.type)))) {
    if (typeof active.selectionStart === 'number' && active.selectionEnd > active.selectionStart) {
      return active.value.slice(active.selectionStart, active.selectionEnd);
    }
  }
  const selection = document.getSelection();
  return selection ? selection.toString() : '';
}`;

const clampViewport = (value) => Math.min(MAX_VIEWPORT, Math.max(MIN_VIEWPORT, Math.round(Number(value) || 0)));

/**
 * Encodes a screencast frame for viewers: a 4-byte big-endian header length,
 * the JSON header, then the JPEG bytes.
 */
const encodeFrame = (header, jpeg) => {
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(headerBytes.length, 0);
  return Buffer.concat([prefix, headerBytes, jpeg]);
};

/**
 * One page in the server browser and the people watching it.
 *
 * Viewers are `{ sendJson(message), sendFrame(buffer) }`. Every viewer gets
 * state changes; frames go to each viewer at the pace it acknowledges them,
 * and a viewer that falls behind gets only the newest frame.
 */
export const createServerBrowserTab = ({ key, cdp, targetId, sessionId, onEmpty, log = () => {}, userAgent = null, lookup = lookupAll }) => {
  const viewers = new Set();
  const state = {
    url: 'about:blank',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    crashed: false,
  };
  let viewport = { width: 1280, height: 800, dpr: 1 };
  let screencasting = false;
  let frameSeq = 0;
  let lastChromeAck = 0;
  let lastInputAt = 0;
  let ackTimer = null;
  let dialog = null;
  let fileChooser = null;
  let fileChooserSeq = 0;
  let isolatedContext = null;
  let pendingMove = null;
  let moveInFlight = false;
  // Wheel events waiting for Chrome, and the dispatch delivering them.
  const pendingWheels = [];
  let wheelDispatch = null;
  let lastCursorProbe = 0;
  let cursorTimer = null;
  let lastCursor = 'default';
  let userLoadPending = null;
  // The address of the document on screen, for when a load is cancelled.
  let committedUrl = 'about:blank';
  let initialUrl = null;
  const documentRequestUrls = new Map();
  const frameIds = new Set([targetId]);
  let closed = false;

  const send = (method, params) => cdp.send(method, params, sessionId);
  // While a navigation swaps the page's renderer, Chrome briefly answers
  // page commands with "Not attached to an active page". Commands the
  // person asked for (Back, Reload) wait that out instead of being dropped.
  const sendToPage = async (method, params) => {
    const deadline = Date.now() + PAGE_SWAP_WAIT_MS;
    for (;;) {
      try {
        return await send(method, params);
      } catch (error) {
        if (!NOT_ATTACHED.test(error?.message || '') || Date.now() >= deadline || cdp.closed) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  };
  const quietly = (promise) => promise.catch((error) => {
    if (!closed) log(`[server-browser] ${error?.message || error}`);
  });

  const broadcast = (message) => {
    for (const viewer of viewers) viewer.sendJson(message);
  };

  const publicState = () => ({ type: 'state', ...state });
  const emitState = () => broadcast(publicState());

  const refreshHistory = async () => {
    try {
      const history = await sendToPage('Page.getNavigationHistory');
      const canGoBack = history.currentIndex > 0;
      const canGoForward = history.currentIndex < history.entries.length - 1;
      if (canGoBack !== state.canGoBack || canGoForward !== state.canGoForward) {
        state.canGoBack = canGoBack;
        state.canGoForward = canGoForward;
        emitState();
      }
    } catch {
      // The page may be navigating or gone; the next navigation refreshes it.
    }
  };

  const isolatedWorld = async () => {
    if (isolatedContext !== null) return isolatedContext;
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: targetId, worldName: ISOLATED_WORLD });
    isolatedContext = executionContextId;
    return executionContextId;
  };

  const callInPage = async (functionDeclaration, args = []) => {
    const expression = `(${functionDeclaration})(${args.map((value) => JSON.stringify(value)).join(', ')})`;
    const run = async () => {
      const contextId = await isolatedWorld();
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, contextId, returnByValue: true });
      if (exceptionDetails) throw new Error(exceptionDetails.text || 'Page script failed');
      return result.value;
    };
    try {
      return await run();
    } catch {
      // The world goes away with each navigation; make a new one once.
      isolatedContext = null;
      return await run();
    }
  };

  // Starting the screencast fails while the page swaps renderer processes
  // (the first load after about:blank, a cross-site navigation). It is
  // retried when the next navigation commits.
  let screencastPending = false;
  const startScreencast = async () => {
    if (closed || viewers.size === 0) return;
    const dpr = Math.min(MAX_DEVICE_SCALE_FACTOR, viewport.dpr);
    screencasting = true;
    try {
      await send('Page.startScreencast', {
        format: 'jpeg',
        quality: SCREENCAST_QUALITY,
        maxWidth: Math.round(viewport.width * dpr),
        maxHeight: Math.round(viewport.height * dpr),
        everyNthFrame: 1,
      });
      screencastPending = false;
    } catch {
      screencastPending = true;
    }
  };

  const refreshTitle = async () => {
    try {
      const { targetInfo } = await send('Target.getTargetInfo', {});
      tab.updateTitle(targetInfo?.title);
    } catch {
      // The next load or title change updates it.
    }
  };

  const stopScreencast = async () => {
    if (!screencasting) return;
    screencasting = false;
    clearTimeout(ackTimer);
    ackTimer = null;
    await quietly(send('Page.stopScreencast'));
  };

  const applyMetrics = async () => {
    await quietly(send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: Math.min(MAX_DEVICE_SCALE_FACTOR, viewport.dpr),
      mobile: false,
    }));
    if (screencasting) {
      await stopScreencast();
      await startScreencast();
    }
  };

  const sendFrameToViewer = (viewer, frame) => {
    if (viewer.inflight >= VIEWER_MAX_INFLIGHT_FRAMES) {
      viewer.pendingFrame = frame;
      return;
    }
    viewer.inflight += 1;
    viewer.sendFrame(frame);
  };

  const ackChrome = (frameSessionId) => {
    const interval = Date.now() - lastInputAt < ACTIVE_AFTER_INPUT_MS ? ACTIVE_ACK_INTERVAL_MS : IDLE_ACK_INTERVAL_MS;
    const wait = Math.max(0, interval - (Date.now() - lastChromeAck));
    clearTimeout(ackTimer);
    ackTimer = setTimeout(() => {
      ackTimer = null;
      lastChromeAck = Date.now();
      void send('Page.screencastFrameAck', { sessionId: frameSessionId }).catch(() => {});
    }, wait);
    ackTimer.unref?.();
  };

  const onScreencastFrame = (params) => {
    ackChrome(params.sessionId);
    if (viewers.size === 0) return;
    frameSeq += 1;
    const metadata = params.metadata || {};
    const frame = encodeFrame({
      seq: frameSeq,
      width: metadata.deviceWidth,
      height: metadata.deviceHeight,
      offsetTop: metadata.offsetTop || 0,
      pageScaleFactor: metadata.pageScaleFactor || 1,
    }, Buffer.from(params.data, 'base64'));
    for (const viewer of viewers) sendFrameToViewer(viewer, frame);
  };

  const setUrl = (url) => {
    if (!url || url === state.url) return false;
    state.url = url;
    return true;
  };

  const onFetchPaused = (params) => {
    const { requestId, request, redirectedRequestId, frameId } = params;
    const url = request?.url || '';
    let from;
    if (redirectedRequestId && documentRequestUrls.has(redirectedRequestId)) {
      from = documentRequestUrls.get(redirectedRequestId);
    } else if (frameId === targetId && userLoadPending && sameDocument(userLoadPending.url, url)) {
      from = null;
      userLoadPending = null;
    } else {
      from = state.url;
    }
    documentRequestUrls.set(requestId, url);
    if (documentRequestUrls.size > 64) documentRequestUrls.delete(documentRequestUrls.keys().next().value);
    const block = () => {
      // Cancel rather than fail: the current page stays, with no error page
      // standing in for the blocked address that Reload would then load.
      void send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(() => {});
      if (frameId === targetId && setUrl(committedUrl)) emitState();
      broadcast({ type: 'notice', kind: 'blocked-server-network', url });
    };
    const proceed = () => { void send('Fetch.continueRequest', { requestId }).catch(() => {}); };
    const fail = (errorReason) => { void send('Fetch.failRequest', { requestId, errorReason }).catch(() => {}); };
    if (isBlockedServerNetworkLoad({ url, from })) {
      block();
      return;
    }
    // A public name can resolve to the server's network (127.0.0.1.nip.io).
    // Chrome resolves the name again itself, so a name that changes its
    // answer in between (DNS rebinding) is not caught. A name that cannot be
    // checked does not load: Chrome shows its own error page for it.
    const host = hostOf(url);
    if (isPublicPage(from) && host && !net.isIP(host.replace(/^\[|\]$/g, ''))) {
      let timer;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), NAME_CHECK_TIMEOUT_MS);
        timer.unref?.();
      });
      void Promise.race([Promise.resolve().then(() => lookup(host)), timedOut])
        .then((addresses) => {
          if (addresses === 'timeout') fail('TimedOut');
          else if (!Array.isArray(addresses) || addresses.length === 0) fail('NameNotResolved');
          else if (addresses.some((entry) => isServerNetworkHost(entry.address))) block();
          else proceed();
        }, () => fail('NameNotResolved'))
        .finally(() => clearTimeout(timer));
      return;
    }
    proceed();
  };

  const handleEvent = (method, params) => {
    switch (method) {
      case 'Page.screencastFrame':
        onScreencastFrame(params);
        return;
      case 'Fetch.requestPaused':
        onFetchPaused(params);
        return;
      case 'Page.frameNavigated': {
        frameIds.add(params.frame.id);
        if (params.frame.parentId) return;
        isolatedContext = null;
        // A file chooser belongs to the page that asked; a new page drops it.
        if (fileChooser) {
          const { id } = fileChooser;
          fileChooser = null;
          broadcast({ type: 'file-chooser-closed', id });
        }
        // Error pages report an internal address; show the one that failed.
        committedUrl = params.frame.unreachableUrl || `${params.frame.url}${params.frame.urlFragment || ''}`;
        // A history load restored from the back/forward cache sends no
        // document request; once the person's load lands, forget it.
        if (userLoadPending && sameDocument(userLoadPending.url, committedUrl)) userLoadPending = null;
        const changed = setUrl(committedUrl);
        if (state.crashed) state.crashed = false;
        if (changed) emitState();
        void refreshHistory();
        if (screencastPending && screencasting) void startScreencast();
        return;
      }
      case 'Page.navigatedWithinDocument':
        if (params.frameId !== targetId) return;
        if (userLoadPending && sameDocument(userLoadPending.url, params.url)) userLoadPending = null;
        committedUrl = params.url;
        if (setUrl(params.url)) emitState();
        void refreshHistory();
        void refreshTitle();
        return;
      case 'Page.frameStartedLoading':
        if (params.frameId !== targetId || state.loading) return;
        state.loading = true;
        emitState();
        return;
      case 'Page.frameStoppedLoading':
        if (params.frameId !== targetId) return;
        void refreshTitle();
        if (screencastPending && screencasting) void startScreencast();
        if (!state.loading) return;
        state.loading = false;
        emitState();
        return;
      case 'Page.javascriptDialogOpening':
        dialog = { kind: params.type, message: String(params.message || '').slice(0, 4000), defaultPrompt: params.defaultPrompt || '', url: params.url || state.url };
        if (viewers.size === 0) {
          void respondDialog({ accept: params.type === 'beforeunload' });
          return;
        }
        broadcast({ type: 'dialog', ...dialog });
        return;
      case 'Page.javascriptDialogClosed':
        dialog = null;
        broadcast({ type: 'dialog-closed' });
        return;
      case 'Page.fileChooserOpened':
        fileChooserSeq += 1;
        fileChooser = { id: fileChooserSeq, backendNodeId: params.backendNodeId, multiple: params.mode === 'selectMultiple' };
        broadcast({ type: 'file-chooser', id: fileChooser.id, multiple: fileChooser.multiple });
        return;
      case 'Inspector.targetCrashed':
        state.crashed = true;
        state.loading = false;
        emitState();
        return;
      default:
    }
  };

  const respondDialog = async ({ accept, text }) => {
    if (!dialog) return;
    const params = { accept: accept === true };
    if (typeof text === 'string' && dialog.kind === 'prompt') params.promptText = text.slice(0, 10_000);
    dialog = null;
    await quietly(send('Page.handleJavaScriptDialog', params));
  };

  const probeCursor = (x, y) => {
    const now = Date.now();
    const wait = CURSOR_PROBE_INTERVAL_MS - (now - lastCursorProbe);
    if (wait > 0) {
      clearTimeout(cursorTimer);
      cursorTimer = setTimeout(() => probeCursor(x, y), wait);
      cursorTimer.unref?.();
      return;
    }
    lastCursorProbe = now;
    void callInPage(CURSOR_FUNCTION, [x, y]).then((cursor) => {
      if (typeof cursor !== 'string' || cursor === lastCursor) return;
      lastCursor = cursor;
      broadcast({ type: 'cursor', cursor });
    }).catch(() => {});
  };

  const dispatchMove = async () => {
    if (moveInFlight || !pendingMove) return;
    const move = pendingMove;
    pendingMove = null;
    moveInFlight = true;
    try {
      await send('Input.dispatchMouseEvent', move);
    } catch {
      // A failed move is superseded by the next one.
    } finally {
      moveInFlight = false;
    }
    if (pendingMove) void dispatchMove();
    else probeCursor(move.x, move.y);
  };

  const flushMove = async () => {
    if (!pendingMove) return;
    const move = pendingMove;
    pendingMove = null;
    await quietly(send('Input.dispatchMouseEvent', move));
  };

  // Chrome answers a wheel event only after the page has handled it, which on
  // a busy page takes longer than a trackpad waits between events. Wheel
  // movement that arrives meanwhile is added up and sent as one event, so
  // scrolling never falls behind the person's hand.
  const MAX_WHEEL_DELTA = 10_000;
  const clampWheel = (value) => Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, value));

  const deliverWheel = async () => {
    while (pendingWheels.length > 0) {
      await quietly(send('Input.dispatchMouseEvent', pendingWheels.shift()));
    }
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

  const BUTTON_BITS = { left: 1, right: 2, middle: 4 };

  const handleMouse = async (message) => {
    lastInputAt = Date.now();
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
      const deltaX = clampWheel(Number(message.deltaX) || 0);
      const deltaY = clampWheel(Number(message.deltaY) || 0);
      queueWheel({ type: 'mouseWheel', x, y, deltaX, deltaY, modifiers });
      return;
    }
    await flushWheel();
    if (message.action !== 'down' && message.action !== 'up') return;
    const clickCount = Math.max(1, Math.min(3, Number(message.clickCount) || 1));
    await quietly(send('Input.dispatchMouseEvent', {
      type: message.action === 'down' ? 'mousePressed' : 'mouseReleased',
      x,
      y,
      modifiers,
      button,
      buttons: buttons || (message.action === 'down' ? BUTTON_BITS[button] || 0 : 0),
      clickCount,
    }));
  };

  const handleKey = async (message) => {
    lastInputAt = Date.now();
    if (message.action !== 'down' && message.action !== 'up') return;
    const key = typeof message.key === 'string' ? message.key.slice(0, 32) : '';
    if (!key) return;
    const modifiers = modifierMask(message.modifiers);
    const code = typeof message.code === 'string' ? message.code.slice(0, 32) : '';
    const keyCode = Number.isInteger(message.keyCode) ? message.keyCode : 0;
    const shortcut = message.modifiers?.ctrl === true || message.modifiers?.meta === true || message.modifiers?.alt === true;
    let text = '';
    if (message.action === 'down' && !shortcut) {
      if (key === 'Enter') text = '\r';
      else if (key.length === 1) text = key;
    }
    const params = {
      type: message.action === 'up' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown',
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
    if (message.action === 'down') {
      const commands = editingCommandsForKey({ key, modifiers: message.modifiers });
      if (commands.length > 0) params.commands = commands;
    }
    await flushMove();
    // Read the selection first: `cut` removes it. The viewer writes it to the
    // device's clipboard, since headless Chrome has no clipboard of its own.
    const copies = params.commands?.includes('copy') || params.commands?.includes('cut');
    const copied = copies ? await callInPage(SELECTION_TEXT_FUNCTION).catch(() => '') : '';
    await quietly(send('Input.dispatchKeyEvent', params));
    if (typeof copied === 'string' && copied) broadcast({ type: 'clipboard', text: copied.slice(0, 1_000_000) });
  };

  const tab = {
    key,
    targetId,
    sessionId,
    frameIds,
    get state() {
      return { ...state };
    },
    get viewerCount() {
      return viewers.size;
    },
    lastViewedAt: Date.now(),

    async init({ url } = {}) {
      await Promise.all([
        send('Page.enable'),
        send('Inspector.enable'),
        send('Page.setInterceptFileChooserDialog', { enabled: true }),
        send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] }),
        send('Emulation.setFocusEmulationEnabled', { enabled: true }),
        userAgent ? quietly(send('Emulation.setUserAgentOverride', userAgent)) : null,
      ]);
      await applyMetrics();
      // The first address loads once a viewer is attached, so it sees what
      // the load does (a blocked redirect, a dialog).
      initialUrl = url && url !== 'about:blank' ? url : null;
    },

    handleEvent,

    attachViewer(viewer) {
      viewer.inflight = 0;
      viewer.pendingFrame = null;
      viewers.add(viewer);
      tab.lastViewedAt = Date.now();
      viewer.sendJson(publicState());
      viewer.sendJson({ type: 'cursor', cursor: lastCursor });
      if (dialog) viewer.sendJson({ type: 'dialog', ...dialog });
      if (fileChooser) viewer.sendJson({ type: 'file-chooser', id: fileChooser.id, multiple: fileChooser.multiple });
      if (initialUrl) {
        const url = initialUrl;
        initialUrl = null;
        void tab.navigate(url);
      }
      if (viewers.size === 1) {
        void startScreencast();
      } else {
        // A late viewer needs a picture now, not on the next page change.
        void stopScreencast().then(startScreencast);
      }
      return () => {
        viewers.delete(viewer);
        tab.lastViewedAt = Date.now();
        if (viewers.size === 0) {
          void stopScreencast();
          onEmpty?.(tab);
        }
      };
    },

    ackFrame(viewer) {
      viewer.inflight = Math.max(0, viewer.inflight - 1);
      if (viewer.pendingFrame && viewer.inflight < VIEWER_MAX_INFLIGHT_FRAMES) {
        const frame = viewer.pendingFrame;
        viewer.pendingFrame = null;
        viewer.inflight += 1;
        viewer.sendFrame(frame);
      }
    },

    async setViewport({ width, height, dpr }) {
      const next = {
        width: clampViewport(width),
        height: clampViewport(height),
        dpr: Math.max(1, Math.min(MAX_DEVICE_SCALE_FACTOR, Number(dpr) || 1)),
      };
      if (next.width === viewport.width && next.height === viewport.height && next.dpr === viewport.dpr) return;
      viewport = next;
      await applyMetrics();
    },

    async navigate(rawUrl) {
      const url = normalizeServerBrowserUrl(rawUrl);
      if (!url) {
        broadcast({ type: 'notice', kind: 'unsupported-address', url: String(rawUrl || '').slice(0, 2048) });
        return;
      }
      userLoadPending = { url };
      if (setUrl(url)) emitState();
      const result = await sendToPage('Page.navigate', { url }).catch((error) => ({ errorText: error?.message }));
      if (result?.errorText && result.errorText !== 'net::ERR_ABORTED') {
        broadcast({ type: 'notice', kind: 'navigation-failed', url, message: result.errorText });
      }
    },

    /** A load the page itself asked for (a popup), under the page's rules. */
    async navigateFromPage(rawUrl) {
      const url = normalizeServerBrowserUrl(rawUrl);
      if (!url || url === 'about:blank') return;
      await quietly(sendToPage('Page.navigate', { url }));
    },

    updateTitle(title) {
      const next = typeof title === 'string' ? title.slice(0, 500) : '';
      if (next === state.title) return;
      state.title = next;
      emitState();
    },

    async goBack() {
      await tab.goToHistoryOffset(-1);
    },

    async goForward() {
      await tab.goToHistoryOffset(1);
    },

    async goToHistoryOffset(offset) {
      const history = await sendToPage('Page.getNavigationHistory').catch(() => null);
      const entry = history?.entries?.[history.currentIndex + offset];
      if (!entry) return;
      userLoadPending = { url: entry.url };
      await quietly(sendToPage('Page.navigateToHistoryEntry', { entryId: entry.id }));
      // A page restored from the back/forward cache may not report a load.
      await refreshHistory();
    },

    async reload() {
      userLoadPending = { url: state.url };
      if (state.crashed) {
        // A crashed page has no renderer to reload; load the address again.
        await quietly(sendToPage('Page.navigate', { url: state.url }));
        return;
      }
      await quietly(sendToPage('Page.reload', {}));
    },

    async stop() {
      await quietly(sendToPage('Page.stopLoading'));
    },

    handleMouse,
    handleKey,

    async insertText(text) {
      lastInputAt = Date.now();
      if (typeof text !== 'string' || !text) return;
      await flushMove();
      await quietly(send('Input.insertText', { text: text.slice(0, 1_000_000) }));
    },

    respondDialog,

    async respondFileChooser({ id, paths }) {
      if (!fileChooser || fileChooser.id !== id) return;
      const chooser = fileChooser;
      fileChooser = null;
      broadcast({ type: 'file-chooser-closed', id });
      if (!Array.isArray(paths) || paths.length === 0) return;
      const files = chooser.multiple ? paths : paths.slice(0, 1);
      await quietly(send('DOM.setFileInputFiles', { files, backendNodeId: chooser.backendNodeId }));
    },

    async inspectAt(x, y) {
      return await callInPage(ELEMENT_METADATA_FUNCTION, [Number(x) || 0, Number(y) || 0]).catch(() => null);
    },

    async captureViewport() {
      const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 85 });
      const dpr = Math.min(MAX_DEVICE_SCALE_FACTOR, viewport.dpr);
      return { base64: data, width: Math.round(viewport.width * dpr), height: Math.round(viewport.height * dpr), cssWidth: viewport.width, cssHeight: viewport.height };
    },

    broadcast,

    /** The page is gone (closed, or the browser exited). */
    detachAll(reason) {
      closed = true;
      clearTimeout(ackTimer);
      clearTimeout(cursorTimer);
      for (const viewer of viewers) viewer.close?.(reason);
      viewers.clear();
    },
  };
  return tab;
};
