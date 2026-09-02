import { useInputStore } from '@/sync/input-store';

export type PreviewConsoleEvent = {
  id: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'resource' | 'runtime';
  message: string;
  details?: string;
  ts: number;
};

export type PreviewConsoleFilter = 'all' | 'errors' | 'warnings' | 'logs';

export type PreviewBridgeMessage = {
  source?: string;
  version?: number;
  type?: string;
  level?: PreviewConsoleEvent['level'];
  args?: unknown[];
  message?: unknown;
  stack?: unknown;
  filename?: unknown;
  line?: unknown;
  column?: unknown;
  tag?: unknown;
  url?: unknown;
  outerHTML?: unknown;
  title?: unknown;
  ts?: unknown;
  target?: unknown;
  navigation?: unknown;
};

export const PREVIEW_CONSOLE_EVENT_LIMIT = 200;

export const getPreviewConsoleFilterMatch = (event: PreviewConsoleEvent, filter: PreviewConsoleFilter): boolean => {
  if (filter === 'all') return true;
  if (filter === 'errors') return event.level === 'error' || event.level === 'runtime' || event.level === 'resource';
  if (filter === 'warnings') return event.level === 'warn';
  return event.level === 'log' || event.level === 'info' || event.level === 'debug';
};

export const appendPendingSyntheticText = (text: string): void => {
  const input = useInputStore.getState();
  input.setPendingSyntheticParts([
    ...(input.pendingSyntheticParts ?? []),
    { text, synthetic: true },
  ]);
};


export type PreviewProxyRegistration = {
  proxyBasePath: string;
  previewToken: string;
  expiresAt: number;
};

export const parsePreviewProxyTargetResponse = async (
  response: Response,
): Promise<{ ok: true; target: PreviewProxyRegistration } | { ok: false; message: string }> => {
  const body = await response.json().catch(() => ({})) as {
    error?: unknown;
    proxyBasePath?: unknown;
    previewToken?: unknown;
    expiresAt?: unknown;
  };
  if (!response.ok) {
    return { ok: false, message: typeof body.error === 'string' ? body.error : `HTTP ${response.status}` };
  }

  const proxyBasePath = typeof body.proxyBasePath === 'string' ? body.proxyBasePath : '';
  const previewToken = typeof body.previewToken === 'string' ? body.previewToken : '';
  if (!proxyBasePath || !previewToken) {
    return { ok: false, message: "Could not start preview proxy." };
  }

  return {
    ok: true,
    target: {
      proxyBasePath,
      previewToken,
      expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : 0,
    },
  };
};

export type PreviewProxyState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; proxyBasePath: string; previewToken?: string; expiresAt: number }
  | { status: 'error'; message: string };

export const getPreviewProxyOrigin = (proxySrc: string): string => {
  if (typeof window === 'undefined') return '';
  try {
    return new URL(proxySrc || window.location.href, window.location.href).origin;
  } catch {
    return window.location.origin;
  }
};

export const postPreviewBridgeMessage = (frameWindow: Window, proxySrc: string, payload: Record<string, unknown>): void => {
  frameWindow.postMessage(payload, getPreviewProxyOrigin(proxySrc));
};

export const stripPreviewTokenFromUrl = (value: string): string => {
  if (!value) return value;
  try {
    const parsed = new URL(value);
    parsed.searchParams.delete('oc_preview_token');
    parsed.searchParams.delete('oc_client_token');
    parsed.searchParams.delete('oc_url_token');
    return parsed.toString();
  } catch {
    return value;
  }
};

export const stripPreviewQueryParams = (value: string): string => {
  if (!value) return value;
  try {
    const parsed = new URL(value);
    parsed.searchParams.delete('ocPreview');
    parsed.searchParams.delete('oc_preview_token');
    parsed.searchParams.delete('oc_client_token');
    parsed.searchParams.delete('oc_url_token');
    return parsed.toString();
  } catch {
    return value;
  }
};
