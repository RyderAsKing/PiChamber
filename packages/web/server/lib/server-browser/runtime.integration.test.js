import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { findChromeExecutable } from './chrome-executable.js';
import { createNetworkGuard } from './network-guard.js';
import { createServerBrowser } from './server-browser.js';
import { createServerBrowserRuntime } from './runtime.js';

// Drives a real headless Chrome. Skipped where none is installed.
const chrome = findChromeExecutable();
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const PAGE = `<!doctype html><html><head><title>Test page</title></head><body style="margin:0">
<input id="field" style="position:absolute;left:10px;top:10px;width:200px;height:30px">
<p id="words" style="position:absolute;left:10px;top:60px;margin:0">copy these words</p>
<button id="popup" onclick="window.open('/popup-page')" style="position:absolute;left:10px;top:100px">popup</button>
<input id="file" type="file" style="position:absolute;left:10px;top:140px">
<a id="dl" href="/download" style="position:absolute;left:10px;top:180px">download</a>
<script>
addEventListener('message', (event) => { fetch('/opener-got?d=' + encodeURIComponent(event.data)); });
document.getElementById('field').addEventListener('input', (event) => { fetch('/typed?v=' + encodeURIComponent(event.target.value)); });
document.getElementById('file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  fetch('/uploaded?name=' + encodeURIComponent(file.name) + '&text=' + encodeURIComponent(await file.text()));
});
</script></body></html>`;

// The pixel size of a JPEG, from its start-of-frame marker.
const jpegSize = (bytes) => {
  for (let at = 2; at + 9 < bytes.length;) {
    const marker = bytes[at + 1];
    if (marker >= 0xc0 && marker <= 0xc2) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
};

// Renderer processes under the Chrome that uses `profile`.
const rendererPids = (profile) => {
  const procs = fs.readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).map((pid) => {
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      const ppid = Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[1]);
      return { pid: Number(pid), ppid, cmdline };
    } catch {
      return null;
    }
  }).filter(Boolean);
  const roots = procs.filter((proc) => proc.cmdline.includes(`--user-data-dir=${profile}`) && !proc.cmdline.includes('--type=')).map((proc) => proc.pid);
  const descends = (proc) => {
    for (let current = proc, depth = 0; current && depth < 8; depth += 1) {
      if (roots.includes(current.ppid)) return true;
      current = procs.find((other) => other.pid === current.ppid);
    }
    return false;
  };
  return procs.filter((proc) => proc.cmdline.includes('--type=renderer') && descends(proc)).map((proc) => proc.pid);
};

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

