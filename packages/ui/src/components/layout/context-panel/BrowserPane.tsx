import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { PiChamberLogo } from '@/components/ui/PiChamberLogo';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { toast } from '@/components/ui';
import { openExternalUrl } from '@/lib/url';
import { invokeDesktopCommand } from '@/lib/desktopNative';
import {
  type PreviewElementMetadata,
  isPreviewElementMetadata,
  formatPreviewAnnotationMarkdown,
  renderPreviewScreenshot,
  desktopAnnotationToFile,
} from '@/lib/preview/screenshot-capture';
import { appendPendingSyntheticText } from './previewShared';
import {
  DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT,
  DESKTOP_BROWSER_INSPECT_SCRIPT,
  DESKTOP_BROWSER_SAME_WEBVIEW_NAVIGATION_SCRIPT,
  normalizeBrowserUrl,
  runIframeScript,
} from './browserScripts';
import { resolveBrowserRoute } from './browserRoute';
import { ServerBrowserPane } from './ServerBrowserPane';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { closeServerBrowserTab, fetchFramePolicy } from '@/lib/serverBrowser/api';
import { cn } from '@/lib/utils';
import { browserPageLabel, type BrowserPage, type BrowserPages } from '@/stores/ui/browserPages';
import type { BrowserRoute } from '@/stores/ui/contextPanel';

type BrowserPaneProps = {
  initialUrl: string;
  directory: string;
  pageId: string;
  /** The page is in an open panel and is its active page. */
  onScreen: boolean;
  routeToggle: React.ReactNode;
  onRouteChange: (route: BrowserRoute) => void;
};

const hostOfUrl = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

const BrowserRouteToggle: React.FC<{ route: BrowserRoute; onRouteChange: (route: BrowserRoute) => void }> = ({ route, onRouteChange }) => {
  const isServer = route === 'server';
  const title = isServer
    ? 'Pages run in a browser on the PiChamber server, so localhost means the server. Switch to load them on this device.'
    : 'Pages load on this device, so localhost means this device. Switch to run them on the PiChamber server.';
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="shrink-0 typography-micro"
      onClick={() => onRouteChange(isServer ? 'device' : 'server')}
      title={title}
      aria-label={isServer ? 'Running on the server. Switch to this device' : 'Loading on this device. Switch to server'}
    >
      {isServer ? 'Server' : 'This device'}
    </Button>
  );
};

const isElectronBrowserRuntime = (): boolean => {
  return typeof window !== 'undefined' && Boolean(window.__PICHAMBER_ELECTRON__);
};

