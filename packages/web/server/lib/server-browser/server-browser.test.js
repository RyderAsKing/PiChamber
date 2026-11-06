import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerBrowserTab, normalizeServerBrowserUrl } from './browser-tab.js';
import { findChromeExecutable } from './chrome-executable.js';
import { classifyLaunchFailure, pageUserAgent } from './chrome-launch.js';
import { createNetworkGuard, isBlockedServerNetworkLoad } from './network-guard.js';
import { createServerBrowser } from './server-browser.js';
import { createTabInput, editingCommandsForKey } from './tab-input.js';
import { createTabStream } from './tab-stream.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('findChromeExecutable', () => {
  const linux = (files, env = {}) => findChromeExecutable({
    env: { PATH: '/usr/bin:/usr/local/bin', ...env },
    platform: 'linux',
    homedir: '/home/me',
    exists: (file) => files.includes(file),
    readdir: (dir) => {
      if (dir !== '/home/me/.cache/ms-playwright') throw new Error('ENOENT');
      return ['chromium-1161', 'chromium_headless_shell-1300', 'chromium-1248', 'ffmpeg-1011'];
    },
  });

  it('prefers an executable named by the environment', () => {
    expect(linux(['/opt/chrome', '/usr/bin/chromium'], { CHROME: '/opt/chrome' })).toEqual({ path: '/opt/chrome', source: 'env', envKey: 'CHROME' });
  });

  it("falls back to Playwright's newest full Chromium, never the headless shell", () => {
    expect(linux([
      '/home/me/.cache/ms-playwright/chromium-1161/chrome-linux/chrome',
      '/home/me/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',
    ])).toEqual({ path: '/home/me/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', source: 'playwright' });
  });
});

describe('Chrome launch', () => {
  const launchError = (stderr) => [
    'browserType.launchPersistentContext: Target page, context or browser has been closed',
    'Browser logs:',
    '<launching> /opt/chrome --disable-field-trial-config --no-sandbox --user-data-dir=/data/profile',
    ...stderr.map((line) => `[pid=42][err] ${line}`),
    'Call log:',
    ...stderr.map((line) => `  - [pid=42][err] ${line}`),
  ].join('\n');

  it('names the missing library from Chrome\'s output', () => {
    const failure = classifyLaunchFailure(launchError(['/opt/chrome: error while loading shared libraries: libnss3.so: cannot open shared object file']));
    expect(failure).toMatchObject({ kind: 'missing-library', library: 'libnss3.so' });
    expect(failure.detail).toBe('/opt/chrome: error while loading shared libraries: libnss3.so: cannot open shared object file');
  });

  it('tells a sandbox Chrome cannot create apart from one refused as root', () => {
    const playwrightSandbox = 'browserType.launchPersistentContext: Target page, context or browser has been closed\nBrowser logs:\nChromium sandboxing failed!';
    expect(classifyLaunchFailure(playwrightSandbox).kind).toBe('sandbox-namespaces');
    expect(classifyLaunchFailure(launchError(['No usable sandbox! Update your kernel'])).kind).toBe('sandbox-namespaces');
    expect(classifyLaunchFailure(launchError(['Running as root without --no-sandbox is not supported'])).kind).toBe('sandbox-root');
  });

  it('does not read the quoted command line as a sandbox failure', () => {
    expect(classifyLaunchFailure(launchError(['Something else broke']), { isRoot: true })).toMatchObject({ kind: 'unknown', detail: 'Something else broke' });
  });

  it('presents a regular Chrome of the running version to pages', () => {
    expect(pageUserAgent('Google Chrome for Testing 156.0.8078.4', 'linux')).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36');
    expect(pageUserAgent('156.0.8078.4', 'darwin')).toContain('(Macintosh; Intel Mac OS X 10_15_7)');
    expect(pageUserAgent(null)).toBeNull();
    expect(pageUserAgent('Chromium')).toBeNull();
  });
});

