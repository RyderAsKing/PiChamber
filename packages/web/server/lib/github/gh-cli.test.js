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
});
