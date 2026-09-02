import type { RuntimeAPIs } from '@/lib/api/types';
import { getInjectedBootOutcome } from '@/lib/desktopBoot';
import { getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { DesktopBridgeGlobal, ElectronRuntimeGlobal } from './desktopTypes';

export const getElectronRuntime = (): ElectronRuntimeGlobal | null => {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __PICHAMBER_ELECTRON__?: ElectronRuntimeGlobal }).__PICHAMBER_ELECTRON__ ?? null;
};

export const getDesktopBridge = (): DesktopBridgeGlobal | null => {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { __PICHAMBER_DESKTOP__?: DesktopBridgeGlobal }).__PICHAMBER_DESKTOP__ ?? null;
};

export const isElectronShell = (): boolean => getElectronRuntime()?.runtime === 'electron';

export const getElectronPlatform = (): string | null => {
  if (typeof window === 'undefined') return null;
  const platform = (window as unknown as { __PICHAMBER_PLATFORM__?: string }).__PICHAMBER_PLATFORM__;
  return typeof platform === 'string' ? platform : null;
};

export const hasDesktopInvoke = (): boolean => {
  return typeof getDesktopBridge()?.invoke === 'function';
};

export const canUseElectronDesktopIPC = (): boolean => isElectronShell() && hasDesktopInvoke();

export const invokeDesktop = async <T = unknown>(command: string, args?: Record<string, unknown>): Promise<T | null> => {
  const bridge = getDesktopBridge();
  if (typeof bridge?.invoke !== 'function') return null;
  return bridge.invoke(command, args ?? {}) as Promise<T>;
};

export const normalizeOrigin = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    try {
      return new URL(trimmed.endsWith('/') ? trimmed : `${trimmed}/`).origin;
    } catch {
      return null;
    }
  }
};

export const parseUrl = (raw: string): URL | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed);
  } catch {
    try {
      return new URL(trimmed.endsWith('/') ? trimmed : `${trimmed}/`);
    } catch {
      return null;
    }
  }
};

export const normalizeHost = (rawHost: string): string => rawHost.replace(/^\[|\]$/g, '').toLowerCase();

export const isLoopbackHost = (host: string): boolean => {
  const normalized = normalizeHost(host);
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
};

export const isDesktopShell = (): boolean => {
  if (typeof window === 'undefined') return false;
  return isElectronShell();
};

export const isDesktopLocalOriginActive = (): boolean => {
  if (typeof window === 'undefined') return false;
  if (!isDesktopShell()) return false;

  if (getRuntimeKey() === 'local') {
    return true;
  }

  const local = typeof window.__PICHAMBER_LOCAL_ORIGIN__ === 'string' ? window.__PICHAMBER_LOCAL_ORIGIN__ : '';
  const localUrl = parseUrl(local);
  const runtimeApiUrl = parseUrl(getRuntimeApiBaseUrl());

  if (!runtimeApiUrl && localUrl && getInjectedBootOutcome()?.target === 'local') {
    return true;
  }

  if (localUrl && runtimeApiUrl) {
    if (localUrl.origin === runtimeApiUrl.origin) {
      return true;
    }

    const localPort = localUrl.port || (localUrl.protocol === 'https:' ? '443' : '80');
    const runtimePort = runtimeApiUrl.port || (runtimeApiUrl.protocol === 'https:' ? '443' : '80');

    return (
      localUrl.protocol === runtimeApiUrl.protocol &&
      localPort === runtimePort &&
      isLoopbackHost(localUrl.hostname) &&
      isLoopbackHost(runtimeApiUrl.hostname)
    );
  }

  const currentUrl = parseUrl(window.location.origin);

  if (localUrl && currentUrl) {
    if (localUrl.origin === currentUrl.origin) {
      return true;
    }

    const localPort = localUrl.port || (localUrl.protocol === 'https:' ? '443' : '80');
    const currentPort = currentUrl.port || (currentUrl.protocol === 'https:' ? '443' : '80');

    return (
      localUrl.protocol === currentUrl.protocol &&
      localPort === currentPort &&
      isLoopbackHost(localUrl.hostname) &&
      isLoopbackHost(currentUrl.hostname)
    );
  }

  const localOrigin = normalizeOrigin(local);
  const currentOrigin = normalizeOrigin(window.location.origin) || window.location.origin;
  if (localOrigin && currentOrigin && localOrigin === currentOrigin) {
    return true;
  }

  return Boolean(currentUrl && isLoopbackHost(currentUrl.hostname));
};

export const isWebRuntime = (): boolean => {
  const apis = getRegisteredRuntimeAPIs();
  const platform = apis?.runtime?.platform;
  if (platform === 'web') {
    return true;
  }
  if (platform === 'desktop') {
    return false;
  }
  return true;
};

export const isBrowserClientRuntime = (
  platform: RuntimeAPIs['runtime']['platform'],
  desktopShell = isDesktopShell(),
): boolean => platform === 'web' && !desktopShell;