describe('server browser input', () => {
  it('sends editing commands Chrome does not map itself', () => {
    expect(editingCommandsForKey({ key: 'c', modifiers: { ctrl: true } })).toEqual(['copy']);
    expect(editingCommandsForKey({ key: 'x', modifiers: { meta: true } })).toEqual(['cut']);
    expect(editingCommandsForKey({ key: 'a', modifiers: { meta: true } })).toEqual(['selectAll']);
    expect(editingCommandsForKey({ key: 'Z', modifiers: { meta: true, shift: true } })).toEqual(['redo']);
    // Ctrl+A and Ctrl+Z already work; doubling them would undo twice.
    expect(editingCommandsForKey({ key: 'a', modifiers: { ctrl: true } })).toEqual([]);
    expect(editingCommandsForKey({ key: 'z', modifiers: { ctrl: true } })).toEqual([]);
    expect(editingCommandsForKey({ key: 'c', modifiers: {} })).toEqual([]);
  });

  it('accepts only http(s) addresses', () => {
    expect(normalizeServerBrowserUrl('http://localhost:3000')).toBe('http://localhost:3000/');
    expect(normalizeServerBrowserUrl(' about:blank ')).toBe('about:blank');
    expect(normalizeServerBrowserUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeServerBrowserUrl('chrome://settings')).toBeNull();
    expect(normalizeServerBrowserUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeServerBrowserUrl('not a url')).toBeNull();
  });

  const inputWith = (send) => {
    const input = createTabInput({ onInput: () => {}, cursorAt: async () => 'default', onCursor: () => {}, takeCopy: async () => '', onCopied: () => {} });
    input.bind(send);
    return input;
  };

  it('lets go of the keys and buttons a viewer held when it leaves', async () => {
    const sent = [];
    const input = inputWith(async (method, params) => { sent.push({ method, ...params }); });
    const viewer = {};
    await input.handleMouse({ action: 'down', x: 5, y: 6, button: 'left', clickCount: 1 }, viewer);
    await input.handleKey({ action: 'down', key: 'Shift', code: 'ShiftLeft', keyCode: 16 }, viewer);
    await input.handleKey({ action: 'down', key: 'a', code: 'KeyA', keyCode: 65 }, viewer);
    await input.handleKey({ action: 'up', key: 'a', code: 'KeyA', keyCode: 65 }, viewer);
    sent.length = 0;
    await input.releaseViewer(viewer);
    expect(sent.map(({ type, code, button }) => [type, code ?? button])).toEqual([['keyUp', 'ShiftLeft'], ['mouseReleased', 'left']]);
    sent.length = 0;
    await input.releaseViewer(viewer);
    expect(sent).toEqual([]);
  });
});

describe('server browser wheel input', () => {
  // Chrome answers a wheel event only after the page handles it, which can
  // take longer than a trackpad waits between events.
  const slowWheelInput = () => {
    const sent = [];
    const answers = [];
    const input = createTabInput({ onInput: () => {}, cursorAt: async () => 'default', onCursor: () => {}, takeCopy: async () => '', onCopied: () => {} });
    input.bind((method, params) => {
      sent.push({ method, ...params });
      if (params?.type !== 'mouseWheel') return Promise.resolve({});
      return new Promise((resolve) => answers.push(resolve));
    });
    const wheels = () => sent.filter((entry) => entry.type === 'mouseWheel').map(({ x, y, deltaX, deltaY }) => ({ x, y, deltaX, deltaY }));
    const answerNext = async () => { answers.shift()?.({}); await settle(); };
    return { input, sent, wheels, answerNext };
  };
  const wheel = (deltaY, x = 10) => ({ action: 'wheel', x, y: 20, deltaX: 0, deltaY });

  it('adds up wheel events that arrive while Chrome is busy instead of queueing them', async () => {
    const { input, wheels, answerNext } = slowWheelInput();
    // Each call returns before Chrome answers, so later input is never stuck behind it.
    for (const deltaY of [10, 10, 10, 10]) await input.handleMouse(wheel(deltaY, 10 + deltaY));
    expect(wheels()).toEqual([{ x: 20, y: 20, deltaX: 0, deltaY: 10 }]);
    await answerNext();
    expect(wheels()).toEqual([{ x: 20, y: 20, deltaX: 0, deltaY: 10 }, { x: 20, y: 20, deltaX: 0, deltaY: 30 }]);
    await answerNext();
    expect(wheels()).toHaveLength(2);
  });

  it('keeps wheel events with different modifiers apart and in order', async () => {
    const { input, sent, answerNext } = slowWheelInput();
    await input.handleMouse(wheel(10));
    await input.handleMouse({ ...wheel(-5), modifiers: { ctrl: true } });
    await input.handleMouse(wheel(20));
    await input.handleMouse(wheel(20));
    for (let i = 0; i < 3; i++) await answerNext();
    expect(sent.map(({ modifiers, deltaY }) => [modifiers, deltaY])).toEqual([[0, 10], [2, -5], [0, 40]]);
  });

  it('delivers waiting wheel movement before a click', async () => {
    const { input, sent, answerNext } = slowWheelInput();
    await input.handleMouse(wheel(10));
    await input.handleMouse(wheel(15));
    const click = input.handleMouse({ action: 'down', x: 30, y: 40, button: 'left', clickCount: 1 });
    await answerNext();
    await answerNext();
    await click;
    expect(sent.filter((entry) => entry.method === 'Input.dispatchMouseEvent').map((entry) => entry.type)).toEqual(['mouseWheel', 'mouseWheel', 'mousePressed']);
    expect(sent[1].deltaY).toBe(15);
  });
});

