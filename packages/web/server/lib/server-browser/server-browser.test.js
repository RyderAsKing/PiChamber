import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerBrowserTab, editingCommandsForKey, isBlockedServerNetworkLoad, normalizeServerBrowserUrl, pageUserAgent } from './browser-tab.js';
import { createCdpConnection } from './cdp.js';
import { findChromeExecutable } from './chrome-executable.js';

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
});

describe('server browser server-network rule on a page', () => {
  const publicTab = (lookup) => {
    const sent = [];
    const cdp = { closed: false, send: (method, params) => { sent.push({ method, ...params }); return Promise.resolve({}); } };
    const tab = createServerBrowserTab({ key: 'k', cdp, targetId: 't', sessionId: 's', onEmpty: () => {}, lookup });
    tab.handleEvent('Page.frameNavigated', { frame: { id: 't', url: 'https://public.example/' } });
    const load = async (requestId, url) => {
      tab.handleEvent('Fetch.requestPaused', { requestId, frameId: 't', request: { url } });
      await new Promise((resolve) => setImmediate(resolve));
    };
    const outcome = (requestId) => sent.find((entry) => entry.requestId === requestId)?.method;
    return { tab, load, outcome };
  };

  it('checks the addresses a public page\'s link resolves to', async () => {
    const { load, outcome } = publicTab(async (host) => [{ address: host === 'rebind.example' ? '127.0.0.1' : '93.184.216.34', family: 4 }]);
    await load('a', 'http://rebind.example:6379/');
    await load('b', 'https://other.example/');
    expect([outcome('a'), outcome('b')]).toEqual(['Fetch.failRequest', 'Fetch.continueRequest']);
  });

  it('forgets a reload once it lands, even without a document request', async () => {
    const { tab, load, outcome } = publicTab(async () => [{ address: '93.184.216.34', family: 4 }]);
    await tab.reload();
    // Restored from the back/forward cache: the page commits with no request.
    tab.handleEvent('Page.frameNavigated', { frame: { id: 't', url: 'https://public.example/' } });
    await load('c', 'http://10.0.0.1/');
    expect(outcome('c')).toBe('Fetch.failRequest');
  });

  it('keeps a typed address the person\'s while the page changes its own URL', async () => {
    const { tab, load, outcome } = publicTab(async () => [{ address: '93.184.216.34', family: 4 }]);
    await tab.navigate('http://localhost:3000/#top');
    tab.handleEvent('Page.navigatedWithinDocument', { frameId: 't', url: 'https://public.example/#s2' });
    await load('d', 'http://localhost:3000/');
    expect(outcome('d')).toBe('Fetch.continueRequest');
  });
});

