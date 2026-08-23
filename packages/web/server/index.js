import 'reflect-metadata';
import compression from 'compression';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClientPairingRuntime } from './lib/client-auth/pairing.js';
import { createRemoteClientAuthRuntime } from './lib/client-auth/remote-clients.js';
import { resolvePiChamberDataDir } from './lib/pichamber-data-dir.js';
import { createTunnelService } from './lib/server/tunnel-service.js';
import { registerPiRuntimeRoutes } from './lib/pi/routes.js';
import { registerWorkspaceIntegrations } from './lib/workspace/host.js';
import { createPiSessionDaemonSupervisor } from './lib/pi/session-daemon/supervisor.js';
import {
  getUnauthenticatedLanErrorMessage,
  isNetworkExposedBindHost,
  isUnsafeUnauthenticatedLanAllowed,
} from './lib/security/bind-host.js';
import { applyUiCorsHeaders } from './lib/server/cors.js';
import { createPairingTransportResolvers } from './lib/server/lan-addresses.js';
import { parseServeCliOptions } from './lib/server/cli-options.js';
import { runCliEntryIfMain } from './lib/server/cli-entry-runtime.js';
import {
  registerAuthAndAccessRoutes,
  registerCommonRequestMiddleware,
  registerServerStatusRoutes,
} from './lib/server/core-routes.js';
import { createTunnelAuth } from './lib/server/tunnel-auth.js';
import { createUiAuth } from './lib/ui-auth/ui-auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PORT = 3000;
const PICHAMBER_DATA_DIR = resolvePiChamberDataDir();
const PICHAMBER_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
})();

let activeController = null;
let signalsAttached = false;

const isEnvFlagEnabled = (value) => value === true || value === 1 || (typeof value === 'string' && ['1', 'true'].includes(value.trim().toLowerCase()));

// Serve-time tunnel startup was removed with the OpenChamber migration; the
// standalone `pichamber tunnel` command still manages cloudflared. Options
// parsed for the removed integration must fail loudly instead of being
// silently ignored — a user passing --tunnel expects an exposed URL.
const IGNORED_TUNNEL_OPTION_NAMES = ['tryCfTunnel', 'tunnelProvider', 'tunnelMode', 'tunnelConfigPath', 'tunnelToken', 'tunnelHostname'];
const warnIgnoredTunnelOptions = (options) => {
  const ignored = IGNORED_TUNNEL_OPTION_NAMES.filter((name) => options[name] !== undefined && options[name] !== false && options[name] !== null && options[name] !== '');
  if (ignored.length === 0) return;
  console.warn(`[pichamber] Ignoring unsupported serve option(s): ${ignored.join(', ')}. This server does not start a tunnel; use the \`pichamber tunnel\` command to manage cloudflared.`);
};

const resolveDistPath = () => {
  const configured = typeof process.env.PICHAMBER_DIST_DIR === 'string' ? process.env.PICHAMBER_DIST_DIR.trim() : '';
  return configured ? path.resolve(configured) : path.join(__dirname, '..', 'dist');
};

const registerStaticRoutes = (app, { apiOnly }) => {
  if (apiOnly) {
    app.get(/^(?!\/api|\/auth|\/health).*/, (_req, res) => res.status(200).type('text/plain').send('PiChamber API-only server is running.'));
    return;
  }
  const distPath = resolveDistPath();
  if (!fs.existsSync(distPath)) {
    app.get(/.*/, (_req, res) => res.status(404).send('Static files not found. Please build the application first.'));
    return;
  }
  app.use(express.static(distPath, {
    setHeaders(res, filePath) {
      if (filePath.endsWith(`${path.sep}sw.js`)) res.setHeader('Cache-Control', 'no-store');
    },
  }));
  app.get(/^(?!\/api|\/auth|\/health|.*\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map)).*$/, (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
};

const listen = (server, port, host) => new Promise((resolve, reject) => {
  const onError = (error) => { server.off('listening', onListening); reject(error); };
  const onListening = () => { server.off('error', onError); resolve(); };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, host);
});

const close = (server) => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

export async function gracefulShutdown({ exitProcess = false } = {}) {
  const controller = activeController;
  if (!controller) return;
  await controller.stop({ exitProcess });
}

