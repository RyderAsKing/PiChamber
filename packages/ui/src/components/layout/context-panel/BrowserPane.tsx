import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { PiChamberLogo } from '@/components/ui/PiChamberLogo';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { toast } from '@/components/ui';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { openExternalUrl } from '@/lib/url';
import { invokeDesktopCommand } from '@/lib/desktopNative';
import {
  type PreviewElementMetadata,
  isPreviewElementMetadata,
  formatPreviewAnnotationMarkdown,
  renderPreviewScreenshot,
  desktopAnnotationToFile,
} from '@/lib/preview/screenshot-capture';
import {
  appendPendingSyntheticText,
  stripPreviewQueryParams,
  type PreviewBridgeMessage,
  type PreviewProxyState,
} from './previewShared';
import { usePreviewProxyAuthReadyKey } from './usePreviewProxyAuth';
import {
  DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT,
  DESKTOP_BROWSER_INSPECT_SCRIPT,
  DESKTOP_BROWSER_SAME_WEBVIEW_NAVIGATION_SCRIPT,
  normalizeBrowserUrl,
  runIframeScript,
} from './browserScripts';
import { resolveBrowserRoute } from './browserRoute';
import { buildBrowserProxyPath, classifyProxiedBrowserUrl, ensureBrowserProxyTarget } from './browserProxy';
import type { BrowserRoute } from '@/stores/ui/contextPanel';

type DesktopBrowserPaneProps = {
  initialUrl: string;
  directory: string;
  tabID: string;
};

type BrowserPaneProps = DesktopBrowserPaneProps & {
  route: BrowserRoute;
  onRouteChange: (route: BrowserRoute) => void;
};

const BrowserRouteToggle: React.FC<{ route: BrowserRoute; onRouteChange: (route: BrowserRoute) => void }> = ({ route, onRouteChange }) => {
  const isServer = route === 'server';
  const title = isServer
    ? 'Pages load through the PiChamber server, so localhost means the server. Switch to load them on this device.'
    : 'Pages load on this device, so localhost means this device. Switch to load them through the PiChamber server.';
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="shrink-0 typography-micro"
      onClick={() => onRouteChange(isServer ? 'device' : 'server')}
      title={title}
      aria-label={isServer ? 'Loading through server. Switch to this device' : 'Loading on this device. Switch to server'}
    >
      {isServer ? 'Server' : 'This device'}
    </Button>
  );
};

const isElectronBrowserRuntime = (): boolean => {
  return typeof window !== 'undefined' && Boolean(window.__PICHAMBER_ELECTRON__);
};

