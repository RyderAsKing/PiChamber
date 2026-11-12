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

    expect(hosts).toEqual([
      { host: 'github.com', authenticated: false, login: null, scopes: [] },
      // A valid account that is merely not the active one is still signed in.
      { host: 'github.com', authenticated: true, login: 'octocat', scopes: ['repo'] },
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
