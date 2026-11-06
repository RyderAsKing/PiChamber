import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';

import { isServerNetworkHost } from '../security/server-network-host.js';

// Tells the "This device" browser, which shows pages in an iframe, whether a
// public site refuses to be shown inside another page (X-Frame-Options or a
// CSP frame-ancestors directive). An iframe cannot see why a page stayed
// blank, so the server asks the site. Only public addresses are checked:
// the server's own network is not reached, and a device's `localhost` is
// not the server's anyway.

const TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 5;
const CACHE_MS = 60_000;
const MAX_CACHE = 200;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' };
const portOf = (url) => url.port || DEFAULT_PORTS[url.protocol] || '';

const headerValues = (value) => {
  if (Array.isArray(value)) return value.flatMap((entry) => String(entry).split(','));
  return typeof value === 'string' ? value.split(',') : [];
};

/** The `frame-ancestors` source lists of every CSP policy that has one. */
export const parseFrameAncestors = (header) => {
  const lists = [];
  // Node joins repeated headers with ", ", which also separates policies.
  for (const policy of headerValues(header)) {
    for (const directive of policy.split(';')) {
      const [name, ...sources] = directive.trim().split(/\s+/);
      if (name?.toLowerCase() === 'frame-ancestors') {
        lists.push(sources.filter(Boolean));
        break;
      }
    }
  }
  return lists;
};

const schemeAllows = (sourceScheme, ancestor) => (
  sourceScheme === ancestor.protocol || (sourceScheme === 'http:' && ancestor.protocol === 'https:')
);

/** Whether one CSP source expression matches the embedding page's origin. */
const sourceMatches = (source, ancestor, target) => {
  const lower = source.toLowerCase();
  if (lower === "'self'") return ancestor.origin === target.origin;
  if (lower === '*') return ancestor.protocol === 'http:' || ancestor.protocol === 'https:';
  if (/^[a-z][a-z0-9+.-]*:$/.test(lower)) return schemeAllows(lower, ancestor);
  const match = /^(?:([a-z][a-z0-9+.-]*:)\/\/)?(\*\.)?([a-z0-9.-]+|\*)(?::(\d+|\*))?(?:\/.*)?$/.exec(lower);
  if (!match) return false;
  const [, scheme, wildcard, host, port] = match;
  if (!schemeAllows(scheme || target.protocol, ancestor)) return false;
  const ancestorHost = ancestor.hostname.toLowerCase();
  if (host === '*') {
    if (wildcard) return false;
  } else if (wildcard) {
    if (!ancestorHost.endsWith(`.${host}`)) return false;
  } else if (ancestorHost !== host) {
    return false;
  }
  if (port === '*') return true;
  const expected = port || DEFAULT_PORTS[scheme || target.protocol] || '';
  return portOf(ancestor) === expected;
};

/**
 * Whether a response with these headers may be shown in an iframe on
 * `ancestorOrigin`, following Chrome: frame-ancestors wins over
 * X-Frame-Options. Returns `refused` only for an unambiguous refusal.
 */
export const frameVerdict = ({ headers, targetUrl, ancestorOrigin }) => {
  const target = new URL(targetUrl);
  const ancestor = new URL(ancestorOrigin);
  const lists = parseFrameAncestors(headers['content-security-policy']);
  if (lists.length > 0) {
    const allowed = lists.every((list) => list.some((source) => sourceMatches(source, ancestor, target)));
    return allowed ? { framing: 'allowed' } : { framing: 'refused', reason: 'frame-ancestors' };
  }
  const values = new Set(headerValues(headers['x-frame-options']).map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (values.size === 0) return { framing: 'allowed' };
  const known = ['deny', 'sameorigin', 'allowall'];
  if (values.size > 1) {
    return [...values].some((value) => known.includes(value)) ? { framing: 'refused', reason: 'x-frame-options' } : { framing: 'allowed' };
  }
  const [value] = values;
  if (value === 'deny') return { framing: 'refused', reason: 'x-frame-options' };
  if (value === 'sameorigin') {
    return ancestor.origin === target.origin ? { framing: 'allowed' } : { framing: 'refused', reason: 'x-frame-options' };
  }
  return { framing: 'allowed' };
};

const isPublicUrl = (url) => (url.protocol === 'http:' || url.protocol === 'https:') && !isServerNetworkHost(url.hostname);

/**
 * A DNS lookup that refuses names resolving to the server's own network, so
 * a public-looking name cannot reach it (also on the connection itself).
 */
export const createPublicLookup = (lookup = dns.lookup) => (hostname, options, callback) => {
  const opts = typeof options === 'object' && options ? options : { family: options };
  lookup(hostname, { ...opts, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const list = Array.isArray(addresses) ? addresses : [];
    if (list.length === 0 || list.some((entry) => isServerNetworkHost(entry.address))) {
      const blocked = new Error(`${hostname} resolves to the server's network`);
      blocked.code = 'ESERVERNETWORK';
      return callback(blocked);
    }
    if (opts.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
};

const defaultFetchHeaders = (lookup) => (url) => new Promise((resolve, reject) => {
  const client = url.protocol === 'https:' ? https : http;
  const request = client.request(url, {
    method: 'GET',
    agent: false,
    lookup,
    timeout: TIMEOUT_MS,
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'iframe' },
  }, (response) => {
    resolve({ status: response.statusCode || 0, headers: response.headers });
    response.destroy();
  });
  request.on('timeout', () => request.destroy(new Error('timed out')));
  request.on('error', reject);
  request.end();
});

/**
 * Checks sites for framing refusals, following redirects and caching
 * answers for a minute. Anything it cannot check is `unknown`, never a
 * refusal.
 */
export const createFramePolicyChecker = ({
  fetchHeaders = defaultFetchHeaders(createPublicLookup()),
  now = Date.now,
} = {}) => {
  const cache = new Map();

  const resolve = async (startUrl, ancestorOrigin) => {
    let url = new URL(startUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!isPublicUrl(url)) return { framing: 'unknown' };
      const { status, headers } = await fetchHeaders(url);
      const location = typeof headers.location === 'string' ? headers.location : null;
      if (REDIRECTS.has(status) && location) {
        url = new URL(location, url);
        continue;
      }
      return frameVerdict({ headers, targetUrl: url.toString(), ancestorOrigin });
    }
    return { framing: 'unknown' };
  };

  return {
    async check(rawUrl, rawOrigin) {
      let url;
      let origin;
      try {
        url = new URL(rawUrl);
        origin = new URL(rawOrigin).origin;
      } catch {
        return { framing: 'unknown' };
      }
      if (!isPublicUrl(url) || origin === 'null') return { framing: 'unknown' };
      const key = `${url.toString()}\n${origin}`;
      const cached = cache.get(key);
      if (cached && now() - cached.at < CACHE_MS) return cached.result;
      const result = await resolve(url.toString(), origin).catch(() => ({ framing: 'unknown' }));
      cache.set(key, { at: now(), result });
      if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      return result;
    },
  };
};
