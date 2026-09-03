import { normalizeHostUrl } from '@/lib/desktopHosts';
import { getDesktopLanAddress, isDesktopLocalOriginActive, isDesktopShell } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';

export const desktopPlatformName = (): string | undefined => {
  if (typeof navigator === 'undefined') return undefined;
  const ua = (navigator.userAgent || '').toLowerCase();
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('win')) return 'windows';
  if (ua.includes('linux')) return 'linux';
  return undefined;
};

export const devicePlatformLabel = (platform?: string | null): string | null => {
  switch ((platform || '').toLowerCase()) {
    case 'ios':
      return 'iOS';
    case 'android':
      return 'Android';
    case 'macos':
    case 'darwin':
      return 'macOS';
    case 'windows':
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return null;
  }
};

export type HeaderDraft = {
  id: string;
  name: string;
  value: string;
};

export const createHeaderDraft = (name = '', value = ''): HeaderDraft => ({
  id:
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `header-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  name,
  value,
});

export const isReservedRequestHeaderName = (name: string): boolean =>
  name.trim().toLowerCase() === 'authorization';

export const buildRequestHeaders = (
  headers: HeaderDraft[]
): Record<string, string> | undefined => {
  const next: Record<string, string> = {};
  for (const header of headers) {
    const name = header.name.trim();
    const value = header.value.trim();
    if (name && value && !isReservedRequestHeaderName(name)) next[name] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
};

export const readRequestHeaderDrafts = (
  headers: Record<string, string> | undefined
): HeaderDraft[] => {
  return Object.entries(headers || {}).map(([name, value]) =>
    createHeaderDraft(name, value)
  );
};

export const getRuntimePort = (): number | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const runtimeApiBaseUrl = getRuntimeApiBaseUrl();
  const portSource = runtimeApiBaseUrl || window.location.href;
  try {
    const port = Number(new URL(portSource).port || window.location.port);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    const port = Number(window.location.port);
    return Number.isFinite(port) && port > 0 ? port : null;
  }
};

export const isLoopbackUrl = (value: string): boolean => {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]'
    );
  } catch {
    return false;
  }
};

export const resolvePairingServerUrl = async (): Promise<string> => {
  const fallback =
    normalizeHostUrl(getRuntimeApiBaseUrl()) || window.location.origin;
  if (!isDesktopShell() || !isDesktopLocalOriginActive()) {
    return fallback;
  }

  let response: Response;
  try {
    response = await runtimeFetch('/api/pi/ui-settings', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return fallback;
  }
  if (!response.ok) return fallback;

  const settings = (await response.json().catch(() => null)) as null | {
    desktopLanAccessActive?: unknown;
  };
  if (settings?.desktopLanAccessActive !== true) {
    return fallback;
  }

  const address = await getDesktopLanAddress();
  const port = getRuntimePort();
  if (!address || !port) {
    return fallback;
  }

  return `http://${address}:${port}`;
};

export const navigateToUrl = (rawUrl: string): void => {
  const target = rawUrl.trim();
  if (!target) {
    return;
  }
  try {
    window.location.assign(target);
  } catch {
    window.location.href = target;
  }
};
