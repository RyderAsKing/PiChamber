import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import {
  assertSafeBrowserPort,
  resolveConfiguredBindHost,
  buildLocalUrl,
  detectLanIPv4Address,
  formatHostForUrl,
} from './cli-network.js';
import { discoverRunningInstances } from './cli-lifecycle.js';
import { requestJson } from './cli-http.js';
import { getInstanceFilePath, readInstanceOptions } from './cli-process.js';
import { resolvePiChamberDataDir } from '../../server/lib/pichamber-data-dir.js';
import { createRemoteClientAuthRuntime } from '../../server/lib/client-auth/remote-clients.js';
import { createClientPairingRuntime } from '../../server/lib/client-auth/pairing.js';
import { createRelayIdentityRuntime } from '../../server/lib/relay/identity.js';
import { createRelayIdentityStore } from '../../server/lib/relay/identity-store.js';
import { DEFAULT_RELAY_URL } from '../../server/lib/relay/service.js';
import { bytesToBase64Url } from '../../server/lib/relay/e2ee.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  log as clackLog,
  isJsonMode,
  isQuietMode,
  canPrompt,
  createSpinner,
  printJson,
  logStatus,
} from '../cli-output.js';

const REMOTE_CLIENTS_FILE_NAME = 'remote-clients.json';
const SETTINGS_FILE_NAME = 'settings.json';
const PAIRING_SESSIONS_FILE_NAME = 'client-pairing-sessions.json';

// How long `pair --tailscale` waits for the server to reach a terminal
// Tailscale state (the approval flow alone may block up to 5 minutes).
const TAILSCALE_PAIR_WAIT_MS = 6 * 60 * 1000;
const TAILSCALE_PAIR_POLL_MS = 2000;
const TAILSCALE_TERMINAL_STATES = new Set(['active', 'needs-approval', 'conflict', 'blocked', 'error', 'unavailable']);

function assertTailscaleFlagCombination(options) {
  if ((options.public === true || options.httpsPort !== undefined) && options.tailscale !== true) {
    throw new TunnelCliError('Use --tailscale with --public / --https-port.', EXIT_CODE.USAGE_ERROR);
  }
}

// Asks the RUNNING server to enable Tailscale (persisted server-side), then
// waits for a terminal state. Returns the status body. Throws TunnelCliError
// on auth/validation failures; terminal non-active states are returned (not
// thrown) so the caller can still print the pairing link with whatever
// candidates exist.
async function enableTailscaleForPairing(options) {
  const mode = options.public === true ? 'public' : 'private';
  const httpsPort = options.httpsPort ?? 443;
  const spin = createSpinner(options);
  spin?.start(`Enabling Tailscale ${mode === 'public' ? 'Funnel (public)' : 'serve (tailnet-only)'} on port ${options.port}...`);
  try {
    const putResult = await requestJson(options.port, '/api/pichamber/tailscale/config', {
      ...options,
      method: 'PUT',
      body: JSON.stringify({ enabled: true, mode, httpsPort }),
      timeoutMs: 15000,
    });
    if (putResult.response.status === 403 || putResult.response.status === 422) {
      throw new TunnelCliError(
        typeof putResult.body?.error === 'string' ? putResult.body.error : 'Tailscale config rejected.',
        EXIT_CODE.AUTH_CONFIG_ERROR,
      );
    }
    if (!putResult.response.ok) {
      throw new TunnelCliError(
        typeof putResult.body?.error === 'string' ? putResult.body.error : 'Failed to enable Tailscale.',
        EXIT_CODE.GENERAL_ERROR,
      );
    }
    const deadline = Date.now() + TAILSCALE_PAIR_WAIT_MS;
    let status = putResult.body;
    while (!TAILSCALE_TERMINAL_STATES.has(status?.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, TAILSCALE_PAIR_POLL_MS));
      const polled = await requestJson(options.port, '/api/pichamber/tailscale/status', {
        ...options,
        timeoutMs: 8000,
      });
      if (polled.response.ok && polled.body) status = polled.body;
    }
    if (!TAILSCALE_TERMINAL_STATES.has(status?.state)) {
      throw new TunnelCliError('Timed out waiting for Tailscale to become active.', EXIT_CODE.GENERAL_ERROR);
    }
    spin?.stop(`Tailscale state: ${status.state}`);
    return status;
  } catch (error) {
    spin?.stop('Tailscale setup failed');
    throw error;
  }
}

