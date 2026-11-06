import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { clearRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';

import { serverBrowserTabKey, type ServerBrowserStatus } from './protocol';

const readError = async (response: Response, fallback: string): Promise<Error> => {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return new Error(typeof body?.error === 'string' ? body.error : fallback);
};

export const fetchServerBrowserStatus = async (): Promise<ServerBrowserStatus> => {
  const response = await runtimeFetch('/api/server-browser/status');
  if (!response.ok) throw await readError(response, 'Could not check the server browser');
  return await response.json() as ServerBrowserStatus;
};

export const saveServerBrowserSettings = async (settings: { allowNoSandbox: boolean }): Promise<ServerBrowserStatus> => {
  const response = await runtimeFetch('/api/server-browser/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!response.ok) throw await readError(response, 'Could not save the server browser settings');
  return await response.json() as ServerBrowserStatus;
};

export type ServerBrowserDevServer = {
  url: string;
  port: number;
  title: string | null;
  /** Name of the process listening, such as `node`. */
  process: string | null;
  /** The process runs inside the project directory. */
  inProject: boolean;
};

/** Web servers listening on the PiChamber server, the project's own first. */
export const fetchServerBrowserDevServers = async (
  directory: string | undefined,
  signal?: AbortSignal,
): Promise<ServerBrowserDevServer[]> => {
  const response = await runtimeFetch('/api/server-browser/dev-servers', {
    query: directory ? { directory } : undefined,
    signal,
  });
  if (!response.ok) throw await readError(response, 'Could not find dev servers');
  const body = await response.json() as { servers?: ServerBrowserDevServer[] };
  return Array.isArray(body.servers) ? body.servers : [];
};

type FramePolicy = { framing: 'refused' | 'allowed' | 'unknown'; reason?: 'x-frame-options' | 'frame-ancestors' };

/**
 * Asks the server whether a public page refuses to be shown in an iframe on
 * this page's origin. `unknown` (or a failed check) is never a refusal.
 */
export const fetchFramePolicy = async (url: string, origin: string, signal?: AbortSignal): Promise<FramePolicy> => {
  const response = await runtimeFetch('/api/server-browser/frame-policy', { query: { url, origin }, signal });
  if (!response.ok) return { framing: 'unknown' };
  const body = await response.json().catch(() => null) as { framing?: unknown; reason?: unknown } | null;
  return body?.framing === 'refused' || body?.framing === 'allowed'
    ? { framing: body.framing, reason: body.reason === 'frame-ancestors' ? 'frame-ancestors' : 'x-frame-options' }
    : { framing: 'unknown' };
};

/** Signs out of every site: stops the server browser and deletes its profile. */
export const clearServerBrowserData = async (): Promise<void> => {
  const response = await runtimeFetch('/api/server-browser/clear-data', { method: 'POST' });
  if (!response.ok) throw await readError(response, 'Could not clear browsing data');
};

/** Closes the server's page for a PiChamber browser page. Best effort. */
export const closeServerBrowserTab = (directory: string, pageId: string): void => {
  const key = serverBrowserTabKey(directory, pageId);
  void runtimeFetch(`/api/server-browser/tabs/${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => {});
};

/** Sends a file to the server so a page's file input can use it. */
export const uploadServerBrowserFile = async (file: File): Promise<string> => {
  const query = new URLSearchParams({ name: file.name, type: file.type, lastModified: String(file.lastModified) });
  const response = await runtimeFetch(`/api/server-browser/uploads?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (!response.ok) throw await readError(response, `Could not upload ${file.name}`);
  const body = await response.json() as { id?: unknown };
  if (typeof body.id !== 'string') throw new Error(`Could not upload ${file.name}`);
  return body.id;
};

/** Saves a finished download from the server to this device. */
export const saveServerBrowserDownload = async (id: string, filename: string): Promise<void> => {
  const response = await runtimeFetch(`/api/server-browser/downloads/${encodeURIComponent(id)}`);
  if (!response.ok) throw await readError(response, `Could not download ${filename}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
};

/** `popup` claims a popup the server offered as this tab's page. */
export type ServerBrowserSocketOpener = (tab: string, url: string, popup: string | null) => Promise<{ socket: RelayTunnelWebSocket; urlAuthToken: string }>;

export const openServerBrowserSocket: ServerBrowserSocketOpener = async (tab, url, popup) => {
  const urlAuthToken = await refreshRuntimeUrlAuthToken();
  const socket = openRuntimeWebSocket(getRuntimeUrlResolver().websocket('/api/server-browser/ws', { tab, url, popup }, urlAuthToken));
  return { socket, urlAuthToken };
};

/** Drops a URL token an upgrade rejected, so the next attempt mints a fresh one. */
export const forgetServerBrowserSocketToken = (urlAuthToken: string): void => {
  clearRuntimeUrlAuthToken(urlAuthToken);
};
