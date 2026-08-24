import { PACKAGED_CLIENT_ORIGINS } from '../security/packaged-client-origins.js';

const ALLOWED_UI_CORS_ORIGINS = PACKAGED_CLIENT_ORIGINS;

const LOOPBACK_HTTP_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/;

const ALLOWED_CORS_HEADER_NAMES = new Set([
  'accept',
  'authorization',
  'cache-control',
  'content-type',
  'x-pichamber-directory',
  'x-requested-with',
]);

const DEFAULT_ALLOWED_CORS_HEADERS = [
  'Content-Type',
  'Authorization',
  'Accept',
  'X-Requested-With',
  'Cache-Control',
  'x-pichamber-directory',
].join(',');

export const isAllowedUiCorsOrigin = (origin) => (
  typeof origin === 'string'
  && (ALLOWED_UI_CORS_ORIGINS.has(origin) || LOOPBACK_HTTP_ORIGIN.test(origin))
);

export const resolveAllowedCorsHeaders = (requestHeaders) => {
  const requested = String(requestHeaders || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (requested.length === 0) return DEFAULT_ALLOWED_CORS_HEADERS;
  const allowed = requested.filter((header) => ALLOWED_CORS_HEADER_NAMES.has(header.toLowerCase()));
  return allowed.length > 0 ? allowed.join(',') : DEFAULT_ALLOWED_CORS_HEADERS;
};

export const applyUiCorsHeaders = (req, res) => {
  const origin = typeof req.headers?.origin === 'string' ? req.headers.origin : '';
  if (!isAllowedUiCorsOrigin(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', resolveAllowedCorsHeaders(req.headers?.['access-control-request-headers']));
  res.setHeader('Vary', 'Origin');
  return req.method === 'OPTIONS';
};
