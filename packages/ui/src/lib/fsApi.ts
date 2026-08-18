import { runtimeFetch } from './runtime-fetch';
import { getRuntimeUrlResolver } from './runtime-url';

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

export async function getFilesystemHome(): Promise<string | null> {
  try {
    const response = await runtimeFetch('/api/fs/home', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (response.ok) {
      const data = (await response.json()) as { home?: unknown };
      if (typeof data.home === 'string' && data.home.trim().length > 0) {
        return data.home.trim();
      }
    }
  } catch {
    // Return null on error
  }
  return null;
}

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
        error: typeof data?.error === 'string' ? data.error : 'Folder picker is not available.',
      };
    }
    if (!response.ok) {
      return {
        status: 'failed',
        error: typeof data?.error === 'string' ? data.error : 'Failed to select directory.',
      };
    }
    if (typeof data?.path === 'string' && data.path.trim()) {
      return { status: 'picked', path: data.path.trim() };
    }
    return { status: 'failed', error: 'Failed to select directory.' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Failed to select directory.',
    };
  }
}
