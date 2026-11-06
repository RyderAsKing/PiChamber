import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { createRequestSecurityRuntime } from '../security/request-security.js';
import { createServerBrowserRuntime } from './runtime.js';

describe('server browser WebSocket upgrade', () => {
  const originalHandleUpgrade = WebSocketServer.prototype.handleUpgrade;
  afterEach(() => { WebSocketServer.prototype.handleUpgrade = originalHandleUpgrade; });

  it('refuses a viewer socket from another site while UI auth is off', async () => {
    const upgradedOrigins = [];
    WebSocketServer.prototype.handleUpgrade = function (req) {
      upgradedOrigins.push(req.headers.origin);
      return undefined;
    };
    const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
    const rejections = [];
    const server = new EventEmitter();
    const runtime = createServerBrowserRuntime({
      app: { get() {}, put() {}, post() {}, delete() {} },
      server,
      express: { json: () => (_req, _res, next) => next() },
      dataDir: '/tmp/server-browser-upgrade-test',
      uiAuthController: null,
      isRequestOriginAllowed: security.isRequestOriginAllowed,
      isCrossSiteRequest: security.isCrossSiteRequest,
      rejectWebSocketUpgrade: (_socket, status) => rejections.push(status),
      browser: { status: () => ({}), shutdown: async () => {} },
    });
    const upgrade = async (origin) => {
      const socket = new EventEmitter();
      socket.destroy = () => {};
      server.emit('upgrade', { url: '/api/server-browser/ws?tab=t1', headers: { host: '127.0.0.1:3001', origin } }, socket, Buffer.alloc(0));
      await new Promise((resolve) => setTimeout(resolve, 10));
    };
    try {
      await upgrade('https://evil.example.com');
      expect(rejections).toEqual([403]);
      expect(upgradedOrigins).toEqual([]);
      await upgrade('http://127.0.0.1:3001');
      expect(rejections).toEqual([403]);
      expect(upgradedOrigins).toEqual(['http://127.0.0.1:3001']);
    } finally {
      await runtime.shutdown();
    }
  });
});
