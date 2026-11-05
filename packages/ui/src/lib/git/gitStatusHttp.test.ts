import { beforeEach, describe, expect, test } from 'bun:test';

import {
  GIT_REPO_CHECK_NEGATIVE_TTL_MS,
  GIT_REPO_CHECK_POSITIVE_TTL_MS,
  GIT_WORKTREES_CACHE_TTL_MS,
  getDirectoryCacheKey,
  gitRepoCache,
  gitRepoInFlight,
  gitWorktreesCache,
  gitWorktreesInFlight,
  invalidateGitRepoCheckCache,
  invalidateGitWorktreesCache,
  resetGitHttpCachesForRuntimeSwitch,
} from './gitHttpHelpers';
import {
  checkIsGitRepository,
  createGitWorktree,
  deleteGitWorktree,
  getGitDiff,
  listGitWorktrees,
} from './gitStatusHttp';
import { getRuntimeKey } from '../runtime-switch';

const previousFetch = globalThis.fetch;
const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const installWindowMock = () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { origin: 'http://localhost:3000' },
    },
  });
};

const installFetchMock = (handler: (url: string, init?: RequestInit) => Response) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
};

const restoreMocks = () => {
  globalThis.fetch = previousFetch;
  if (previousWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
  } else {
    delete (globalThis as { window?: Window }).window;
  }
};

const backdateExpiry = (cache: Map<string, { expiresAt: number }>, directory: string): void => {
  const entry = cache.get(getDirectoryCacheKey(getRuntimeKey(), directory));
  expect(entry).toBeDefined();
  entry!.expiresAt = Date.now() - 1;
};

beforeEach(() => {
  resetGitHttpCachesForRuntimeSwitch();
  installWindowMock();
});

const afterEachRestore = () => restoreMocks();

describe('getGitDiff source', () => {
  const requestedQuery = async (options: Parameters<typeof getGitDiff>[1]) => {
    const calls = installFetchMock(() => jsonResponse({ diff: '' }));
    try {
      await getGitDiff('/repo', options);
      return new URL(calls[0].url, 'http://localhost').searchParams;
    } finally {
      afterEachRestore();
    }
  };

  test('requests the HEAD to working tree diff', async () => {
    const query = await requestedQuery({ path: 'file.txt', source: 'head' });
    expect(query.get('source')).toBe('head');
    expect(query.get('staged')).toBeNull();
  });

  test('sends staged=true for the staged source so older servers keep working', async () => {
    const query = await requestedQuery({ path: 'file.txt', source: 'staged' });
    expect(query.get('source')).toBe('staged');
    expect(query.get('staged')).toBe('true');
  });

  test('keeps the legacy staged flag', async () => {
    const query = await requestedQuery({ path: 'file.txt', staged: true });
    expect(query.get('source')).toBe('staged');
    expect(query.get('staged')).toBe('true');
  });

  test('defaults to the unstaged diff', async () => {
    const query = await requestedQuery({ path: 'file.txt' });
    expect(query.get('source')).toBe('unstaged');
    expect(query.get('staged')).toBeNull();
  });
});