describe('server browser frame pacing', () => {
  afterEach(() => { vi.useRealTimers(); });

  // Chrome sends the next frame only after the last one is acknowledged.
  const pacedStream = async () => {
    const acks = [];
    const stream = createTabStream({ viewport: () => ({ width: 100, height: 100, dpr: 1 }) });
    await stream.bind(async (method) => {
      if (method === 'Page.screencastFrameAck') acks.push(Date.now());
      return {};
    });
    await stream.addViewer({ sendFrame: () => {} });
    // Whether the second of two back-to-back frames is acknowledged within `ms`.
    const frameAckedAfter = (ms) => {
      stream.onFrame({ sessionId: 1, data: '', metadata: {} });
      vi.advanceTimersByTime(0);
      const start = Date.now();
      stream.onFrame({ sessionId: 2, data: '', metadata: {} });
      vi.advanceTimersByTime(ms);
      return acks.some((at) => at > start);
    };
    return { stream, frameAckedAfter };
  };

  it('streams about 30 frames a second while nobody touches the page', async () => {
    vi.useFakeTimers({ now: 100_000 });
    const { frameAckedAfter } = await pacedStream();
    vi.advanceTimersByTime(1_000);
    expect(frameAckedAfter(20)).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(frameAckedAfter(34)).toBe(true);
  });

  it('streams about 60 frames a second for a moment after input', async () => {
    vi.useFakeTimers({ now: 100_000 });
    const { stream, frameAckedAfter } = await pacedStream();
    vi.advanceTimersByTime(1_000);
    stream.noteInput();
    expect(frameAckedAfter(17)).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(frameAckedAfter(20)).toBe(false);
  });

  it('sends a viewer that falls behind only the newest frame', async () => {
    const stream = createTabStream({ viewport: () => ({ width: 100, height: 100, dpr: 1 }) });
    await stream.bind(async () => ({}));
    const received = [];
    const viewer = { sendFrame: (frame) => received.push(JSON.parse(frame.subarray(4, 4 + frame.readUInt32BE(0)).toString()).seq) };
    await stream.addViewer(viewer);
    for (let i = 0; i < 5; i++) stream.onFrame({ sessionId: i, data: '', metadata: {} });
    expect(received).toEqual([1, 2]);
    stream.ack(viewer);
    stream.ack(viewer);
    expect(received).toEqual([1, 2, 5]);
  });
});

describe('isBlockedServerNetworkLoad', () => {
  it('blocks public pages from loading server-network addresses', () => {
    expect(isBlockedServerNetworkLoad({ url: 'http://127.0.0.1:6379/', from: 'https://example.com/' })).toBe(true);
    expect(isBlockedServerNetworkLoad({ url: 'http://192.168.1.1/', from: 'https://example.com/' })).toBe(true);
    expect(isBlockedServerNetworkLoad({ url: 'http://169.254.169.254/latest', from: 'https://example.com/' })).toBe(true);
    // A page at a public IPv4-mapped address is a public page.
    expect(isBlockedServerNetworkLoad({ url: 'http://127.0.0.1/', from: 'http://[::ffff:8.8.8.8]/' })).toBe(true);
    expect(isBlockedServerNetworkLoad({ url: 'http://[::ffff:8.8.8.8]/', from: 'https://example.com/' })).toBe(true);
  });

  it('allows what the person asked for, local pages, and public destinations', () => {
    expect(isBlockedServerNetworkLoad({ url: 'http://127.0.0.1:6379/', from: null })).toBe(false);
    expect(isBlockedServerNetworkLoad({ url: 'http://localhost:3000/b', from: 'http://localhost:3000/a' })).toBe(false);
    expect(isBlockedServerNetworkLoad({ url: 'http://localhost:3000/', from: 'about:blank' })).toBe(false);
    expect(isBlockedServerNetworkLoad({ url: 'https://example.com/', from: 'http://localhost:3000/' })).toBe(false);
  });
});

// A browser-level DevTools session that records what the guard answers.
const fakeBrowserSession = () => {
  const emitter = new EventEmitter();
  const sent = [];
  const session = {
    on: (event, handler) => emitter.on(event, handler),
    send: async (method, params) => { sent.push({ method, ...params }); return {}; },
    detach: async () => {},
  };
  const context = { browser: () => ({ newBrowserCDPSession: async () => session }) };
  return { context, sent, emit: (event, params) => emitter.emit(event, params) };
};

const fakeOwner = (url) => {
  const owner = {
    url,
    blockedUrls: [],
    userLoad: null,
    sourceUrl: () => owner.url,
    consumeUserLoad: (next) => {
      if (owner.userLoad !== next) return false;
      owner.userLoad = null;
      return true;
    },
    blocked: (blocked, { mainFrame }) => owner.blockedUrls.push({ url: blocked, mainFrame }),
  };
  return owner;
};

