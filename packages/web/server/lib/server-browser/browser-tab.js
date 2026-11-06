import { CHROME_SCALE_FACTOR } from './chrome-launch.js';
import { createPageWorld, CURSOR_FUNCTION, ELEMENT_METADATA_FUNCTION, TITLE_BINDING } from './page-scripts.js';
import { createTabInput } from './tab-input.js';
import { createTabPrompts } from './tab-prompts.js';
import { createTabStream } from './tab-stream.js';

const MIN_VIEWPORT = 100;
const MAX_VIEWPORT = 4096;
// Viewer navigation returns once the new document commits, and never holds
// up later input: a stalled load gives up after this.
const NAVIGATION = { waitUntil: 'commit', timeout: 15_000 };
// Chrome does not answer a command to a renderer that is hung or was killed
// mid-command; viewer messages apply in order, so one such command would
// hold up every later one.
const COMMAND_TIMEOUT_MS = 10_000;
// A new page whose renderer dies while it starts is never reported ready, so
// opening one gives up after this and tries once more.
const OPEN_PAGE_TIMEOUT_MS = 5_000;
const OPEN_PAGE_ATTEMPTS = 2;

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

// Document requests carry no fragment; history entries and typed addresses may.
const sameDocument = (a, b) => typeof a === 'string' && typeof b === 'string' && a.split('#')[0] === b.split('#')[0];

const clampViewport = (value) => Math.min(MAX_VIEWPORT, Math.max(MIN_VIEWPORT, Math.round(Number(value) || 0)));

