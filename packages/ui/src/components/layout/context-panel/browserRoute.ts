import type { BrowserRoute } from '@/stores/ui/contextPanel';
import { normalizeBrowserRoute } from '@/stores/ui/contextPanel';
import { isDesktopLocalOriginActive, isElectronShell } from '@/lib/desktopBridge';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

// True for a URL that only reaches something on the machine that resolves it
// (localhost and friends). Through the server route that machine is the
// PiChamber server; on the device route it is the device itself.
export const isLoopbackBrowserUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host);
  } catch {
    return false;
  }
};

// The desktop app talking to its own in-process server already sits on the
// server machine, so loading pages directly is equivalent and keeps the
// native webview. Every other runtime (web, hosted mobile, Capacitor, desktop
// connected to a remote server) defaults to the server's network so that
// server-local addresses resolve where the agent runs.
export const resolveDefaultBrowserRoute = (): BrowserRoute => {
  return isElectronShell() && isDesktopLocalOriginActive() ? 'device' : 'server';
};

// A page's own route wins. Without one, the desktop app uses the route last
// picked; other runtimes always start on Server, because many sites refuse
// to load in the iframe "This device" uses there. "This device" stays a
// per-page fallback on those runtimes, never the default.
export const resolveBrowserRoute = (pageRoute: unknown, preference: unknown): BrowserRoute => {
  return normalizeBrowserRoute(pageRoute)
    ?? (isElectronShell() ? normalizeBrowserRoute(preference) : null)
    ?? resolveDefaultBrowserRoute();
};