describe('server browser network guard', () => {
  afterEach(() => { vi.useRealTimers(); });

  const guarded = async ({ lookup = async () => [{ address: '93.184.216.34', family: 4 }], onPopupTarget } = {}) => {
    const browser = fakeBrowserSession();
    const guard = createNetworkGuard({ lookup, onPopupTarget });
    await guard.attach(browser.context);
    const page = fakeOwner('https://public.example/');
    guard.addPage('T', page);
    const load = async (requestId, url, frameId = 'T', extra = {}) => {
      browser.emit('Fetch.requestPaused', { requestId, frameId, request: { url }, ...extra });
      await settle();
    };
    const outcome = (requestId) => browser.sent.filter((entry) => entry.requestId === requestId).map(({ method, errorReason }) => (errorReason ? `${method}:${errorReason}` : method));
    return { browser, guard, page, load, outcome };
  };

  it('watches every document request in the browser and denies local network access', async () => {
    const { browser } = await guarded();
    expect(browser.sent.map(({ method }) => method)).toContain('Fetch.enable');
    expect(browser.sent.find(({ method }) => method === 'Fetch.enable').patterns).toEqual([{ resourceType: 'Document', requestStage: 'Request' }]);
    expect(browser.sent.filter(({ method }) => method === 'Browser.setPermission').every(({ setting }) => setting === 'denied')).toBe(true);
  });

  it('checks the addresses a public page\'s link resolves to', async () => {
    const answers = { 'rebind.example': '127.0.0.1', 'bench.example': '198.18.0.1', 'nat64.example': '64:ff9b::a00:1' };
    const { load, outcome, page } = await guarded({ lookup: async (host) => [{ address: answers[host] || '93.184.216.34' }] });
    await load('a', 'http://rebind.example:6379/');
    await load('b', 'https://other.example/');
    await load('c', 'http://bench.example/');
    await load('d', 'http://nat64.example/');
    expect(['a', 'b', 'c', 'd'].map(outcome)).toEqual([['Fetch.failRequest:Aborted'], ['Fetch.continueRequest'], ['Fetch.failRequest:Aborted'], ['Fetch.failRequest:Aborted']]);
    expect(page.blockedUrls).toHaveLength(3);
    expect(page.blockedUrls[0]).toEqual({ url: 'http://rebind.example:6379/', mainFrame: true });
  });

  it('refuses a public page\'s link when its name does not resolve in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const answers = {
      'gone.example': () => Promise.reject(new Error('ENOTFOUND')),
      'empty.example': async () => [],
      'slow.example': () => new Promise(() => {}),
    };
    const { load, outcome, page } = await guarded({ lookup: (host) => answers[host]() });
    await load('a', 'http://gone.example/');
    await load('b', 'http://empty.example/');
    await load('c', 'http://slow.example/');
    expect(outcome('c')).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(['a', 'b', 'c'].map(outcome)).toEqual([['Fetch.failRequest:NameNotResolved'], ['Fetch.failRequest:NameNotResolved'], ['Fetch.failRequest:TimedOut']]);
    // Not the server network, so no notice says it was.
    expect(page.blockedUrls).toEqual([]);
  });

  it('lets the person\'s own load through, and checks where it redirects', async () => {
    const { load, outcome, page } = await guarded();
    page.userLoad = 'http://127.0.0.1:3000/';
    await load('a', 'http://127.0.0.1:3000/');
    // The redirect is judged by the public address that sent it, not the local page showing.
    page.url = 'http://127.0.0.1:3000/';
    page.userLoad = 'https://public.example/go';
    await load('b', 'https://public.example/go');
    await load('c', 'http://127.0.0.1:3000/admin', 'T', { redirectedRequestId: 'b' });
    expect(['a', 'b', 'c'].map(outcome)).toEqual([['Fetch.continueRequest'], ['Fetch.continueRequest'], ['Fetch.failRequest:Aborted']]);
  });

  it('judges a frame by the page it is nested in', async () => {
    const { guard, browser, load, outcome, page } = await guarded();
    guard.frameAttached('F1', 'T');
    browser.emit('Target.targetCreated', { targetInfo: { type: 'iframe', targetId: 'F2', parentFrameId: 'F1' } });
    await load('a', 'http://10.0.0.1/', 'F2');
    expect(outcome('a')).toEqual(['Fetch.failRequest:Aborted']);
    expect(page.blockedUrls).toEqual([{ url: 'http://10.0.0.1/', mainFrame: false }]);
    // A local page's frames may load local addresses.
    page.url = 'http://localhost:3000/';
    await load('b', 'http://10.0.0.1/', 'F2');
    expect(outcome('b')).toEqual(['Fetch.continueRequest']);
  });

  it('waits for a frame Chrome reports late, and judges a frame it never links as public', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { browser, load, outcome } = await guarded();
    await load('a', 'http://10.0.0.1/', 'LATE');
    expect(outcome('a')).toEqual([]);
    browser.emit('Target.targetCreated', { targetInfo: { type: 'iframe', targetId: 'LATE', parentFrameId: 'T' } });
    await settle();
    expect(outcome('a')).toEqual(['Fetch.failRequest:Aborted']);
    await load('b', 'http://10.0.0.1/', 'NOBODY');
    await load('c', 'https://example.com/', 'NOBODY');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(['b', 'c'].map(outcome)).toEqual([['Fetch.failRequest:Aborted'], ['Fetch.continueRequest']]);
  });

  it('hands a popup to its own owner before its first request', async () => {
    const popup = { ...fakeOwner('https://public.example/'), admit: vi.fn(() => false) };
    const onPopupTarget = vi.fn(() => popup);
    const { browser, load, outcome } = await guarded({ onPopupTarget });
    browser.emit('Target.targetCreated', { targetInfo: { type: 'page', targetId: 'P', openerId: 'T' } });
    expect(onPopupTarget).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'P' }));
    await load('a', 'http://127.0.0.1/', 'P');
    await load('b', 'https://example.com/next', 'P');
    expect(['a', 'b'].map(outcome)).toEqual([['Fetch.failRequest:Aborted'], ['Fetch.failRequest:Aborted']]);
    expect(popup.blockedUrls).toEqual([{ url: 'http://127.0.0.1/', mainFrame: true }]);
    expect(popup.admit).toHaveBeenCalledWith('https://example.com/next', { mainFrame: true });
  });
});

