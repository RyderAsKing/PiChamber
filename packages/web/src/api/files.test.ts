import { describe, expect, it, vi } from 'vitest';

import type { RuntimeUrlQuery, RuntimeUrlResolver } from '@pichamber/ui/lib/runtime-url';

const runtimeFetchMock = vi.fn();

vi.mock('@pichamber/ui/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

const toUrl = (path: string, query?: RuntimeUrlQuery): string => {
  const params = query instanceof URLSearchParams ? query : new URLSearchParams();
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
};

const urls: RuntimeUrlResolver = {
  api: toUrl,
  authenticatedAsset: toUrl,
  auth: toUrl,
  health: (query?: RuntimeUrlQuery) => toUrl('/health', query),
  rawFile: (path: string) => toUrl('/api/fs/raw', new URLSearchParams({ path })),
  sse: toUrl,
  websocket: toUrl,
};

describe('createWebFilesAPI', () => {
  it('preserves the directory permission failure contract', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    runtimeFetchMock.mockResolvedValueOnce(Response.json(
      { error: 'Access to directory denied', reason: 'os-permission' },
      { status: 403 },
    ));

    const error = await api.listDirectory('/protected').catch((caught) => caught);

    expect(error).toMatchObject({
      name: 'FilesystemError',
      reason: 'os-permission',
      status: 403,
      message: 'Access to directory denied',
    });
  });

  it('rejects malformed successful directory listings', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ path: '/workspace' }));

    await expect(api.listDirectory('/workspace')).rejects.toMatchObject({
      reason: 'invalid-response',
    });
  });

  it('uses per-call workspace directory for stat and read requests', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/stale-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ path: '/worktree-b/file.txt', isFile: true, size: 12 }));
    await api.statFile?.('/worktree-b/file.txt', { directory: '/worktree-a' });

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/stat', {
      query: new URLSearchParams({ path: '/worktree-b/file.txt' }),
      headers: { 'x-pichamber-directory': '/worktree-a' },
    });

    runtimeFetchMock.mockResolvedValueOnce(new Response('content'));
    await api.readFile?.('/worktree-b/file.txt', { directory: '/worktree-a' });

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/read', {
      query: new URLSearchParams({ path: '/worktree-b/file.txt' }),
      cache: 'default',
      headers: { 'x-pichamber-directory': '/worktree-a' },
    });
  });

  it('forwards guarded write options and knownRevision on stat', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ path: '/workspace/a.txt', isFile: true, size: 2 }));
    await api.statFile?.('/workspace/a.txt', { knownRevision: 'v1:2:10:abc' });
    const statCall = runtimeFetchMock.mock.calls.at(-1);
    expect(statCall?.[0]).toBe('/api/fs/stat');
    expect((statCall?.[1] as { query: URLSearchParams }).query.get('knownRevision')).toBe('v1:2:10:abc');

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ path: '/workspace/a.txt', isFile: true, size: 2 }));
    await api.statFile?.('/workspace/a.txt', {});
    const statCallNoRevision = runtimeFetchMock.mock.calls.at(-1);
    expect((statCallNoRevision?.[1] as { query: URLSearchParams }).query.has('knownRevision')).toBe(false);

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ success: true, path: '/workspace/a.txt', revision: 'v1:2:11:def' }));
    await api.writeFile?.('/workspace/a.txt', 'next', { expectedRevision: 'v1:2:10:abc' });
    const writeCall = runtimeFetchMock.mock.calls.at(-1);
    expect(JSON.parse((writeCall?.[1] as { body: string }).body)).toEqual({
      path: '/workspace/a.txt',
      content: 'next',
      expectedRevision: 'v1:2:10:abc',
    });
  });

  it('sends the workspace directory header for downloads', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/current-workspace' });

    runtimeFetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(api.downloadFile?.('/current-workspace/file.txt')).rejects.toThrow('Download failed');

    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/raw', {
      query: { path: '/current-workspace/file.txt', download: true },
      headers: { 'x-pichamber-directory': '/current-workspace' },
    });
  });

  it('retains the opaque read revision exact', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    const revision = 'v1:5:1000:abc123';
    runtimeFetchMock.mockResolvedValueOnce(new Response('hello', {
      headers: { 'x-pichamber-file-revision': revision },
    }));
    const result = await api.readFile?.('/workspace/a.txt');
    expect(result?.content).toBe('hello');
    expect(result?.revision).toBe(revision);
    expect(result?.exists).toBe(true);
  });

  it('maps missing optional reads to a null revision', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    runtimeFetchMock.mockResolvedValueOnce(new Response('', {
      headers: { 'x-pichamber-file-exists': 'false' },
    }));
    const result = await api.readFile?.('/workspace/missing.txt', { optional: true });
    expect(result?.content).toBe('');
    expect(result?.revision).toBeNull();
    expect(result?.exists).toBe(false);
  });

  it('sends expectedRevision and maps typed revision conflicts', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    runtimeFetchMock.mockResolvedValueOnce(Response.json(
      { error: 'File has changed on disk', reason: 'file-revision-conflict', currentRevision: 'v1:8:2000:def', exists: true, path: '/workspace/a.txt' },
      { status: 409 },
    ));
    const error = await api.writeFile?.('/workspace/a.txt', 'stale', { expectedRevision: 'v1:5:1000:abc' }).catch((caught) => caught);
    expect(error).toMatchObject({
      name: 'FileRevisionConflictError',
      reason: 'file-revision-conflict',
      status: 409,
      currentRevision: 'v1:8:2000:def',
      exists: true,
    });
    expect(runtimeFetchMock).toHaveBeenLastCalledWith('/api/fs/write', expect.objectContaining({
      method: 'POST',
    }));
    const lastBody = JSON.parse((runtimeFetchMock.mock.lastCall?.[1] as { body?: string }).body ?? '{}');
    expect(lastBody).toMatchObject({ path: '/workspace/a.txt', content: 'stale', expectedRevision: 'v1:5:1000:abc' });
  });

  it('sends create-only and explicit overwrite markers', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ success: true, path: '/workspace/new.txt', revision: 'v1:0:1000:hash' }));
    await api.writeFile?.('/workspace/new.txt', '', { expectedRevision: null });
    expect(JSON.parse((runtimeFetchMock.mock.lastCall?.[1] as { body?: string }).body ?? '{}')).toMatchObject({
      expectedRevision: null,
    });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ success: true, path: '/workspace/a.txt', revision: 'v1:6:3000:hash2' }));
    const forced = await api.writeFile?.('/workspace/a.txt', 'forced', { expectedRevision: 'v1:5:1000:abc', overwrite: true });
    expect(forced?.revision).toBe('v1:6:3000:hash2');
    expect(JSON.parse((runtimeFetchMock.mock.lastCall?.[1] as { body?: string }).body ?? '{}')).toMatchObject({
      overwrite: true,
    });
  });

  it('returns stat revisions for guarded saves', async () => {
    const { createWebFilesAPI } = await import('./files');
    const api = createWebFilesAPI({ urls, getDirectory: () => '/workspace' });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ path: '/workspace/a.txt', isFile: true, size: 5, mtimeMs: 1000, revision: 'v1:5:1000:abc', exists: true }));
    const stat = await api.statFile?.('/workspace/a.txt');
    expect(stat?.revision).toBe('v1:5:1000:abc');
    expect(stat?.exists).toBe(true);
  });
});