function appendTailscaleCandidate(candidates, tailscaleStatus) {
  const url = typeof tailscaleStatus?.url === 'string' ? tailscaleStatus.url : null;
  if (!url || candidates.some((candidate) => candidate?.url === url)) return candidates;
  return [...candidates, { type: 'tailscale', url, mode: tailscaleStatus.mode || 'private', priority: 20 }];
}

function isValidRelayUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'ws:' || url.protocol === 'wss:';
  } catch {
    return false;
  }
}

// Resolve the relay endpoint the same way the running host does (service.js):
// PICHAMBER_RELAY_URL env override, then the stored setting, then the default —
// so the pairing link points at the same relay the host connects out to.
function resolveRelayUrl(settings) {
  const envUrl = process.env.PICHAMBER_RELAY_URL;
  if (isValidRelayUrl(envUrl)) return envUrl.trim();
  const stored = settings?.privateRelay?.relayUrl;
  if (isValidRelayUrl(stored)) return stored.trim();
  return DEFAULT_RELAY_URL;
}

// Minimal settings.json read for non-identity relay config (privateRelay
// relayUrl/enabled). Host identity keys live in the host-local
// relay-identity.json (see server/lib/relay/identity-store.js) — never in
// settings.json, which is portable between hosts and rewritten by the UI
// settings store.
async function readPairingRelaySettings() {
  const settingsPath = path.join(getPiChamberDataDir(), SETTINGS_FILE_NAME);
  try {
    return JSON.parse(await fs.promises.readFile(settingsPath, 'utf8'));
  } catch {
    return {};
  }
}

// Resolves the instance's relay identity (serverId + encryption public key,
// generating it if the relay was never enabled) into a pairing-v2 relay
// candidate. Relay is a transport, not a separate link format: the candidate
// carries no token — the client redeems the one-time pairing secret over the
// E2EE tunnel like any other candidate. `enabled` reports whether the host relay
// is actually on (a relay candidate only connects when the host is relaying).
async function buildRelayPairingCandidate() {
  const settings = await readPairingRelaySettings();
  const relayUrl = resolveRelayUrl(settings);
  const identityRuntime = createRelayIdentityRuntime({
    crypto,
    ...createRelayIdentityStore({ dataDir: getPiChamberDataDir() }),
  });
  const identity = await identityRuntime.getRelayIdentity();
  return {
    enabled: settings?.privateRelay?.enabled === true,
    relayUrl,
    serverId: identity.serverId,
    candidate: {
      type: 'relay',
      relayUrl,
      serverId: identity.serverId,
      hostEncPubJwk: identity.hostEncPubJwk,
      priority: 30,
    },
  };
}

// Pairing runtime backed by the same on-disk store the running host reads, so a
// session created here is redeemable by the live server. createPairingSession
// only writes the store (no server needed to mint); redeem is served by the host.
function createCliPairingRuntime() {
  const dataDir = getPiChamberDataDir();
  const remoteClientAuthRuntime = createRemoteClientAuthRuntime({
    fsPromises: fs.promises,
    path,
    crypto,
    storePath: path.join(dataDir, REMOTE_CLIENTS_FILE_NAME),
  });
  return createClientPairingRuntime({
    fsPromises: fs.promises,
    path,
    crypto,
    storePath: path.join(dataDir, PAIRING_SESSIONS_FILE_NAME),
    remoteClientAuthRuntime,
  });
}

// Mirror of encodePairingConnectionPayload in @pichamber/ui (the bin cannot
// import the UI package). Keep in sync: v2 payload → base64url(JSON) in the URL
// query, so the one-time secret rides the link, never the network.
function encodePairingConnectUrl(payload) {
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `pichamber://connect?v=2&p=${encoded}`;
}

function buildPairingPayload({ pairing, label, candidates }) {
  return {
    v: 2,
    pairingId: pairing.id,
    secret: pairing.secret,
    ...(label ? { label } : {}),
    ...(pairing.fingerprint ? { fingerprint: pairing.fingerprint } : {}),
    ...(pairing.expiresAt ? { expiresAt: pairing.expiresAt } : {}),
    candidates,
  };
}

