import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * Tailscale remote-access client surface (no components — a later task builds
 * the settings UI). Shared by web, desktop, hosted-mobile and Capacitor
 * runtimes: every call goes through `runtimeFetch` so relay/tunnel transports
 * keep working, and no runtime URL is cached across endpoint switches.
 */

export type TailscaleMode = 'private' | 'public';
export type TailscaleHttpsPort = 443 | 8443 | 10000;
export type TailscaleState =
  | 'off'
  | 'unavailable'
  | 'blocked'
  | 'starting'
  | 'needs-approval'
  | 'active'
  | 'conflict'
  | 'error';

export interface TailscaleConfig {
  enabled: boolean;
  mode: TailscaleMode;
  httpsPort: TailscaleHttpsPort;
}

export interface TailscaleAuthGate {
  privateAllowed: boolean;
  publicAllowed: boolean;
}

export interface TailscaleStatus {
  installed: boolean;
  running: boolean;
  loggedIn: boolean;
  magicDnsName: string | null;
  httpsCertsAvailable: boolean | null;
  config: TailscaleConfig;
  state: TailscaleState;
  /** Set only once a probe of the URL answers as THIS server (no credentials sent). */
  url: string | null;
  approvalUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Per-mode auth-gate result: private may allow the LAN escape hatch, public never does. */
  authGate?: TailscaleAuthGate | null;
}

const isTailscaleStatus = (value: unknown): value is TailscaleStatus =>
  Boolean(value) && typeof value === 'object' && typeof (value as { state?: unknown }).state === 'string';

const throwForStatus = async (response: Response, fallback: string): Promise<never> => {
  const body = (await response.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
  const message = typeof body?.error === 'string' && body.error ? body.error : fallback;
  const error = new Error(message) as Error & { code?: string; status?: number };
  if (typeof body?.code === 'string') error.code = body.code;
  error.status = response.status;
  throw error;
};

export const getTailscaleStatus = async (options?: { signal?: AbortSignal }): Promise<TailscaleStatus> => {
  const response = await runtimeFetch('/api/pichamber/tailscale/status', {
    headers: { Accept: 'application/json' },
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) await throwForStatus(response, 'Failed to get Tailscale status');
  const body = (await response.json().catch(() => null)) as unknown;
  if (!isTailscaleStatus(body)) throw new Error('Invalid Tailscale status response');
  return body;
};

export const updateTailscaleConfig = async (patch: Partial<TailscaleConfig>): Promise<TailscaleStatus> => {
  const response = await runtimeFetch('/api/pichamber/tailscale/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) await throwForStatus(response, 'Failed to update Tailscale config');
  const body = (await response.json().catch(() => null)) as unknown;
  if (!isTailscaleStatus(body)) throw new Error('Invalid Tailscale status response');
  return body;
};

export const retryTailscale = async (): Promise<TailscaleStatus> => {
  const response = await runtimeFetch('/api/pichamber/tailscale/retry', {
    method: 'POST',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) await throwForStatus(response, 'Tailscale retry failed');
  const body = (await response.json().catch(() => null)) as unknown;
  if (!isTailscaleStatus(body)) throw new Error('Invalid Tailscale status response');
  return body;
};