describe.skipIf(!chrome?.path)('server browser over its WebSocket', () => {
  const seen = [];
  let upstream;
  let upstreamPort;
  let appServer;
  let base;
  let runtime;
  let dataDir;

  const userAgents = [];
  const logs = [];

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      seen.push(req.url);
      userAgents.push(String(req.headers['user-agent'] || ''));
      if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(PAGE); return; }
      if (req.url === '/popup-page') { res.setHeader('content-type', 'text/html'); res.end('<title>Popup</title><button onclick="window.close()" style="position:absolute;left:0;top:0;width:300px;height:100px">close</button><script>window.opener.postMessage("from-popup", "*")</script>'); return; }
      if (req.url === '/second') { res.setHeader('content-type', 'text/html'); res.end('<title>Second</title><h1>second</h1>'); return; }
      if (req.url === '/alert') { res.setHeader('content-type', 'text/html'); res.end('<script>setTimeout(() => { alert("hello there"); fetch("/after-alert"); }, 50)</script>'); return; }
      if (req.url === '/download') { res.setHeader('content-disposition', 'attachment; filename="notes.txt"'); res.end('downloaded body'); return; }
      if (req.url === '/popup-to-local') { res.setHeader('content-type', 'text/html'); res.end(`<a href="http://127.0.0.1:${upstreamPort}/popup-secret" target="_blank" style="position:absolute;left:0;top:0;width:300px;height:100px">open</a>`); return; }
      if (req.url === '/frame-public') { res.setHeader('content-type', 'text/html'); res.end(`<iframe src="http://public.example:${upstreamPort}/to-local"></iframe>`); return; }
      if (req.url === '/to-local') { res.statusCode = 302; res.setHeader('location', `http://127.0.0.1:${upstreamPort}/secret`); res.end(); return; }
      if (req.url === '/nest') { res.setHeader('content-type', 'text/html'); res.end(`<iframe src="http://other.example:${upstreamPort}/nest-inner"></iframe>`); return; }
      if (req.url === '/nest-inner') { res.setHeader('content-type', 'text/html'); res.end(`<iframe src="http://127.0.0.1:${upstreamPort}/nested-secret"></iframe>`); return; }
      if (req.url === '/local-nest') { res.setHeader('content-type', 'text/html'); res.end(`<iframe src="http://127.0.0.1:${upstreamPort}/local-mid"></iframe>`); return; }
      if (req.url === '/local-mid') { res.setHeader('content-type', 'text/html'); res.end(`<iframe src="http://127.0.0.1:${upstreamPort}/local-leaf"></iframe>`); return; }
      if (req.url === '/stall') return; // Never answers.
      if (req.url === '/buttons') {
        res.setHeader('content-type', 'text/html');
        res.end('<title>Buttons</title><body style="margin:0;height:100vh" onmousedown="fetch(\'/pressed\')" onmouseup="fetch(\'/released\')"></body>');
        return;
      }
      res.end('ok');
    });
    upstreamPort = await listen(upstream);

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pichamber-server-browser-'));
    const app = express();
    appServer = http.createServer(app);
    const browser = createServerBrowser({
      dataDir,
      // Root always needs it; elsewhere keep the runner's own choice.
      env: { ...process.env, PICHAMBER_BROWSER_NO_SANDBOX: isRoot ? '1' : (process.env.PICHAMBER_BROWSER_NO_SANDBOX ?? '') },
      // Public-looking names for this machine, to test public pages.
      extraChromeArgs: ['--host-resolver-rules=MAP *.example 127.0.0.1'],
      // The rule's own lookup sees them as public addresses.
      createGuard: (options) => createNetworkGuard({ ...options, lookup: async () => [{ address: '93.184.216.34', family: 4 }] }),
      log: (message) => logs.push(message),
    });
    runtime = createServerBrowserRuntime({
      app,
      server: appServer,
      express,
      dataDir,
      uiAuthController: null,
      isRequestOriginAllowed: async () => true,
      rejectWebSocketUpgrade: (socket) => socket.destroy(),
      browser,
    });
    base = `127.0.0.1:${await listen(appServer)}`;

    // Chrome's first start on a fresh CI machine has taken 13 to 30 seconds,
    // longer than a test's waits, so start it before the tests (retrying a
    // start that timed out).
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        await browser.openTab('warmup');
        break;
      } catch (error) {
        logs.push(`warm-up start failed: ${error?.status?.problem?.detail || error?.message}`);
        if (Date.now() > deadline) throw new Error(logs.join('\n'));
      }
    }
    await browser.closeTab('warmup');
  }, 120_000);

  afterAll(async () => {
    await runtime?.shutdown();
    appServer?.closeAllConnections();
    upstream?.closeAllConnections();
    await Promise.all([appServer, upstream].filter(Boolean).map((server) => new Promise((resolve) => server.close(resolve))));
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const connect = (tab, url, { popup } = {}) => {
    const socket = new WebSocket(`ws://${base}/api/server-browser/ws?tab=${tab}&url=${encodeURIComponent(url)}${popup ? `&popup=${popup}` : ''}`);
    const messages = [];
    const frames = [];
    const waiters = [];
    const check = () => {
      for (const waiter of [...waiters]) {
        const found = waiter.predicate();
        if (found) {
          waiters.splice(waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve(found);
        }
      }
    };
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        const headerLength = data.readUInt32BE(0);
        frames.push({ header: JSON.parse(data.subarray(4, 4 + headerLength).toString('utf8')), jpeg: data.subarray(4 + headerLength) });
        socket.send(JSON.stringify({ type: 'ack' }));
      } else {
        messages.push(JSON.parse(data.toString('utf8')));
      }
      check();
    });
    const closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)));
    const until = (predicate, label, timeoutMs = 8000) => new Promise((resolve, reject) => {
      const found = predicate();
      if (found) { resolve(found); return; }
      const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error(`Timed out waiting for ${label}; last messages: ${JSON.stringify(messages.slice(-6))}${logs.length ? `; server browser log:\n${logs.join('\n')}` : ''}`)), timeoutMs) };
      waiters.push(waiter);
      // Requests the page makes arrive outside the socket; check them too.
      const poll = setInterval(check, 50);
      waiter.timer.unref?.();
      const done = waiter.resolve;
      waiter.resolve = (value) => { clearInterval(poll); done(value); };
      setTimeout(() => clearInterval(poll), timeoutMs).unref?.();
    });
    const waitFor = (predicate, label, timeoutMs) => until(() => messages.find(predicate), label, timeoutMs);
    const send = (message) => socket.send(JSON.stringify(message));
    const open = new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const waitForSeen = (match, label) => until(() => seen.find((url) => match.test(url)), label);
    const click = async (x, y) => {
      send({ type: 'mouse', action: 'down', x, y, button: 'left', clickCount: 1 });
      send({ type: 'mouse', action: 'up', x, y, button: 'left', clickCount: 1 });
    };
    return { socket, messages, frames, waitFor, until, send, open, closed, waitForSeen, click };
  };

  it('streams the page, takes input, and reports its state', async () => {
    const page = connect('main', `http://127.0.0.1:${upstreamPort}/`);
    await page.open;
    page.send({ type: 'viewport', width: 600, height: 400, dpr: 1 });
    await page.waitFor((m) => m.type === 'state' && m.title === 'Test page', 'title');
    await page.until(() => page.frames.find((frame) => frame.header.width === 600), 'a 600px frame');
    // Sites see a regular Chrome, not HeadlessChrome.
    expect(userAgents[0]).toMatch(/ Chrome\/\d+/);
    expect(userAgents.some((agent) => agent.includes('Headless'))).toBe(false);
    expect(page.frames.at(-1).jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

    await page.click(50, 25);
    for (const key of 'hi') {
      page.send({ type: 'key', action: 'down', key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) });
      page.send({ type: 'key', action: 'up', key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) });
    }
    await page.waitForSeen(/^\/typed\?v=hi$/, 'typed text');
    page.send({ type: 'text', text: ' there' });
    await page.waitForSeen(/^\/typed\?v=hi%20there$/, 'inserted text');

    page.send({ type: 'inspect', x: 50, y: 25, requestId: 1 });
    const hover = await page.waitFor((m) => m.type === 'inspect-hover' && m.requestId === 1, 'inspect hover');
    expect(hover.target).toMatchObject({ tag: 'input', selector: '#field' });
    page.send({ type: 'inspect', x: 50, y: 25, pick: true, requestId: 2 });
    const pick = await page.waitFor((m) => m.type === 'inspect-pick' && m.requestId === 2, 'inspect pick');
    expect(pick.screenshot).toMatchObject({ cssWidth: 600, cssHeight: 400 });
    expect(pick.screenshot.base64.length).toBeGreaterThan(100);

    // Select the paragraph with a triple click, then copy.
    page.send({ type: 'mouse', action: 'down', x: 30, y: 65, button: 'left', clickCount: 3 });
    page.send({ type: 'mouse', action: 'up', x: 30, y: 65, button: 'left', clickCount: 3 });
    page.send({ type: 'key', action: 'down', key: 'c', code: 'KeyC', keyCode: 67, modifiers: { ctrl: true } });
    const copied = await page.waitFor((m) => m.type === 'clipboard', 'clipboard');
    expect(copied.text.trim()).toBe('copy these words');
    page.socket.close();
  }, 30_000);

  it('opens a popup as its own tab that can reach its opener, until it closes itself', async () => {
    const page = connect('opener', `http://127.0.0.1:${upstreamPort}/`);
    await page.open;
    page.send({ type: 'viewport', width: 600, height: 400, dpr: 1 });
    await page.waitFor((m) => m.type === 'state' && m.title === 'Test page' && !m.loading, 'title');
    await page.click(25, 108);
    const { id } = await page.waitFor((m) => m.type === 'popup', 'popup');
    expect(page.messages.find((m) => m.type === 'popup')).toEqual({ type: 'popup', id });

    // The device opens a tab for it; its first connection claims the popup.
    const popup = connect('opened-popup', '', { popup: id });
    await popup.open;
    popup.send({ type: 'viewport', width: 600, height: 400, dpr: 1 });
    await popup.waitFor((m) => m.type === 'state' && m.title === 'Popup' && m.url === `http://127.0.0.1:${upstreamPort}/popup-page`, 'popup page');
    await page.waitForSeen(/^\/opener-got\?d=from-popup$/, 'message to the opener');
    await popup.until(() => popup.frames.length > 0, 'popup frames');

    // The popup closes itself; its tab closes, and stays closed.
    await popup.click(50, 50);
    expect(await popup.closed).toBe(4005);
    const again = connect('opened-popup', '');
    expect(await again.closed).toBe(4005);
    // A claim is used once.
    const reclaim = connect('another-popup', '', { popup: id });
    expect(await reclaim.closed).toBe(4005);
    page.socket.close();
  }, 30_000);

  it('goes back and downloads files', async () => {
    const page = connect('popup', `http://127.0.0.1:${upstreamPort}/`);
    await page.open;
    page.send({ type: 'viewport', width: 600, height: 400, dpr: 1 });
    await page.waitFor((m) => m.type === 'state' && m.title === 'Test page' && !m.loading, 'title');
    page.send({ type: 'navigate', url: `http://127.0.0.1:${upstreamPort}/second` });
    // Back is offered once Chrome has the new address in its history.
    await page.waitFor((m) => m.type === 'state' && m.url === `http://127.0.0.1:${upstreamPort}/second` && m.canGoBack && !m.loading, 'second page');

    page.send({ type: 'back' });
    // Back loads the page again (no back/forward cache); click once it has.
    await page.waitFor((m) => m.type === 'state' && m.url === `http://127.0.0.1:${upstreamPort}/` && m.title === 'Test page' && m.canGoForward && !m.canGoBack && !m.loading, 'back');
    await page.click(30, 188);
    const done = await page.waitFor((m) => m.type === 'download' && m.state === 'completed', 'download');
    expect(done.filename).toBe('notes.txt');
    const response = await fetch(`http://${base}/api/server-browser/downloads/${done.id}`);
    expect(await response.text()).toBe('downloaded body');
    expect(response.headers.get('content-disposition')).toContain('notes.txt');
    page.socket.close();
  }, 30_000);

  it('uploads files the page asks for', async () => {
    const page = connect('upload', `http://127.0.0.1:${upstreamPort}/`);
    await page.open;
    page.send({ type: 'viewport', width: 600, height: 400, dpr: 1 });
    await page.waitFor((m) => m.type === 'state' && m.title === 'Test page', 'title');
    await page.click(40, 150);
    const chooser = await page.waitFor((m) => m.type === 'file-chooser', 'file chooser');
    const upload = await fetch(`http://${base}/api/server-browser/uploads?name=hello.txt`, { method: 'POST', body: 'file contents' }).then((r) => r.json());
    page.send({ type: 'file-chooser', id: chooser.id, uploadIds: [upload.id] });
    await page.waitForSeen(/^\/uploaded\?name=hello\.txt&text=file%20contents$/, 'uploaded file');
    page.socket.close();
  }, 30_000);

  it('shows page dialogs and applies the answer', async () => {
    const page = connect('dialog', `http://127.0.0.1:${upstreamPort}/alert`);
    await page.open;
    const dialog = await page.waitFor((m) => m.type === 'dialog', 'dialog');
    expect(dialog).toMatchObject({ kind: 'alert', message: 'hello there' });
    page.send({ type: 'dialog', accept: true });
    await page.waitFor((m) => m.type === 'dialog-closed', 'dialog closed');
    await page.waitForSeen(/^\/after-alert$/, 'page resumed');
    page.socket.close();
  }, 30_000);

  it('blocks a public page from sending the browser to the server network', async () => {
    const page = connect('public', `http://public.example:${upstreamPort}/to-local`);
    await page.open;
    const notice = await page.waitFor((m) => m.type === 'notice' && m.kind === 'blocked-server-network', 'blocked notice');
    expect(notice.url).toBe(`http://127.0.0.1:${upstreamPort}/secret`);
    expect(seen).not.toContain('/secret');
    // The load is cancelled: the page on screen stays, with its address,
    // and no error page stands in for the blocked one.
    const notices = page.messages.length;
    await page.until(() => page.messages.slice(notices - 1).find((m) => m.type === 'state' && !m.loading), 'loading stopped');
    expect(page.messages.filter((m) => m.type === 'state').at(-1).url).toBe('about:blank');
    expect(page.messages.filter((m) => m.type === 'notice')).toHaveLength(1);

    // Typing the same address is the person's choice, so it loads.
    page.send({ type: 'navigate', url: `http://127.0.0.1:${upstreamPort}/secret` });
    await page.waitForSeen(/^\/secret$/, 'typed local address');
    page.socket.close();
  }, 30_000);

  it('blocks a public frame from redirecting to the server network', async () => {
    const before = seen.length;
    const page = connect('public-frame', `http://127.0.0.1:${upstreamPort}/frame-public`);
    await page.open;
    const notice = await page.waitFor((m) => m.type === 'notice' && m.kind === 'blocked-server-network', 'blocked notice');
    expect(notice.url).toBe(`http://127.0.0.1:${upstreamPort}/secret`);
    expect(seen.slice(before)).not.toContain('/secret');
    page.socket.close();
  }, 30_000);

  it('blocks a popup from a public page before it reaches the server network', async () => {
    const page = connect('public-popup', `http://public.example:${upstreamPort}/popup-to-local`);
    await page.open;
    page.send({ type: 'viewport', width: 600, height: 400, dpr: 1 });
    // The page has no title of its own; its address stands in once it commits.
    await page.waitFor((m) => m.type === 'state' && m.title.endsWith('/popup-to-local') && !m.loading, 'public page');
    await page.click(50, 50);
    const notice = await page.waitFor((m) => m.type === 'notice' && m.kind === 'blocked-server-network', 'blocked notice');
    expect(notice.url).toBe(`http://127.0.0.1:${upstreamPort}/popup-secret`);
    // The popup closed, possibly before it was offered to a device. Claiming
    // it loads nothing, even with its address.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const offered = page.messages.find((m) => m.type === 'popup');
    const claim = connect('blocked-popup', `http://127.0.0.1:${upstreamPort}/popup-secret`, { popup: offered?.id ?? 'unknown-popup' });
    expect(await claim.closed).toBe(4005);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).not.toContain('/popup-secret');
    page.socket.close();
  }, 30_000);

  it('streams at the device pixel ratio', async () => {
    const page = connect('hidpi', `http://127.0.0.1:${upstreamPort}/second`);
    await page.open;
    page.send({ type: 'viewport', width: 600, height: 400, dpr: 2 });
    await page.waitFor((m) => m.type === 'state' && m.title === 'Second', 'title');
    // Frames from before the resize may still arrive; wait for the new size.
    await page.until(() => page.frames.find((entry) => entry.header.width === 600 && entry.header.height === 400 && jpegSize(entry.jpeg)?.height === 800), 'a 2x frame');
    expect(jpegSize(page.frames.findLast((entry) => entry.header.height === 400).jpeg)).toEqual({ width: 1200, height: 800 });
    page.socket.close();
  }, 30_000);

  it('shows an idle page to a second viewer at once', async () => {
    const first = connect('shared', `http://127.0.0.1:${upstreamPort}/second`);
    await first.open;
    first.send({ type: 'viewport', width: 600, height: 400, dpr: 1 });
    await first.waitFor((m) => m.type === 'state' && m.title === 'Second' && !m.loading, 'title');
    await first.until(() => first.frames.length > 0, 'a frame');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const second = connect('shared', '');
    await second.open;
    await second.until(() => second.frames.length > 0, 'a frame for the second viewer', 3000);
    first.socket.close();
    second.socket.close();
  }, 30_000);

  it('lets go of a disconnected viewer\'s mouse button', async () => {
    const page = connect('buttons', `http://127.0.0.1:${upstreamPort}/buttons`);
    await page.open;
    page.send({ type: 'viewport', width: 600, height: 400, dpr: 1 });
    await page.waitFor((m) => m.type === 'state' && m.title === 'Buttons' && !m.loading, 'title');
    page.send({ type: 'mouse', action: 'down', x: 50, y: 50, button: 'left', clickCount: 1 });
    await page.waitForSeen(/^\/pressed$/, 'press');
    page.socket.close();
    await page.waitForSeen(/^\/released$/, 'release on disconnect');
  }, 30_000);

  it('takes input while a load is stalled', async () => {
    const page = connect('stalled', `http://127.0.0.1:${upstreamPort}/`);
    await page.open;
    page.send({ type: 'viewport', width: 600, height: 400, dpr: 1 });
    await page.waitFor((m) => m.type === 'state' && m.title === 'Test page' && !m.loading, 'title');
    await page.click(50, 25);
    page.send({ type: 'navigate', url: `http://127.0.0.1:${upstreamPort}/stall` });
    page.send({ type: 'text', text: 'still here' });
    await page.waitForSeen(/^\/typed\?v=still%20here$/, 'text typed during the load');
    page.socket.close();
  }, 30_000);

  it('blocks a frame nested in a public frame from the server network', async () => {
    const page = connect('nested-public', `http://public.example:${upstreamPort}/nest`);
    await page.open;
    const notice = await page.waitFor((m) => m.type === 'notice' && m.kind === 'blocked-server-network', 'blocked notice');
    expect(notice.url).toBe(`http://127.0.0.1:${upstreamPort}/nested-secret`);
    expect(seen).not.toContain('/nested-secret');
    page.socket.close();
  }, 30_000);

  it('loads frames nested in a local page\'s frames', async () => {
    const page = connect('nested-local', `http://localhost:${upstreamPort}/local-nest`);
    await page.open;
    await page.waitForSeen(/^\/local-leaf$/, 'nested local frame');
    expect(page.messages.some((m) => m.type === 'notice')).toBe(false);
    page.socket.close();
  }, 30_000);

  it.skipIf(!fs.existsSync('/proc/self/cmdline'))('replaces a crashed page when the viewer reloads', async () => {
    const page = connect('crashed', `http://127.0.0.1:${upstreamPort}/second`);
    await page.open;
    page.send({ type: 'viewport', width: 600, height: 400, dpr: 1 });
    await page.waitFor((m) => m.type === 'state' && m.title === 'Second' && !m.loading, 'title');
    const pids = rendererPids(path.join(dataDir, 'server-browser', 'profile'));
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    await page.waitFor((m) => m.type === 'state' && m.crashed, 'crashed state');
    const before = page.messages.length;
    const frames = page.frames.length;
    page.send({ type: 'reload' });
    await page.until(() => page.messages.slice(before).find((m) => m.type === 'state' && !m.crashed && m.title === 'Second' && !m.loading), 'reloaded page');
    await page.until(() => page.frames.length > frames, 'frames after the reload');
    page.socket.close();
  }, 30_000);

  // Finds Chrome's processes through /proc.
  it.skipIf(!fs.existsSync('/proc/self/cmdline'))('reopens the last address after Chrome exits', async () => {
    const page = connect('crash', `http://127.0.0.1:${upstreamPort}/second`);
    await page.open;
    await page.waitFor((m) => m.type === 'state' && m.title === 'Second', 'title');
    const pids = fs.readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).filter((pid) => {
      try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(`--user-data-dir=${path.join(dataDir, 'server-browser', 'profile')}`); } catch { return false; }
    });
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } }
    expect(await page.closed).toBe(4001);

    const again = connect('crash', '');
    await again.open;
    await again.waitFor((m) => m.type === 'state' && m.url === `http://127.0.0.1:${upstreamPort}/second`, 'reopened address', 15_000);
    again.socket.close();
  }, 40_000);
});