/** The web browser on the device route: an iframe loading pages directly. */
const IframeBrowserPane: React.FC<BrowserPaneProps> = ({ initialUrl, directory, pageId, routeToggle, onRouteChange }) => {
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const updateBrowserPage = useUIStore((state) => state.updateBrowserPage);
  const [refused, setRefused] = React.useState<string | null>(null);
  const normalized = normalizeBrowserUrl(initialUrl);
  const startUrl = normalized !== 'about:blank' ? normalized : '';
  const [urlInput, setUrlInput] = React.useState(startUrl);
  const [currentUrl, setCurrentUrl] = React.useState(startUrl);
  const [history, setHistory] = React.useState<string[]>(() => startUrl ? [startUrl] : []);
  const [historyIndex, setHistoryIndex] = React.useState(() => startUrl ? 0 : -1);
  const [reloadNonce, bumpReload] = React.useReducer((value: number) => value + 1, 0);
  const [isLoading, setIsLoading] = React.useState(Boolean(startUrl));
  const [isInspecting, setIsInspecting] = React.useState(false);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => state.newSessionDraft?.open);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);

  // The iframe cannot read another site's title; the strip shows the host.
  const persistUrl = React.useCallback((url: string) => {
    if (!url || url === 'about:blank' || !directory || !pageId) return;
    updateBrowserPage(directory, pageId, { url });
  }, [directory, pageId, updateBrowserPage]);

  const applyUrl = React.useCallback((url: string) => {
    const normalizedUrl = normalizeBrowserUrl(url);
    const nextUrl = normalizedUrl !== 'about:blank' ? normalizedUrl : '';
    setCurrentUrl(nextUrl);
    setUrlInput(nextUrl);
    setIsLoading(Boolean(nextUrl));
    persistUrl(nextUrl);
    setHistory((current) => {
      if (!nextUrl) {
        setHistoryIndex(-1);
        return [];
      }
      const kept = historyIndex >= 0 ? current.slice(0, historyIndex + 1) : [];
      if (kept[kept.length - 1] === nextUrl) {
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

  // An iframe cannot tell why a page stayed blank, so the server asks the
  // site whether it refuses to be framed here. Only a definite refusal
  // replaces the page; anything else leaves the iframe alone.
  React.useEffect(() => {
    if (!currentUrl) return;
    const controller = new AbortController();
    void fetchFramePolicy(currentUrl, window.location.origin, controller.signal)
      .then((policy) => { if (policy.framing === 'refused') setRefused(currentUrl); })
      .catch(() => {});
    return () => controller.abort();
  }, [currentUrl]);
  const refusedHost = refused && refused === currentUrl ? hostOfUrl(currentUrl) : null;

  // A new address set from outside the pane (an Open request, or another
  // caller of openContextBrowser) arrives as a changed page address. The pane
  // persists its own navigations to the same field, so only a value that
  // differs from what is showing counts as a navigation.
  React.useEffect(() => {
    if (!startUrl || startUrl === currentUrl) return;
    applyUrl(startUrl);
    // Only react to the incoming address, not to local navigation state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUrl]);

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
    if (!iframe) return;
    void runIframeScript<unknown>(iframe, DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT).catch(() => {});
  }, []);

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

  // Inspect reaches into the frame, so it works only for pages that share
  // this app's origin; others say so.
  const handleInspect = React.useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe || !currentUrl) return;
    if (isInspecting) {
      setIsInspecting(false);
      cancelInspect();
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
        toast.error("This page cannot be inspected on this device. Switch to Server to inspect it.");
      }
    })();
  }, [attachBrowserAnnotation, cancelInspect, currentUrl, isInspecting]);

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <div className="flex items-center gap-1 border-b border-border bg-[var(--surface-background)] px-2 py-1">
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={historyIndex <= 0} onClick={() => goToHistory(historyIndex - 1)} aria-label="Back" title="Back">
          <Icon name="arrow-left" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={historyIndex < 0 || historyIndex >= history.length - 1} onClick={() => goToHistory(historyIndex + 1)} aria-label="Forward" title="Forward">
          <Icon name="arrow-right" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={!currentUrl} onClick={handleReload} aria-label="Reload" title="Reload">
          <Icon name="refresh" className="h-3.5 w-3.5" />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); applyUrl(urlInput); }}>
          <input
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            placeholder="Enter an address"
            className="h-7 w-full rounded-md border border-border/50 bg-[var(--surface-elevated)] px-2 typography-micro text-foreground outline-none focus:border-[var(--interactive-focus-ring)]"
            aria-label={"Browser address"}
          />
        </form>
        {routeToggle}
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
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={!currentUrl} onClick={() => void openExternalUrl(currentUrl)} title="Open in system browser" aria-label="Open in system browser">
          <Icon name="external-link" className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
        {currentUrl ? (
          <iframe
            key={`${pageId}:${reloadNonce}`}
            ref={iframeRef}
            src={currentUrl}
            title={"Web browser"}
            className="absolute inset-0 h-full w-full border-0 bg-background"
            allow="clipboard-read; clipboard-write; fullscreen"
            allowFullScreen
            onLoad={() => setIsLoading(false)}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-background p-6 text-center">
            <PiChamberLogo width={140} height={140} className="opacity-20" />
            <span className="typography-ui-header text-muted-foreground">{"Web browser"}</span>
            <span className="max-w-sm typography-micro text-muted-foreground [text-wrap:pretty]">
              {"Pages load on this device, so localhost addresses reach this device. Many sites refuse to load inside other pages here; Server opens them."}
            </span>
          </div>
        )}
        {isLoading && !refusedHost ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 typography-micro text-muted-foreground">
            {"Loading..."}
          </div>
        ) : null}
        {refusedHost ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-background p-6 text-center">
            <span className="max-w-sm typography-ui-header text-foreground [text-wrap:balance]">{`${refusedHost} can't be shown here`}</span>
            <span className="max-w-sm typography-micro text-muted-foreground [text-wrap:pretty]">
              {"This site doesn't allow being shown inside other pages. Use Server to open it in PiChamber, or open it in your system browser."}
            </span>
            <div className="flex flex-wrap justify-center gap-2">
              <Button type="button" size="sm" onClick={() => onRouteChange('server')}>{'Use server'}</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void openExternalUrl(currentUrl)}>{'Open in system browser'}</Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

/**
 * The web browser on the device route in the desktop app: a native webview
 * in its own storage partition (`persist:pichamber-browser`), so pages never
 * share PiChamber's cookies, storage, or preload bridges.
 */
