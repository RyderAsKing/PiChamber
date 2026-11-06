import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { copyTextToClipboard } from '@/lib/clipboard';
import {
  desktopAnnotationToFile,
  formatPreviewAnnotationMarkdown,
  isPreviewElementMetadata,
  type PreviewElementMetadata,
} from '@/lib/preview/screenshot-capture';
import {
  fetchServerBrowserStatus,
  forgetServerBrowserSocketToken,
  openServerBrowserSocket,
  saveServerBrowserDownload,
  uploadServerBrowserFile,
} from '@/lib/serverBrowser/api';
import { ServerBrowserConnection, type ServerBrowserConnectionPhase } from '@/lib/serverBrowser/connection';
import {
  fitDeviceViewport,
  MAX_SERVER_BROWSER_UPLOAD_BYTES,
  serverBrowserTabKey,
  type ServerBrowserDialog,
  type ServerBrowserMessage,
  type ServerBrowserPageState,
  type ServerBrowserStatus,
} from '@/lib/serverBrowser/protocol';
import { openExternalUrl } from '@/lib/url';
import { useUIStore } from '@/stores/useUIStore';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { BrowserRoute } from '@/stores/ui/contextPanel';

import { appendPendingSyntheticText } from './previewShared';
import { normalizeBrowserUrl, pageHost } from './browserScripts';
import { ConnectionOverlay, CrashedPage, FileChooserBar, PageDialog } from './ServerBrowserOverlays';
import { useServerBrowserFrames } from './useServerBrowserFrames';
import { useServerBrowserInput } from './useServerBrowserInput';

type Props = {
  initialUrl: string;
  directory: string;
  pageId: string;
  /** A popup the server is holding for this page; the first connection claims it. */
  popupId: string | null;
  /** The page is in an open panel and is its active page. */
  onScreen: boolean;
  routeToggle: React.ReactNode;
  onRouteChange: (route: BrowserRoute) => void;
};

const BLANK_STATE: ServerBrowserPageState = { url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false, crashed: false };
const HIDE_DISCONNECT_DELAY_MS = 1500;

/**
 * The PiChamber browser on the server route: a Chrome page running on the
 * PiChamber server, streamed to this device and driven from it. `localhost`
 * means the server. Pages never run in PiChamber's own origin.
 */