// A Playwright page with one DevTools session, enough for a tab.
const fakePage = (targetId = 'T') => {
  const page = new EventEmitter();
  const session = new EventEmitter();
  session.sent = [];
  session.history = { currentIndex: 0, entries: [{ id: 1, url: 'https://public.example/' }] };
  // Methods Chrome never answers, as for a renderer that was killed mid-command.
  session.unanswered = new Set();
  session.send = async (method, params) => {
    session.sent.push({ method, ...params });
    if (session.unanswered.has(method)) return new Promise(() => {});
    if (method === 'Target.getTargetInfo') return { targetInfo: { targetId, title: '' } };
    if (method === 'Page.getNavigationHistory') return session.history;
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: targetId } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    if (method === 'Runtime.evaluate') return { result: { value: '' } };
    return {};
  };
  Object.assign(page, {
    session,
    context: () => ({ newCDPSession: async () => session }),
    goto: vi.fn(async () => null),
    reload: vi.fn(async () => null),
    goBack: vi.fn(async () => null),
    goForward: vi.fn(async () => null),
    closed: false,
    close: vi.fn(async () => {
      if (page.closed) return;
      page.closed = true;
      page.emit('close');
    }),
    isClosed: () => page.closed,
    url: () => '',
  });
  return page;
};

describe('server browser tab', () => {
  afterEach(() => { vi.useRealTimers(); });

  const openTab = async ({ openPage } = {}) => {
    const pages = [];
    let owner = null;
    const guard = { addPage: (_id, next) => { owner = next; }, removePage: () => {}, frameAttached: () => {} };
    const tab = createServerBrowserTab({
      key: 'k',
      openPage: openPage ?? (async () => { pages.push(fakePage(`T${pages.length}`)); return pages.at(-1); }),
      guard,
      onEmpty: () => {},
      onClosed: vi.fn(),
    });
    await tab.init();
    const messages = [];
    const frames = [];
    tab.attachViewer({ sendJson: (message) => messages.push(message), sendFrame: (frame) => frames.push(frame) });
    const commit = (url, page = pages.at(-1)) => page.session.emit('Page.frameNavigated', { frame: { id: 'T', url } });
    return { tab, pages, owner: () => owner, messages, frames, commit };
  };

  it('treats a typed address as the person\'s until it commits, even as the page changes its own URL', async () => {
    const { tab, owner, pages } = await openTab();
    tab.navigate('http://localhost:3000/#top');
    pages[0].session.emit('Page.navigatedWithinDocument', { frameId: 'T0', url: 'https://public.example/#s2' });
    expect(owner().consumeUserLoad('http://localhost:3000/')).toBe(true);
    expect(owner().consumeUserLoad('http://localhost:3000/')).toBe(false);
  });

  it('forgets a reload once it lands, even without a document request', async () => {
    const { tab, owner, commit } = await openTab();
    commit('https://public.example/');
    await tab.reload();
    // Restored from the back/forward cache: the page commits with no request.
    commit('https://public.example/');
    expect(owner().consumeUserLoad('https://public.example/')).toBe(false);
  });

  it('follows title changes the page\'s title watcher reports', async () => {
    const { tab, pages, messages } = await openTab();
    pages[0].session.emit('Runtime.bindingCalled', { name: 'someOtherBinding', payload: 'Ignored' });
    expect(tab.state.title).toBe('');
    pages[0].session.emit('Runtime.bindingCalled', { name: 'pichamberTitleChanged', payload: 'Inbox (3)' });
    expect(tab.state.title).toBe('Inbox (3)');
    expect(messages.at(-1)).toMatchObject({ type: 'state', title: 'Inbox (3)' });
    expect(pages[0].session.sent.map(({ method }) => method)).toEqual(expect.arrayContaining(['Runtime.enable', 'Runtime.addBinding']));
  });

  it('shows the last committed address again when a load is blocked', async () => {
    const { tab, owner, commit, messages } = await openTab();
    commit('https://public.example/');
    tab.navigate('https://public.example/redirects');
    owner().blocked('http://127.0.0.1/', { mainFrame: true });
    expect(tab.state.url).toBe('https://public.example/');
    expect(messages.at(-1)).toEqual({ type: 'notice', kind: 'blocked-server-network', url: 'http://127.0.0.1/' });
  });

  it('replaces a crashed page on reload and keeps its viewers', async () => {
    const { tab, pages, commit, messages } = await openTab();
    commit('https://public.example/');
    pages[0].emit('crash');
    expect(tab.state.crashed).toBe(true);
    await tab.reload();
    expect(pages).toHaveLength(2);
    expect(pages[0].close).toHaveBeenCalled();
    expect(pages[1].goto).toHaveBeenCalledWith('https://public.example/', expect.objectContaining({ waitUntil: 'commit' }));
    commit('https://public.example/');
    expect(messages.filter((m) => m.type === 'state').at(-1)).toMatchObject({ crashed: false, url: 'https://public.example/' });
  });

  it('does not wait for a navigation before taking more input', async () => {
    const { tab, pages } = await openTab();
    pages[0].goto.mockImplementation(() => new Promise(() => {}));
    tab.navigate('https://slow.example/');
    await tab.insertText('typed');
    expect(pages[0].session.sent.some(({ method, text }) => method === 'Input.insertText' && text === 'typed')).toBe(true);
  });

  it('lets go of a command the crashed page will never answer', async () => {
    const { tab, pages } = await openTab();
    pages[0].session.unanswered.add('Runtime.evaluate');
    const inspected = tab.inspectAt(10, 10);
    await settle();
    expect(pages[0].session.sent.at(-1).method).toBe('Runtime.evaluate');
    pages[0].emit('crash');
    await expect(inspected).resolves.toBeNull();
  });

  it('gives up on a command Chrome never answers, so later input is not held up', async () => {
    const { tab, pages } = await openTab();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    pages[0].session.unanswered.add('Runtime.evaluate');
    const inspected = tab.inspectAt(10, 10);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(inspected).resolves.toBeNull();
  });

  it('tries again when a new page never reports ready, and closes it if it turns up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const late = fakePage('LATE');
    let showLate;
    const pages = [];
    const openPage = vi.fn(() => {
      if (openPage.mock.calls.length === 1) return new Promise((resolve) => { showLate = () => resolve(late); });
      pages.push(fakePage('T1'));
      return Promise.resolve(pages.at(-1));
    });
    const opened = openTab({ openPage });
    await vi.advanceTimersByTimeAsync(5_000);
    const { tab } = await opened;
    expect(openPage).toHaveBeenCalledTimes(2);
    showLate();
    await settle();
    expect(late.close).toHaveBeenCalled();
    tab.navigate('https://public.example/');
    expect(pages[0].goto).toHaveBeenCalled();
  });

  it('never offers Back to the blank page a tab starts on', async () => {
    const { tab, pages, commit, messages } = await openTab();
    pages[0].session.history = { currentIndex: 1, entries: [{ id: 1, url: 'about:blank' }, { id: 2, url: 'https://public.example/' }] };
    commit('https://public.example/');
    await settle();
    expect(messages.filter((m) => m.type === 'state').at(-1)).toMatchObject({ canGoBack: false });
    await tab.goBack();
    expect(pages[0].goBack).not.toHaveBeenCalled();
    pages[0].session.history = { currentIndex: 2, entries: [...pages[0].session.history.entries, { id: 3, url: 'https://public.example/next' }] };
    commit('https://public.example/next');
    await settle();
    expect(messages.filter((m) => m.type === 'state').at(-1)).toMatchObject({ canGoBack: true });
    await tab.goBack();
    expect(pages[0].goBack).toHaveBeenCalled();
  });

  it('shows a late viewer, and inspect, the newest frame without a screenshot', async () => {
    const { tab, pages, frames } = await openTab();
    pages[0].session.emit('Page.screencastFrame', { sessionId: 1, data: Buffer.from('jpeg').toString('base64'), metadata: { deviceWidth: 640, deviceHeight: 480 } });
    expect(frames).toHaveLength(1);
    const late = [];
    tab.attachViewer({ sendJson: () => {}, sendFrame: (frame) => late.push(frame) });
    expect(late).toEqual([frames[0]]);
    expect(tab.captureViewport()).toMatchObject({ base64: Buffer.from('jpeg').toString('base64'), cssWidth: 640, cssHeight: 480 });
    expect(pages[0].session.sent.some(({ method }) => method === 'Page.captureScreenshot')).toBe(false);
  });
});