const DesktopBrowserPane: React.FC<BrowserPaneProps> = ({ initialUrl, directory, pageId, routeToggle }) => {
  const webviewRef = React.useRef<WebviewElement | null>(null);
  const updateBrowserPage = useUIStore((state) => state.updateBrowserPage);
  const normalized = normalizeBrowserUrl(initialUrl);
  const startUrl = normalized !== 'about:blank' ? normalized : '';
  const [urlInput, setUrlInput] = React.useState(startUrl);
  const [currentUrl, setCurrentUrl] = React.useState(startUrl);
  // Mounted once on the first address; later ones go through loadURL.
  const [webviewSrc] = React.useState(normalized);
  const [isInspecting, setIsInspecting] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const loadingTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistUrl = React.useCallback((url: string) => {
    if (!url || url === 'about:blank' || !directory || !pageId) return;
    updateBrowserPage(directory, pageId, { url });
  }, [directory, pageId, updateBrowserPage]);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => state.newSessionDraft?.open);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);

  const loadUrl = React.useCallback((value: string) => {
    const webview = webviewRef.current;
    if (typeof webview?.loadURL !== 'function') return;
    try { webview.loadURL(normalizeBrowserUrl(value)); } catch { /* webview may not be ready */ }
  }, []);

  // Listen to webview navigation events
  React.useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const showUrl = (url: string) => {
      if (!url || url === 'about:blank') return;
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
      const url = (event as Event & { url?: unknown }).url;
      showUrl(typeof url === 'string' ? url : '');
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

    const onTitle = (event: Event) => {
      const title = (event as Event & { title?: unknown }).title;
      if (typeof title === 'string' && directory && pageId) updateBrowserPage(directory, pageId, { title });
    };

    const installSameWebviewNavigation = () => {
      try {
        webview.executeJavaScript?.(DESKTOP_BROWSER_SAME_WEBVIEW_NAVIGATION_SCRIPT, true).catch(() => {});
      } catch { /* webview not ready */ }
    };

    webview.addEventListener('did-navigate', onNavigate);
    webview.addEventListener('did-navigate-in-page', onNavigate);
    webview.addEventListener('did-start-loading', onStartLoading);
    webview.addEventListener('did-stop-loading', onStopLoading);
    webview.addEventListener('new-window', onNewWindow);
    webview.addEventListener('page-title-updated', onTitle);
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
      webview.removeEventListener('did-navigate', onNavigate);
      webview.removeEventListener('did-navigate-in-page', onNavigate);
      webview.removeEventListener('did-start-loading', onStartLoading);
      webview.removeEventListener('did-stop-loading', onStopLoading);
      webview.removeEventListener('new-window', onNewWindow);
      webview.removeEventListener('page-title-updated', onTitle);
      webview.removeEventListener('dom-ready', installSameWebviewNavigation);
    };
  }, [directory, loadUrl, pageId, persistUrl, updateBrowserPage]);

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
          updateBrowserPage(directory, pageId, { url });
        }
      } catch { /* webview not ready */ }
      try { webview?.executeJavaScript?.(DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT).catch(() => {}); } catch { /* webview not ready */ }
    };
  }, [directory, pageId, updateBrowserPage]);

  // Same contract as the iframe pane: an address that differs from what
  // the webview shows was set from outside, so navigate to it.
  React.useEffect(() => {
    if (!startUrl || startUrl === currentUrl) return;
    loadUrl(startUrl);
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
        {routeToggle}
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
      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
        <webview
          ref={webviewRef}
          src={webviewSrc}
          partition="persist:pichamber-browser"
          allowpopups
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' }}
        />
        {!currentUrl && !isLoading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-background p-6 text-center">
            <PiChamberLogo width={140} height={140} className="opacity-20" />
            <span className="typography-ui-header text-muted-foreground">{"Web browser"}</span>
          </div>
        ) : null}
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 typography-micro text-muted-foreground">
            {"Loading..."}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const PAGE_LABEL_MAX_CHARS = 28;

const truncateLabel = (label: string): string => (
  label.length > PAGE_LABEL_MAX_CHARS ? `${label.slice(0, PAGE_LABEL_MAX_CHARS - 1)}…` : label
);

/** One page of the browser, on its route. */
const BrowserPageView: React.FC<{ page: BrowserPage; directory: string; route: BrowserRoute; onScreen: boolean }> = ({ page, directory, route, onScreen }) => {
  const updateBrowserPage = useUIStore((state) => state.updateBrowserPage);
  const setBrowserRoutePreference = useUIStore((state) => state.setBrowserRoutePreference);
  const onRouteChange = React.useCallback((next: BrowserRoute) => {
    updateBrowserPage(directory, page.id, { route: next });
    // The desktop app remembers the route for new pages; elsewhere new pages
    // always start on Server (see resolveBrowserRoute).
    if (isElectronBrowserRuntime()) setBrowserRoutePreference(next);
  }, [directory, page.id, setBrowserRoutePreference, updateBrowserPage]);
  const routeToggle = <BrowserRouteToggle route={route} onRouteChange={onRouteChange} />;
  const props = { initialUrl: page.url ?? '', directory, pageId: page.id, onScreen, routeToggle, onRouteChange };
  // The server route streams a browser running on the server, on every
  // runtime. The device route loads pages here: a native webview on desktop
  // (storage separate from PiChamber's), an iframe elsewhere.
  if (route === 'server') return <ServerBrowserPane key={route} {...props} popupId={page.popupId ?? null} />;
  const BrowserPane = isElectronBrowserRuntime() ? DesktopBrowserPane : IframeBrowserPane;
  return <BrowserPane key={route} {...props} />;
};

type ContextPanelBrowserPaneProps = {
  directory: string;
  browser: BrowserPages | null;
  /** The panel is open on this Browser tab. A closed panel keeps its pages
   *  mounted at full size (only clipped), so size alone cannot tell. */
  onScreen: boolean;
};

/**
 * The PiChamber browser: a strip of pages under the Browser header, and the
 * pages themselves. Every page stays mounted so switching keeps its state;
 * server pages stream only while on screen (see ServerBrowserPane).
 */
export const ContextPanelBrowserPane: React.FC<ContextPanelBrowserPaneProps> = ({ directory, browser, onScreen }) => {
  const preference = useUIStore((state) => state.browserRoutePreference);
  const openContextBrowser = useUIStore((state) => state.openContextBrowser);
  const activateBrowserPage = useUIStore((state) => state.activateBrowserPage);
  const closeBrowserPage = useUIStore((state) => state.closeBrowserPage);
  const updateBrowserPage = useUIStore((state) => state.updateBrowserPage);
  const pages = React.useMemo(() => browser?.pages ?? [], [browser]);
  const activePageId = browser?.activePageId ?? null;

  // A page without a route takes the default once and keeps it, so picking
  // a route on another page later never moves it.
  React.useEffect(() => {
    for (const page of pages) {
      if (!page.route) updateBrowserPage(directory, page.id, { defaultRoute: resolveBrowserRoute(null, preference) });
    }
  }, [directory, pages, preference, updateBrowserPage]);

  const items = React.useMemo(() => pages.map((page) => {
    const label = browserPageLabel(page);
    return {
      id: page.id,
      label: truncateLabel(label),
      title: page.url && page.url !== label ? `${label}\n${page.url}` : label,
      closeLabel: `Close ${label}`,
    };
  }), [pages]);

  const openNewPage = () => {
    openContextBrowser(directory, '', { target: 'new', route: resolveBrowserRoute(null, preference) });
  };

  const closePage = (pageId: string) => {
    // The page may be running on the server; close it there too instead of
    // leaving it until it idles out.
    closeServerBrowserTab(directory, pageId);
    closeBrowserPage(directory, pageId);
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-[var(--surface-background)]">
        <SortableTabsStrip
          items={items}
          activeId={activePageId}
          onSelect={(pageId) => activateBrowserPage(directory, pageId)}
          onClose={closePage}
          layoutMode="scrollable"
          variant="default"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mx-1 my-auto h-7 w-7 shrink-0 p-0"
          onClick={openNewPage}
          title="New browser tab"
          aria-label="New browser tab"
        >
          <Icon name="add" className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {pages.map((page) => {
          const route = resolveBrowserRoute(page.route, preference);
          const active = page.id === activePageId;
          // A desktop webview reloads when hidden with display: none, so
          // inactive webviews are only made invisible.
          const keepsLayout = route === 'device' && isElectronBrowserRuntime();
          return (
            <div
              key={page.id}
              className={cn('absolute inset-0', !active && (keepsLayout ? 'invisible pointer-events-none' : 'hidden'))}
              aria-hidden={active ? undefined : true}
            >
              <BrowserPageView page={page} directory={directory} route={route} onScreen={onScreen && active} />
            </div>
          );
        })}
      </div>
    </div>
  );
};
