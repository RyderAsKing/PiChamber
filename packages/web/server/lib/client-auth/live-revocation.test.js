import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocket } from 'ws';

// The data dir must exist before ui-auth.js resolves its JWT secret path.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pichamber-live-revocation-'));
process.env.PICHAMBER_DATA_DIR = dataDir;

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const loadModules = async () => ({
  createUiAuth: (await import('../ui-auth/ui-auth.js')).createUiAuth,
  createRemoteClientAuthRuntime: (await import('./remote-clients.js')).createRemoteClientAuthRuntime,
  createRevocationCoordinator: (await import('./principal-tracker.js')).createRevocationCoordinator,
  createRequestSecurityRuntime: (await import('../security/request-security.js')).createRequestSecurityRuntime,
  createTerminalRuntime: (await import('../terminal/runtime.js')).createTerminalRuntime,
  createSttRuntime: (await import('../stt/runtime.js')).createSttRuntime,
  createTunnelHost: (await import('../relay/tunnel-host.js')).createTunnelHost,
  tunnelCodec: await import('../relay/tunnel-codec.js'),
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withTimeout = (promise, label, ms = 3000) => Promise.race([
  promise,
  wait(ms).then(() => { throw new Error(`timed out waiting for ${label}`); }),
]);

const openWebSocket = async (url, headers = {}) => {
  const socket = new WebSocket(url, { headers });
  // A server-side destroy can surface as multiple 'error' events (hangup
  // emits error+close; a second error can fire after the handshake settles).
  // Keep a persistent swallow handler from creation so no late error crashes
  // the run; the once handlers below still observe the handshake outcome.
  socket.on('error', () => {});
  const outcome = withTimeout(new Promise((resolve, reject) => {
    socket.once('open', () => resolve('open'));
    socket.once('close', () => resolve('closed'));
    socket.once('error', (error) => reject(error));
  }), 'websocket handshake');
  try {
    const result = await outcome;
    return { socket, result };
  } catch (error) {
    return { socket, result: 'error', error };
  }
};

const waitForSocketClose = (socket, ms = 3000) => withTimeout(new Promise((resolve) => {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return resolve('closed');
  socket.once('close', () => resolve('closed'));
}), 'websocket close', ms);

const waitForSseEnd = async (response, ms = 3000) => {
  const reader = response.body.getReader();
  return withTimeout((async () => {
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) return 'ended';
      }
    } catch {
      return 'destroyed';
    }
  })(), 'sse end', ms);
};