export const ServerBrowserPane: React.FC<Props> = ({ initialUrl, directory, pageId, popupId, onScreen, routeToggle, onRouteChange }) => {
  // Each page has its own server page; devices showing the same page share it.
  const tabKey = React.useMemo(() => serverBrowserTabKey(directory, pageId), [directory, pageId]);
  const updateBrowserPage = useUIStore((state) => state.updateBrowserPage);
  const openBrowserPopup = useUIStore((state) => state.openBrowserPopup);
  const closeBrowserPage = useUIStore((state) => state.closeBrowserPage);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => state.newSessionDraft?.open);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);

  const normalizedInitial = normalizeBrowserUrl(initialUrl);
  const startUrl = normalizedInitial !== 'about:blank' ? normalizedInitial : '';

  const [page, setPage] = React.useState<ServerBrowserPageState>(BLANK_STATE);
  const [phase, setPhase] = React.useState<ServerBrowserConnectionPhase>('idle');
  const [status, setStatus] = React.useState<ServerBrowserStatus | null>(null);
  const [failure, setFailure] = React.useState('');
  const [urlInput, setUrlInput] = React.useState(startUrl);
  const [cursor, setCursor] = React.useState('default');
  const [dialog, setDialog] = React.useState<ServerBrowserDialog | null>(null);
  const [promptText, setPromptText] = React.useState('');
  const [fileChooser, setFileChooser] = React.useState<{ id: number; multiple: boolean } | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [inspecting, setInspecting] = React.useState(false);
  const [hover, setHover] = React.useState<PreviewElementMetadata | null>(null);
  const [area, setArea] = React.useState({ width: 0, height: 0 });
  const [documentVisible, setDocumentVisible] = React.useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');

  const areaRef = React.useRef<HTMLDivElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const connectionRef = React.useRef<ServerBrowserConnection | null>(null);
  const lastUrlRef = React.useRef(startUrl);
  const popupRef = React.useRef(popupId);
  popupRef.current = popupId;
  const pendingNavigateRef = React.useRef<string | null>(null);
  const editingAddressRef = React.useRef(false);
  const seenDownloadsRef = React.useRef(new Map<string, string>());
  const inspectRef = React.useRef<{ seq: number; inFlight: boolean; queued: { x: number; y: number } | null }>({ seq: 0, inFlight: false, queued: null });
  const areaSizeRef = React.useRef(area);
  areaSizeRef.current = area;

  const send = React.useCallback((message: Record<string, unknown>) => connectionRef.current?.send(message) ?? false, []);
  const { canvasRef, headerRef, frameSize, onFrame, reset: resetFrames } = useServerBrowserFrames(() => connectionRef.current?.ack());

  const persistPage = React.useCallback((url: string, title: string) => {
    if (!url || url === 'about:blank' || !directory || !pageId) return;
    updateBrowserPage(directory, pageId, { url, title });
  }, [directory, pageId, updateBrowserPage]);

  const navigate = React.useCallback((value: string) => {
    const url = normalizeBrowserUrl(value);
    if (url === 'about:blank') {
      toast.warning('Enter an http or https address');
      return;
    }
    lastUrlRef.current = url;
    setUrlInput(url);
    if (!send({ type: 'navigate', url })) pendingNavigateRef.current = url;
  }, [send]);

  const sendViewport = React.useCallback(() => {
    const { width, height } = areaSizeRef.current;
    if (width <= 0 || height <= 0) return;
    send({ type: 'viewport', width: Math.round(width), height: Math.round(height), dpr: window.devicePixelRatio || 1 });
  }, [send]);

  const attachAnnotation = React.useCallback(async (target: PreviewElementMetadata, screenshot: { base64: string; width: number; height: number; cssWidth: number; cssHeight: number } | null) => {
    const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
    if (!sessionKey) {
      toast.error('Open a chat session before attaching preview annotations');
      return;
    }
    const file = screenshot
      ? await desktopAnnotationToFile(screenshot.base64, screenshot.width, screenshot.height, screenshot.cssWidth, screenshot.cssHeight, target)
      : null;
    if (file) await addAttachedFile(file);
    const cssWidth = screenshot?.cssWidth ?? headerRef.current?.width ?? 0;
    const cssHeight = screenshot?.cssHeight ?? headerRef.current?.height ?? 0;
    appendPendingSyntheticText(formatPreviewAnnotationMarkdown({
      pageUrl: lastUrlRef.current,
      viewport: { width: cssWidth, height: cssHeight },
      devicePixelRatio: screenshot && screenshot.cssWidth > 0 ? screenshot.width / screenshot.cssWidth : 1,
      target,
      screenshotAttached: Boolean(file),
      intro: file
        ? 'This is a selected DOM element from the in-app preview. A screenshot of the visible preview area with the selected element highlighted is attached.'
        : 'This is a selected DOM element from the in-app preview.',
    }));
    toast.success('Preview annotation attached to chat');
  }, [addAttachedFile, currentSessionId, headerRef, newSessionDraftOpen]);

  const handleMessage = (message: ServerBrowserMessage) => {
    switch (message.type) {
      case 'state': {
        const next: ServerBrowserPageState = {
          url: message.url,
          title: message.title,
          loading: message.loading,
          canGoBack: message.canGoBack,
          canGoForward: message.canGoForward,
          crashed: message.crashed,
        };
        setPage(next);
        if (next.url && next.url !== 'about:blank') {
          lastUrlRef.current = next.url;
          persistPage(next.url, next.title);
        }
        if (!editingAddressRef.current) setUrlInput(next.url === 'about:blank' ? '' : next.url);
        return;
      }
      case 'cursor':
        setCursor(message.cursor || 'default');
        return;
      case 'dialog':
        setDialog(message);
        setPromptText(message.defaultPrompt || '');
        return;
      case 'dialog-closed':
        setDialog(null);
        return;
      case 'file-chooser':
        setFileChooser({ id: message.id, multiple: message.multiple });
        return;
      case 'file-chooser-closed':
        setFileChooser((current) => (current?.id === message.id ? null : current));
        return;
      case 'clipboard':
        void copyTextToClipboard(message.text);
        return;
      case 'notice':
        if (message.kind === 'blocked-server-network') {
          toast.warning(`Blocked a page from opening ${pageHost(message.url)}`, {
            description: 'Sites on the internet cannot send the server browser to addresses on the server or its network. Type the address to open it yourself.',
          });
        } else if (message.kind === 'unsupported-address') {
          toast.warning('The server browser opens http and https addresses only');
        } else if (message.kind === 'upload-failed') {
          toast.error('Upload failed', { description: message.message });
        } else {
          toast.error(`Could not load ${pageHost(message.url)}`, { description: message.message });
        }
        return;
      case 'popup':
        if (!openBrowserPopup(directory, pageId, message.id)) {
          toast.warning('A page opened a popup, but too many tabs are open', {
            description: 'Close a tab, then try again.',
          });
        }
        return;
      case 'download': {
        const seen = seenDownloadsRef.current;
        if (seen.get(message.id) === message.state) return;
        seen.set(message.id, message.state);
        if (message.state === 'completed') {
          const { id, filename } = message;
          toast.success(`Downloaded ${filename}`, {
            action: {
              label: 'Save',
              onClick: () => {
                void saveServerBrowserDownload(id, filename).catch((error: unknown) => {
                  toast.error(error instanceof Error ? error.message : `Could not download ${filename}`);
                });
              },
            },
          });
        } else if (message.state === 'canceled') {
          toast.error(`Download of ${message.filename} failed`);
        }
        return;
      }
      case 'inspect-hover': {
        const inspect = inspectRef.current;
        if (message.requestId !== inspect.seq) return;
        inspect.inFlight = false;
        setHover(isPreviewElementMetadata(message.target) ? message.target : null);
        const queued = inspect.queued;
        inspect.queued = null;
        if (queued) requestInspect(queued.x, queued.y);
        return;
      }
      case 'inspect-pick':
        setHover(null);
        if (isPreviewElementMetadata(message.target)) void attachAnnotation(message.target, message.screenshot);
        return;
      case 'unavailable':
        if (message.status) setStatus(message.status);
        setFailure(message.message || '');
        return;
      default:
    }
  };
  const handleMessageRef = React.useRef(handleMessage);
  handleMessageRef.current = handleMessage;

  const requestInspect = (x: number, y: number) => {
    const inspect = inspectRef.current;
    if (inspect.inFlight) {
      inspect.queued = { x, y };
      return;
    }
    inspect.seq += 1;
    inspect.inFlight = send({ type: 'inspect', x, y, requestId: inspect.seq });
  };

  const input = useServerBrowserInput({
    send,
    canvasRef,
    headerRef,
    areaHeight: () => areaSizeRef.current.height,
    inspecting,
    onInspectHover: (point) => requestInspect(point.x, point.y),
    onInspectPick: (point) => {
      inspectRef.current.seq += 1;
      send({ type: 'inspect', ...point, pick: true, requestId: inspectRef.current.seq });
      setInspecting(false);
    },
  });
  const { focusKeyboard } = input;

  // One connection per tab, kept for the life of the pane.
  React.useEffect(() => {
    const connection = new ServerBrowserConnection(tabKey, () => ({ url: pendingNavigateRef.current || lastUrlRef.current, popup: popupRef.current }), {
      onPhase: (next) => {
        setPhase(next);
        if (next === 'open') setStatus(null);
      },
      onOpen: () => {
        // The server took the popup; later connections find the tab by key.
        if (popupRef.current) useUIStore.getState().updateBrowserPage(directory, pageId, { popupId: null });
        resetFrames();
        inspectRef.current.inFlight = false;
        sendViewport();
        const pending = pendingNavigateRef.current;
        pendingNavigateRef.current = null;
        if (pending) connection.send({ type: 'navigate', url: pending });
      },
      onMessage: (message) => handleMessageRef.current(message),
      onFrame,
    }, {
      open: openServerBrowserSocket,
      forgetToken: forgetServerBrowserSocketToken,
      setTimeout: (callback, ms) => window.setTimeout(callback, ms),
      clearTimeout: (handle) => window.clearTimeout(handle as number),
    });
    connectionRef.current = connection;
    return () => {
      connection.dispose();
      if (connectionRef.current === connection) connectionRef.current = null;
    };
  }, [directory, onFrame, pageId, resetFrames, sendViewport, tabKey]);

  // The page closed itself (a sign-in popup that is done), so its tab
  // closes here too.
  React.useEffect(() => {
    if (phase === 'closed') closeBrowserPage(directory, pageId);
  }, [closeBrowserPage, directory, pageId, phase]);

  // Stream only while the page is on screen: the panel is open on it and the
  // window is visible. Hidden pages keep their page on the server and
  // reconnect when shown; the empty-page server list stops polling too.
  const visible = onScreen && area.width > 0 && area.height > 0 && documentVisible;
  React.useEffect(() => {
    if (visible) {
      connectionRef.current?.setActive(true);
      return;
    }
    const timer = window.setTimeout(() => connectionRef.current?.setActive(false), HIDE_DISCONNECT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);

  React.useEffect(() => {
    const onVisibility = () => setDocumentVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  React.useEffect(() => {
    const element = areaRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setArea((current) => (current.width === width && current.height === height ? current : { width, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (phase !== 'open') return;
    const timer = window.setTimeout(sendViewport, 80);
    return () => window.clearTimeout(timer);
  }, [area, phase, sendViewport]);

  // The browser is unavailable but the server did not say why.
  React.useEffect(() => {
    if (phase !== 'unavailable' || status) return;
    let cancelled = false;
    void fetchServerBrowserStatus().then((next) => { if (!cancelled) setStatus(next); }).catch((error: unknown) => {
      if (!cancelled) setFailure(error instanceof Error ? error.message : 'Could not check the server browser');
    });
    return () => { cancelled = true; };
  }, [phase, status]);

  // An address set from outside the pane (an Open request) navigates.
  React.useEffect(() => {
    if (!startUrl || startUrl === lastUrlRef.current) return;
    navigate(startUrl);
    // Only react to the incoming address, not to local navigation state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUrl]);

  // Escape leaves inspect mode before the page sees it.
  React.useEffect(() => {
    if (!inspecting) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setInspecting(false);
      setHover(null);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [inspecting]);

  const respondDialog = (accept: boolean) => {
    send({ type: 'dialog', accept, text: dialog?.kind === 'prompt' ? promptText : undefined });
    setDialog(null);
    focusKeyboard();
  };

  const chooseFiles = async (files: FileList | null) => {
    const chooser = fileChooser;
    if (!chooser || !files || files.length === 0) return;
    const picked = chooser.multiple ? Array.from(files) : [files[0]];
    // The page keeps them in memory, so one answer stays under 50 MB.
    if (picked.reduce((total, file) => total + file.size, 0) > MAX_SERVER_BROWSER_UPLOAD_BYTES) {
      toast.warning(picked.length === 1 ? 'The file is too large' : 'The files are too large together', {
        description: 'The server browser uploads under 50 MB at a time.',
      });
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setUploading(true);
    try {
      const uploadIds = await Promise.all(picked.map((file) => uploadServerBrowserFile(file)));
      send({ type: 'file-chooser', id: chooser.id, uploadIds });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const display = frameSize ? fitDeviceViewport(frameSize, area) : null;
  const hasPage = page.url !== 'about:blank';
  const showBlank = phase === 'open' && !hasPage && !page.loading;

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <div className="flex items-center gap-1 border-b border-border bg-[var(--surface-background)] px-2 py-1">
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={!page.canGoBack} onClick={() => send({ type: 'back' })} aria-label="Back" title="Back">
          <Icon name="arrow-left" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={!page.canGoForward} onClick={() => send({ type: 'forward' })} aria-label="Forward" title="Forward">
          <Icon name="arrow-right" className="h-3.5 w-3.5" />
        </Button>
        {page.loading ? (
          <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => send({ type: 'stop' })} aria-label="Stop loading" title="Stop loading">
            <Icon name="close" className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={!hasPage} onClick={() => send({ type: 'reload' })} aria-label="Reload" title="Reload">
            <Icon name="refresh" className="h-3.5 w-3.5" />
          </Button>
        )}
        <form className="min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); editingAddressRef.current = false; navigate(urlInput); focusKeyboard(); }}>
          <input
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            onFocus={(event) => { editingAddressRef.current = true; event.currentTarget.select(); }}
            onBlur={() => { editingAddressRef.current = false; }}
            placeholder="Enter an address"
            className="h-7 w-full rounded-md border border-border/50 bg-[var(--surface-elevated)] px-2 typography-micro text-foreground outline-none focus:border-[var(--interactive-focus-ring)]"
            aria-label="Browser address"
          />
        </form>
        {routeToggle}
        <Button
          type="button"
          variant={inspecting ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 w-7 p-0"
          disabled={!hasPage || phase !== 'open'}
          aria-pressed={inspecting}
          onClick={() => { setInspecting((value) => !value); setHover(null); }}
          title="Inspect preview element"
          aria-label="Inspect preview element"
        >
          <Icon name="cursor" className="h-3.5 w-3.5" />
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" disabled={!hasPage} onClick={() => void openExternalUrl(page.url)} title="Open in system browser" aria-label="Open in system browser">
          <Icon name="external-link" className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div ref={areaRef} className="relative min-h-0 flex-1 overflow-hidden bg-background">
        <div className="absolute inset-0 flex items-start justify-start">
          <div className="relative" style={display ? { width: display.width, height: display.height } : { width: '100%', height: '100%' }}>
            <canvas
              ref={canvasRef}
              className="block h-full w-full touch-none select-none outline-none"
              style={{ cursor: inspecting ? 'crosshair' : cursor }}
              {...input.canvasHandlers}
              aria-label={page.title ? `Web page: ${page.title}` : 'Web page'}
              role="img"
            />
            {inspecting && hover && frameSize && display ? (
              <div
                className="pointer-events-none absolute rounded-sm border-2 border-[var(--interactive-focus-ring)] bg-[var(--interactive-focus-ring)]/35"
                style={{
                  left: hover.bounds.x * display.scale,
                  top: hover.bounds.y * display.scale,
                  width: hover.bounds.width * display.scale,
                  height: hover.bounds.height * display.scale,
                }}
              >
                <div className="absolute -top-6 left-0 max-w-64 truncate rounded bg-[var(--surface-elevated)] px-2 py-0.5 typography-micro text-foreground shadow">
                  {hover.tag}{hover.text ? ` · ${hover.text}` : ''}
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <textarea
          ref={input.keyboardRef}
          className="pointer-events-none absolute left-0 top-0 h-px w-px resize-none opacity-0"
          aria-label="Keyboard input for the web page"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          tabIndex={-1}
          {...input.keyboardHandlers}
        />
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          multiple={fileChooser?.multiple === true}
          onChange={(event) => void chooseFiles(event.target.files)}
        />

        {fileChooser ? (
          <FileChooserBar
            multiple={fileChooser.multiple}
            uploading={uploading}
            onChoose={() => fileInputRef.current?.click()}
            onCancel={() => send({ type: 'file-chooser', id: fileChooser.id, uploadIds: [] })}
          />
        ) : null}

        {dialog ? <PageDialog dialog={dialog} promptText={promptText} onPromptTextChange={setPromptText} onRespond={respondDialog} /> : null}

        {page.crashed ? <CrashedPage onReload={() => send({ type: 'reload' })} /> : null}

        <ConnectionOverlay
          phase={phase}
          status={status}
          failure={failure}
          hasFrame={frameSize !== null}
          showBlank={showBlank}
          directory={directory}
          onRetry={() => connectionRef.current?.retry()}
          onSetupRetry={() => { setStatus(null); setFailure(''); connectionRef.current?.retry(); }}
          onUseDevice={() => onRouteChange('device')}
          onOpenAddress={navigate}
        />
      </div>
    </div>
  );
};