const IframeBrowserPane: React.FC<BrowserPaneProps> = ({ initialUrl, directory, tabID, route, onRouteChange }) => {
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const setContextPanelTabTargetPath = useUIStore((state) => state.setContextPanelTabTargetPath);
  const normalized = normalizeBrowserUrl(initialUrl);
  const startUrl = normalized !== 'about:blank' ? normalized : '';
  const [urlInput, setUrlInput] = React.useState(startUrl);
  const [currentUrl, setCurrentUrl] = React.useState(startUrl);
  const [loadedUrl, setLoadedUrl] = React.useState(startUrl);
  const [history, setHistory] = React.useState<string[]>(() => startUrl ? [startUrl] : []);
  const [historyIndex, setHistoryIndex] = React.useState(() => startUrl ? 0 : -1);
  const [reloadNonce, bumpReload] = React.useReducer((value: number) => value + 1, 0);
  const [isLoading, setIsLoading] = React.useState(Boolean(startUrl));
  const [isInspecting, setIsInspecting] = React.useState(false);
  const [hoverTarget, setHoverTarget] = React.useState<PreviewElementMetadata | null>(null);
  const [proxyState, setProxyState] = React.useState<PreviewProxyState>({ status: 'idle' });
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => state.newSessionDraft?.open);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);

  const persistUrl = React.useCallback((url: string) => {
    if (!url || url === 'about:blank' || !directory || !tabID) return;
    setContextPanelTabTargetPath(directory, tabID, url);
  }, [directory, tabID, setContextPanelTabTargetPath]);

  const applyUrl = React.useCallback((url: string, options?: { replaceHistory?: boolean; inFrame?: boolean }) => {
    const normalizedUrl = normalizeBrowserUrl(url);
    const nextUrl = normalizedUrl !== 'about:blank' ? normalizedUrl : '';
    setCurrentUrl(nextUrl);
    setUrlInput(nextUrl);
    if (!options?.inFrame) {
      setLoadedUrl(nextUrl);
      setIsLoading(Boolean(nextUrl));
    } else {
      setIsLoading(false);
    }
    persistUrl(nextUrl);

    setHistory((current) => {
      if (!nextUrl) {
        setHistoryIndex(-1);
        return [];
      }

      if (options?.replaceHistory) {
        return current;
      }

      const kept = historyIndex >= 0 ? current.slice(0, historyIndex + 1) : [];
      const previous = kept[kept.length - 1];
      if (previous === nextUrl) {
        setHistoryIndex(kept.length - 1);
        return kept;
      }

      const nextHistory = [...kept, nextUrl];
      setHistoryIndex(nextHistory.length - 1);
      return nextHistory;
    });
  }, [historyIndex, persistUrl]);

  const goToHistory = React.useCallback((nextIndex: number) => {
    const nextUrl = history[nextIndex];
    if (!nextUrl) return;
    setHistoryIndex(nextIndex);
    setCurrentUrl(nextUrl);
    setLoadedUrl(nextUrl);
    setUrlInput(nextUrl);
    setIsLoading(true);
    persistUrl(nextUrl);
  }, [history, persistUrl]);

  const handleReload = React.useCallback(() => {
    if (!currentUrl) return;
    setIsLoading(true);
    try {
      iframeRef.current?.contentWindow?.location.reload();
    } catch {
      bumpReload();
    }
  }, [currentUrl]);

  React.useEffect(() => {
    if (!loadedUrl || route !== 'server') {
      setProxyState({ status: 'idle' });
      return;
    }

    let cancelled = false;
    setProxyState({ status: 'loading' });
    setIsLoading(true);

    void ensureBrowserProxyTarget(loadedUrl).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setProxyState({ status: 'error', message: result.message });
        setIsLoading(false);
        return;
      }
      setProxyState({ status: 'ready', ...result.target });
    });

    return () => {
      cancelled = true;
    };
  }, [loadedUrl, route]);

  // A new address set from outside the pane (an Open request, or another
  // caller of openContextBrowser) arrives as a changed targetPath. The pane
  // persists its own navigations to the same field, so only a value that
  // differs from what is showing counts as a navigation.
  React.useEffect(() => {
    const normalizedInitial = normalizeBrowserUrl(initialUrl);
    const nextUrl = normalizedInitial !== 'about:blank' ? normalizedInitial : '';
    if (!nextUrl || nextUrl === currentUrl) return;
    applyUrl(nextUrl);
    // Only react to the incoming address, not to local navigation state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUrl]);

  const proxyUrlAuthKey = loadedUrl && proxyState.status === 'ready'
    ? `${proxyState.proxyBasePath}|${proxyState.previewToken || ''}|${reloadNonce}`
    : '';

  const urlAuthReadyKey = usePreviewProxyAuthReadyKey(proxyUrlAuthKey);

  const proxySrc = React.useMemo(() => {
    if (urlAuthReadyKey !== proxyUrlAuthKey) return '';
    if (!loadedUrl || proxyState.status !== 'ready') return '';
    try {
      return getRuntimeUrlResolver().authenticatedAsset(buildBrowserProxyPath(loadedUrl, proxyState, reloadNonce));
    } catch {
      return '';
    }
  }, [loadedUrl, proxyState, proxyUrlAuthKey, reloadNonce, urlAuthReadyKey]);

  // The device route loads the page directly. The server route never falls
  // back to a direct load: that would silently resolve localhost on the
  // device instead of the server.
  const iframeSrc = route === 'device' ? loadedUrl : proxySrc;
  const proxyError = route === 'server' && loadedUrl && proxyState.status === 'error' ? proxyState.message : '';

  const getCurrentUrlFromFrameUrl = React.useCallback((frameUrl: string): string => {
    if (!frameUrl || !loadedUrl || proxyState.status !== 'ready') return '';
    try {
      const parsedFrameUrl = new URL(frameUrl, window.location.origin);
      const proxyBasePath = proxyState.proxyBasePath.endsWith('/')
        ? proxyState.proxyBasePath.slice(0, -1)
        : proxyState.proxyBasePath;
      if (parsedFrameUrl.origin !== window.location.origin || !parsedFrameUrl.pathname.startsWith(proxyBasePath)) {
        return '';
      }

      const rest = parsedFrameUrl.pathname.slice(proxyBasePath.length) || '/';
      const upstreamOrigin = new URL(loadedUrl).origin;
      return stripPreviewQueryParams(new URL(`${rest}${parsedFrameUrl.search}${parsedFrameUrl.hash}`, upstreamOrigin).toString());
    } catch {
      return '';
    }
  }, [loadedUrl, proxyState]);

  const getUpstreamUrlFromLocalFrameUrl = React.useCallback((frameUrl: string): string => {
    if (!frameUrl || !loadedUrl || proxyState.status !== 'ready') return '';
    try {
      const parsedFrameUrl = new URL(frameUrl, window.location.origin);
      const upstreamOrigin = new URL(loadedUrl).origin;
      if (parsedFrameUrl.origin !== window.location.origin || upstreamOrigin === window.location.origin) {
        return '';
      }

      const proxyBasePath = proxyState.proxyBasePath.endsWith('/')
        ? proxyState.proxyBasePath.slice(0, -1)
        : proxyState.proxyBasePath;
      if (parsedFrameUrl.pathname.startsWith(proxyBasePath)) {
        return '';
      }

      return stripPreviewQueryParams(new URL(`${parsedFrameUrl.pathname}${parsedFrameUrl.search}${parsedFrameUrl.hash}`, upstreamOrigin).toString());
    } catch {
      return '';
    }
  }, [loadedUrl, proxyState]);

  const postInspectMode = React.useCallback((enabled: boolean) => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!frameWindow) return;
    frameWindow.postMessage({
      source: 'pichamber-preview-parent',
      version: 1,
      type: 'set-inspect-mode',
      enabled,
    }, window.location.origin);
  }, []);

  const attachBrowserAnnotation = React.useCallback(async (target: PreviewElementMetadata) => {
    const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
    if (!sessionKey) {
      toast.error("Open a chat session before attaching preview annotations");
      return;
    }

    const iframe = iframeRef.current;
    const frameWindow = iframe?.contentWindow;
    const rect = iframe?.getBoundingClientRect();
    const viewport = {
      width: Number.isFinite(frameWindow?.innerWidth) ? frameWindow?.innerWidth ?? rect?.width ?? 0 : rect?.width ?? 0,
      height: Number.isFinite(frameWindow?.innerHeight) ? frameWindow?.innerHeight ?? rect?.height ?? 0 : rect?.height ?? 0,
    };

    const file = iframe ? await renderPreviewScreenshot(iframe, target) : null;
    const screenshotAttached = Boolean(file);
    if (file) {
      await addAttachedFile(file);
    }

    appendPendingSyntheticText(formatPreviewAnnotationMarkdown({
      pageUrl: currentUrl,
      viewport,
      devicePixelRatio: window.devicePixelRatio || 1,
      target,
      screenshotAttached,
      intro: (screenshotAttached ? "This is a selected DOM element from the in-app preview. A screenshot of the visible preview area with the selected element highlighted is attached." : "This is a selected DOM element from the in-app preview."),
    }));
    toast.success("Preview annotation attached to chat");
  }, [addAttachedFile, currentSessionId, currentUrl, newSessionDraftOpen]);

  const cancelInspect = React.useCallback(() => {
    const iframe = iframeRef.current;
    setHoverTarget(null);
    postInspectMode(false);
    if (!iframe) return;
    void runIframeScript<unknown>(iframe, DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT).catch(() => {});
  }, [postInspectMode]);

  React.useEffect(() => {
    if (!isInspecting) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setIsInspecting(false);
      cancelInspect();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [cancelInspect, isInspecting]);

  React.useEffect(() => () => cancelInspect(), [cancelInspect]);

  React.useEffect(() => {
    const handler = (event: MessageEvent<PreviewBridgeMessage>) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (!data || data.source !== 'pichamber-preview-bridge' || data.version !== 1) return;

      if (data.type === 'ready') {
        const frameUrl = typeof data.url === 'string' ? data.url : '';
        const nextUrl = getCurrentUrlFromFrameUrl(frameUrl);
        if (nextUrl && nextUrl !== currentUrl) {
          applyUrl(nextUrl, { inFrame: true });
        }
        return;
      }

      if (data.type === 'hover') {
        setHoverTarget(isPreviewElementMetadata(data.target) ? data.target : null);
        return;
      }

      if (data.type === 'select' && isPreviewElementMetadata(data.target)) {
        setHoverTarget(null);
        setIsInspecting(false);
        postInspectMode(false);
        void attachBrowserAnnotation(data.target);
        return;
      }

      if (data.type === 'navigate-preview') {
        const nextUrl = typeof data.url === 'string' ? data.url : '';
        const upstreamUrl = getUpstreamUrlFromLocalFrameUrl(nextUrl);
        if (upstreamUrl) {
          applyUrl(upstreamUrl);
          return;
        }
        if (nextUrl) {
          applyUrl(nextUrl);
        }
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [applyUrl, attachBrowserAnnotation, currentUrl, getCurrentUrlFromFrameUrl, getUpstreamUrlFromLocalFrameUrl, postInspectMode]);

  const handleInspect = React.useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe || !currentUrl) return;

    if (isInspecting) {
      setIsInspecting(false);
      cancelInspect();
      return;
    }

    if (proxySrc) {
      setHoverTarget(null);
      setIsInspecting(true);
      postInspectMode(true);
      return;
    }

    setIsInspecting(true);
    void (async () => {
      try {
        const target = await runIframeScript<unknown>(iframe, DESKTOP_BROWSER_INSPECT_SCRIPT);
        setIsInspecting(false);
        if (!target || !isPreviewElementMetadata(target)) return;
        await attachBrowserAnnotation(target);
      } catch {
        setIsInspecting(false);
        toast.error("This page cannot be inspected from the browser panel.");
      }
    })();
  }, [attachBrowserAnnotation, cancelInspect, currentUrl, isInspecting, postInspectMode, proxySrc]);

  const handleIframeLoad = React.useCallback(() => {
    try {
      const frameUrl = iframeRef.current?.contentWindow?.location.href || '';
      const upstreamUrl = getUpstreamUrlFromLocalFrameUrl(frameUrl);
      if (upstreamUrl) {
        applyUrl(upstreamUrl, { inFrame: true });
        return;
      }
    } catch {
      // Cross-origin direct iframe fallback; regular load handling still applies.
    }

    setIsLoading(false);
    if (isInspecting && proxySrc) {
      postInspectMode(true);
    }
  }, [applyUrl, getUpstreamUrlFromLocalFrameUrl, isInspecting, postInspectMode, proxySrc]);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <div className="flex items-center gap-1 border-b border-border bg-[var(--surface-background)] px-2 py-1">
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={historyIndex <= 0} onClick={() => goToHistory(historyIndex - 1)}>
          <Icon name="arrow-left" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={historyIndex < 0 || historyIndex >= history.length - 1} onClick={() => goToHistory(historyIndex + 1)}>
          <Icon name="arrow-right" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={!currentUrl} onClick={handleReload}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); applyUrl(urlInput); }}>
          <input
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            className="h-7 w-full rounded-md border border-border/50 bg-[var(--surface-elevated)] px-2 typography-micro text-foreground outline-none focus:border-[var(--interactive-focus-ring)]"
            aria-label={"Browser address"}
          />
        </form>
        <BrowserRouteToggle route={route} onRouteChange={onRouteChange} />
        <Button
          type="button"
          variant={isInspecting ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 w-7 p-0"
          disabled={!currentUrl}
          onClick={handleInspect}
          title={"Inspect preview element"}
          aria-label={"Inspect preview element"}
        >
          <Icon name="cursor" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={!currentUrl} onClick={() => void openExternalUrl(currentUrl)}>
          <Icon name="external-link" className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 bg-background">
        {iframeSrc ? (
          <div className="absolute inset-0">
            <iframe
              key={`${tabID}:${reloadNonce}`}
              ref={iframeRef}
              src={iframeSrc}
              title={"Web browser"}
              className="absolute inset-0 h-full w-full border-0 bg-background"
              allow="clipboard-read; clipboard-write; fullscreen"
              allowFullScreen
              onLoad={handleIframeLoad}
            />
            {isInspecting && hoverTarget ? (
              <div
                className="pointer-events-none absolute rounded-sm border-2 border-[var(--interactive-focus-ring)] bg-[var(--interactive-focus-ring)]/35"
                style={{
                  left: hoverTarget.bounds.x,
                  top: hoverTarget.bounds.y,
                  width: hoverTarget.bounds.width,
                  height: hoverTarget.bounds.height,
                }}
              >
                <div className="absolute -top-6 left-0 max-w-64 truncate rounded bg-[var(--surface-elevated)] px-2 py-0.5 typography-micro text-foreground shadow">
                  {hoverTarget.tag}{hoverTarget.text ? ` · ${hoverTarget.text}` : ''}
                </div>
              </div>
            ) : null}
          </div>
        ) : proxyError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
            <span className="typography-ui-header text-foreground">{"Can't load this page through the server"}</span>
            <span className="max-w-md typography-micro text-muted-foreground [text-wrap:pretty]">{proxyError}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => onRouteChange('device')}>
              {"Open on this device"}
            </Button>
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-background p-6 text-center">
            <PiChamberLogo width={140} height={140} className="opacity-20" />
            <span className="typography-ui-header text-muted-foreground">{"Web browser"}</span>
            <span className="max-w-sm typography-micro text-muted-foreground [text-wrap:pretty]">
              {route === 'server'
                ? "Pages load through the PiChamber server, so localhost addresses reach the server."
                : "Pages load on this device, so localhost addresses reach this device."}
            </span>
            {route === 'server' ? (
              <span className="max-w-md typography-micro leading-relaxed text-status-warning/70 [text-wrap:pretty]">{"Pages opened through the server run with full access to PiChamber — needed for inspect and screenshots. Only open sites you trust: a malicious page could read your data or act on your behalf."}</span>
            ) : null}
          </div>
        )}
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 typography-micro text-muted-foreground">
            {"Loading..."}
          </div>
        ) : null}
      </div>
    </div>
  );
};

