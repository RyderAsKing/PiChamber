import express from 'express';
import request from 'supertest';
import { describe, expect, test } from 'vitest';

import { registerAuthAndAccessRoutes } from './core-routes.js';

const LAN = 'http://192.168.1.20:3000';

const createApp = (overrides = {}) => {
  const app = express();
  registerAuthAndAccessRoutes(app, {
    express,
    tunnelAuthController: {
      classifyRequestScope: () => 'local',
      requireTunnelSession: (_req, _res, next) => next(),
    },
    uiAuthController: {
      resolveAuthContext: async () => ({ type: 'session' }),
      requireAuth: (_req, _res, next) => next(),
    },
    remoteClientAuthRuntime: { listClients: async () => [] },
    clientPairingRuntime: {
      createPairingSession: async () => ({ pairing: { id: 'p1', secret: 's', expiresAt: null } }),
    },
    readSettingsFromDiskMigrated: async () => ({}),
    normalizeTunnelSessionTtlMs: () => 1000,
    getPairingTransports: () => ({ local: 'http://127.0.0.1:3000', lan: LAN, relayAvailable: false }),
    getDirectCandidateUrls: () => [LAN],
    getServerId: async () => 'server-1',
    getServerLabel: () => 'box',
    ...overrides,
  });
  return app;
};

const createSession = (app, { host, proto, body = {} }) => {
  let req = request(app).post('/api/client-auth/pairing/sessions').set('Host', host);
  if (proto) req = req.set('X-Forwarded-Proto', proto);
  return req.send({ label: 'phone', includeRelay: false, includeDirect: true, ...body });
};

describe('pairing candidates behind a reverse proxy', () => {
  test('a UI opened through the proxy pairs through it first, keeping the LAN URL after it', async () => {
    const response = await createSession(createApp(), {
      host: 'pichamber.example.com',
      proto: 'https',
      body: { serverUrl: LAN },
    });
    expect(response.status).toBe(201);
    expect(response.body.server.candidates).toEqual([
      { type: 'tunnel', url: 'https://pichamber.example.com', priority: 10 },
      { type: 'lan', url: LAN, priority: 10 },
    ]);
  });

  test('a loopback request (desktop shell, relay) still uses the supplied LAN URL only', async () => {
    const response = await createSession(createApp(), {
      host: '127.0.0.1:3000',
      body: { serverUrl: LAN },
    });
    expect(response.body.server.candidates).toEqual([{ type: 'lan', url: LAN, priority: 10 }]);
  });

  test('a loopback request without a LAN URL falls back to the request origin as before', async () => {
    const response = await createSession(createApp(), { host: 'localhost:3000' });
    expect(response.body.server.candidates).toEqual([
      { type: 'lan', url: 'http://localhost:3000', priority: 10 },
    ]);
  });

  test('a LAN-address request does not duplicate the LAN URL', async () => {
    const response = await createSession(createApp(), {
      host: '192.168.1.20:3000',
      body: { serverUrl: LAN },
    });
    expect(response.body.server.candidates).toEqual([{ type: 'lan', url: LAN, priority: 10 }]);
  });

  test('the configured public URL leads even when the proxy forwards the container address', async () => {
    const app = createApp({ getPublicUrl: () => 'https://pichamber.example.com' });
    const response = await createSession(app, {
      host: '172.17.0.2:3000',
      body: { serverUrl: 'http://172.17.0.2:3000' },
    });
    expect(response.body.server.candidates).toEqual([
      { type: 'tunnel', url: 'https://pichamber.example.com', priority: 10 },
      { type: 'lan', url: 'http://172.17.0.2:3000', priority: 10 },
    ]);
  });

  test('a direct URL equal to the live Tailscale URL is left to the Tailscale candidate', async () => {
    const tailscale = { type: 'tailscale', url: 'https://box.tail1.ts.net', mode: 'private', priority: 20 };
    const app = createApp({ getTailscalePairingCandidate: () => tailscale });
    const response = await createSession(app, {
      host: 'box.tail1.ts.net',
      proto: 'https',
      body: { serverUrl: LAN },
    });
    expect(response.body.server.candidates).toEqual([
      { type: 'lan', url: LAN, priority: 10 },
      tailscale,
    ]);
  });

  test('advertises only the origin of the request address', async () => {
    const response = await createSession(createApp(), {
      host: 'pichamber.example.com/extra',
      proto: 'https',
      body: { serverUrl: LAN },
    });
    expect(response.body.server.candidates[0]).toEqual(
      { type: 'tunnel', url: 'https://pichamber.example.com', priority: 10 },
    );
  });

  test('keeps the Tailscale URL as a direct candidate when it is the only one, for older clients', async () => {
    const tailscale = { type: 'tailscale', url: 'https://box.tail1.ts.net', mode: 'private', priority: 20 };
    const app = createApp({
      getTailscalePairingCandidate: () => tailscale,
      getPairingTransports: () => ({ local: 'http://127.0.0.1:3000', lan: null, relayAvailable: false }),
    });
    const response = await createSession(app, { host: 'box.tail1.ts.net', proto: 'https' });
    expect(response.body.server.candidates).toEqual([
      { type: 'tunnel', url: 'https://box.tail1.ts.net', priority: 10 },
      tailscale,
    ]);
  });

  test('prefers X-Forwarded-Host, with its port, over a rewritten Host', async () => {
    const response = await request(createApp())
      .post('/api/client-auth/pairing/sessions')
      .set('Host', 'pichamber:3000')
      .set('X-Forwarded-Host', 'pichamber.example.com:8443, inner.proxy')
      .set('X-Forwarded-Proto', 'https')
      .send({ label: 'phone', includeRelay: false, includeDirect: true, serverUrl: LAN });
    expect(response.body.server.candidates).toEqual([
      { type: 'tunnel', url: 'https://pichamber.example.com:8443', priority: 10 },
      { type: 'lan', url: LAN, priority: 10 },
    ]);
  });

  test('a relay-only link carries no direct candidates', async () => {
    const response = await createSession(createApp({ getPublicUrl: () => 'https://pichamber.example.com' }), {
      host: 'pichamber.example.com',
      proto: 'https',
      body: { includeDirect: false },
    });
    expect(response.body.server.candidates).toEqual([]);
  });
});

