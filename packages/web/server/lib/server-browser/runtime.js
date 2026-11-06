import fs from 'node:fs';

import { WebSocketServer } from 'ws';

import { createDevServerFinder } from './dev-servers.js';
import { createFramePolicyChecker } from './frame-policy.js';
import { createServerBrowser, isValidTabKey } from './server-browser.js';

const SERVER_BROWSER_WS_PATH = '/api/server-browser/ws';
const MAX_CLIENT_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;
// A viewer whose socket holds this much unsent data is too slow to keep up:
// it is disconnected and reconnects to a fresh stream.
const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
// Close codes viewers act on.
const CLOSE_CODES = { closed: 4000, 'browser-exited': 4001, 'browser-restarting': 4002, unavailable: 4003, 'bad-request': 4004, 'page-closed': 4005 };

const parsePath = (url) => {
  try {
    return new URL(url || '', 'http://localhost');
  } catch {
    return null;
  }
};

const parseMessage = (raw) => {
  try {
    const message = JSON.parse(raw.toString('utf8'));
    return message && typeof message === 'object' ? message : null;
  } catch {
    return null;
  }
};

/**
 * Routes and the viewer WebSocket for the server browser.
 *
 * Viewers connect to `/api/server-browser/ws?tab=<key>&url=<start>` (or
 * `&popup=<id>` to claim a popup); see
 * `DOCUMENTATION.md` for the message protocol.
 */
