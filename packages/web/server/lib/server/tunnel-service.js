import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  checkCloudflaredAvailable,
  startCloudflareManagedRemoteTunnel,
  startCloudflareManagedLocalTunnel,
} from '../cloudflare-tunnel.js';
import { writeFileAtomicSync } from '../fs/atomic-write.js';
import { getTunnelDependencyInstallInfo } from '../tunnels/install-help.js';
import { TUNNEL_PROVIDER_CLOUDFLARE } from '../tunnels/types.js';

const TUNNEL_TOKEN_FILE = 'cloudflare-tunnel-token.json';

// Quick tunnels were removed: their ephemeral URL changed on every restart and
// broke saved device connections. Use `pichamber pair --tailscale [--public]`
// or a managed-remote tunnel with your own hostname instead.

const sanitizeToken = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const redactToken = (value) => {
  if (!value || typeof value !== 'string') return '';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
};

export const createTunnelService = ({
  dataDir,
  getPort,
  tunnelAuthController,
  getServerLabel = () => 'PiChamber',
} = {}) => {
  const tokenPath = path.join(dataDir, TUNNEL_TOKEN_FILE);
  let activeController = null;
  let activePublicUrl = null;
  let activeMode = null;
  let bootstrapToken = null;
  let bootstrapExpiresAt = null;

  const readTokenStore = () => {
    try {
      const raw = fs.readFileSync(tokenPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.token === 'string' && typeof parsed.hostname === 'string') {
        return parsed;
      }
    } catch {}
    return null;
  };

  const writeTokenStore = (token, hostname) => {
    try {
      // Atomic replace so a concurrent server never reads a torn token.
      writeFileAtomicSync(tokenPath, JSON.stringify({ token, hostname }));
    } catch {}
  };

  const clearTokenStore = () => {
    try { fs.unlinkSync(tokenPath); } catch {}
  };

  const getStatus = async () => {
    const hasManagedRemoteTunnelToken = Boolean(readTokenStore()?.token);
    const active = Boolean(activeController && activePublicUrl);
    const providerMetadata = active ? { mode: activeMode } : null;
    const hasBootstrapToken = Boolean(bootstrapToken && bootstrapExpiresAt && bootstrapExpiresAt > Date.now());
    return {
      active,
      url: activePublicUrl,
      mode: activeMode,
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      providerMetadata,
      hasManagedRemoteTunnelToken,
      managedRemoteTunnelHostname: readTokenStore()?.hostname ?? null,
      hasBootstrapToken,
      bootstrapExpiresAt: hasBootstrapToken ? bootstrapExpiresAt : null,
      activeTunnelMode: activeMode,
      activeSessions: tunnelAuthController?.listTunnelSessions?.() ?? [],
      localPort: typeof getPort === 'function' ? getPort() : null,
      policy: 'tunnel-gated',
      ttlConfig: { bootstrapTtlMs: 30 * 60 * 1000, sessionTtlMs: 8 * 60 * 60 * 1000 },
    };
  };

  const check = async () => {
    const result = await checkCloudflaredAvailable();
    if (result.available) {
      return {
        available: true,
        provider: TUNNEL_PROVIDER_CLOUDFLARE,
        version: result.version,
        dependency: 'cloudflared',
        installCommand: null,
        platform: process.platform,
        message: null,
      };
    }
    const installInfo = getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_CLOUDFLARE, process.platform);
    return {
      available: false,
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      version: null,
      dependency: installInfo.dependency ?? 'cloudflared',
      installCommand: installInfo.installCommand ?? installInfo.message,
      platform: process.platform,
      message: installInfo.message,
    };
  };

  const start = async (options = {}) => {
    // No mode default: quick tunnels were removed, and managed modes each
    // require explicit inputs. Stored quick state from older versions is
    // treated as absent (never started) so startup cannot resurrect it.
    const mode = typeof options.mode === 'string' ? options.mode.trim().toLowerCase() : '';
    const hostname = sanitizeToken(options.hostname);
    const token = sanitizeToken(options.token);

    if (mode === 'quick' || mode === '') {
      const error = new Error(
        mode === 'quick'
          ? 'Quick tunnels were removed because their URL changed on every restart. Use `pichamber pair --tailscale [--public]` or `pichamber tunnel start --mode managed-remote --token-file <path> --hostname <host>`.'
          : 'A tunnel mode is required (--mode managed-remote or --mode managed-local). Quick tunnels were removed; use `pichamber pair --tailscale [--public]` or a managed-remote tunnel with your own hostname.'
      );
      error.code = mode === 'quick' ? 'quick_tunnel_removed' : 'validation_error';
      throw error;
    }

    // Validate mode-specific inputs before checking binary availability so the
    // user gets a actionable validation error even when cloudflared is missing.
    if (mode === 'managed-remote') {
      if (!token) {
        const error = new Error('Managed remote tunnel token is required');
        error.code = 'validation_error';
        throw error;
      }
      if (!hostname) {
        const error = new Error('Managed remote tunnel hostname is required');
        error.code = 'validation_error';
        throw error;
      }
    } else if (mode !== 'managed-local') {
      const error = new Error(`Unsupported tunnel mode: ${mode}`);
      error.code = 'mode_unsupported';
      throw error;
    }

    if (activeController) {
      await stop();
    }

    const availability = await checkCloudflaredAvailable();
    if (!availability.available) {
      const installInfo = getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_CLOUDFLARE, process.platform);
      const error = new Error(installInfo.message);
      error.code = 'missing_dependency';
      throw error;
    }

    let controller;
    if (mode === 'managed-remote') {
      controller = await startCloudflareManagedRemoteTunnel({ token, hostname });
      writeTokenStore(token, hostname);
    } else if (mode === 'managed-local') {
      const configPath = typeof options.configPath === 'string' ? options.configPath : undefined;
      controller = await startCloudflareManagedLocalTunnel({ configPath, hostname });
    } else {
      const error = new Error(`Unsupported tunnel mode: ${mode}`);
      error.code = 'mode_unsupported';
      throw error;
    }

    activeController = controller;
    activePublicUrl = controller.getPublicUrl?.() ?? null;
    activeMode = mode;

    if (tunnelAuthController && activePublicUrl) {
      const tunnelId = crypto.randomUUID();
      tunnelAuthController.setActiveTunnel({ tunnelId, publicUrl: activePublicUrl, mode });
      try {
        const issued = tunnelAuthController.issueBootstrapToken({ ttlMs: 30 * 60 * 1000 });
        bootstrapToken = issued.token;
        bootstrapExpiresAt = issued.expiresAt;
      } catch {}
    }

    return {
      ok: true,
      url: activePublicUrl,
      mode: activeMode,
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      providerMetadata: controller.getResolvedHostname ? { resolvedHostname: controller.getResolvedHostname() } : null,
      connectUrl: bootstrapToken && activePublicUrl ? `${activePublicUrl.replace(/\/$/, '')}/connect?t=${encodeURIComponent(bootstrapToken)}` : null,
      bootstrapExpiresAt,
    };
  };

  const stop = async () => {
    if (activeController?.stop) {
      try { activeController.stop(); } catch {}
    }
    if (activeController?.process?.kill) {
      try { activeController.process.kill('SIGINT'); } catch {}
    }
    activeController = null;
    activePublicUrl = null;
    activeMode = null;
    bootstrapToken = null;
    bootstrapExpiresAt = null;
    if (tunnelAuthController) {
      try { tunnelAuthController.clearActiveTunnel(); } catch {}
    }
    return { ok: true };
  };

  const saveManagedRemoteToken = async ({ token, hostname, presetName }) => {
    const cleanToken = sanitizeToken(token);
    const cleanHostname = sanitizeToken(hostname);
    if (!cleanToken || !cleanHostname) {
      const error = new Error('Token and hostname are required');
      error.code = 'validation_error';
      throw error;
    }
    writeTokenStore(cleanToken, cleanHostname);
    return { ok: true };
  };

  return {
    getStatus,
    check,
    start,
    stop,
    saveManagedRemoteToken,
    _internals: { getActiveController: () => activeController, redactToken },
  };
};