describe('pairing transports', () => {
  test('reports the configured public URL and the non-loopback request address', async () => {
    const app = createApp({ getPublicUrl: () => 'https://pichamber.example.com' });
    const response = await request(app)
      .get('/api/client-auth/pairing/transports')
      .set('Host', 'proxy.internal')
      .set('X-Forwarded-Proto', 'https');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      lan: LAN,
      publicUrl: 'https://pichamber.example.com',
      requestUrl: 'https://proxy.internal',
    });
  });

  test('reports neither for a loopback request without a configured URL', async () => {
    const response = await request(createApp())
      .get('/api/client-auth/pairing/transports')
      .set('Host', '127.0.0.1:3000');
    expect(response.body).toMatchObject({ publicUrl: null, requestUrl: null });
  });
});

describe('connection candidates refresh', () => {
  test('lists the configured public URL ahead of interface addresses', async () => {
    const app = createApp({ getPublicUrl: () => 'https://pichamber.example.com' });
    const response = await request(app)
      .get('/api/client-auth/connection/candidates')
      .set('Host', '127.0.0.1:3000');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      label: 'box',
      serverId: 'server-1',
      candidates: [
        { type: 'tunnel', url: 'https://pichamber.example.com', priority: 10 },
        { type: 'lan', url: LAN, priority: 10 },
      ],
    });
  });

  test('is unchanged without a configured public URL', async () => {
    const response = await request(createApp())
      .get('/api/client-auth/connection/candidates')
      .set('Host', 'pichamber.example.com');
    expect(response.body.candidates).toEqual([{ type: 'lan', url: LAN, priority: 10 }]);
  });
});