describe('server browser lifecycle', () => {
  const dirs = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const fakeContext = () => {
    const context = new EventEmitter();
    context.closed = false;
    context.browser = () => ({ version: () => '156.0.8078.4', newBrowserCDPSession: async () => ({ on: () => {}, send: async () => ({}), detach: async () => {} }) });
    context.pages = [];
    context.newPage = async () => { context.pages.push(fakePage()); return context.pages.at(-1); };
    context.close = vi.fn(async () => { context.closed = true; context.emit('close'); });
    return context;
  };

  const create = (launchChrome, options = {}) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pichamber-server-browser-'));
    dirs.push(dataDir);
    const profile = path.join(dataDir, 'server-browser', 'profile');
    const browser = createServerBrowser({
      dataDir,
      isRoot: false,
      findExecutable: () => ({ path: '/fake/chrome', source: 'env' }),
      readChromeVersion: async () => '156.0.8078.4',
      launchChrome,
      log: () => {},
      ...options,
    });
    return { browser, profile };
  };

  it('stops Chrome when its setup fails', async () => {
    const context = fakeContext();
    const { browser } = create(async () => context, {
      createGuard: () => ({ attach: async () => { throw new Error('setup failed'); }, detach: async () => {} }),
    });
    await expect(browser.openTab('k')).rejects.toThrow('setup failed');
    expect(context.closed).toBe(true);
  });

  it('starts Chrome with a user agent for its version, learning it from a first run when needed', async () => {
    const launches = [];
    const { browser } = create(async (options) => { launches.push(options.userAgent); return fakeContext(); }, { readChromeVersion: async () => null });
    await browser.openTab('k');
    expect(launches).toEqual([null, expect.stringContaining('Chrome/156.0.0.0')]);
  });

  it('reports a launch failure in the status', async () => {
    const { ChromeLaunchError } = await import('./chrome-launch.js');
    const { browser } = create(async () => { throw new ChromeLaunchError({ kind: 'missing-library', library: 'libnss3.so', detail: 'libnss3.so missing' }); });
    await expect(browser.openTab('k')).rejects.toThrow('failed to start');
    expect(browser.status().problem).toEqual({ kind: 'launch-failed', reason: 'missing-library', library: 'libnss3.so', detail: 'libnss3.so missing' });
  });

  it('tells viewers when Chrome exits, not that the page closed itself', async () => {
    const context = fakeContext();
    const { browser } = create(async () => context);
    const tab = await browser.openTab('k');
    const close = vi.fn();
    tab.attachViewer({ sendJson: () => {}, sendFrame: () => {}, close });
    // Playwright closes the pages before it reports the browser gone.
    context.pages[0].emit('close');
    await new Promise((resolve) => setTimeout(resolve, 50));
    context.emit('close');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(close).toHaveBeenCalledWith('browser-exited');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('deletes the profile only after a launch in progress stops, and launches after', async () => {
    const first = fakeContext();
    let finishLaunch;
    const launches = [];
    const { browser, profile } = create(({ userDataDir }) => {
      launches.push(fs.existsSync(path.join(userDataDir, 'Cookies')));
      if (launches.length > 1) return Promise.resolve(fakeContext());
      return new Promise((resolve) => { finishLaunch = () => resolve(first); });
    });
    const opened = browser.openTab('k').catch(() => {});
    await vi.waitFor(() => expect(finishLaunch).toBeTypeOf('function'));
    const cleared = browser.clearData();
    const reopened = browser.openTab('k2').catch(() => {});
    fs.writeFileSync(path.join(profile, 'Cookies'), 'signed in');
    finishLaunch();
    await cleared;
    await Promise.all([opened, reopened]);
    expect(first.closed).toBe(true);
    expect(launches).toEqual([false, false]);
  });

  const viewer = () => ({ messages: [], sendJson(message) { this.messages.push(message); }, sendFrame: () => {}, close: vi.fn() });
  const offered = (target) => target.messages.filter((message) => message.type === 'popup').map((message) => message.id);

  it('offers a popup to the device that used its opener last, whose tab then takes the page', async () => {
    const context = fakeContext();
    const { browser } = create(async () => context);
    const opener = await browser.openTab('k');
    const [first, second] = [viewer(), viewer()];
    opener.attachViewer(first);
    opener.attachViewer(second);
    await opener.insertText('x', second);
    const popup = fakePage('P');
    context.pages[0].emit('popup', popup);
    expect(offered(first)).toEqual([]);
    const [id] = offered(second);
    expect(id).toEqual(expect.any(String));
    const tab = await browser.openTab('k2', { popup: id });
    expect(tab).not.toBe(opener);
    expect(context.pages).toHaveLength(1);
    expect(popup.close).not.toHaveBeenCalled();
    // One claim per popup.
    await expect(browser.openTab('k3', { popup: id })).rejects.toMatchObject({ pageClosed: true });
  });

  it('closes a popup no device can show or claims in time', async () => {
    const context = fakeContext();
    const { browser } = create(async () => context);
    const opener = await browser.openTab('k');
    const unwatched = fakePage('P1');
    context.pages[0].emit('popup', unwatched);
    expect(unwatched.close).toHaveBeenCalled();

    const watcher = viewer();
    opener.attachViewer(watcher);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const unclaimed = fakePage('P2');
    context.pages[0].emit('popup', unclaimed);
    const nested = fakePage('P3');
    unclaimed.emit('popup', nested);
    expect(nested.close).toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(unclaimed.close).toHaveBeenCalled();
    vi.useRealTimers();
    await expect(browser.openTab('k2', { popup: offered(watcher)[0] })).rejects.toMatchObject({ pageClosed: true });
    await expect(browser.openTab('k3', { popup: 'unknown' })).rejects.toMatchObject({ pageClosed: true });
  });

  it('keeps at most four popups waiting', async () => {
    const context = fakeContext();
    const { browser } = create(async () => context);
    const opener = await browser.openTab('k');
    const watcher = viewer();
    opener.attachViewer(watcher);
    const popups = Array.from({ length: 5 }, (_, index) => fakePage(`P${index}`));
    for (const popup of popups) context.pages[0].emit('popup', popup);
    expect(offered(watcher)).toHaveLength(4);
    expect(popups.map((popup) => popup.close.mock.calls.length > 0)).toEqual([false, false, false, false, true]);
  });

  it('refuses to reopen a page that closed itself until its tab is closed', async () => {
    const context = fakeContext();
    const { browser } = create(async () => context);
    const tab = await browser.openTab('k', { url: 'https://public.example/' });
    const watcher = viewer();
    tab.attachViewer(watcher);
    await context.pages[0].close();
    await vi.waitFor(() => expect(watcher.close).toHaveBeenCalledWith('page-closed'));
    await expect(browser.openTab('k', { url: 'https://public.example/' })).rejects.toMatchObject({ pageClosed: true });
    expect(context.pages).toHaveLength(1);
    await browser.closeTab('k');
    await browser.openTab('k', { url: 'https://public.example/' });
    expect(context.pages).toHaveLength(2);
  });

  it('judges a popup\'s first load as its opener\'s link and closes it when blocked', async () => {
    let guardOptions;
    let guard;
    const { browser } = create(async () => fakeContext(), {
      createGuard: (options) => {
        guardOptions = options;
        guard = createNetworkGuard(options);
        guard.closeTarget = vi.fn(async () => {});
        return guard;
      },
    });
    await browser.openTab('k');
    const opener = fakeOwner('https://public.example/');
    const owner = guardOptions.onPopupTarget({ targetId: 'P', opener });
    expect(owner.sourceUrl()).toBe('https://public.example/');
    expect(owner.consumeUserLoad('http://127.0.0.1/')).toBe(false);
    owner.blocked('http://127.0.0.1/', { mainFrame: true });
    expect(opener.blockedUrls).toEqual([{ url: 'http://127.0.0.1/', mainFrame: false }]);
    expect(guard.closeTarget).toHaveBeenCalledWith('P');
  });

  it('removes uploads after an hour, with no later upload', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const { browser } = create(async () => fakeContext());
    const old = await browser.saveUpload({ name: 'old.txt', stream: Readable.from(['old']) });
    const [oldPath] = browser.uploadPaths([old.id]);
    expect(fs.existsSync(oldPath)).toBe(true);
    await vi.advanceTimersByTimeAsync(61 * 60 * 1000);
    await vi.waitFor(() => expect(fs.existsSync(oldPath)).toBe(false));
    expect(browser.uploadPaths([old.id])).toEqual([]);
  });

  it('never hands a page an upload past its hour, even before it is removed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { browser } = create(async () => fakeContext());
    const upload = await browser.saveUpload({ name: 'late.txt', stream: Readable.from(['late']) });
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    expect(browser.uploadPaths([upload.id])).toEqual([]);
  });
});