// Electron properties of webview events arrive on the event object itself.
type WebviewNavigationEvent = Event & { url?: unknown; isMainFrame?: unknown; isInPlace?: unknown };

const readWebviewEventUrl = (event: Event): string => {
  const url = (event as WebviewNavigationEvent).url;
  return typeof url === 'string' ? url : '';
};

const isHttpBrowserUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/**
 * The desktop browser: a native webview in its own storage partition
 * (`persist:pichamber-browser`), so pages never share PiChamber's cookies,
 * storage, or preload bridges.
 *
 * On the device route it loads addresses directly. On the server route it
 * loads them through the preview proxy as top-level pages, authorized only by
 * the per-target preview token; the address bar shows the page's own address.
 * Navigations that leave the proxy are sent back through it.
 */
const DesktopBrowserPane: React.FC<BrowserPaneProps> = ({ initialUrl, directory, tabID, route, onRouteChange }) => {
  const isServerRoute = route === 'server';
  const webviewRef = React.useRef<WebviewElement | null>(null);
  const setContextPanelTabTargetPath = useUIStore((state) => state.setContextPanelTabTargetPath);
  const normalized = normalizeBrowserUrl(initialUrl);
  const startUrl = normalized !== 'about:blank' ? normalized : '';
  // The device route mounts the webview on the address right away. The
  // server route first registers a proxy target, so it starts unmounted.
  const [webviewSrc, setWebviewSrc] = React.useState<string | null>(() => (
    isServerRoute && startUrl ? null : normalized
  ));
  const [urlInput, setUrlInput] = React.useState(startUrl);
  const [currentUrl, setCurrentUrl] = React.useState(startUrl);
  const [isInspecting, setIsInspecting] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [serverError, setServerError] = React.useState('');
  const loadingTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Server route: proxy base path -> upstream origin for every target this
  // pane loaded, the proxy's origin, and the origin of the page showing.
  const proxyTargetsRef = React.useRef(new Map<string, string>());
  const proxyOriginRef = React.useRef('');
  const upstreamOriginRef = React.useRef('');
  const navigationSeqRef = React.useRef(0);
  const showLoading = isLoading;
  const webviewMounted = webviewSrc !== null;

  const persistUrl = React.useCallback((url: string) => {
    if (!url || url === 'about:blank' || !directory || !tabID) return;
    setContextPanelTabTargetPath(directory, tabID, url);
  }, [directory, tabID, setContextPanelTabTargetPath]);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => state.newSessionDraft?.open);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);

  // Server route: the absolute proxy address for a page, or null with the
  // error shown when the server cannot proxy it.
  const resolveProxiedUrl = React.useCallback(async (upstreamUrl: string): Promise<string | null> => {
    const result = await ensureBrowserProxyTarget(upstreamUrl);
    if (!result.ok) {
      setServerError(result.message);
      setIsLoading(false);
      return null;
    }
    try {
      const proxied = new URL(getRuntimeUrlResolver().api(buildBrowserProxyPath(upstreamUrl, result.target)), window.location.href);
      proxyTargetsRef.current.set(result.target.proxyBasePath, new URL(upstreamUrl).origin);
      proxyOriginRef.current = proxied.origin;
      upstreamOriginRef.current = new URL(upstreamUrl).origin;
      setServerError('');
      return proxied.toString();
    } catch {
      setServerError("Could not start preview proxy.");
      setIsLoading(false);
      return null;
    }
  }, []);

  // The address to show for what the webview reports.
  const toDisplayUrl = React.useCallback((webviewUrl: string): string => {
    if (!isServerRoute) return webviewUrl;
    const classified = classifyProxiedBrowserUrl(webviewUrl, proxyOriginRef.current, proxyTargetsRef.current);
    return classified.kind === 'proxied' ? classified.upstreamUrl : webviewUrl;
  }, [isServerRoute]);

  const loadUrl = React.useCallback((value: string) => {
    const nextUrl = normalizeBrowserUrl(value);
    const seq = ++navigationSeqRef.current;
    if (!isServerRoute || nextUrl === 'about:blank') {
      const webview = webviewRef.current;
      if (typeof webview?.loadURL !== 'function') return;
      try { webview.loadURL(nextUrl); } catch { /* webview may not be ready */ }
      return;
    }
    // Show and keep the address before the proxy answers, so a failure (or
    // switching to this device from the error) keeps what was asked for.
    setCurrentUrl(nextUrl);
    setUrlInput(nextUrl);
    persistUrl(nextUrl);
    setIsLoading(true);
    void resolveProxiedUrl(nextUrl).then((proxied) => {
      if (!proxied || seq !== navigationSeqRef.current) return;
      const webview = webviewRef.current;
      if (!webview) {
        setWebviewSrc(proxied);
        return;
      }
      try { webview.loadURL(proxied); } catch { /* webview may not be ready */ }
    });
  }, [isServerRoute, persistUrl, resolveProxiedUrl]);

  // Server route: mount the webview on the proxied start address.
  React.useEffect(() => {
    if (!isServerRoute || !startUrl) return;
    loadUrl(startUrl);
    // Mount only; later addresses arrive through loadUrl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen to webview navigation events
  React.useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const showUrl = (webviewUrl: string) => {
      if (!webviewUrl || webviewUrl === 'about:blank') return;
      const url = toDisplayUrl(webviewUrl);
      setCurrentUrl(url);
      setUrlInput(url);
      persistUrl(url);
    };

    const syncUrl = () => {
      try {
        showUrl(webview.getURL());
      } catch { /* webview not ready */ }
    };

    const onNavigate = (event: Event) => {
      showUrl(readWebviewEventUrl(event));
    };

    // Server route: a main-frame navigation off the proxy (a link to another
    // site, a root-relative link that escaped the proxy path, a popup loaded
    // in place) would load on this device. Stop it and load it through the
    // server instead.
    const onStartNavigation = (event: Event) => {
      if (!isServerRoute) return;
      const { isMainFrame, isInPlace } = event as WebviewNavigationEvent;
      if (isMainFrame !== true || isInPlace === true) return;
      const url = readWebviewEventUrl(event);
      if (!isHttpBrowserUrl(url)) return;
      const classified = classifyProxiedBrowserUrl(url, proxyOriginRef.current, proxyTargetsRef.current);
      if (classified.kind === 'proxied') return;
      let upstreamUrl = url;
      if (classified.kind === 'escaped') {
        if (!upstreamOriginRef.current) return;
        try {
          upstreamUrl = new URL(classified.relative, upstreamOriginRef.current).toString();
        } catch {
          return;
        }
      }
      try { webview.stop(); } catch { /* webview not ready */ }
      loadUrl(upstreamUrl);
    };

    const onStartLoading = () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = setTimeout(() => setIsLoading(true), 200);
    };
    const onStopLoading = () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      setIsLoading(false);
      syncUrl();
    };

    const onNewWindow = (event: Event) => {
      const detail = (event as CustomEvent<{ url: string; disposition: string }>).detail;
      if (detail?.disposition === 'new-window' || detail?.disposition === 'foreground-tab' || detail?.disposition === 'background-tab') {
        event.preventDefault();
        if (detail.url) loadUrl(detail.url);
      }
    };

    const installSameWebviewNavigation = () => {
      try {
        webview.executeJavaScript?.(DESKTOP_BROWSER_SAME_WEBVIEW_NAVIGATION_SCRIPT, true).catch(() => {});
      } catch { /* webview not ready */ }
    };

    webview.addEventListener('did-start-navigation', onStartNavigation);
    webview.addEventListener('did-redirect-navigation', onStartNavigation);
    webview.addEventListener('did-navigate', onNavigate);
    webview.addEventListener('did-navigate-in-page', onNavigate);
    webview.addEventListener('did-start-loading', onStartLoading);
    webview.addEventListener('did-stop-loading', onStopLoading);
    webview.addEventListener('new-window', onNewWindow);
    webview.addEventListener('dom-ready', installSameWebviewNavigation);

    // Check current loading state imperatively — we may have missed the event
    try {
      if (!webview.isLoading()) {
        setIsLoading(false);
        syncUrl();
      }
    } catch { /* webview not ready */ }
    installSameWebviewNavigation();

    return () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      webview.removeEventListener('did-start-navigation', onStartNavigation);
      webview.removeEventListener('did-redirect-navigation', onStartNavigation);
      webview.removeEventListener('did-navigate', onNavigate);
      webview.removeEventListener('did-navigate-in-page', onNavigate);
      webview.removeEventListener('did-start-loading', onStartLoading);
      webview.removeEventListener('did-stop-loading', onStopLoading);
      webview.removeEventListener('new-window', onNewWindow);
      webview.removeEventListener('dom-ready', installSameWebviewNavigation);
    };
  }, [isServerRoute, loadUrl, persistUrl, toDisplayUrl, webviewMounted]);

  // Safety timeout: hide loading overlay after 30s even if events fire late
  React.useEffect(() => {
    const safety = setTimeout(() => setIsLoading(false), 30_000);
    return () => clearTimeout(safety);
  }, []);

  // Escape key cancels inspect mode
  React.useEffect(() => {
    if (!isInspecting) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setIsInspecting(false);
      const webview = webviewRef.current;
      try { webview?.executeJavaScript?.(DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT).catch(() => {}); } catch { /* webview not ready */ }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isInspecting]);

  // Cancel inspect on unmount
  React.useEffect(() => {
    const webview = webviewRef.current;
    return () => {
      try {
        const url = webview?.getURL?.();
        if (url && url !== 'about:blank') {
          setContextPanelTabTargetPath(directory, tabID, toDisplayUrl(url));
        }
      } catch { /* webview not ready */ }
      try { webview?.executeJavaScript?.(DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT).catch(() => {}); } catch { /* webview not ready */ }
    };
  }, [directory, tabID, setContextPanelTabTargetPath, toDisplayUrl, webviewMounted]);

  // Same contract as the iframe pane: a targetPath that differs from what
  // the webview shows was set from outside, so navigate to it.
  React.useEffect(() => {
    const normalizedInitial = normalizeBrowserUrl(initialUrl);
    if (normalizedInitial === 'about:blank' || normalizedInitial === currentUrl) return;
    loadUrl(normalizedInitial);
    // Only react to the incoming address, not to local navigation state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUrl]);

  const handleInspect = React.useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    if (isInspecting) {
      setIsInspecting(false);
      try { webview.executeJavaScript?.(DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT).catch(() => {}); } catch { /* webview not ready */ }
      return;
    }

    setIsInspecting(true);
    webview.executeJavaScript?.(DESKTOP_BROWSER_INSPECT_SCRIPT, true)
      .then(async (target: unknown) => {
        setIsInspecting(false);
        if (!target || !isPreviewElementMetadata(target)) return;

        const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
        if (!sessionKey) {
          toast.error("Open a chat session before attaching preview annotations");
          return;
        }

        const wcId = typeof webview.getWebContentsId === 'function' ? webview.getWebContentsId() : null;
        if (wcId === null || wcId === undefined) return;

        const capture = await invokeDesktopCommand<{ mime: string; base64: string; width: number; height: number }>(
          'desktop_browser_capture_page', { webContentsId: wcId }
        );

        const cssViewport = await webview.executeJavaScript?.(
          '({ width: window.innerWidth, height: window.innerHeight })', true
        ).catch(() => null) as { width: number; height: number } | null | undefined;

        const cssWidth = Number.isFinite(cssViewport?.width) ? (cssViewport as { width: number }).width : capture.width;
        const cssHeight = Number.isFinite(cssViewport?.height) ? (cssViewport as { height: number }).height : capture.height;

        const file = await desktopAnnotationToFile(capture.base64, capture.width, capture.height, cssWidth, cssHeight, target);
        const screenshotAttached = Boolean(file);
        if (file) {
          await addAttachedFile(file);
        }

        appendPendingSyntheticText(formatPreviewAnnotationMarkdown({
          pageUrl: currentUrl,
          viewport: { width: cssWidth, height: cssHeight },
          devicePixelRatio: window.devicePixelRatio || 1,
          target,
          screenshotAttached,
          intro: "This is a selected DOM element from the in-app preview. A screenshot of the visible preview area with the selected element highlighted is attached.",
        }));
        toast.success("Preview annotation attached to chat");
      })
      .catch(() => setIsInspecting(false));
  }, [addAttachedFile, currentSessionId, currentUrl, isInspecting, newSessionDraftOpen]);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <div className="flex items-center gap-1 border-b border-border bg-[var(--surface-background)] px-2 py-1">
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => { try { webviewRef.current?.goBack?.(); } catch { /* webview not ready */ } }}>
          <Icon name="arrow-left" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => { try { webviewRef.current?.goForward?.(); } catch { /* webview not ready */ } }}>
          <Icon name="arrow-right" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => { try { webviewRef.current?.reload?.(); } catch { /* webview not ready */ } }}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); loadUrl(urlInput); }}>
          <input
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            className="h-7 w-full rounded-md border border-border/50 bg-[var(--surface-elevated)] px-2 typography-micro text-foreground outline-none focus:border-[var(--interactive-focus-ring)]"
            aria-label={"Browser address"}
          />
        </form>
        <BrowserRouteToggle route={route} onRouteChange={onRouteChange} />
        <Button
          type="button"
          variant={isInspecting ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 w-7 p-0"
          onClick={handleInspect}
          title={"Inspect preview element"}
          aria-label={"Inspect preview element"}
        >
          <Icon name="cursor" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => void openExternalUrl(currentUrl)}>
          <Icon name="external-link" className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 bg-background">
        {webviewSrc !== null ? (
          <webview
            ref={webviewRef}
            src={webviewSrc}
            partition="persist:pichamber-browser"
            allowpopups
            style={{ width: '100%', height: '100%', border: 'none' }}
          />
        ) : null}
        {serverError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
            <span className="typography-ui-header text-foreground">{"Can't load this page through the server"}</span>
            <span className="max-w-md typography-micro text-muted-foreground [text-wrap:pretty]">{serverError}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => onRouteChange('device')}>
              {"Open on this device"}
            </Button>
          </div>
        ) : (!currentUrl || currentUrl === 'about:blank') && !isLoading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-background p-6 text-center">
            <PiChamberLogo width={140} height={140} className="opacity-20" />
            <span className="typography-ui-header text-muted-foreground">{"Web browser"}</span>
          </div>
        ) : null}
        {showLoading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 typography-micro text-muted-foreground">
            {"Loading..."}
          </div>
        ) : null}
      </div>
    </div>
  );
};


type ContextPanelBrowserPaneProps = DesktopBrowserPaneProps & {
  browserRoute: BrowserRoute | null;
};

export const ContextPanelBrowserPane: React.FC<ContextPanelBrowserPaneProps> = ({ browserRoute, ...props }) => {
  const preference = useUIStore((state) => state.browserRoutePreference);
  const setContextPanelBrowserRoute = useUIStore((state) => state.setContextPanelBrowserRoute);
  const route = resolveBrowserRoute(browserRoute, preference);
  const onRouteChange = React.useCallback((next: BrowserRoute) => {
    setContextPanelBrowserRoute(props.directory, props.tabID, next);
  }, [props.directory, props.tabID, setContextPanelBrowserRoute]);
  // Desktop always uses the native webview, whose storage is separate from
  // PiChamber's; it loads through the server on the server route. Other
  // runtimes use the iframe, which frames the proxy on the server route.
  const BrowserPane = isElectronBrowserRuntime() ? DesktopBrowserPane : IframeBrowserPane;
  return <BrowserPane key={route} {...props} route={route} onRouteChange={onRouteChange} />;
};
