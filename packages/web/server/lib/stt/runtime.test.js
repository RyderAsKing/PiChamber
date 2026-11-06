import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import { WebSocketServer } from 'ws';

import { createRequestSecurityRuntime } from '../security/request-security.js';
import { createSttRuntime } from './runtime.js';

describe('STT runtime upgrade', () => {
  test('skips handleUpgrade when principal tracking throws', async () => {
    const originalHandleUpgrade = WebSocketServer.prototype.handleUpgrade;
    let handleUpgradeCalls = 0;
    WebSocketServer.prototype.handleUpgrade = function () {
      handleUpgradeCalls += 1;
      return undefined;
    };
    const app = {
      get() {},
      put() {},
      post() {},
      delete() {},
    };
    const express = { json: () => (_req, _res, next) => next?.() };
    const server = new EventEmitter();
    const runtime = createSttRuntime({
      app,
      server,
      express,
      uiAuthController: {
        enabled: true,
        ensureSessionToken: async () => 'client:thrower',
      },
      isRequestOriginAllowed: async () => true,
      isCrossSiteRequest: async () => false,
      rejectWebSocketUpgrade: () => {},
      modelsDir: '/tmp/stt-test-models',
      configFile: '/tmp/stt-test-config.json',
      liveRevocation: {
        getGeneration: () => 0,
        trackLiveConnection: () => { throw new Error('tracker boom'); },
      },
    });
    try {
      const socket = new EventEmitter();
      socket.destroyed = false;
      socket.destroy = function () { this.destroyed = true; };
      server.emit('upgrade', { url: '/api/stt/ws', headers: {} }, socket, Buffer.alloc(0));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(socket.destroyed).toBe(true);
      expect(handleUpgradeCalls).toBe(0);
    } finally {
      WebSocketServer.prototype.handleUpgrade = originalHandleUpgrade;
      await runtime.shutdown();
    }
  });

  test('refuses a WebSocket from another site while UI auth is off', async () => {
    const originalHandleUpgrade = WebSocketServer.prototype.handleUpgrade;
    const upgradedOrigins = [];
    WebSocketServer.prototype.handleUpgrade = function (req) {
      upgradedOrigins.push(req.headers.origin ?? null);
      return undefined;
    };
    const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
    const rejections = [];
    const server = new EventEmitter();
    const runtime = createSttRuntime({
      app: { get() {}, put() {}, post() {}, delete() {} },
      server,
      express: { json: () => (_req, _res, next) => next?.() },
      uiAuthController: null,
      isRequestOriginAllowed: security.isRequestOriginAllowed,
      isCrossSiteRequest: security.isCrossSiteRequest,
      rejectWebSocketUpgrade: (_socket, status) => rejections.push(status),
      modelsDir: '/tmp/stt-test-models',
      configFile: '/tmp/stt-test-config.json',
    });
    const upgrade = async (origin) => {
      const socket = new EventEmitter();
      socket.destroyed = false;
      socket.destroy = function () { this.destroyed = true; };
      server.emit('upgrade', { url: '/api/stt/ws', headers: { host: '127.0.0.1:3001', origin } }, socket, Buffer.alloc(0));
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
      WebSocketServer.prototype.handleUpgrade = originalHandleUpgrade;
      await runtime.shutdown();
    }
  });
});