// The pixel size of a JPEG, from its start-of-frame marker.
const jpegSize = (bytes) => {
  for (let at = 2; at + 9 < bytes.length;) {
    const marker = bytes[at + 1];
    if (marker >= 0xc0 && marker <= 0xc2) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
};

// The net error a failed navigation reports, if it is one worth showing.
const navigationError = (error) => {
  const code = /net::ERR_[A-Z_]+/.exec(String(error?.message || ''))?.[0];
  return code && code !== 'net::ERR_ABORTED' ? code : null;
};

/**
 * One page in the server browser and the people watching it.
 *
 * The tab outlives its Chrome page: a crashed page is replaced under the same
 * key, and viewers stay connected. `openPage()` makes a new page in the
 * browser; `guard` is the server-network rule (`network-guard.js`).
 * `onPopup(tab, page)` gets each page this one opens; `onClosed(tab)` is
 * called when the page closes itself.
 *
 * Viewers are `{ sendJson(message), sendFrame(buffer), close(reason) }`.
 */
export const createServerBrowserTab = ({ key, openPage, guard, onEmpty, onClosed, onPopup = () => {}, onDownload = () => {}, log = () => {} }) => {
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
  let page = null;
  let session = null;
  let targetId = null;
  let lastCursor = 'default';
  let userLoadPending = null;
  // The address of the document on screen, for when a load is cancelled.
  let committedUrl = 'about:blank';
  let initialUrl = null;
  let closed = false;
  // The viewer whose input came last: the one a popup opens for.
  let lastInputViewer = null;

  // Commands in flight on the current page, rejected when it crashes or is replaced.
  const inFlight = new Set();
  // Set when the current page's renderer dies; a new page clears it.
  let pageCrashed = false;
  const send = (method, params) => {
    if (!session) return Promise.reject(new Error('The page is closed'));
    if (pageCrashed) return Promise.reject(new Error('The page crashed'));
    return new Promise((resolve, reject) => {
      const settle = (error, value) => {
        clearTimeout(timer);
        if (!inFlight.delete(abandon)) return;
        if (error) reject(error);
        else resolve(value);
      };
      const abandon = (reason) => settle(new Error(reason));
      const timer = setTimeout(() => abandon(`${method} timed out`), COMMAND_TIMEOUT_MS);
      timer.unref?.();
      inFlight.add(abandon);
      session.send(method, params).then((value) => settle(null, value), (error) => settle(error));
    });
  };
  const abandonCommands = (reason) => {
    for (const abandon of [...inFlight]) abandon(reason);
  };

  const openFreshPage = async () => {
    for (let attempt = 1; ; attempt += 1) {
      const opening = openPage();
      let timer;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), OPEN_PAGE_TIMEOUT_MS);
        timer.unref?.();
      });
      const opened = await Promise.race([opening, timedOut]).finally(() => clearTimeout(timer));
      if (opened) return opened;
      // A page that turns up after all is not used.
      void opening.then((late) => late.close()).catch(() => {});
      if (attempt >= OPEN_PAGE_ATTEMPTS) throw new Error('Chrome did not open a page');
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
  const setUrl = (url) => {
    if (!url || url === state.url) return false;
    state.url = url;
    return true;
  };

  const world = createPageWorld(send);
  const stream = createTabStream({ viewport: () => viewport });
  const prompts = createTabPrompts({ broadcast, hasViewers: () => viewers.size > 0, log });
  const input = createTabInput({
    onInput: () => stream.noteInput(),
    cursorAt: (x, y) => world.call(CURSOR_FUNCTION, [x, y]),
    onCursor: (cursor) => {
      if (cursor === lastCursor) return;
      lastCursor = cursor;
      broadcast({ type: 'cursor', cursor });
    },
    takeCopy: () => world.takeCopy(),
    onCopied: (text) => broadcast({ type: 'clipboard', text }),
  });

  // A page starts on about:blank. Back never returns to it: Chrome records
  // the first address only after reporting its commit, so the entry cannot
  // be removed without racing the next load.
  const firstEntryIndex = (history) => (history.entries[0]?.url === 'about:blank' ? 1 : 0);

  const refreshHistory = async () => {
    try {
      const history = await send('Page.getNavigationHistory');
      const canGoBack = history.currentIndex > firstEntryIndex(history);
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

  const refreshTitle = async () => {
    try {
      const { targetInfo } = await send('Target.getTargetInfo');
      tab.updateTitle(targetInfo?.title);
    } catch {
      // The next load or title change updates it.
    }
  };

  const applyMetrics = async () => {
    await quietly(send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: CHROME_SCALE_FACTOR,
      mobile: false,
    }));
    await stream.restart();
  };

  // What the server-network rule needs to know about this page.
  const owner = {
    sourceUrl: () => state.url,
    consumeUserLoad(url) {
      if (!userLoadPending || !sameDocument(userLoadPending.url, url)) return false;
      userLoadPending = null;
      return true;
    },
    blocked(url, { mainFrame }) {
      if (mainFrame && setUrl(committedUrl)) emitState();
      broadcast({ type: 'notice', kind: 'blocked-server-network', url });
    },
  };

  const onFrameNavigated = ({ frame }) => {
    if (frame.parentId) return;
    world.frameNavigated(frame.id);
    prompts.documentChanged();
    // Error pages report an internal address; show the one that failed.
    committedUrl = frame.unreachableUrl || `${frame.url}${frame.urlFragment || ''}`;
    // A history load restored from the back/forward cache sends no
    // document request; once the person's load lands, forget it.
    if (userLoadPending && sameDocument(userLoadPending.url, committedUrl)) userLoadPending = null;
    const recovered = state.crashed;
    state.crashed = false;
    if (setUrl(committedUrl) || recovered) emitState();
    void refreshHistory();
    void stream.retry();
  };

  // Frames inside an out-of-process frame are reported only to that frame's
  // own session, so the server-network rule could not link their requests to
  // this page. Each such frame is attached once it commits.
  const watchedFrames = new WeakSet();
  const watchFrame = async (frame, context) => {
    if (watchedFrames.has(frame) || frame.parentFrame() === null) return;
    let frameSession;
    try {
      frameSession = await context.newCDPSession(frame);
    } catch {
      return; // In the page's own process: its session reports it.
    }
    watchedFrames.add(frame);
    frameSession.on('Page.frameAttached', ({ frameId, parentFrameId }) => guard.frameAttached(frameId, parentFrameId));
    try {
      await frameSession.send('Page.enable');
      const { frameTree } = await frameSession.send('Page.getFrameTree');
      const walk = (node) => {
        for (const child of node.childFrames || []) {
          guard.frameAttached(child.frame.id, node.frame.id);
          walk(child);
        }
      };
      walk(frameTree);
    } catch {
      // The frame went away.
    }
  };

  const bindPage = async (nextPage) => {
    const nextSession = await nextPage.context().newCDPSession(nextPage);
    const { targetInfo } = await nextSession.send('Target.getTargetInfo');
    const current = () => page === nextPage && !closed;
    page = nextPage;
    session = nextSession;
    pageCrashed = false;
    targetId = targetInfo.targetId;
    nextSession.on('Page.screencastFrame', (params) => { if (current()) stream.onFrame(params); });
    nextSession.on('Page.frameNavigated', (params) => { if (current()) onFrameNavigated(params); });
    nextSession.on('Page.frameAttached', ({ frameId, parentFrameId }) => guard.frameAttached(frameId, parentFrameId));
    nextSession.on('Page.navigatedWithinDocument', ({ frameId, url }) => {
      if (!current() || frameId !== targetId) return;
      if (userLoadPending && sameDocument(userLoadPending.url, url)) userLoadPending = null;
      committedUrl = url;
      if (setUrl(url)) emitState();
      void refreshHistory();
      void refreshTitle();
    });
    nextSession.on('Page.frameStartedLoading', ({ frameId }) => {
      if (!current() || frameId !== targetId || state.loading) return;
      state.loading = true;
      emitState();
    });
    nextSession.on('Page.frameStoppedLoading', ({ frameId }) => {
      if (!current() || frameId !== targetId) return;
      void refreshTitle();
      // Reading history fails while Chrome swaps the page's process.
      void refreshHistory();
      void stream.retry();
      if (!state.loading) return;
      state.loading = false;
      emitState();
    });
    // Title changes after a load, from the page's title watcher.
    nextSession.on('Runtime.bindingCalled', ({ name, payload }) => {
      if (current() && name === TITLE_BINDING) tab.updateTitle(payload);
    });
    nextPage.on('crash', () => {
      if (!current()) return;
      pageCrashed = true;
      abandonCommands('The page crashed');
      state.crashed = true;
      state.loading = false;
      prompts.reset();
      emitState();
    });
    nextPage.on('close', () => {
      // A replaced page closes on purpose; this one closed itself.
      if (current()) onClosed?.(tab);
    });
    nextPage.on('download', (download) => onDownload(tab, download));
    nextPage.on('popup', (popup) => {
      if (current()) onPopup(tab, popup);
      else void popup.close().catch(() => {});
    });
    nextPage.on('framenavigated', (frame) => { if (current()) void watchFrame(frame, nextPage.context()); });
    prompts.bindPage(nextPage);
    guard.addPage(targetId, owner);
    await Promise.all([
      nextSession.send('Page.enable'),
      // Delivers the title watcher's binding calls.
      nextSession.send('Runtime.enable'),
      world.install(targetId),
    ]);
    input.bind(send);
    await applyMetrics();
    await stream.bind(send);
  };

  // Playwright cannot reload a crashed page; a new one takes its place.
  const replacePage = async () => {
    const previous = page;
    page = null;
    session = null;
    abandonCommands('The page was replaced');
    if (targetId) guard.removePage(targetId, owner);
    await bindPage(await openFreshPage());
    await previous?.close().catch(() => {});
  };

  const load = (navigation, url) => {
    void navigation.catch((error) => {
      const code = navigationError(error);
      if (code && !closed) broadcast({ type: 'notice', kind: 'navigation-failed', url, message: code });
    });
  };

  const goToHistoryOffset = async (offset) => {
    const history = await send('Page.getNavigationHistory').catch(() => null);
    const index = history ? history.currentIndex + offset : -1;
    const entry = history?.entries?.[index];
    if (!entry || !page || index < firstEntryIndex(history)) return;
    userLoadPending = { url: entry.url };
    load(offset < 0 ? page.goBack(NAVIGATION) : page.goForward(NAVIGATION), entry.url);
  };

  const tab = {
    key,
    get state() {
      return { ...state };
    },
    get viewerCount() {
      return viewers.size;
    },
    lastViewedAt: Date.now(),

    /**
     * Opens the tab's page: `page` when given (a popup this tab now owns, already
     * loading), else a new one that loads `url` once a viewer is attached, so
     * it sees what the load does (a blocked redirect, a dialog).
     */
    async init({ url, page: adopted } = {}) {
      if (!adopted) {
        await bindPage(await openFreshPage());
        initialUrl = url && url !== 'about:blank' ? url : null;
        return;
      }
      await bindPage(adopted);
      // It may have committed and started loading before the tab listened.
      const shown = adopted.url();
      if (shown && shown !== 'about:blank') {
        committedUrl = shown;
        setUrl(shown);
      }
      const readyState = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }).catch(() => null);
      if (readyState?.result?.value && readyState.result.value !== 'complete') state.loading = true;
      await Promise.all([refreshTitle(), refreshHistory()]);
    },

    attachViewer(viewer) {
      viewers.add(viewer);
      tab.lastViewedAt = Date.now();
      viewer.sendJson(publicState());
      viewer.sendJson({ type: 'cursor', cursor: lastCursor });
      prompts.replay(viewer);
      if (initialUrl) {
        const url = initialUrl;
        initialUrl = null;
        tab.navigate(url);
      }
      void stream.addViewer(viewer);
      return () => {
        if (!viewers.delete(viewer)) return;
        stream.removeViewer(viewer);
        void input.releaseViewer(viewer);
        tab.lastViewedAt = Date.now();
        if (viewers.size === 0) onEmpty?.(tab);
      };
    },

    ackFrame(viewer) {
      stream.ack(viewer);
    },

    async setViewport({ width, height, dpr }) {
      const next = {
        width: clampViewport(width),
        height: clampViewport(height),
        dpr: Math.max(1, Math.min(CHROME_SCALE_FACTOR, Number(dpr) || 1)),
      };
      if (next.width === viewport.width && next.height === viewport.height && next.dpr === viewport.dpr) return;
      viewport = next;
      await applyMetrics();
    },

    navigate(rawUrl) {
      const url = normalizeServerBrowserUrl(rawUrl);
      if (!url) {
        broadcast({ type: 'notice', kind: 'unsupported-address', url: String(rawUrl || '').slice(0, 2048) });
        return;
      }
      if (!page) return;
      userLoadPending = { url };
      if (setUrl(url)) emitState();
      load(page.goto(url, NAVIGATION), url);
    },

    updateTitle(title) {
      const next = typeof title === 'string' ? title.slice(0, 500) : '';
      if (next === state.title) return;
      state.title = next;
      emitState();
    },

    goBack: () => goToHistoryOffset(-1),
    goForward: () => goToHistoryOffset(1),

    async reload() {
      userLoadPending = { url: state.url };
      if (state.crashed) {
        await quietly(replacePage());
        if (page && state.url !== 'about:blank') load(page.goto(state.url, NAVIGATION), state.url);
        return;
      }
      if (page) load(page.reload(NAVIGATION), state.url);
    },

    async stop() {
      await quietly(send('Page.stopLoading'));
    },

    handleMouse(message, viewer) {
      if (viewer) lastInputViewer = viewer;
      return input.handleMouse(message, viewer);
    },
    handleKey(message, viewer) {
      if (viewer) lastInputViewer = viewer;
      return input.handleKey(message, viewer);
    },
    insertText(text, viewer) {
      if (viewer) lastInputViewer = viewer;
      return input.insertText(text);
    },

    /** The viewer a popup from this page opens for, or null with none watching. */
    popupViewer() {
      if (lastInputViewer && viewers.has(lastInputViewer)) return lastInputViewer;
      return viewers.values().next().value ?? null;
    },
    respondDialog: (answer) => prompts.respondDialog(answer),
    respondFileChooser: (answer) => prompts.respondFileChooser(answer),

    async inspectAt(x, y) {
      return await world.call(ELEMENT_METADATA_FUNCTION, [Number(x) || 0, Number(y) || 0]).catch(() => null);
    },

    /** The page as viewers see it now, from the stream's newest frame. */
    captureViewport() {
      const still = stream.still();
      if (!still) return null;
      const size = jpegSize(still.jpeg) ?? { width: still.width, height: still.height };
      return { base64: still.jpeg.toString('base64'), ...size, cssWidth: still.width, cssHeight: still.height };
    },

    broadcast,

    /** The page is gone (closed, or the browser exited): viewers are let go. */
    detachAll(reason) {
      closed = true;
      abandonCommands('The page is closed');
      if (targetId) guard.removePage(targetId, owner);
      stream.close();
      input.close();
      for (const viewer of viewers) viewer.close?.(reason);
      viewers.clear();
    },

    /** Closes the page and lets viewers go. */
    async close(reason) {
      const current = page;
      tab.detachAll(reason);
      page = null;
      session = null;
      await current?.close().catch(() => {});
    },
  };
  return tab;
};
