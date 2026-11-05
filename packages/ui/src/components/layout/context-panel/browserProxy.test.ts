import { describe, expect, test } from 'bun:test';

import { buildBrowserProxyPath, classifyProxiedBrowserUrl } from './browserProxy';

const target = { proxyBasePath: '/api/preview/proxy/0123456789abcdef', previewToken: 'tok' };
const proxyOrigin = 'http://127.0.0.1:3000';
const targets = new Map([[target.proxyBasePath, 'http://localhost:4000']]);

describe('buildBrowserProxyPath', () => {
  test('keeps path, query, and hash and adds the preview token', () => {
    expect(buildBrowserProxyPath('http://localhost:4000/review?x=1#top', target))
      .toBe('/api/preview/proxy/0123456789abcdef/review?x=1&oc_preview_token=tok#top');
  });

  test('drops PiChamber credentials from the page address and adds the reload nonce', () => {
    expect(buildBrowserProxyPath('http://localhost:4000/?oc_url_token=a&oc_client_token=b', target, 2))
      .toBe('/api/preview/proxy/0123456789abcdef/?ocPreview=2&oc_preview_token=tok');
  });
});

describe('classifyProxiedBrowserUrl', () => {
  test('maps a proxy address back to the page address without preview parameters', () => {
    expect(classifyProxiedBrowserUrl(`${proxyOrigin}${target.proxyBasePath}/review?x=1&oc_preview_token=tok#top`, proxyOrigin, targets))
      .toEqual({ kind: 'proxied', upstreamUrl: 'http://localhost:4000/review?x=1#top' });
  });

  test('maps the bare proxy base to the page root', () => {
    expect(classifyProxiedBrowserUrl(`${proxyOrigin}${target.proxyBasePath}`, proxyOrigin, targets))
      .toEqual({ kind: 'proxied', upstreamUrl: 'http://localhost:4000/' });
  });

  test('reports a root-relative path that escaped the proxy', () => {
    expect(classifyProxiedBrowserUrl(`${proxyOrigin}/login?next=1`, proxyOrigin, targets))
      .toEqual({ kind: 'escaped', relative: '/login?next=1' });
  });

  test('does not treat a lookalike prefix as the target', () => {
    expect(classifyProxiedBrowserUrl(`${proxyOrigin}${target.proxyBasePath}ff/x`, proxyOrigin, targets))
      .toEqual({ kind: 'proxied', upstreamUrl: `${proxyOrigin}${target.proxyBasePath}ff/x` });
  });

  test('leaves other origins alone', () => {
    expect(classifyProxiedBrowserUrl('https://example.com/', proxyOrigin, targets)).toEqual({ kind: 'other' });
    expect(classifyProxiedBrowserUrl('http://localhost:4000/review', proxyOrigin, targets)).toEqual({ kind: 'other' });
    expect(classifyProxiedBrowserUrl('not a url', proxyOrigin, targets)).toEqual({ kind: 'other' });
  });
});
