import crypto from 'node:crypto';
import http from 'node:http';

import express from 'express';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import { afterEach, describe, expect, it } from 'vitest';

import { createPreviewProxyRuntime } from './proxy-runtime.js';

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const request = (port, path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers });
  req.on('response', (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
  });
  req.on('upgrade', (res, socket) => {
    socket.destroy();
    resolve({ status: res.statusCode });
  });
  req.on('error', reject);
  req.end(body);
});

describe('preview proxy WebSockets', () => {
  const servers = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    })));
  });

  it('rewrites the Origin of an upgrade after the page has loaded over HTTP', async () => {
    const upgrades = [];
    const upstream = http.createServer((_req, res) => res.end('ok'));
    upstream.on('upgrade', (req, socket) => {
      upgrades.push(req.headers.origin);
      socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);

    const app = express();
    const server = http.createServer(app);
    servers.push(server);
    const port = await listen(server);
    const ownOrigin = `http://127.0.0.1:${port}`;
    createPreviewProxyRuntime({ crypto, URL, createProxyMiddleware, responseInterceptor }).attach(app, {
      server,
      express,
      uiAuthController: null,
      isRequestOriginAllowed: async (req) => req.headers.origin === ownOrigin,
      isCrossSiteRequest: async (req) => Boolean(req.headers.origin) && req.headers.origin !== ownOrigin,
      rejectWebSocketUpgrade: (socket) => socket.destroy(),
    });

    const registered = await request(port, '/api/preview/targets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${upstreamPort}/` }),
    });
    const { proxyBasePath, previewToken } = JSON.parse(registered.body);
    const path = `${proxyBasePath}/?oc_preview_token=${previewToken}`;

    // The page loads first; a proxy that hooks the server's upgrade event on
    // its first HTTP request would then take the WebSocket below.
    expect((await request(port, path)).status).toBe(200);
    const upgraded = await request(port, path, {
      headers: { connection: 'Upgrade', upgrade: 'websocket', origin: ownOrigin },
    });

    expect(upgraded.status).toBe(101);
    expect(upgrades).toEqual([`http://127.0.0.1:${upstreamPort}`]);
  });
});
