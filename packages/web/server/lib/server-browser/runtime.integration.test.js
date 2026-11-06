import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { findChromeExecutable } from './chrome-executable.js';
import { createServerBrowser } from './server-browser.js';
import { createServerBrowserRuntime } from './runtime.js';

// Drives a real headless Chrome. Skipped where none is installed.
const chrome = findChromeExecutable();
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const PAGE = `<!doctype html><html><head><title>Test page</title></head><body style="margin:0">
<input id="field" style="position:absolute;left:10px;top:10px;width:200px;height:30px">
<p id="words" style="position:absolute;left:10px;top:60px;margin:0">copy these words</p>
<a id="popup" href="/second" target="_blank" style="position:absolute;left:10px;top:100px">popup</a>
<input id="file" type="file" style="position:absolute;left:10px;top:140px">
<a id="dl" href="/download" style="position:absolute;left:10px;top:180px">download</a>
<script>
document.getElementById('field').addEventListener('input', (event) => { fetch('/typed?v=' + encodeURIComponent(event.target.value)); });
document.getElementById('file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  fetch('/uploaded?name=' + encodeURIComponent(file.name) + '&text=' + encodeURIComponent(await file.text()));
});
</script></body></html>`;

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

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      seen.push(req.url);
      userAgents.push(String(req.headers['user-agent'] || ''));
      if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(PAGE); return; }
      if (req.url === '/second') { res.setHeader('content-type', 'text/html'); res.end('<title>Second</title><h1>second</h1>'); return; }
      if (req.url === '/alert') { res.setHeader('content-type', 'text/html'); res.end('<script>setTimeout(() => { alert("hello there"); fetch("/after-alert"); }, 50)</script>'); return; }
      if (req.url === '/download') { res.setHeader('content-disposition', 'attachment; filename="notes.txt"'); res.end('downloaded body'); return; }
      if (req.url === '/to-local') { res.statusCode = 302; res.setHeader('location', `http://127.0.0.1:${upstreamPort}/secret`); res.end(); return; }
      res.end('ok');
    });
    upstreamPort = await listen(upstream);

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pichamber-server-browser-'));
    const app = express();
    appServer = http.createServer(app);
    const browser = createServerBrowser({
      dataDir,
      env: { ...process.env, PICHAMBER_BROWSER_NO_SANDBOX: isRoot ? '1' : '' },
      // A public-looking name for this machine, to test public pages.
      extraChromeArgs: ['--host-resolver-rules=MAP public.example 127.0.0.1'],
      log: () => {},
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
  }, 30_000);

  afterAll(async () => {
    await runtime?.shutdown();
    appServer?.closeAllConnections();
    upstream?.closeAllConnections();
    await Promise.all([appServer, upstream].filter(Boolean).map((server) => new Promise((resolve) => server.close(resolve))));
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const connect = (tab, url) => {
    const socket = new WebSocket(`ws://${base}/api/server-browser/ws?tab=${tab}&url=${encodeURIComponent(url)}`);
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
      const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs) };
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

  it('opens popups in the same tab and downloads files', async () => {
    const page = connect('popup', `http://127.0.0.1:${upstreamPort}/`);
    await page.open;
    page.send({ type: 'viewport', width: 600, height: 400, dpr: 1 });
    await page.waitFor((m) => m.type === 'state' && m.title === 'Test page', 'title');
    await page.click(25, 108);
    await page.waitFor((m) => m.type === 'state' && m.url === `http://127.0.0.1:${upstreamPort}/second`, 'popup address in this tab');

    page.send({ type: 'back' });
    await page.waitFor((m) => m.type === 'state' && m.url === `http://127.0.0.1:${upstreamPort}/` && m.canGoForward, 'back');
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

  it('reopens the last address after Chrome exits', async () => {
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