describe('server browser wheel input', () => {
  // Chrome answers a wheel event only after the page handles it, which can
  // take longer than a trackpad waits between events.
  const slowWheelTab = () => {
    const sent = [];
    const answers = [];
    const cdp = {
      closed: false,
      send: (method, params) => {
        sent.push({ method, ...params });
        if (params?.type !== 'mouseWheel') return Promise.resolve({});
        return new Promise((resolve) => answers.push(resolve));
      },
    };
    const tab = createServerBrowserTab({ key: 'k', cdp, targetId: 't', sessionId: 's', onEmpty: () => {} });
    const wheels = () => sent.filter((entry) => entry.type === 'mouseWheel').map(({ x, y, deltaX, deltaY }) => ({ x, y, deltaX, deltaY }));
    const answerNext = async () => { answers.shift()?.({}); await new Promise((resolve) => setImmediate(resolve)); };
    return { tab, sent, wheels, answerNext };
  };
  const wheel = (deltaY, x = 10) => ({ action: 'wheel', x, y: 20, deltaX: 0, deltaY });

  it('adds up wheel events that arrive while Chrome is busy instead of queueing them', async () => {
    const { tab, wheels, answerNext } = slowWheelTab();
    // Each call returns before Chrome answers, so later input is never stuck behind it.
    for (const deltaY of [10, 10, 10, 10]) await tab.handleMouse(wheel(deltaY, 10 + deltaY));
    expect(wheels()).toEqual([{ x: 20, y: 20, deltaX: 0, deltaY: 10 }]);
    await answerNext();
    expect(wheels()).toEqual([{ x: 20, y: 20, deltaX: 0, deltaY: 10 }, { x: 20, y: 20, deltaX: 0, deltaY: 30 }]);
    await answerNext();
    expect(wheels()).toHaveLength(2);
  });

  it('keeps wheel events with different modifiers apart and in order', async () => {
    const { tab, sent, answerNext } = slowWheelTab();
    await tab.handleMouse(wheel(10));
    await tab.handleMouse({ ...wheel(-5), modifiers: { ctrl: true } });
    await tab.handleMouse(wheel(20));
    await tab.handleMouse(wheel(20));
    for (let i = 0; i < 3; i++) await answerNext();
    expect(sent.map(({ modifiers, deltaY }) => [modifiers, deltaY])).toEqual([[0, 10], [2, -5], [0, 40]]);
  });

  it('delivers waiting wheel movement before a click', async () => {
    const { tab, sent, answerNext } = slowWheelTab();
    await tab.handleMouse(wheel(10));
    await tab.handleMouse(wheel(15));
    const click = tab.handleMouse({ action: 'down', x: 30, y: 40, button: 'left', clickCount: 1 });
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
  const pacedTab = () => {
    const acks = [];
    const cdp = {
      closed: false,
      send: (method) => {
        if (method === 'Page.screencastFrameAck') acks.push(Date.now());
        return Promise.resolve({});
      },
    };
    const tab = createServerBrowserTab({ key: 'k', cdp, targetId: 't', sessionId: 's', onEmpty: () => {} });
    // Whether the second of two back-to-back frames is acknowledged within `ms`.
    const frameAckedAfter = (ms) => {
      tab.handleEvent('Page.screencastFrame', { sessionId: 1, data: '', metadata: {} });
      vi.advanceTimersByTime(0);
      const start = Date.now();
      tab.handleEvent('Page.screencastFrame', { sessionId: 2, data: '', metadata: {} });
      vi.advanceTimersByTime(ms);
      return acks.some((at) => at > start);
    };
    return { tab, frameAckedAfter };
  };

  it('streams about 30 frames a second while nobody touches the page', () => {
    vi.useFakeTimers({ now: 100_000 });
    const { frameAckedAfter } = pacedTab();
    vi.advanceTimersByTime(1_000);
    expect(frameAckedAfter(20)).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(frameAckedAfter(34)).toBe(true);
  });

  it('streams about 60 frames a second for a moment after input', async () => {
    vi.useFakeTimers({ now: 100_000 });
    const { tab, frameAckedAfter } = pacedTab();
    vi.advanceTimersByTime(1_000);
    await tab.handleMouse({ action: 'wheel', x: 1, y: 1, deltaX: 0, deltaY: 10 });
    expect(frameAckedAfter(17)).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(frameAckedAfter(20)).toBe(false);
  });
});

describe('isBlockedServerNetworkLoad', () => {
  it('blocks public pages from loading server-network addresses', () => {
    expect(isBlockedServerNetworkLoad({ url: 'http://127.0.0.1:6379/', from: 'https://example.com/' })).toBe(true);
    expect(isBlockedServerNetworkLoad({ url: 'http://192.168.1.1/', from: 'https://example.com/' })).toBe(true);
    expect(isBlockedServerNetworkLoad({ url: 'http://169.254.169.254/latest', from: 'https://example.com/' })).toBe(true);
  });

  it('allows what the person asked for, local pages, and public destinations', () => {
    expect(isBlockedServerNetworkLoad({ url: 'http://127.0.0.1:6379/', from: null })).toBe(false);
    expect(isBlockedServerNetworkLoad({ url: 'http://localhost:3000/b', from: 'http://localhost:3000/a' })).toBe(false);
    expect(isBlockedServerNetworkLoad({ url: 'http://localhost:3000/', from: 'about:blank' })).toBe(false);
    expect(isBlockedServerNetworkLoad({ url: 'https://example.com/', from: 'http://localhost:3000/' })).toBe(false);
  });
});

describe('createCdpConnection', () => {
  const connect = () => {
    const toChrome = new PassThrough();
    const fromChrome = new PassThrough();
    const written = [];
    toChrome.on('data', (chunk) => written.push(...chunk.toString('utf8').split('\0').filter(Boolean).map((text) => JSON.parse(text))));
    return { cdp: createCdpConnection({ writable: toChrome, readable: fromChrome, commandTimeoutMs: 1000 }), fromChrome, written };
  };

  it('matches replies to commands across split and merged chunks', async () => {
    const { cdp, fromChrome, written } = connect();
    const events = [];
    cdp.onEvent((event) => events.push(event));
    const first = cdp.send('Browser.getVersion');
    const second = cdp.send('Page.navigate', { url: 'about:blank' }, 'S1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(written).toEqual([
      { id: 1, method: 'Browser.getVersion', params: {} },
      { id: 2, method: 'Page.navigate', params: { url: 'about:blank' }, sessionId: 'S1' },
    ]);
    const payload = `${JSON.stringify({ id: 2, result: { frameId: 'F' } })}\0${JSON.stringify({ method: 'Page.loadEventFired', params: {}, sessionId: 'S1' })}\0${JSON.stringify({ id: 1, result: { product: 'Chrome' } })}\0`;
    fromChrome.write(Buffer.from(payload.slice(0, 17)));
    fromChrome.write(Buffer.from(payload.slice(17)));
    await expect(second).resolves.toEqual({ frameId: 'F' });
    await expect(first).resolves.toEqual({ product: 'Chrome' });
    expect(events).toEqual([{ method: 'Page.loadEventFired', params: {}, sessionId: 'S1' }]);
  });

  it('rejects errors and pending commands when the pipe closes', async () => {
    const { cdp, fromChrome } = connect();
    const failing = cdp.send('Page.reload');
    const pending = cdp.send('Page.stopLoading');
    fromChrome.write(`${JSON.stringify({ id: 1, error: { code: -32000, message: 'Not attached' } })}\0`);
    await expect(failing).rejects.toThrow('Page.reload: Not attached');
    fromChrome.destroy();
    await expect(pending).rejects.toThrow('browser connection closed');
    await expect(cdp.send('Page.enable')).rejects.toThrow('browser connection closed');
  });
});

describe('pageUserAgent', () => {
  it('drops the headless marker from the user agent and its client hints', () => {
    const agent = pageUserAgent({
      product: 'HeadlessChrome/156.0.7000.1',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.7000.1 Safari/537.36',
    }, 'linux');
    expect(agent.userAgent).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.7000.1 Safari/537.36');
    expect(agent.userAgentMetadata).toMatchObject({ platform: 'Linux', fullVersion: '156.0.7000.1', mobile: false });
    expect(agent.userAgentMetadata.brands).toContainEqual({ brand: 'Chromium', version: '156' });
    expect(pageUserAgent({ userAgent: 'Mozilla/5.0 Chrome/156.0 Safari/537.36' })).toBeNull();
    expect(pageUserAgent(null)).toBeNull();
  });
});
