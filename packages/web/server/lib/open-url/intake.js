import { createServer } from 'node:http';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

// The PiChamber server's Open request intake: a Unix socket next to the
// session daemon's socket. The `$BROWSER` handler (browser-handler.mjs)
// posts `{ url, sessionId? }` here. Filesystem permissions are the access
// check: the socket and its directory are private to this user, and neither
// the HTTP app, its auth middleware, nor the relay can reach it.
//
// The response says whether a device received the request. The server, not
// the daemon, answers that: the daemon also has server-internal subscribers
// (the notification watcher), so only the server knows whether any device
// has a live event stream.

const MAX_BODY_BYTES = 8 * 1024;

const readJsonBody = (req) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      reject(Object.assign(new Error('Body too large'), { statusCode: 413 }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
    } catch {
      reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
    }
  });
  req.on('error', reject);
});

const respond = (res, statusCode, body) => {
  if (res.headersSent) return;
  res.writeHead(statusCode, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/**
 * Handle one intake request.
 *
 * `publish(payload)` asks the daemon to attribute and publish the request and
 * resolves `{ published }`. `hasConnectedDevices()` reports whether any device
 * has a live event stream. A request is delivered only when both hold; on
 * anything else the handler falls back to the server machine's own opener.
 */
const handleOpenUrlIntakeRequest = async ({ req, res, publish, hasConnectedDevices }) => {
  if (req.method !== 'POST' || req.url !== '/open') {
    respond(res, 404, { delivered: false });
    return;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    respond(res, error?.statusCode ?? 400, { delivered: false });
    return;
  }
  const url = typeof body?.url === 'string' ? body.url : '';
  const sessionId = typeof body?.sessionId === 'string' && body.sessionId.length > 0 && body.sessionId.length <= 256
    ? body.sessionId
    : undefined;
  if (!url) {
    respond(res, 400, { delivered: false });
    return;
  }
  // Without a device there is nobody to show it to: skip the daemon so a
  // request is never published and also opened on the server.
  if (!hasConnectedDevices()) {
    respond(res, 200, { delivered: false });
    return;
  }
  try {
    const result = await publish({ url, ...(sessionId ? { sessionId } : {}) });
    respond(res, 200, { delivered: result?.published === true });
  } catch {
    // An older daemon without `openUrl.publish`, or an invalid URL: the
    // handler falls back rather than losing the request.
    respond(res, 200, { delivered: false });
  }
};

const removeStaleSocket = async (socketPath) => {
  try {
    const info = await lstat(socketPath);
    if (info.isSocket()) await rm(socketPath, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
};

const SOCKET_CHECK_INTERVAL_MS = 60_000;

export const createOpenUrlIntake = ({
  socketPath,
  publish,
  hasConnectedDevices,
  platform = process.platform,
  checkIntervalMs = SOCKET_CHECK_INTERVAL_MS,
}) => {
  let server = null;
  let checkTimer = null;
  let rebinding = false;

  const listen = async () => {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    await removeStaleSocket(socketPath);
    const next = createServer((req, res) => {
      void handleOpenUrlIntakeRequest({ req, res, publish, hasConnectedDevices }).catch(() => {
        respond(res, 500, { delivered: false });
      });
    });
    await new Promise((resolve, reject) => {
      next.once('error', reject);
      next.listen(socketPath, () => {
        next.off('error', reject);
        resolve();
      });
    });
    try {
      await chmod(socketPath, 0o600);
    } catch {
      // Some filesystems reject mode bits; the directory is already private.
    }
    return next;
  };

  const closeServer = (current) => new Promise((resolve) => current.close(() => resolve()));

  // Logout or a temp cleaner can delete the runtime directory while the
  // server keeps running; the listener then has no path. Bind again.
  const rebindIfMissing = async () => {
    if (rebinding || !server) return;
    rebinding = true;
    try {
      try {
        await lstat(socketPath);
        return;
      } catch (error) {
        if (error?.code !== 'ENOENT') return;
      }
      // Close first: closing a Unix socket server unlinks its path, which
      // would remove the new socket if it were already bound there.
      const previous = server;
      await closeServer(previous);
      if (server !== previous) return;
      const next = await listen();
      if (server !== previous) {
        // Stopped while binding.
        await closeServer(next);
        return;
      }
      server = next;
    } catch {
      // Try again on the next check.
    } finally {
      rebinding = false;
    }
  };

  const start = async () => {
    if (platform === 'win32' || typeof socketPath !== 'string' || socketPath.length === 0) return false;
    server = await listen();
    checkTimer = setInterval(() => { void rebindIfMissing(); }, checkIntervalMs);
    checkTimer.unref?.();
    return true;
  };

  const stop = async () => {
    if (checkTimer) clearInterval(checkTimer);
    checkTimer = null;
    const current = server;
    server = null;
    if (!current) return;
    await closeServer(current);
    await rm(socketPath, { force: true }).catch(() => {});
  };

  return { start, stop, rebindIfMissing };
};