async function resolveConnectUrlServerUrl(options) {
  let hostOverride = options.host;
  if (typeof hostOverride !== 'string' && !process.env.PICHAMBER_HOST && !process.env.PICHAMBER_HOST) {
    const storedOptions = readInstanceOptions(await getInstanceFilePath(options.port));
    if (typeof storedOptions?.host === 'string' && storedOptions.host.trim()) {
      hostOverride = storedOptions.host.trim();
    }
  }

  const bindHost = resolveConfiguredBindHost(hostOverride);

  // A host that's already a full http(s) URL is a public/server URL, not a bind
  // address (e.g. `--host https://devchamber.example.com` for a remote deploy
  // behind a reverse proxy). Use it directly instead of feeding it to
  // buildLocalUrl, which would produce `http://https://...:port`.
  const hostAsServerUrl = normalizeServerUrlForConnection(bindHost);
  if (hostAsServerUrl) {
    return { serverUrl: hostAsServerUrl, source: 'configured-host' };
  }

  if (!isWildcardBindHost(bindHost)) {
    return {
      serverUrl: buildLocalUrl(options.port, '/', hostOverride).replace(/\/+$/, ''),
      source: 'configured-host',
    };
  }

  const lanAddress = await detectLanIPv4Address();
  if (!lanAddress) {
    return {
      serverUrl: buildLocalUrl(options.port, '/').replace(/\/+$/, ''),
      source: 'loopback-fallback',
    };
  }

  return {
    serverUrl: `http://${formatHostForUrl(lanAddress)}:${options.port}`,
    source: 'lan-detected',
  };
}