describe('checkIsGitRepository cache', () => {
  test('positive results are served from cache', async () => {
    const calls = installFetchMock(() => jsonResponse({ isGitRepository: true }));
    try {
      expect(await checkIsGitRepository('/repo-pos')).toBe(true);
      expect(await checkIsGitRepository('/repo-pos')).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/api/git/check');
    } finally {
      afterEachRestore();
    }
  });

  test('negative results are served from cache', async () => {
    const calls = installFetchMock(() => jsonResponse({ isGitRepository: false }));
    try {
      expect(await checkIsGitRepository('/plain-neg')).toBe(false);
      expect(await checkIsGitRepository('/plain-neg')).toBe(false);
      expect(calls).toHaveLength(1);
    } finally {
      afterEachRestore();
    }
  });

  test('positive entries outlive the negative TTL', async () => {
    const calls = installFetchMock(() => jsonResponse({ isGitRepository: true }));
    try {
      expect(GIT_REPO_CHECK_POSITIVE_TTL_MS).toBeGreaterThan(GIT_REPO_CHECK_NEGATIVE_TTL_MS);
      expect(await checkIsGitRepository('/repo-long')).toBe(true);
      // Age the entry past the negative TTL but inside the positive TTL.
      const entry = gitRepoCache.get(getDirectoryCacheKey(getRuntimeKey(), '/repo-long'));
      expect(entry).toBeDefined();
      entry!.expiresAt = Date.now() + GIT_REPO_CHECK_NEGATIVE_TTL_MS + 60_000;
      expect(await checkIsGitRepository('/repo-long')).toBe(true);
      expect(calls).toHaveLength(1);
    } finally {
      afterEachRestore();
    }
  });

  test('expired entries refetch', async () => {
    const calls = installFetchMock(() => jsonResponse({ isGitRepository: false }));
    try {
      expect(await checkIsGitRepository('/plain-exp')).toBe(false);
      backdateExpiry(gitRepoCache, '/plain-exp');
      expect(await checkIsGitRepository('/plain-exp')).toBe(false);
      expect(calls).toHaveLength(2);
    } finally {
      afterEachRestore();
    }
  });

  test('concurrent checks share one request', async () => {
    const calls = installFetchMock(() => jsonResponse({ isGitRepository: true }));
    try {
      const [first, second] = await Promise.all([
        checkIsGitRepository('/repo-flight'),
        checkIsGitRepository('/repo-flight'),
      ]);
      expect(first).toBe(true);
      expect(second).toBe(true);
      expect(calls).toHaveLength(1);
      expect(gitRepoInFlight.size).toBe(0);
    } finally {
      afterEachRestore();
    }
  });

  test('failures throw and are never cached as not-a-repo', async () => {
    const calls = installFetchMock(() => jsonResponse({ error: 'boom' }, 500));
    try {
      await expect(checkIsGitRepository('/repo-fail')).rejects.toThrow();
      await expect(checkIsGitRepository('/repo-fail')).rejects.toThrow();
      expect(calls).toHaveLength(2);
      expect(gitRepoCache.has(getDirectoryCacheKey(getRuntimeKey(), '/repo-fail'))).toBe(false);
    } finally {
      afterEachRestore();
    }
  });

  test('explicit invalidation forces a recheck', async () => {
    let isRepo = true;
    const calls = installFetchMock(() => jsonResponse({ isGitRepository: isRepo }));
    try {
      expect(await checkIsGitRepository('/repo-inv')).toBe(true);
      isRepo = false;
      // Still cached until invalidated.
      expect(await checkIsGitRepository('/repo-inv')).toBe(true);
      invalidateGitRepoCheckCache('/repo-inv');
      expect(await checkIsGitRepository('/repo-inv')).toBe(false);
      expect(calls).toHaveLength(2);
    } finally {
      afterEachRestore();
    }
  });
});

describe('listGitWorktrees cache', () => {
  test('lists are served from cache inside the TTL', async () => {
    const worktrees = [{ path: '/repo', branch: 'main' }];
    const calls = installFetchMock(() => jsonResponse({ worktrees }));
    try {
      expect(await listGitWorktrees('/repo-wt')).toEqual(worktrees);
      expect(await listGitWorktrees('/repo-wt')).toEqual(worktrees);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('/api/git/worktrees');
      expect(GIT_WORKTREES_CACHE_TTL_MS).toBe(10_000);
    } finally {
      afterEachRestore();
    }
  });

  test('expired entries refetch', async () => {
    const calls = installFetchMock(() => jsonResponse({ worktrees: [] }));
    try {
      expect(await listGitWorktrees('/repo-wt-exp')).toEqual([]);
      backdateExpiry(gitWorktreesCache, '/repo-wt-exp');
      expect(await listGitWorktrees('/repo-wt-exp')).toEqual([]);
      expect(calls).toHaveLength(2);
    } finally {
      afterEachRestore();
    }
  });

  test('concurrent lists share one request', async () => {
    const calls = installFetchMock(() => jsonResponse({ worktrees: [] }));
    try {
      const [first, second] = await Promise.all([
        listGitWorktrees('/repo-wt-flight'),
        listGitWorktrees('/repo-wt-flight'),
      ]);
      expect(first).toEqual([]);
      expect(second).toEqual([]);
      expect(calls).toHaveLength(1);
      expect(gitWorktreesInFlight.size).toBe(0);
    } finally {
      afterEachRestore();
    }
  });

  test('failures throw and are never cached as empty', async () => {
    const calls = installFetchMock(() => jsonResponse({ error: 'offline' }, 500));
    try {
      await expect(listGitWorktrees('/repo-wt-fail')).rejects.toThrow();
      await expect(listGitWorktrees('/repo-wt-fail')).rejects.toThrow();
      expect(calls).toHaveLength(2);
      expect(gitWorktreesCache.has(getDirectoryCacheKey(getRuntimeKey(), '/repo-wt-fail'))).toBe(false);
    } finally {
      afterEachRestore();
    }
  });

  test('malformed payloads throw and are never cached', async () => {
    const calls = installFetchMock(() => jsonResponse({}));
    try {
      await expect(listGitWorktrees('/repo-wt-bad')).rejects.toThrow('invalid');
      expect(calls).toHaveLength(1);
      expect(gitWorktreesCache.has(getDirectoryCacheKey(getRuntimeKey(), '/repo-wt-bad'))).toBe(false);
    } finally {
      afterEachRestore();
    }
  });

  test('explicit invalidation forces a re-list', async () => {
    const calls = installFetchMock(() => jsonResponse({ worktrees: [] }));
    try {
      expect(await listGitWorktrees('/repo-wt-inv')).toEqual([]);
      invalidateGitWorktreesCache('/repo-wt-inv');
      expect(await listGitWorktrees('/repo-wt-inv')).toEqual([]);
      expect(calls).toHaveLength(2);
    } finally {
      afterEachRestore();
    }
  });

  test('create invalidates the cached topology', async () => {
    const calls = installFetchMock((url, init) => {
      if (init?.method === 'POST') {
        return jsonResponse({ path: '/work/new', branch: 'pichamber/new' }, 201);
      }
      return jsonResponse({ worktrees: [] });
    });
    try {
      expect(await listGitWorktrees('/repo-wt-create')).toEqual([]);
      await createGitWorktree('/repo-wt-create', { mode: 'new', startRef: 'main' });
      expect(await listGitWorktrees('/repo-wt-create')).toEqual([]);
      const listCalls = calls.filter((call) => call.url.includes('/api/git/worktrees') && call.init?.method !== 'POST' && call.init?.method !== 'DELETE');
      expect(listCalls).toHaveLength(2);
    } finally {
      afterEachRestore();
    }
  });

  test('delete invalidates both the project and the removed path', async () => {
    const calls = installFetchMock((url, init) =>
      init?.method === 'DELETE' ? jsonResponse({ success: true }) : jsonResponse({ worktrees: [] }),
    );
    try {
      expect(await listGitWorktrees('/repo-wt-del')).toEqual([]);
      expect(await listGitWorktrees('/work/old')).toEqual([]);
      await deleteGitWorktree('/repo-wt-del', { directory: '/work/old', force: true });
      expect(await listGitWorktrees('/repo-wt-del')).toEqual([]);
      expect(await listGitWorktrees('/work/old')).toEqual([]);
      expect(calls.filter((call) => !call.init?.method || call.init.method === 'GET')).toHaveLength(4);
    } finally {
      afterEachRestore();
    }
  });

  test('runtime-switch reset drops every git HTTP cache', async () => {
    const calls = installFetchMock((url) => {
      if (url.includes('/api/git/check')) return jsonResponse({ isGitRepository: true });
      return jsonResponse({ worktrees: [] });
    });
    try {
      expect(await checkIsGitRepository('/repo-reset')).toBe(true);
      expect(await listGitWorktrees('/repo-reset')).toEqual([]);
      expect(calls).toHaveLength(2);
      resetGitHttpCachesForRuntimeSwitch();
      expect(gitRepoCache.size).toBe(0);
      expect(gitWorktreesCache.size).toBe(0);
      expect(await checkIsGitRepository('/repo-reset')).toBe(true);
      expect(await listGitWorktrees('/repo-reset')).toEqual([]);
      expect(calls).toHaveLength(4);
    } finally {
      afterEachRestore();
    }
  });
});

