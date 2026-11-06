import { describe, expect, it } from 'vitest';

import { createFramePolicyChecker, createPublicLookup, frameVerdict, parseFrameAncestors } from './frame-policy.js';

const ORIGIN = 'http://192.168.0.5:5180';
const verdict = (headers, targetUrl = 'https://www.example.com/watch') => frameVerdict({ headers, targetUrl, ancestorOrigin: ORIGIN });

describe('frameVerdict', () => {
  it('reads X-Frame-Options', () => {
    expect(verdict({ 'x-frame-options': 'SAMEORIGIN' })).toEqual({ framing: 'refused', reason: 'x-frame-options' });
    expect(verdict({ 'x-frame-options': 'deny' })).toEqual({ framing: 'refused', reason: 'x-frame-options' });
    expect(verdict({ 'x-frame-options': 'sameorigin' }, `${ORIGIN}/page`).framing).toBe('allowed');
    expect(verdict({ 'x-frame-options': 'ALLOW-FROM https://a.example' }).framing).toBe('allowed');
    expect(verdict({ 'x-frame-options': 'deny, sameorigin' }).framing).toBe('refused');
    expect(verdict({}).framing).toBe('allowed');
  });

  it('lets frame-ancestors override X-Frame-Options', () => {
    expect(verdict({ 'x-frame-options': 'DENY', 'content-security-policy': 'frame-ancestors *' }).framing).toBe('allowed');
    expect(verdict({ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" })).toEqual({ framing: 'refused', reason: 'frame-ancestors' });
    expect(verdict({ 'content-security-policy': "frame-ancestors 'self' https://*.example.com" }).framing).toBe('refused');
  });

  it('matches host, scheme, and port sources against the embedding origin', () => {
    expect(verdict({ 'content-security-policy': 'frame-ancestors http://192.168.0.5:5180' }).framing).toBe('allowed');
    expect(verdict({ 'content-security-policy': 'frame-ancestors http://192.168.0.5:*' }).framing).toBe('allowed');
    expect(verdict({ 'content-security-policy': 'frame-ancestors http://192.168.0.5' }).framing).toBe('refused');
    // Without a scheme a source takes the protected page's (https), which an http origin does not match.
    expect(verdict({ 'content-security-policy': 'frame-ancestors 192.168.0.5:*' }).framing).toBe('refused');
    expect(verdict({ 'content-security-policy': 'frame-ancestors 192.168.0.5:5180' }, 'http://site.example/').framing).toBe('allowed');
    expect(verdict({ 'content-security-policy': 'frame-ancestors http:' }).framing).toBe('allowed');
    expect(verdict({ 'content-security-policy': 'frame-ancestors https:' }).framing).toBe('refused');
  });

  it('needs every policy with frame-ancestors to allow it', () => {
    expect(parseFrameAncestors("frame-ancestors *, script-src 'self', frame-ancestors 'none'")).toEqual([['*'], ["'none'"]]);
    expect(verdict({ 'content-security-policy': "frame-ancestors *, frame-ancestors 'none'" }).framing).toBe('refused');
  });
});

describe('createPublicLookup', () => {
  const lookupWith = (addresses) => createPublicLookup((_host, _options, callback) => callback(null, addresses));

  it('passes public addresses and refuses the server network', async () => {
    const run = (lookup, options) => new Promise((resolve) => lookup('site.example', options, (error, address) => resolve(error ? error.code : address)));
    expect(await run(lookupWith([{ address: '93.184.216.34', family: 4 }]), {})).toBe('93.184.216.34');
    expect(await run(lookupWith([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.2', family: 4 }]), {})).toBe('ESERVERNETWORK');
    expect(await run(lookupWith([{ address: '::1', family: 6 }]), { all: true })).toBe('ESERVERNETWORK');
  });
});

describe('createFramePolicyChecker', () => {
  it('follows redirects to the page that loads', async () => {
    const seen = [];
    const checker = createFramePolicyChecker({
      fetchHeaders: async (url) => {
        seen.push(url.toString());
        return url.hostname === 'youtube.com'
          ? { status: 301, headers: { location: 'https://www.youtube.com/' } }
          : { status: 200, headers: { 'x-frame-options': 'SAMEORIGIN' } };
      },
    });
    expect(await checker.check('https://youtube.com/', ORIGIN)).toEqual({ framing: 'refused', reason: 'x-frame-options' });
    expect(seen).toEqual(['https://youtube.com/', 'https://www.youtube.com/']);
  });

  it('never checks the server network and reports failures as unknown', async () => {
    let calls = 0;
    const checker = createFramePolicyChecker({
      fetchHeaders: async (url) => {
        calls += 1;
        if (url.hostname === 'down.example') throw new Error('ECONNREFUSED');
        return { status: 302, headers: { location: 'http://127.0.0.1:8080/' } };
      },
    });
    expect(await checker.check('http://localhost:5173/', ORIGIN)).toEqual({ framing: 'unknown' });
    expect(await checker.check('http://10.1.2.3/', ORIGIN)).toEqual({ framing: 'unknown' });
    expect(calls).toBe(0);
    expect(await checker.check('https://redirects.example/', ORIGIN)).toEqual({ framing: 'unknown' });
    expect(await checker.check('https://down.example/', ORIGIN)).toEqual({ framing: 'unknown' });
    expect(await checker.check('not a url', ORIGIN)).toEqual({ framing: 'unknown' });
  });

  it('caches answers for a minute', async () => {
    let calls = 0;
    let time = 0;
    const checker = createFramePolicyChecker({
      fetchHeaders: async () => { calls += 1; return { status: 200, headers: {} }; },
      now: () => time,
    });
    await checker.check('https://a.example/', ORIGIN);
    await checker.check('https://a.example/', ORIGIN);
    expect(calls).toBe(1);
    time = 61_000;
    await checker.check('https://a.example/', ORIGIN);
    expect(calls).toBe(2);
  });
});