describe('live credential revocation across transports', () => {
  it('closes the revoked principal SSE and terminal/dictation connections, denies re-entry, and converges cross-process', async () => {
    const {
      createUiAuth,
      createRemoteClientAuthRuntime,
      createRevocationCoordinator,
      createRequestSecurityRuntime,
      createTerminalRuntime,
      createSttRuntime,
    } = await loadModules();

    const storePath = path.join(dataDir, 'remote-clients.json');
    const remoteClientAuthRuntime = createRemoteClientAuthRuntime({ fsPromises: fs.promises, path, crypto, storePath });
    // Bounded poll: in-process revocations close immediately through the
    // revoke route; this interval also bounds cross-process convergence.
    const liveRevocation = createRevocationCoordinator({
      listRevokedClientIds: () => remoteClientAuthRuntime.listRevokedClientIds(),
      pollIntervalMs: 25,
    });
    liveRevocation.start();

    const uiAuthController = createUiAuth({
      password: 'secret',
      readSettingsFromDiskMigrated: async () => ({}),
      clientAuthController: remoteClientAuthRuntime,
      liveRevocation,
    });
    const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });

    const app = express();
    app.use(express.json({ limit: '1mb' }));

    // SSE at the auth-owning boundary: requireAuth resolves the principal and
    // registers the live connection; the route only streams frames.
    const sseClients = new Set();
    app.get('/api/pi/events', (req, res) => {
      void uiAuthController.requireAuth(req, res, () => {
        res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.flushHeaders?.();
        res.write('data: {"hello":true}\n\n');
        const heartbeat = setInterval(() => {
          if (res.destroyed || res.writableEnded) return;
          res.write('event: heartbeat\ndata: {}\n\n');
        }, 50);
        sseClients.add(res);
        res.once('close', () => {
          clearInterval(heartbeat);
          sseClients.delete(res);
        });
      });
    });

    // Mirror of the auth-owning core revoke route: store write, then immediate
    // in-process close through the coordinator.
    app.delete('/api/client-auth/clients/:id', (req, res) => {
      void uiAuthController.requireAuth(req, res, async () => {
        const result = await remoteClientAuthRuntime.revokeClient(req.params?.id);
        if (!result.revoked) {
          return res.status(404).json({ revoked: false, error: 'Client not found' });
        }
        const closedConnections = liveRevocation.clientRevoked(result.client.id);
        res.json({ ...result, closedConnections });
      });
    });

    app.post('/auth/url-token', (req, res) => {
      void uiAuthController.handleUrlAuthToken(req, res);
    });

    const realServer = http.createServer(app);

    const fakePtyProvider = async () => ({
      backend: 'fake-pty',
      spawn: () => {
        const data = new Set();
        const exits = new Set();
        return {
          pid: 42_000,
          write() {},
          resize() {},
          kill() {},
          onData(handler) { data.add(handler); return { dispose: () => data.delete(handler) }; },
          onExit(handler) { exits.add(handler); return { dispose: () => exits.delete(handler) }; },
        };
      },
    });
    // The terminal/dictation upgrade handlers attach to the real HTTP server.
    const terminalRuntime = createTerminalRuntime({
      app, server: realServer, express, fs, path,
      uiAuthController,
      liveRevocation,
      buildAugmentedPath: () => process.env.PATH || '',
      searchPathFor: () => '/bin/sh',
      isExecutable: () => true,
      isRequestOriginAllowed: security.isRequestOriginAllowed,
      rejectWebSocketUpgrade: security.rejectWebSocketUpgrade,
      TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 1000,
      loadPtyProvider: fakePtyProvider,
      terminalTerminationGraceMs: 10,
    });
    const sttRuntime = createSttRuntime({
      app, server: realServer, express,
      uiAuthController,
      liveRevocation,
      isRequestOriginAllowed: security.isRequestOriginAllowed,
      rejectWebSocketUpgrade: security.rejectWebSocketUpgrade,
      modelsDir: path.join(dataDir, 'speech-models'),
      configFile: path.join(dataDir, 'stt', 'config.json'),
    });

    await new Promise((resolve) => realServer.listen(0, '127.0.0.1', resolve));
    const port = realServer.address().port;
    const base = `http://127.0.0.1:${port}`;
    const origin = base;

    try {
      const deviceA = await remoteClientAuthRuntime.createClient({ label: 'Phone A' });
      const deviceB = await remoteClientAuthRuntime.createClient({ label: 'Tablet B' });

      // Mint A's URL tokens BEFORE revocation: they must fail at establishment
      // afterwards (mint/open race), even though their 60s TTL has not elapsed.
      const mintToken = async (bearer) => {
        const response = await fetch(`${base}/auth/url-token`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
        });
        expect(response.status).toBe(200);
        return (await response.json()).token;
      };
      const urlTokenA = await mintToken(deviceA.token);

      // Device A: direct SSE, relay-classified SSE (header only — NOT a true
      // relay tunnel; it exercises transport classification/usesRelay healing
      // through the same server-side auth gate), terminal WS, dictation WS.
      // True tunnel dispatch (loopback fetch with overwritten origin) is
      // covered by the disposable tunnel-host integration below.
      const sseDirect = await fetch(`${base}/api/pi/events`, { headers: { authorization: `Bearer ${deviceA.token}` } });
      expect(sseDirect.status).toBe(200);
      const sseRelayClassified = await fetch(`${base}/api/pi/events`, {
        headers: { authorization: `Bearer ${deviceA.token}`, 'x-pichamber-relay-connection': 'tunnel-conn-1' },
      });
      expect(sseRelayClassified.status).toBe(200);
      const sseOther = await fetch(`${base}/api/pi/events`, { headers: { authorization: `Bearer ${deviceB.token}` } });
      expect(sseOther.status).toBe(200);
      // Relay traffic must not be misclassified: the store heals usesRelay.
      const listedA = (await remoteClientAuthRuntime.listClients()).find((client) => client.id === deviceA.client.id);
      expect(listedA.usesRelay).toBe(true);

      const wsHeaders = { origin };
      const terminalSocket = await openWebSocket(`${base}/api/terminal/ws?oc_url_token=${encodeURIComponent(urlTokenA)}`, wsHeaders);
      expect(terminalSocket.result).toBe('open');
      const sttSocket = await openWebSocket(`${base}/api/stt/ws?oc_url_token=${encodeURIComponent(urlTokenA)}`, wsHeaders);
      expect(sttSocket.result).toBe('open');

      // Four live connections for A, none for B.
      expect(liveRevocation.countPrincipal(`client:${deviceA.client.id}`)).toBe(4);
      expect(liveRevocation.countPrincipal(`client:${deviceB.client.id}`)).toBe(1);

      // Revoke A through the route: the response reports the closed sockets.
      const revokeResponse = await fetch(`${base}/api/client-auth/clients/${deviceA.client.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${deviceA.token}` },
      });
      expect(revokeResponse.status).toBe(200);
      const revokeBody = await revokeResponse.json();
      expect(revokeBody.revoked).toBe(true);
      expect(revokeBody.closedConnections).toBe(4);

      // Every A connection ends bounded (destroy surfaces as either a clean
      // end or a connection reset, depending on flush timing); B survives.
      expect(['ended', 'destroyed']).toContain(await waitForSseEnd(sseDirect));
      expect(['ended', 'destroyed']).toContain(await waitForSseEnd(sseRelayClassified));
      expect(await waitForSocketClose(terminalSocket.socket)).toBe('closed');
      expect(await waitForSocketClose(sttSocket.socket)).toBe('closed');
      await wait(60);
      // B's live connection is untouched by A's revocation.
      expect(liveRevocation.countPrincipal(`client:${deviceB.client.id}`)).toBe(1);
      expect((await fetch(`${base}/api/pi/events`, { headers: { authorization: `Bearer ${deviceB.token}` } })).status).toBe(200);

      // Revoked credentials cannot re-establish anything.
      const reconnect = await fetch(`${base}/api/pi/events`, { headers: { authorization: `Bearer ${deviceA.token}` } });
      expect(reconnect.status).toBe(401);
      const racedTerminal = await openWebSocket(`${base}/api/terminal/ws?oc_url_token=${encodeURIComponent(urlTokenA)}`, wsHeaders);
      expect(racedTerminal.result).toBe('error');
      // Client libraries phrase the 401 handshake rejection differently; the
      // upgrade never opens either way.
      expect(/401|Connection ended|Unexpected server response/.test(String(racedTerminal.error?.message))).toBe(true);
      const racedStt = await openWebSocket(`${base}/api/stt/ws?oc_url_token=${encodeURIComponent(urlTokenA)}`, wsHeaders);
      expect(racedStt.result).toBe('error');

      // Cross-process propagation: a second process shares the credential
      // store (no emitter exists between processes). Its revocation of B is
      // picked up by the bounded poll when storage reads succeed (healthy
      // storage). While polls fail, established cross-process connections are
      // retained (degraded); new establishment stays authoritatively gated.
      const secondProcessRuntime = createRemoteClientAuthRuntime({ fsPromises: fs.promises, path, crypto, storePath });
      await secondProcessRuntime.revokeClient(deviceB.client.id);
      // B's stream only ends once the poll observes the cross-process write.
      expect(['ended', 'destroyed']).toContain(await waitForSseEnd(sseOther));
    } finally {
      liveRevocation.dispose();
      await Promise.allSettled([terminalRuntime.shutdown(), sttRuntime.shutdown()]);
      realServer.closeAllConnections?.();
      await new Promise((resolve) => realServer.close(resolve));
    }
  }, 20_000);

  it('rejects WebSocket upgrades with an untrusted origin through the real gate', async () => {
    const {
      createUiAuth,
      createRemoteClientAuthRuntime,
      createRevocationCoordinator,
      createRequestSecurityRuntime,
      createTerminalRuntime,
    } = await loadModules();
    const storePath = path.join(dataDir, `remote-clients-origin-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const remoteClientAuthRuntime = createRemoteClientAuthRuntime({ fsPromises: fs.promises, path, crypto, storePath });
    const liveRevocation = createRevocationCoordinator({
      listRevokedClientIds: () => remoteClientAuthRuntime.listRevokedClientIds(),
      pollIntervalMs: 60_000,
    });
    const uiAuthController = createUiAuth({
      password: 'secret',
      readSettingsFromDiskMigrated: async () => ({}),
      clientAuthController: remoteClientAuthRuntime,
      liveRevocation,
    });
    const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
    const app = express();
    app.post('/auth/url-token', (req, res) => {
      void uiAuthController.handleUrlAuthToken(req, res);
    });
    const realServer = http.createServer(app);
    const terminalRuntime = createTerminalRuntime({
      app,
      server: realServer,
      express,
      fs,
      path,
      uiAuthController,
      liveRevocation,
      buildAugmentedPath: () => process.env.PATH || '',
      searchPathFor: () => '/bin/sh',
      isExecutable: () => true,
      isRequestOriginAllowed: security.isRequestOriginAllowed,
      rejectWebSocketUpgrade: security.rejectWebSocketUpgrade,
      TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 1000,
      loadPtyProvider: async () => ({
        backend: 'fake-pty',
        spawn: () => ({
          pid: 42_001,
          write() {},
          resize() {},
          kill() {},
          onData() { return { dispose: () => {} }; },
          onExit() { return { dispose: () => {} }; },
        }),
      }),
      terminalTerminationGraceMs: 10,
    });
    await new Promise((resolve) => realServer.listen(0, '127.0.0.1', resolve));
    const port = realServer.address().port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const device = await remoteClientAuthRuntime.createClient({ label: 'Origin probe' });
      const mint = await fetch(`${base}/auth/url-token`, {
        method: 'POST',
        headers: { authorization: `Bearer ${device.token}` },
      });
      expect(mint.status).toBe(200);
      const urlToken = (await mint.json()).token;
      // Real gate: loopback origin derived from Host is trusted.
      const trusted = await openWebSocket(`${base}/api/terminal/ws?oc_url_token=${encodeURIComponent(urlToken)}`, { origin: base });
      expect(trusted.result).toBe('open');
      trusted.socket.on('error', () => {});
      trusted.socket.close();
      await waitForSocketClose(trusted.socket);
      // Real gate: an unrelated origin is rejected without opening.
      const untrusted = await openWebSocket(`${base}/api/terminal/ws?oc_url_token=${encodeURIComponent(urlToken)}`, { origin: 'https://evil.example' });
      expect(untrusted.result).toBe('error');
      expect(/403|Failed|Unexpected|Connection ended/.test(String(untrusted.error?.message ?? ''))).toBe(true);
    } finally {
      liveRevocation.dispose();
      await terminalRuntime.shutdown().catch(() => {});
      realServer.closeAllConnections?.();
      await new Promise((resolve) => realServer.close(resolve));
      await fs.promises.rm(storePath, { force: true }).catch(() => {});
    }
  }, 20_000);

  it('rejects a WebSocket racing revocation during the origin gate without calling handleUpgrade', async () => {
    const {
      createUiAuth,
      createRemoteClientAuthRuntime,
      createRevocationCoordinator,
      createRequestSecurityRuntime,
      createTerminalRuntime,
    } = await loadModules();
    const storePath = path.join(dataDir, `remote-clients-race-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const remoteClientAuthRuntime = createRemoteClientAuthRuntime({ fsPromises: fs.promises, path, crypto, storePath });
    const liveRevocation = createRevocationCoordinator({
      listRevokedClientIds: () => remoteClientAuthRuntime.listRevokedClientIds(),
      pollIntervalMs: 60_000,
    });
    const uiAuthController = createUiAuth({
      password: 'secret',
      readSettingsFromDiskMigrated: async () => ({}),
      clientAuthController: remoteClientAuthRuntime,
      liveRevocation,
    });
    const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
    const app = express();
    app.post('/auth/url-token', (req, res) => {
      void uiAuthController.handleUrlAuthToken(req, res);
    });
    const realServer = http.createServer(app);
    // Deterministic verify-registration race: the origin gate awaits, and the
    // revocation commits inside that window — after ensureSessionToken
    // already resolved the principal, before trackLiveConnection runs.
    const racingOriginGate = async (req) => {
      const allowed = await security.isRequestOriginAllowed(req);
      if (allowed && req.__revokeTarget) {
        await remoteClientAuthRuntime.revokeClient(req.__revokeTarget);
        liveRevocation.clientRevoked(req.__revokeTarget);
      }
      return allowed;
    };
    // Tag the racing request by wrapping ensureSessionToken:stash the client
    // id on the req object the origin gate can read. The URL token embeds
    // `client:<id>`; decoding is unnecessary — the test knows the id.
    const deviceForRace = await remoteClientAuthRuntime.createClient({ label: 'Racer' });
    const terminalRuntime = createTerminalRuntime({
      app,
      server: realServer,
      express,
      fs,
      path,
      uiAuthController: {
        ...uiAuthController,
        enabled: true,
        ensureSessionToken: async (req) => {
          const principal = await uiAuthController.ensureSessionToken(req, null);
          if (principal === `client:${deviceForRace.client.id}`) req.__revokeTarget = deviceForRace.client.id;
          return principal;
        },
      },
      liveRevocation,
      buildAugmentedPath: () => process.env.PATH || '',
      searchPathFor: () => '/bin/sh',
      isExecutable: () => true,
      isRequestOriginAllowed: racingOriginGate,
      rejectWebSocketUpgrade: security.rejectWebSocketUpgrade,
      TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 1000,
      loadPtyProvider: async () => ({
        backend: 'fake-pty',
        spawn: () => ({
          pid: 42_002,
          write() {},
          resize() {},
          kill() {},
          onData() { return { dispose: () => {} }; },
          onExit() { return { dispose: () => {} }; },
        }),
      }),
      terminalTerminationGraceMs: 10,
    });
    await new Promise((resolve) => realServer.listen(0, '127.0.0.1', resolve));
    const port = realServer.address().port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const mint = await fetch(`${base}/auth/url-token`, {
        method: 'POST',
        headers: { authorization: `Bearer ${deviceForRace.token}` },
      });
      expect(mint.status).toBe(200);
      const urlToken = (await mint.json()).token;
      // The principal verified, then the revoke committed during the origin
      // await; the coordinator's revoked memory must reject the late
      // registration so handleUpgrade never runs and the socket never opens.
      const raced = await openWebSocket(`${base}/api/terminal/ws?oc_url_token=${encodeURIComponent(urlToken)}`, { origin: base });
      expect(raced.result).toBe('error');
      expect(coordinatorHasNoLiveConnection(liveRevocation, deviceForRace.client.id)).toBe(true);
    } finally {
      liveRevocation.dispose();
      await terminalRuntime.shutdown().catch(() => {});
      realServer.closeAllConnections?.();
      await new Promise((resolve) => realServer.close(resolve));
      await fs.promises.rm(storePath, { force: true }).catch(() => {});
    }
  }, 20_000);

  it('dispatches authenticated HTTP through the true tunnel host with loopback origin (disposable)', async () => {
    const {
      createUiAuth,
      createRemoteClientAuthRuntime,
      createRevocationCoordinator,
      createTunnelHost,
      tunnelCodec,
    } = await loadModules();
    const { TunnelFrameType, encodeTunnelFrame, decodeTunnelFrame, encodeJsonPayload } = tunnelCodec;
    const storePath = path.join(dataDir, `remote-clients-tunnel-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const remoteClientAuthRuntime = createRemoteClientAuthRuntime({ fsPromises: fs.promises, path, crypto, storePath });
    const liveRevocation = createRevocationCoordinator({
      listRevokedClientIds: () => remoteClientAuthRuntime.listRevokedClientIds(),
      pollIntervalMs: 60_000,
    });
    const uiAuthController = createUiAuth({
      password: 'secret',
      readSettingsFromDiskMigrated: async () => ({}),
      clientAuthController: remoteClientAuthRuntime,
      liveRevocation,
    });
    const app = express();
    // Echo route behind the real auth gate: proves the tunneled bearer was
    // authenticated and shows which origin/relay headers the host presented.
    app.get('/api/echo-tunnel', (req, res) => {
      void uiAuthController.requireAuth(req, res, () => {
        res.json({
          origin: req.headers.origin ?? null,
          relay: req.headers['x-pichamber-relay-connection'] ?? null,
        });
      });
    });
    const realServer = http.createServer(app);
    await new Promise((resolve) => realServer.listen(0, '127.0.0.1', resolve));
    const port = realServer.address().port;
    const loopbackOrigin = `http://127.0.0.1:${port}`;
    const outbound = [];
    const host = createTunnelHost({
      connectionId: 'tunnel-conn-true',
      getLocalPort: () => port,
      sendFrame: (frame) => { outbound.push(frame); },
      getBufferedAmount: () => 0,
    });
    const waitForFrames = async (predicate, ms = 3000) => {
      const start = Date.now();
      for (;;) {
        if (predicate()) return;
        if (Date.now() - start > ms) throw new Error('timed out waiting for tunnel frames');
        await wait(10);
      }
    };
    try {
      const device = await remoteClientAuthRuntime.createClient({ label: 'Tunnel device' });
      const decodeOutbound = () => outbound.map((frame) => decodeTunnelFrame(frame));
      // Authenticated request through the true host: client-supplied origin
      // must be overwritten with the loopback origin being dialed.
      outbound.length = 0;
      await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
        method: 'GET',
        path: '/api/echo-tunnel',
        query: '',
        headers: { authorization: `Bearer ${device.token}`, origin: 'https://evil.example' },
      })));
      await waitForFrames(() => decodeOutbound().some((f) => f.frameType === TunnelFrameType.StreamEnd));
      const frames = decodeOutbound();
      const response = frames.find((f) => f.frameType === TunnelFrameType.HttpResponse);
      expect(response).toBeTruthy();
      const responsePayload = JSON.parse(Buffer.from(response.payload).toString('utf8'));
      expect(responsePayload.status).toBe(200);
      const bodyFrame = frames.find((f) => f.frameType === TunnelFrameType.HttpBody);
      expect(bodyFrame).toBeTruthy();
      const body = JSON.parse(Buffer.from(bodyFrame.payload).toString('utf8'));
      expect(body.origin).toBe(loopbackOrigin);
      expect(body.relay).toBe('tunnel-conn-true');
      // Unauthenticated request through the same host is denied by the same
      // server-side gate (no credentials injected by the host).
      outbound.length = 0;
      await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpRequest, 3, encodeJsonPayload({
        method: 'GET',
        path: '/api/echo-tunnel',
        query: '',
        headers: { origin: 'https://evil.example' },
      })));
      await waitForFrames(() => decodeOutbound().some((f) => f.frameType === TunnelFrameType.StreamEnd));
      const denied = decodeOutbound().find((f) => f.frameType === TunnelFrameType.HttpResponse);
      expect(JSON.parse(Buffer.from(denied.payload).toString('utf8')).status).toBe(401);
    } finally {
      host.close();
      liveRevocation.dispose();
      uiAuthController.dispose?.();
      realServer.closeAllConnections?.();
      await new Promise((resolve) => realServer.close(resolve));
      await fs.promises.rm(storePath, { force: true }).catch(() => {});
    }
    // Gap label: this proves true-tunnel HTTP auth + origin overwrite. It
    // does not prove tunneled WebSocket upgrades or long-lived SSE streaming
    // through the tunnel — those paths reuse the same server-side
    // ensureSessionToken/origin gates but have no disposable integration here.
  }, 20_000);
});

const coordinatorHasNoLiveConnection = (coordinator, clientId) =>
  coordinator.countPrincipal(`client:${clientId}`) === 0;