export async function startWebUiServer(options = {}) {
  warnIgnoredTunnelOptions(options);
  const port = Number.isInteger(options.port) && options.port >= 0 ? options.port : DEFAULT_PORT;
  const host = typeof options.host === 'string' && options.host.trim() ? options.host.trim() : (process.env.PICHAMBER_HOST || '127.0.0.1');
  const uiPassword = typeof options.uiPassword === 'string' ? options.uiPassword : (process.env.PICHAMBER_UI_PASSWORD || null);
  if (isNetworkExposedBindHost(host) && !uiPassword?.trim() && !isUnsafeUnauthenticatedLanAllowed(process.env)) {
    throw new Error(getUnauthenticatedLanErrorMessage(host));
  }
  const apiOnly = options.apiOnly === true || isEnvFlagEnabled(process.env.PICHAMBER_API_ONLY);
  const app = express();
  const server = http.createServer(app);
  const pairingTransports = createPairingTransportResolvers({
    getPort: () => {
      const address = server.address();
      return typeof address === 'object' && address ? address.port : null;
    },
    bindHost: host,
  });
  const serverStartedAt = new Date().toISOString();
  const dataPath = (name) => path.join(PICHAMBER_DATA_DIR, name);
  const remoteClientAuthRuntime = createRemoteClientAuthRuntime({ fsPromises: fs.promises, path, crypto: await import('node:crypto'), storePath: dataPath('remote-clients.json') });
  const clientPairingRuntime = createClientPairingRuntime({ fsPromises: fs.promises, path, crypto: await import('node:crypto'), storePath: dataPath('client-pairing-sessions.json'), remoteClientAuthRuntime });
  const tunnelAuthController = createTunnelAuth();
  const uiAuthController = createUiAuth({ password: uiPassword, readSettingsFromDiskMigrated: async () => ({}) , clientAuthController: remoteClientAuthRuntime });
  const piSessionDaemonRuntime = createPiSessionDaemonSupervisor({ dataDir: PICHAMBER_DATA_DIR });
  const tunnelService = createTunnelService({
    dataDir: PICHAMBER_DATA_DIR,
    getPort: () => {
      const address = server.address();
      return typeof address === 'object' && address ? address.port : null;
    },
    tunnelAuthController,
    getServerLabel: () => os.hostname() || 'PiChamber',
  });
  let stopped = false;

  // trust proxy = true is intentional for PiChamber's deployment model:
  // - In production the server sits behind the user's reverse proxy / tunnel
  //   (Caddy, Nginx, Cloudflare Tunnel) which terminates TLS and sets
  //   X-Forwarded-* . Client IP rate-limiting and secure-cookie detection
  //   (`isSecureRequest` checks X-Forwarded-Proto) depend on this.
  // - For direct LAN access without a proxy, Express correctly ignores the
  //   header when none is present. Changing to 'loopback' or false would break
  //   `getClientIp` and `isSecureRequest` behind a tunnel; see
  //   `security/bind-host.js` and `ui-auth.js` . Do not change without a
  //   deployment-wide review.
  app.set('trust proxy', true);
  app.use((_req, res, next) => { res.setHeader('X-Robots-Tag', 'noindex, nofollow'); next(); });
  app.get('/robots.txt', (_req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  app.use((req, res, next) => {
    if (applyUiCorsHeaders(req, res)) return res.status(204).end();
    next();
  });
  app.use(compression({ filter: (req, res) => req.path === '/api/pi/events' || req.headers.accept?.includes('text/event-stream') ? false : compression.filter(req, res) }));

  registerServerStatusRoutes(app, {
    express,
    process,
    pichamberVersion: PICHAMBER_VERSION,
    runtimeName: process.env.PICHAMBER_RUNTIME || 'web',
    serverStartedAt,
    gracefulShutdown,
    getHealthSnapshot: () => ({ pi: { state: 'ready' }, apiOnly }),
    getServerPort: () => {
      const address = server.address();
      return typeof address === 'object' && address ? address.port : null;
    },
    getTunnelUrl: () => null,
    getServerId: async () => null,
    tunnelAuthController,
    uiAuthController,
  });
  registerCommonRequestMiddleware(app, { express, verboseRequestLogs: isEnvFlagEnabled(process.env.PICHAMBER_VERBOSE_REQUEST_LOGS) });
  registerAuthAndAccessRoutes(app, {
    express,
    tunnelAuthController,
    uiAuthController,
    remoteClientAuthRuntime,
    clientPairingRuntime,
    readSettingsFromDiskMigrated: async () => ({}),
    normalizeTunnelSessionTtlMs: () => 8 * 60 * 60 * 1000,
    getPairingTransports: () => pairingTransports.getPairingTransports(),
    getDirectCandidateUrls: () => pairingTransports.getDirectCandidateUrls(),
    getServerId: async () => null,
    getServerLabel: () => os.hostname() || 'PiChamber',
  });
  registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => piSessionDaemonRuntime });
  // Cloudflare Tunnel external access (manual token + quick modes).
  const requireTunnelAuth = (req, res, next) => uiAuthController.requireAuth(req, res, next);
  app.get('/api/pichamber/tunnel/status', requireTunnelAuth, async (_req, res) => {
    try { res.json(await tunnelService.getStatus()); } catch (error) { res.status(500).json({ error: error?.message || 'Failed to get tunnel status' }); }
  });
  app.get('/api/pichamber/tunnel/check', requireTunnelAuth, async (req, res) => {
    try { res.json(await tunnelService.check(req.query?.provider)); } catch (error) { res.status(500).json({ error: error?.message || 'Tunnel check failed' }); }
  });
  app.get('/api/pichamber/tunnel/providers', requireTunnelAuth, async (_req, res) => {
    res.json({ providers: [{ provider: 'cloudflare', modes: [{ key: 'quick' }, { key: 'managed-remote' }, { key: 'managed-local' }] }] });
  });
  app.post('/api/pichamber/tunnel/start', express.json({ limit: '64kb' }), requireTunnelAuth, async (req, res) => {
    try { const result = await tunnelService.start(req.body ?? {}); res.json(result); } catch (error) { const code = error?.code === 'missing_dependency' ? 400 : error?.code === 'validation_error' ? 422 : 500; res.status(code).json({ ok: false, error: error?.message || 'Failed to start tunnel', code: error?.code }); }
  });
  app.post('/api/pichamber/tunnel/stop', requireTunnelAuth, async (_req, res) => {
    try { res.json(await tunnelService.stop()); } catch (error) { res.status(500).json({ error: error?.message || 'Failed to stop tunnel' }); }
  });
  app.put('/api/pichamber/tunnel/managed-remote-token', express.json({ limit: '64kb' }), requireTunnelAuth, async (req, res) => {
    try { res.json(await tunnelService.saveManagedRemoteToken(req.body ?? {})); } catch (error) { const code = error?.code === 'validation_error' ? 400 : 500; res.status(code).json({ ok: false, error: error?.message || 'Failed to save token' }); }
  });
  app.get('/api/pichamber/tunnel/doctor', requireTunnelAuth, async (req, res) => {
    try { const status = await tunnelService.getStatus(); const checkResult = await tunnelService.check(); res.json({ ok: true, status, check: checkResult, query: req.query }); } catch (error) { res.status(500).json({ ok: false, error: error?.message || 'Doctor failed' }); }
  });
  registerWorkspaceIntegrations({ app, server, express, uiAuthController });
  registerStaticRoutes(app, { apiOnly });

  await listen(server, port, host);
  const resolvedPort = typeof server.address() === 'object' && server.address() ? server.address().port : null;
  if (typeof resolvedPort === 'number') process.send?.({ type: 'pichamber:ready', port: resolvedPort });
  // Warm the detached daemon as soon as HTTP is listening. Requests arriving
  // during cold start share the supervisor's startPromise; server readiness
  // itself never waits for provider/model initialization in the child.
  void piSessionDaemonRuntime.start().catch((error) => {
    console.warn(`[PiSessionDaemon] unavailable: ${error?.code ?? 'DAEMON_UNAVAILABLE'}`);
  });
  const controller = {
    expressApp: app,
    httpServer: server,
    getPort: () => {
      const address = server.address();
      return typeof address === 'object' && address ? address.port : null;
    },
    getTunnelUrl: () => null,
    getQuitRiskStatus: () => ({ tunnel: { active: false } }),
    isReady: () => !stopped,
    stop: async ({ exitProcess = false } = {}) => {
      if (stopped) return;
      stopped = true;
      if (activeController === controller) activeController = null;
      await Promise.allSettled([piSessionDaemonRuntime.stop(), close(server)]);
      uiAuthController.dispose?.();
      if (exitProcess) process.exit(0);
    },
  };
  activeController = controller;
  if (options.attachSignals !== false && !signalsAttached) {
    signalsAttached = true;
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void controller.stop({ exitProcess: options.exitOnShutdown === true }); });
  }
  console.log(`PiChamber listening on http://${host}:${controller.getPort()}`);
  return controller;
}

runCliEntryIfMain({
  process,
  currentFilename: __filename,
  parseServeCliOptions,
  defaultPort: DEFAULT_PORT,
  cloudflareProvider: 'cloudflare',
  managedLocalMode: 'managed-local',
  setExitOnShutdown: () => {},
  startServer: startWebUiServer,
});

export const parseArgs = (argv = []) => parseServeCliOptions({ argv, env: process.env, defaultPort: DEFAULT_PORT, cloudflareProvider: 'cloudflare', managedLocalMode: 'managed-local' });