describe('in-flight reads racing a mutation', () => {
  const deferredFetch = () => {
    const pending: Array<{ url: string; resolve: (response: Response) => void }> = [];
    globalThis.fetch = ((input: RequestInfo | URL) =>
      new Promise<Response>((resolve) => {
        pending.push({ url: String(input), resolve });
      })) as typeof fetch;
    return pending;
  };
  // `runtimeFetch` resolves its URL asynchronously before calling fetch.
  const waitForRequests = async (pending: unknown[], count: number) => {
    for (let attempt = 0; attempt < 50 && pending.length < count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(pending).toHaveLength(count);
  };

  test('a listing that started before create does not cache the pre-create topology', async () => {
    const pending = deferredFetch();
    try {
      const staleListing = listGitWorktrees('/repo-wt-race');
      await waitForRequests(pending, 1);
      invalidateGitWorktreesCache('/repo-wt-race');
      pending[0]!.resolve(jsonResponse({ worktrees: [] }));
      // The stale caller still receives its own answer.
      expect(await staleListing).toEqual([]);
      expect(gitWorktreesCache.has(getDirectoryCacheKey(getRuntimeKey(), '/repo-wt-race'))).toBe(false);

      const fresh = listGitWorktrees('/repo-wt-race');
      await waitForRequests(pending, 2);
      const created = [{ path: '/work/new', branch: 'feature' }];
      pending[1]!.resolve(jsonResponse({ worktrees: created }));
      expect(await fresh).toEqual(created);
    } finally {
      afterEachRestore();
    }
  });

  test('a repository check that started before invalidation is not cached', async () => {
    const pending = deferredFetch();
    try {
      const staleCheck = checkIsGitRepository('/repo-check-race');
      await waitForRequests(pending, 1);
      invalidateGitRepoCheckCache('/repo-check-race');
      pending[0]!.resolve(jsonResponse({ isGitRepository: false }));
      expect(await staleCheck).toBe(false);
      expect(gitRepoCache.has(getDirectoryCacheKey(getRuntimeKey(), '/repo-check-race'))).toBe(false);
    } finally {
      afterEachRestore();
    }
  });
});
