import { describe, expect, it } from 'vitest';

import { createGhCli } from './gh-cli.js';

const { parseJsonAuthStatus } = createGhCli()._internals;

describe('parseJsonAuthStatus', () => {
  it('reads the current gh shape, where each host maps to a list of accounts', () => {
    // `gh auth status --json hosts` on gh 2.103.
    const hosts = parseJsonAuthStatus(JSON.stringify({
      hosts: {
        'github.com': [
          {
            state: 'success',
            active: true,
            host: 'github.com',
            login: 'octocat',
            tokenSource: 'keyring',
            scopes: 'gist, read:org, repo, workflow',
            gitProtocol: 'https',
          },
        ],
      },
    }));

    expect(hosts).toEqual([
      {
        host: 'github.com',
        authenticated: true,
        login: 'octocat',
        scopes: ['gist', 'read:org', 'repo', 'workflow'],
      },
    ]);
  });

  it('keeps only the active account when a host has several', () => {
    const hosts = parseJsonAuthStatus(JSON.stringify({
      hosts: {
        'github.com': [
          { state: 'success', active: false, host: 'github.com', login: 'work-account', scopes: 'repo' },
          { state: 'success', active: true, host: 'github.com', login: 'octocat', scopes: 'gist, repo' },
        ],
      },
    }));

    expect(hosts).toEqual([
      { host: 'github.com', authenticated: true, login: 'octocat', scopes: ['gist', 'repo'] },
    ]);
  });

  it('reads a flat per-host object', () => {
    const hosts = parseJsonAuthStatus(JSON.stringify({
      hosts: { 'github.com': { user: 'octocat', tokenScopes: ['repo'] } },
    }));

    expect(hosts).toEqual([
      { host: 'github.com', authenticated: true, login: 'octocat', scopes: ['repo'] },
    ]);
  });

  it('reads a top-level array of hosts', () => {
    const hosts = parseJsonAuthStatus(JSON.stringify({
      hosts: [{ hostname: 'github.com', user: 'octocat' }],
    }));

    expect(hosts).toEqual([
      { host: 'github.com', authenticated: true, login: 'octocat', scopes: [] },
    ]);
  });

  it('reports a logged-out host as unauthenticated', () => {
    const hosts = parseJsonAuthStatus(JSON.stringify({ hosts: { 'github.com': [] } }));

    expect(hosts).toEqual([]);
  });

  it('does not report a rejected token as authenticated', () => {
    // gh 2.103.3 for an invalid token: it still exits successfully in JSON
    // mode and still sets `active: true`, so only `state` is trustworthy.
    const hosts = parseJsonAuthStatus(JSON.stringify({
      hosts: {
        'github.com': [
          {
            state: 'error',
            error: 'non-200 OK status code: 401 Unauthorized',
            active: true,
            host: 'github.com',
            login: '',
            tokenSource: 'GH_TOKEN',
            gitProtocol: 'https',
          },
          {
            state: 'success',
            active: false,
            host: 'github.com',
            login: 'octocat',
            tokenSource: 'keyring',
            scopes: 'repo',
            gitProtocol: 'https',
          },
        ],
      },
    }));

    // The host reports its active account only. The valid inactive one is not
    // what `gh auth token` hands out, so it must not make the host read as
    // signed in.
    expect(hosts).toEqual([
      { host: 'github.com', authenticated: false, login: null, scopes: [] },
    ]);
  });

  it('trusts state over a login when the token was rejected', () => {
    const hosts = parseJsonAuthStatus(JSON.stringify({
      hosts: { 'github.com': { state: 'error', active: true, login: 'octocat' } },
    }));

    expect(hosts).toEqual([
      { host: 'github.com', authenticated: false, login: 'octocat', scopes: [] },
    ]);
  });
});
