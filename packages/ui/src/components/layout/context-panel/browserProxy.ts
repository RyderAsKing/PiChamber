import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  getBrowserProxyTargetKey,
  getCachedProxyTarget,
  previewProxyTargetCache,
  type CachedProxyTarget,
} from '@/lib/preview/screenshot-capture';
import { parsePreviewProxyTargetResponse, stripPreviewQueryParams } from './previewShared';
import { isLoopbackBrowserUrl } from './browserRoute';

/**
 * The PiChamber browser's server route: pages load through the preview proxy
 * (`/api/preview/proxy/<id>/...`), authorized by a per-target preview token.
 * The iframe pane frames the proxy path; the desktop webview loads it as an
 * absolute URL in its own storage partition.
 */

type ProxyTargetResult =
  | { ok: true; target: CachedProxyTarget }
  | { ok: false; message: string };

/** Register (or reuse) the proxy target for a page's origin. */
export const ensureBrowserProxyTarget = async (url: string): Promise<ProxyTargetResult> => {
  const key = getBrowserProxyTargetKey(url);
  const cached = getCachedProxyTarget(key);
  if (cached?.previewToken) return { ok: true, target: cached };
  if (cached) previewProxyTargetCache.delete(key);

  try {
    const response = await runtimeFetch('/api/preview/targets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      // Loopback goes through the loopback proxy path; everything else
      // through the external path, which refuses private addresses.
      body: JSON.stringify({ url, allowExternal: !isLoopbackBrowserUrl(url) }),
    });
    const result = await parsePreviewProxyTargetResponse(response);
    if (!result.ok) return result;
    previewProxyTargetCache.set(key, result.target);
    return { ok: true, target: result.target };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

const trimTrailingSlash = (value: string): string => (value.endsWith('/') ? value.slice(0, -1) : value);

/**
 * The proxy path (with query and hash) that serves `upstreamUrl` through a
 * registered target. Relative to the PiChamber API base.
 */
export const buildBrowserProxyPath = (
  upstreamUrl: string,
  target: Pick<CachedProxyTarget, 'proxyBasePath' | 'previewToken'>,
  reloadNonce?: number,
): string => {
  const parsed = new URL(upstreamUrl);
  const searchParams = new URLSearchParams(parsed.search);
  searchParams.delete('oc_url_token');
  searchParams.delete('oc_client_token');
  if (reloadNonce !== undefined) searchParams.set('ocPreview', String(reloadNonce));
  searchParams.set('oc_preview_token', target.previewToken || '');
  const search = searchParams.toString();
  return `${trimTrailingSlash(target.proxyBasePath)}${parsed.pathname || '/'}${search ? `?${search}` : ''}${parsed.hash}`;
};

type ProxiedBrowserUrl =
  /** A proxy URL for a target this pane loaded: the page's own address. */
  | { kind: 'proxied'; upstreamUrl: string }
  /** A path on the proxy origin outside any proxy target: a root-relative link that escaped the proxy. */
  | { kind: 'escaped'; relative: string }
  /** Anything else: a page outside the proxy. */
  | { kind: 'other' };

/**
 * Classify an address the desktop webview reports on the server route.
 * `targets` maps each proxy base path the pane loaded to its upstream origin.
 */
export const classifyProxiedBrowserUrl = (
  url: string,
  proxyOrigin: string,
  targets: ReadonlyMap<string, string>,
): ProxiedBrowserUrl => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'other' };
  }
  if (parsed.origin !== proxyOrigin) return { kind: 'other' };
  for (const [basePath, upstreamOrigin] of targets) {
    const base = trimTrailingSlash(basePath);
    if (parsed.pathname !== base && !parsed.pathname.startsWith(`${base}/`)) continue;
    const rest = parsed.pathname.slice(base.length) || '/';
    try {
      return {
        kind: 'proxied',
        upstreamUrl: stripPreviewQueryParams(new URL(`${rest}${parsed.search}${parsed.hash}`, upstreamOrigin).toString()),
      };
    } catch {
      return { kind: 'other' };
    }
  }
  // Another target's proxy path (one this pane did not register) still loads
  // through the server; show it without its token.
  if (parsed.pathname.startsWith('/api/preview/proxy/')) return { kind: 'proxied', upstreamUrl: stripPreviewQueryParams(url) };
  return { kind: 'escaped', relative: `${parsed.pathname}${parsed.search}${parsed.hash}` };
};
