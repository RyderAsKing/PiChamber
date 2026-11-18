import { describe, expect, it } from 'vitest';

import { normalizeNetwork, SandboxLaunchError } from './launcher.js';

const allowHosts = (allowHosts) =>
  normalizeNetwork({ mode: 'proxy', allowHosts, allowLocalPorts: [] }).allowHosts;

const expectRefused = (host) => {
  let error;
  try {
    allowHosts([host]);
  } catch (cause) {
    error = cause;
  }
  expect(error).toBeInstanceOf(SandboxLaunchError);
  expect(error?.code).toBe('SANDBOX_INVALID_NETWORK');
};

describe('normalizeNetwork hosts', () => {
  it('accepts ordinary public host names and wildcards with two or more labels', () => {
    expect(allowHosts([
      'api.anthropic.com',
      'registry.npmjs.org',
      '*.githubusercontent.com',
      'index.rubygems.org',
      'npm.jsr.io',
      'repo.maven.apache.org',
      'proxy.golang.org',
    ])).toEqual([
      '*.githubusercontent.com',
      'api.anthropic.com',
      'index.rubygems.org',
      'npm.jsr.io',
      'proxy.golang.org',
      'registry.npmjs.org',
      'repo.maven.apache.org',
    ]);
  });

  it('accepts a 63-character label', () => {
    expect(allowHosts([`${'a'.repeat(63)}.com`])).toEqual([`${'a'.repeat(63)}.com`]);
  });

  it('lowercases, trims, de-duplicates and sorts hosts', () => {
    expect(allowHosts(['  GitHub.com ', 'github.com', 'api.github.com', 'GITHUB.COM'])).toEqual([
      'api.github.com',
      'github.com',
    ]);
  });

  it('refuses one-label names', () => {
    for (const host of ['localhost', 'com', 'myserver', 'LocalHost']) expectRefused(host);
  });

  it('refuses localhost and .local names', () => {
    for (const host of ['foo.localhost', '*.localhost', 'printer.local', 'myserver.local']) {
      expectRefused(host);
    }
  });

  it('refuses IPv4 literals and names ending in a number', () => {
    for (const host of ['127.0.0.1', '10.0.0.5', '1.2.3.4', 'example.123', '1.2.3.0x4', '0x7f.0.0.1']) expectRefused(host);
  });

  it('refuses wildcards wider than *.example.com', () => {
    expectRefused('*.com');
  });

  it('refuses malformed names', () => {
    for (const host of ['', 'https://x', 'a..b', '-bad.com', 'bad-.com', 'under_score.com', '*.']) {
      expectRefused(host);
    }
  });

  it('refuses a label above 63 characters or a name above 253 characters', () => {
    expectRefused(`${'a'.repeat(64)}.com`);
    expectRefused(Array(5).fill('a'.repeat(50)).join('.'));
  });

  it('keeps refusing non-proxy and malformed network values', () => {
    expect(normalizeNetwork({ mode: 'none' })).toEqual({ mode: 'none' });
    expect(() => normalizeNetwork({})).toThrowError(expect.objectContaining({ code: 'SANDBOX_INVALID_NETWORK' }));
    expect(() => normalizeNetwork({ mode: 'proxy', allowHosts: ['ok.example.com'], allowLocalPorts: [0] }))
      .toThrowError(expect.objectContaining({ code: 'SANDBOX_INVALID_NETWORK' }));
  });

  it('sorts and de-duplicates local ports', () => {
    expect(normalizeNetwork({ mode: 'proxy', allowHosts: [], allowLocalPorts: [11434, 8080, 8080] }))
      .toEqual({ mode: 'proxy', allowHosts: [], allowLocalPorts: [8080, 11434] });
  });
});
