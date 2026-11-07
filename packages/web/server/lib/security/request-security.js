import { PACKAGED_CLIENT_ORIGINS } from './packaged-client-origins.js';
import { isAllowedUiCorsOrigin } from '../server/cors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Proxied dev-server traffic: it carries no PiChamber credentials (the proxy
// strips them) and the dev server's own pages may send any Origin.
const PREVIEW_PROXY_PREFIX = '/api/preview/proxy/';

export const createRequestSecurityRuntime = (deps) => {
  const { readSettingsFromDiskMigrated } = deps;
  const packagedClientOrigins = PACKAGED_CLIENT_ORIGINS;

  const getUiSessionTokenFromRequest = (req) => {
    const cookieHeader = req?.headers?.cookie;
    if (!cookieHeader || typeof cookieHeader !== 'string') {
      return null;
    }
    const segments = cookieHeader.split(';');
    for (const segment of segments) {
      const [rawName, ...rest] = segment.split('=');
      const name = rawName?.trim();
      if (!name) continue;
      if (name !== 'oc_ui_session') continue;
      const value = rest.join('=').trim();
      try {
        return decodeURIComponent(value || '');
      } catch {
        return value || null;
      }
    }
    return null;
  };

  const rejectWebSocketUpgrade = (socket, statusCode, reason) => {
    if (!socket || socket.destroyed) {
      return;
    }

    const message = typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : 'Bad Request';
    const body = Buffer.from(message, 'utf8');
    const statusText = {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      500: 'Internal Server Error',
    }[statusCode] || 'Bad Request';

    try {
      socket.write(
        `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
        'Connection: close\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        `Content-Length: ${body.length}\r\n\r\n`
      );
      socket.write(body);
    } catch {
    }

    try {
      socket.destroy();
    } catch {
    }
  };

  const getRequestOriginCandidates = async (req) => {
    const origins = new Set();
    const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string'
      ? req.headers['x-forwarded-proto'].split(',')[0].trim().toLowerCase()
      : '';
    const protocol = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');

    const forwardedHost = typeof req.headers['x-forwarded-host'] === 'string'
      ? req.headers['x-forwarded-host'].split(',')[0].trim()
      : '';
    const host = forwardedHost || (typeof req.headers.host === 'string' ? req.headers.host.trim() : '');

    if (host) {
      origins.add(`${protocol}://${host}`);
      const [hostname, port] = host.split(':');
      const normalizedHost = typeof hostname === 'string' ? hostname.toLowerCase() : '';
      const portSuffix = typeof port === 'string' && port.length > 0 ? `:${port}` : '';
      if (normalizedHost === 'localhost') {
        origins.add(`${protocol}://127.0.0.1${portSuffix}`);
        origins.add(`${protocol}://[::1]${portSuffix}`);
      } else if (normalizedHost === '127.0.0.1' || normalizedHost === '[::1]') {
        origins.add(`${protocol}://localhost${portSuffix}`);
      }
    }

    try {
      const settings = await readSettingsFromDiskMigrated();
      if (typeof settings?.publicOrigin === 'string' && settings.publicOrigin.trim().length > 0) {
        origins.add(new URL(settings.publicOrigin.trim()).origin);
      }
    } catch {
    }

    return origins;
  };

  const isRequestOriginAllowed = async (req) => {
    const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    if (!originHeader) {
      return false;
    }

    if (packagedClientOrigins.has(originHeader)) {
      return true;
    }

    let normalizedOrigin = '';
    try {
      normalizedOrigin = new URL(originHeader).origin;
    } catch {
      return false;
    }

    const allowedOrigins = await getRequestOriginCandidates(req);
    return allowedOrigins.has(normalizedOrigin);
  };

  // A request another site's page started. Browsers always send Origin on
  // WebSocket upgrades and on POST, PUT, PATCH, and DELETE, and pages cannot
  // set it, so a page elsewhere cannot pass as PiChamber. Allowed: no Origin
  // (not a browser page), PiChamber's own origin, packaged clients, loopback
  // pages (the same origins CORS allows), and requests the browser marks
  // same-origin (`Sec-Fetch-Site`, for proxies that rewrite Host). This is the
  // only origin rule while UI auth is off; DNS rebinding is not caught.
  const isCrossSiteRequest = async (req) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    if (!origin) return false;
    if (req.headers['sec-fetch-site'] === 'same-origin') return false;
    if (isAllowedUiCorsOrigin(origin)) return false;
    return !await isRequestOriginAllowed(req);
  };

  // Refuses state-changing HTTP requests from other sites, whatever the auth
  // mode. Reads stay open: CORS keeps their responses from other sites.
  const rejectCrossSiteRequests = (req, res, next) => {
    const path = req.originalUrl || req.url || '';
    if (SAFE_METHODS.has(req.method) || path.startsWith(PREVIEW_PROXY_PREFIX)) {
      next();
      return;
    }
    isCrossSiteRequest(req).then(
      (crossSite) => (crossSite ? res.status(403).json({ error: 'Invalid origin' }) : next()),
      () => res.status(403).json({ error: 'Invalid origin' }),
    );
  };

  return {
    getUiSessionTokenFromRequest,
    rejectWebSocketUpgrade,
    isRequestOriginAllowed,
    isCrossSiteRequest,
    rejectCrossSiteRequests,
  };
};
