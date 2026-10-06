import { runtimeFetch } from './runtime-fetch';
import { getRuntimeKey } from './runtime-switch';
import { getRuntimeUrlResolver } from './runtime-url';
import i18n from '@/i18n';

export interface FilesystemEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink?: boolean;
}

export interface ProjectFileSearchHit {
  name: string;
  path: string;
  relativePath: string;
  extension?: string;
}

export async function getFilesystemHome(options?: { fresh?: boolean }): Promise<string | null> {
  return (await getFilesystemHomeState(options)).home;
}

/**
 * Server-reported home plus the PiChamber data directory in one request.
 *
 * Boot issues several sequential home reads (the directory store plus the
 * project config readers). They share one runtime-scoped result so cold
 * start performs a single `GET /api/fs/home` per runtime:
 *
 * - Concurrent callers share the in-flight promise.
 * - Settled successes memoize by `getRuntimeKey()`; home does not change
 *   during a runtime's lifetime, so no TTL is needed beyond runtime scope.
 * - Failure or a null/empty home never populates the memo, so the next
 *   caller retries against the network instead of caching the outage.
 * - `resetFilesystemHomeCache()` (wired through the central runtime-endpoint
 *   reset) clears both entries on a runtime switch.
 * - `{ fresh: true }` bypasses both entries and always hits the network.
 *   The directory explorer's explicit fresh resolver uses it.
 */
export interface FilesystemHomeState {
  home: string | null;
  pichamberDataDir: string | null;
}

let cachedFilesystemHome: { key: string; state: FilesystemHomeState } | null = null;
let inflightFilesystemHome: { key: string; promise: Promise<FilesystemHomeState> } | null = null;

export const resetFilesystemHomeCache = (): void => {
  cachedFilesystemHome = null;
  inflightFilesystemHome = null;
};

const fetchFilesystemHomeState = async (): Promise<FilesystemHomeState> => {
  let home: string | null = null;
  let pichamberDataDir: string | null = null;
  try {
    const response = await runtimeFetch('/api/fs/home', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      // Avoid conditional requests (304 + empty body).
      cache: 'no-store',
    });
    if (response.ok) {
      const data = (await response.json().catch(() => null)) as {
        home?: unknown;
        pichamberDataDir?: unknown;
      } | null;
      if (typeof data?.home === 'string' && data.home.trim().length > 0) {
        home = data.home.trim();
      }
      if (typeof data?.pichamberDataDir === 'string' && data.pichamberDataDir.trim().length > 0) {
        pichamberDataDir = data.pichamberDataDir.trim();
      }
    }
  } catch {
    // Return nulls on error
  }
  return { home, pichamberDataDir };
};

export const getFilesystemHomeState = async (options?: {
  fresh?: boolean;
}): Promise<FilesystemHomeState> => {
  const key = getRuntimeKey();
  if (!options?.fresh) {
    const cached = cachedFilesystemHome;
    if (cached && cached.key === key) return cached.state;
    const inflight = inflightFilesystemHome;
    if (inflight && inflight.key === key) return inflight.promise;
  }
  const promise = (async (): Promise<FilesystemHomeState> => {
    const state = await fetchFilesystemHomeState();
    // Explicit fresh reads observe the server without replacing the shared
    // snapshot, so an explorer refresh cannot skew boot consumers.
    if (!options?.fresh && state.home && getRuntimeKey() === key) {
      cachedFilesystemHome = { key, state };
    }
    return state;
  })();
  if (!options?.fresh) inflightFilesystemHome = { key, promise };
  try {
    return await promise;
  } finally {
    if (inflightFilesystemHome?.promise === promise) inflightFilesystemHome = null;
  }
};

export async function listLocalDirectory(
  directoryPath: string | null | undefined,
  options?: { respectGitignore?: boolean }
): Promise<FilesystemEntry[]> {
  if (!directoryPath || directoryPath.trim().length === 0) return [];
  const query: Record<string, string | boolean> = { path: directoryPath };
  if (options?.respectGitignore) {
    query.respectGitignore = true;
  }
  const url = getRuntimeUrlResolver().api('/api/fs/list', query);
  const response = await runtimeFetch(url);
  if (!response.ok) {
    return [];
  }
  const data = (await response.json()) as { entries?: FilesystemEntry[] };
  return Array.isArray(data.entries) ? data.entries : [];
}

export async function searchFiles(
  query: string,
  options?: {
    directory?: string | null;
    limit?: number;
    includeHidden?: boolean;
    respectGitignore?: boolean;
    type?: 'file' | 'directory';
  }
): Promise<ProjectFileSearchHit[]> {
  const directory = options?.directory || '';
  if (!directory) return [];
  const params: Record<string, string | number | boolean> = {
    directory,
    query,
  };
  if (options?.limit) params.limit = options.limit;
  if (options?.includeHidden) params.includeHidden = true;
  if (options?.respectGitignore !== undefined) params.respectGitignore = options.respectGitignore;
  if (options?.type) params.type = options.type;

  const url = getRuntimeUrlResolver().api('/api/fs/find', params);
  const response = await runtimeFetch(url);
  if (!response.ok) return [];
  const data = (await response.json()) as { files?: ProjectFileSearchHit[] };
  return Array.isArray(data.files) ? data.files : [];
}

export type DirectoryPickResult =
  | { status: 'picked'; path: string }
  | { status: 'cancelled' }
  | { status: 'unavailable'; error: string }
  | { status: 'failed'; error: string };

export async function pickLocalDirectory(defaultPath = ''): Promise<DirectoryPickResult> {
  try {
    const response = await runtimeFetch('/api/fs/pick-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ path: defaultPath || undefined }),
    });
    const data = (await response.json().catch(() => null)) as {
      path?: unknown;
      cancelled?: unknown;
      error?: unknown;
    } | null;
    if (data?.cancelled === true) {
      return { status: 'cancelled' };
    }
    if (response.status === 501) {
      return {
        status: 'unavailable',
        error: typeof data?.error === 'string' ? data.error : i18n.t('Folder picker is not available.'),
      };
    }
    if (!response.ok) {
      return {
        status: 'failed',
        error: typeof data?.error === 'string' ? data.error : i18n.t('Failed to select directory.'),
      };
    }
    if (typeof data?.path === 'string' && data.path.trim()) {
      return { status: 'picked', path: data.path.trim() };
    }
    return { status: 'failed', error: i18n.t('Failed to select directory.') };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : i18n.t('Failed to select directory.'),
    };
  }
}