export const createServerBrowserRuntime = ({
  app,
  server,
  express,
  dataDir,
  uiAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  liveRevocation = null,
  browser = createServerBrowser({ dataDir }),
  devServers = createDevServerFinder(),
  framePolicy = createFramePolicyChecker(),
}) => {
  app.get('/api/server-browser/status', (_req, res) => {
    res.json(browser.status());
  });

  app.get('/api/server-browser/dev-servers', async (req, res) => {
    const directory = typeof req.query?.directory === 'string' && req.query.directory ? req.query.directory : null;
    try {
      res.setHeader('Cache-Control', 'no-store');
      // PiChamber's own port is not a dev server.
      res.json(await devServers.find({ directory, excludePorts: [req.socket?.localPort].filter(Boolean) }));
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to find dev servers' });
    }
  });

  // Whether a public page refuses to be shown in an iframe on `origin` (the
  // "This device" browser). Answers `refused`, `allowed`, or `unknown`.
  app.get('/api/server-browser/frame-policy', async (req, res) => {
    const url = typeof req.query?.url === 'string' ? req.query.url : '';
    const origin = typeof req.query?.origin === 'string' ? req.query.origin : '';
    res.setHeader('Cache-Control', 'no-store');
    res.json(await framePolicy.check(url, origin));
  });

  app.put('/api/server-browser/settings', express.json({ limit: '4kb' }), async (req, res) => {
    try {
      res.json(await browser.saveSettings({ allowNoSandbox: req.body?.allowNoSandbox === true }));
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to save server browser settings' });
    }
  });

  app.post('/api/server-browser/clear-data', async (_req, res) => {
    try {
      await browser.clearData();
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to clear browsing data' });
    }
  });

  app.delete('/api/server-browser/tabs/:key', async (req, res) => {
    if (!isValidTabKey(req.params.key)) return res.status(400).json({ error: 'Invalid tab' });
    await browser.closeTab(req.params.key);
    res.json({ ok: true });
  });

  app.post('/api/server-browser/uploads', async (req, res) => {
    const name = typeof req.query?.name === 'string' ? req.query.name : 'file';
    if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD_BYTES) return res.status(413).json({ error: 'File is too large' });
    try {
      res.json(await browser.saveUpload({ name, stream: req, maxBytes: MAX_UPLOAD_BYTES }));
    } catch (error) {
      if (res.headersSent) return;
      res.status(error?.code === 'TOO_LARGE' ? 413 : 500).json({ error: error?.message || 'Upload failed' });
    }
  });

  app.get('/api/server-browser/downloads/:id', (req, res) => {
    const download = browser.getDownload(req.params.id);
    if (!download) return res.status(404).json({ error: 'Download not found' });
    res.setHeader('Cache-Control', 'no-store');
    res.attachment(download.filename);
    fs.createReadStream(download.path)
      .on('error', () => { if (!res.headersSent) res.status(404).end(); else res.destroy(); })
      .pipe(res);
  });

  let wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE_BYTES, perMessageDeflate: false });

  wsServer.on('connection', (socket, req) => {
    const url = parsePath(req.url);
    const key = url?.searchParams.get('tab') || '';
    const startUrl = url?.searchParams.get('url') || '';
    const popup = url?.searchParams.get('popup') || '';
    let detach = null;
    let tab = null;
    let closed = false;
    const heartbeat = setInterval(() => { try { socket.ping(); } catch { /* closing */ } }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const write = (data, options) => {
      if (socket.readyState !== 1) return;
      const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
      if (socket.bufferedAmount + bytes > MAX_SOCKET_BUFFER_BYTES) {
        socket.terminate();
        return;
      }
      socket.send(data, options);
    };
    const sendJson = (message) => write(JSON.stringify(message));
    const viewer = {
      sendJson,
      sendFrame(frame) {
        write(frame, { binary: true });
      },
      close(reason) {
        if (socket.readyState <= 1) socket.close(CLOSE_CODES[reason] ?? CLOSE_CODES.closed, reason);
      },
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      detach?.();
      detach = null;
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    if (!isValidTabKey(key)) {
      viewer.close('bad-request');
      return;
    }

    const handle = async (message) => {
      if (!tab) return;
      switch (message.type) {
        case 'viewport': await tab.setViewport(message); return;
        case 'mouse': await tab.handleMouse(message, viewer); return;
        case 'key': await tab.handleKey(message, viewer); return;
        case 'text': await tab.insertText(message.text, viewer); return;
        case 'navigate': tab.navigate(message.url); return;
        case 'back': await tab.goBack(); return;
        case 'forward': await tab.goForward(); return;
        case 'reload': await tab.reload(); return;
        case 'stop': await tab.stop(); return;
        case 'dialog': await tab.respondDialog({ accept: message.accept === true, text: message.text }); return;
        case 'file-chooser':
          await tab.respondFileChooser({ id: message.id, files: browser.uploadPaths(message.uploadIds) });
          return;
        case 'inspect': {
          const target = await tab.inspectAt(message.x, message.y);
          if (message.pick !== true) {
            sendJson({ type: 'inspect-hover', requestId: message.requestId, target });
            return;
          }
          const screenshot = target ? tab.captureViewport() : null;
          sendJson({ type: 'inspect-pick', requestId: message.requestId, target, screenshot });
          return;
        }
        default:
      }
    };

    // Messages apply in arrival order, even when one waits on the page, and
    // the first ones wait for the tab to open.
    let markReady;
    let queue = new Promise((resolve) => { markReady = resolve; });
    socket.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const message = parseMessage(raw);
      if (!message) return;
      // Frame acks only release frames; they never wait behind page input.
      if (message.type === 'ack') {
        tab?.ackFrame(viewer);
        return;
      }
      queue = queue.then(() => handle(message)).catch(() => {});
    });

    void (async () => {
      try {
        tab = await browser.openTab(key, { url: startUrl, popup });
      } catch (error) {
        if (error?.pageClosed) {
          viewer.close('page-closed');
          return;
        }
        sendJson({ type: 'unavailable', status: error?.status ?? browser.status(), message: error?.status ? undefined : error?.message });
        viewer.close('unavailable');
        return;
      }
      if (closed) return;
      detach = tab.attachViewer(viewer);
      markReady();
    })();
  });

  const trackUpgradePrincipal = (socket, principal, generation) => {
    if (!principal || typeof liveRevocation?.trackLiveConnection !== 'function') return null;
    let tracked;
    try {
      tracked = liveRevocation.trackLiveConnection({
        principal,
        close: () => { if (!socket.destroyed) socket.destroy(); },
        generation,
      });
    } catch {
      try { if (!socket.destroyed) socket.destroy(); } catch { /* gone */ }
      return { active: false, end: () => {}, revoke: () => false };
    }
    socket.once('close', () => tracked.end());
    return tracked;
  };

  // The same gates as the terminal WebSocket: UI auth, origin, and live
  // revocation tracking.
  const upgradeHandler = (req, socket, head) => {
    if (parsePath(req.url)?.pathname !== SERVER_BROWSER_WS_PATH) return;
    void (async () => {
      try {
        let principal = null;
        let generation;
        try {
          if (typeof liveRevocation?.getGeneration === 'function') generation = liveRevocation.getGeneration();
        } catch {
          generation = undefined;
        }
        if (uiAuthController?.enabled) {
          principal = await uiAuthController.ensureSessionToken(req, null);
          if (!principal) { rejectWebSocketUpgrade(socket, 401, 'UI authentication required'); return; }
          if (!await isRequestOriginAllowed(req)) { rejectWebSocketUpgrade(socket, 403, 'Invalid origin'); return; }
        }
        if (!wsServer) { rejectWebSocketUpgrade(socket, 503, 'Server browser unavailable'); return; }
        const tracked = trackUpgradePrincipal(socket, principal, generation);
        if (principal && tracked && tracked.active === false) return;
        wsServer.handleUpgrade(req, socket, head, (ws) => wsServer.emit('connection', ws, req));
      } catch {
        rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
      }
    })();
  };
  server.on('upgrade', upgradeHandler);

  const shutdown = async () => {
    server.off('upgrade', upgradeHandler);
    const current = wsServer;
    wsServer = null;
    if (current) {
      for (const client of current.clients) client.terminate();
      await Promise.race([new Promise((resolve) => current.close(resolve)), new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
    await browser.shutdown();
  };

  return { shutdown, browser };
};