function isWildcardBindHost(host) {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

function isLoopbackServerUrl(serverUrl) {
  try {
    const hostname = new URL(serverUrl).hostname.replace(/^\[|\]$/g, '');
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

function normalizeServerUrlForConnection(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function getPiChamberDataDir() {
  return resolvePiChamberDataDir();
}

async function displayTunnelQrCode(url) {
  try {
    const qrcode = await import('qrcode-terminal');
    console.log('\n📱 Scan this QR code to access the tunnel:\n');
    qrcode.default.generate(url, { small: true });
    console.log('');
  } catch (error) {
    console.warn(`Warning: Could not generate QR code: ${error.message}`);
  }
}

function createConnectUrlCommand({ serveCommand }) {
  return async function connectUrlCommand(options = {}) {
    assertSafeBrowserPort(options.port, { context: 'PiChamber pair' });
    assertTailscaleFlagCombination(options);
    const explicitServerUrl = options.server ? normalizeServerUrlForConnection(options.server) : null;
    if (options.server && !explicitServerUrl) {
      throw new TunnelCliError('Invalid --server URL. Use an http:// or https:// URL.', EXIT_CODE.USAGE_ERROR);
    }

    const running = await discoverRunningInstances();
    const serverState = running.some((entry) => entry.port === options.port)
      ? { port: options.port, autoStarted: false }
      : await (async () => {
          await serveCommand({
            port: options.port,
            explicitPort: true,
            host: options.host,
            lan: options.lan,
            uiPassword: options.uiPassword,
            explicitUiPassword: options.explicitUiPassword === true,
            apiOnly: options.apiOnly,
            foreground: false,
            json: false,
            quiet: true,
            suppressUnsafePortWarning: true,
            suppressUiPasswordWarning: true,
            suppressStartupSummary: true,
            suppressQuietOutput: true,
          });
          return { port: options.port, autoStarted: true };
        })();

    const resolvedServerUrl = explicitServerUrl
      ? { serverUrl: explicitServerUrl, source: 'explicit' }
      : await resolveConnectUrlServerUrl(options);
    const serverUrl = resolvedServerUrl.serverUrl;
    const label = options.name || os.hostname();

    // Direct candidate for the reachable server URL, plus the relay transport as
    // a fallback candidate — one link that works both on the LAN and off-network.
    // Candidate priorities make the client prefer the direct route and try the
    // relay last, mirroring the UI's "Anywhere" pairing. `--relay` opts in even
    // when the host relay is not up yet (the demand-driven lifecycle starts it);
    // otherwise the relay rides along only when it is already enabled.
    const candidates = [{ type: serverUrl.startsWith('https://') ? 'tunnel' : 'lan', url: serverUrl, priority: 10 }];
    const relay = await buildRelayPairingCandidate();
    if (options.relay || relay.enabled) candidates.push(relay.candidate);

    // Tailscale: persist the config on the RUNNING server and wait for a
    // terminal state, then append the ts.net URL (when live) as a candidate.
    let tailscale = null;
    if (options.tailscale === true) {
      tailscale = await enableTailscaleForPairing(options);
      const withTailscale = appendTailscaleCandidate(candidates, tailscale);
      candidates.length = 0;
      candidates.push(...withTailscale);
    }

    const pairingRuntime = createCliPairingRuntime();
    // Mark relay-carrying sessions like the server route does, so the host's
    // demand-driven relay lifecycle keeps the relay up while the link is pending.
    const usesRelay = candidates.some((candidate) => candidate.type === 'relay');
    const { pairing } = await pairingRuntime.createPairingSession({ label, usesRelay });
    const connectUrl = encodePairingConnectUrl(buildPairingPayload({ pairing, label, candidates }));

    if (isJsonMode(options)) {
      printJson({
        serverUrl,
        connectUrl,
        pairingId: pairing.id,
        fingerprint: pairing.fingerprint,
        expiresAt: pairing.expiresAt,
        candidates,
        autoStarted: serverState.autoStarted,
        ...(tailscale ? { tailscale } : {}),
      });
      return;
    }

    if (isQuietMode(options)) {
      process.stdout.write(`${connectUrl}\n`);
      return;
    }

    clackIntro('PiChamber pairing link');
    if (serverState.autoStarted) {
      logStatus('success', `started PiChamber on port ${options.port}`);
    }
    logStatus('success', connectUrl);
    clackLog.info(`Server URL: ${serverUrl}`);
    if (tailscale) {
      if (tailscale.state === 'active' && tailscale.url) {
        clackLog.info(`Tailscale URL: ${tailscale.url}`);
      } else if (tailscale.state === 'needs-approval' && tailscale.approvalUrl) {
        logStatus('warn', '[TAILSCALE_APPROVAL]', `Approve Tailscale access: ${tailscale.approvalUrl}`);
      } else {
        logStatus('warn', '[TAILSCALE_NOT_ACTIVE]', `Tailscale state is ${tailscale.state ?? 'unknown'}${tailscale.errorMessage ? `: ${tailscale.errorMessage}` : ''}. The link below carries the remaining candidates.`);
      }
    }
    if (options.relay || relay.enabled) {
      clackLog.info(`Relay fallback: ${relay.relayUrl}`);
    }
    if (options.relay && !relay.enabled) {
      logStatus('info', '[RELAY_STARTING]', 'Relay is not up yet. A running instance starts it within a minute; a stopped instance starts it on next launch.');
    }
    if (pairing.fingerprint) {
      clackLog.info(`Fingerprint: ${pairing.fingerprint}`);
    }
    if (resolvedServerUrl.source === 'lan-detected') {
      clackLog.info('Detected a LAN address because PiChamber is bound to all interfaces. Use --server to override it.');
    } else if (resolvedServerUrl.source === 'loopback-fallback') {
      clackLog.warn('PiChamber is bound to all interfaces, but no LAN address was detected. Use --server to provide a reachable URL.');
    } else if (isLoopbackServerUrl(serverUrl)) {
      // The direct candidate points at this machine only — other devices cannot
      // use it. Say so instead of letting a "LAN" link silently not work (or a
      // --relay link silently go relay-only).
      if (options.relay) {
        logStatus('warn', '[LAN_UNREACHABLE]', 'PiChamber only listens on this machine, so devices will always connect through the relay. Restart with --lan to allow direct home-network connections.');
      } else {
        logStatus('warn', '[LAN_UNREACHABLE]', 'PiChamber only listens on this machine, so other devices cannot use this link. Restart with --lan, or use --server to provide a reachable URL.');
      }
    }
    clackLog.info('Scan or paste this link into another PiChamber client. It is single-use and expires.');
    // QR art is terminal UI. Keep non-TTY stdout limited to the pairing link so
    // agents can capture it even when they pass --qr defensively.
    if (options.qr === true && canPrompt(options)) {
      await displayTunnelQrCode(connectUrl);
    }
    clackOutro('pairing link generated');
  };
}

export { createConnectUrlCommand };
