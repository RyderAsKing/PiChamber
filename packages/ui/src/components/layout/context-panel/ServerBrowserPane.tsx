import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { PiChamberLogo } from '@/components/ui/PiChamberLogo';
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
  isPasteShortcut,
  modifiersOf,
  serverBrowserTabKey,
  toPagePoint,
  type FrameHeader,
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
import { normalizeBrowserUrl } from './browserScripts';
import { ServerBrowserDevServers } from './ServerBrowserDevServers';
import { ServerBrowserSetup } from './ServerBrowserSetup';

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
const MULTI_CLICK_MS = 500;
const TOUCH_TAP_SLOP_PX = 6;

const isMacPlatform = (): boolean => (
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
);

const BUTTON_NAMES = ['left', 'middle', 'right'] as const;

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const dialogText = (dialog: ServerBrowserDialog): { message: string; accept: string; dismiss: string | null } => {
  if (dialog.kind === 'beforeunload') return { message: 'Leave this page? Changes you made may not be saved.', accept: 'Leave', dismiss: 'Stay' };
  if (dialog.kind === 'alert') return { message: dialog.message, accept: 'OK', dismiss: null };
  return { message: dialog.message, accept: 'OK', dismiss: 'Cancel' };
};

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
  const [frameSize, setFrameSize] = React.useState<{ width: number; height: number } | null>(null);
  const [area, setArea] = React.useState({ width: 0, height: 0 });
  const [documentVisible, setDocumentVisible] = React.useState(() => typeof document === 'undefined' || document.visibilityState === 'visible');

  const areaRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const keyboardRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const connectionRef = React.useRef<ServerBrowserConnection | null>(null);
  const frameHeaderRef = React.useRef<FrameHeader | null>(null);
  const lastUrlRef = React.useRef(startUrl);
  const popupRef = React.useRef(popupId);
  popupRef.current = popupId;
  const pendingNavigateRef = React.useRef<string | null>(null);
  const editingAddressRef = React.useRef(false);
  const seenDownloadsRef = React.useRef(new Map<string, string>());
  const drawRef = React.useRef<{ busy: boolean; pending: { header: FrameHeader; jpeg: Uint8Array } | null }>({ busy: false, pending: null });
  const inspectRef = React.useRef<{ seq: number; inFlight: boolean; queued: { x: number; y: number } | null }>({ seq: 0, inFlight: false, queued: null });
  const clickRef = React.useRef<{ at: number; x: number; y: number; count: number }>({ at: 0, x: 0, y: 0, count: 0 });
  const touchRef = React.useRef<{ id: number; startX: number; startY: number; lastX: number; lastY: number; moved: boolean } | null>(null);
  const areaSizeRef = React.useRef(area);
  areaSizeRef.current = area;

  const send = React.useCallback((message: Record<string, unknown>) => connectionRef.current?.send(message) ?? false, []);

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

  // Frames: decode off the main path, draw the newest, and acknowledge each
  // one so the server sends the next.
  const drawFrame = React.useCallback(async (header: FrameHeader, jpeg: Uint8Array) => {
    const state = drawRef.current;
    state.busy = true;
    try {
      const bitmap = await createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }));
      const canvas = canvasRef.current;
      const context = canvas?.getContext('2d');
      if (canvas && context) {
        if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
        if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
        context.drawImage(bitmap, 0, 0);
      }
      bitmap.close();
      const previous = frameHeaderRef.current;
      frameHeaderRef.current = header;
      if (!previous || previous.width !== header.width || previous.height !== header.height) {
        setFrameSize({ width: header.width, height: header.height });
      }
    } catch {
      // A frame that fails to decode is skipped; the next one replaces it.
    } finally {
      connectionRef.current?.ack();
      state.busy = false;
      const next = state.pending;
      state.pending = null;
      if (next) void drawFrame(next.header, next.jpeg);
    }
  }, []);

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
    const cssWidth = screenshot?.cssWidth ?? frameHeaderRef.current?.width ?? 0;
    const cssHeight = screenshot?.cssHeight ?? frameHeaderRef.current?.height ?? 0;
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
  }, [addAttachedFile, currentSessionId, newSessionDraftOpen]);

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
          toast.warning(`Blocked a page from opening ${hostOf(message.url)}`, {
            description: 'Sites on the internet cannot send the server browser to addresses on the server or its network. Type the address to open it yourself.',
          });
        } else if (message.kind === 'unsupported-address') {
          toast.warning('The server browser opens http and https addresses only');
        } else {
          toast.error(`Could not load ${hostOf(message.url)}`, { description: message.message });
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
        drawRef.current = { busy: false, pending: null };
        inspectRef.current.inFlight = false;
        sendViewport();
        const pending = pendingNavigateRef.current;
        pendingNavigateRef.current = null;
        if (pending) connection.send({ type: 'navigate', url: pending });
      },
      onMessage: (message) => handleMessageRef.current(message),
      onFrame: (header, jpeg) => {
        const state = drawRef.current;
        if (state.busy) {
          // Keep only the newest waiting frame; release the one it replaces.
          if (state.pending) connection.ack();
          state.pending = { header, jpeg };
          return;
        }
        void drawFrame(header, jpeg);
      },
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
  }, [directory, drawFrame, pageId, sendViewport, tabKey]);

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

  const pagePoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const header = frameHeaderRef.current;
    if (!canvas || !header) return null;
    return toPagePoint(clientX, clientY, canvas.getBoundingClientRect(), header);
  };

  // Wheel needs a non-passive listener to keep the panel from scrolling.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = pagePoint(event.clientX, event.clientY);
      if (!point) return;
      const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? areaSizeRef.current.height : 1;
      send({ type: 'mouse', action: 'wheel', ...point, deltaX: event.deltaX * scale, deltaY: event.deltaY * scale, modifiers: modifiersOf(event) });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
    // pagePoint reads refs only.
  }, [send]);

  const focusKeyboard = () => keyboardRef.current?.focus({ preventScroll: true });

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    // The press belongs to the page. Cancelling it also stops the mousedown
    // that would move focus off the keyboard input.
    event.preventDefault();
    focusKeyboard();
    const point = pagePoint(event.clientX, event.clientY);
    if (!point) return;
    if (event.pointerType === 'touch') {
      touchRef.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button === 3 || event.button === 4) {
      event.preventDefault();
      send({ type: event.button === 3 ? 'back' : 'forward' });
      return;
    }
    if (inspecting) {
      event.preventDefault();
      if (event.button !== 0) return;
      inspectRef.current.seq += 1;
      send({ type: 'inspect', ...point, pick: true, requestId: inspectRef.current.seq });
      setInspecting(false);
      return;
    }
    const button = BUTTON_NAMES[event.button] ?? 'left';
    const click = clickRef.current;
    const now = performance.now();
    const near = Math.abs(event.clientX - click.x) < 5 && Math.abs(event.clientY - click.y) < 5;
    click.count = now - click.at < MULTI_CLICK_MS && near ? Math.min(3, click.count + 1) : 1;
    click.at = now;
    click.x = event.clientX;
    click.y = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
    send({ type: 'mouse', action: 'down', ...point, button, buttons: event.buttons, clickCount: click.count, modifiers: modifiersOf(event) });
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pagePoint(event.clientX, event.clientY);
    if (!point) return;
    const touch = touchRef.current;
    if (event.pointerType === 'touch') {
      if (!touch || touch.id !== event.pointerId) return;
      if (Math.abs(event.clientX - touch.startX) > TOUCH_TAP_SLOP_PX || Math.abs(event.clientY - touch.startY) > TOUCH_TAP_SLOP_PX) touch.moved = true;
      if (!touch.moved) return;
      const header = frameHeaderRef.current;
      const rect = event.currentTarget.getBoundingClientRect();
      const scale = header && rect.width > 0 ? header.width / rect.width : 1;
      send({ type: 'mouse', action: 'wheel', ...point, deltaX: (touch.lastX - event.clientX) * scale, deltaY: (touch.lastY - event.clientY) * scale });
      touch.lastX = event.clientX;
      touch.lastY = event.clientY;
      return;
    }
    if (inspecting) {
      requestInspect(point.x, point.y);
      return;
    }
    send({ type: 'mouse', action: 'move', ...point, buttons: event.buttons, modifiers: modifiersOf(event) });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pagePoint(event.clientX, event.clientY);
    if (!point) return;
    if (event.pointerType === 'touch') {
      const touch = touchRef.current;
      touchRef.current = null;
      if (!touch || touch.id !== event.pointerId || touch.moved) return;
      send({ type: 'mouse', action: 'down', ...point, button: 'left', buttons: 1, clickCount: 1 });
      send({ type: 'mouse', action: 'up', ...point, button: 'left', buttons: 0, clickCount: 1 });
      return;
    }
    if (inspecting || event.button === 3 || event.button === 4) return;
    const button = BUTTON_NAMES[event.button] ?? 'left';
    send({ type: 'mouse', action: 'up', ...point, button, buttons: event.buttons, clickCount: clickRef.current.count || 1, modifiers: modifiersOf(event) });
  };

  const keyMessage = (action: 'down' | 'up', event: React.KeyboardEvent<HTMLTextAreaElement>) => ({
    type: 'key',
    action,
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    location: event.nativeEvent.location,
    repeat: event.repeat,
    modifiers: modifiersOf(event),
  });

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    // Let the paste event read this device's clipboard.
    if (isPasteShortcut(event, isMacPlatform())) return;
    event.preventDefault();
    event.stopPropagation();
    send(keyMessage('down', event));
  };

  const onKeyUp = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.stopPropagation();
    send(keyMessage('up', event));
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    if (text) send({ type: 'text', text });
  };

  const onCompositionEnd = (event: React.CompositionEvent<HTMLTextAreaElement>) => {
    if (event.data) send({ type: 'text', text: event.data });
    event.currentTarget.value = '';
  };

  const respondDialog = (accept: boolean) => {
    send({ type: 'dialog', accept, text: dialog?.kind === 'prompt' ? promptText : undefined });
    setDialog(null);
    focusKeyboard();
  };

  const chooseFiles = async (files: FileList | null) => {
    const chooser = fileChooser;
    if (!chooser || !files || files.length === 0) return;
    setUploading(true);
    try {
      const picked = chooser.multiple ? Array.from(files) : [files[0]];
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
  const dialogCopy = dialog ? dialogText(dialog) : null;

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
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => { touchRef.current = null; }}
              onMouseDown={(event) => event.preventDefault()}
              onContextMenu={(event) => event.preventDefault()}
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
          ref={keyboardRef}
          className="pointer-events-none absolute left-0 top-0 h-px w-px resize-none opacity-0"
          aria-label="Keyboard input for the web page"
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onPaste={onPaste}
          onCompositionEnd={onCompositionEnd}
          onInput={(event) => { if (!(event.nativeEvent as InputEvent).isComposing) event.currentTarget.value = ''; }}
        />
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          multiple={fileChooser?.multiple === true}
          onChange={(event) => void chooseFiles(event.target.files)}
        />

        {fileChooser ? (
          <div className="absolute inset-x-0 top-0 flex flex-wrap items-center gap-2 border-b border-border bg-[var(--surface-elevated)] px-3 py-2">
            <span className="min-w-0 flex-1 typography-micro text-foreground">
              {fileChooser.multiple ? 'This page asks for files.' : 'This page asks for a file.'}
            </span>
            <Button type="button" size="xs" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
              {uploading ? 'Uploading...' : fileChooser.multiple ? 'Choose files' : 'Choose file'}
            </Button>
            <Button type="button" variant="ghost" size="xs" disabled={uploading} onClick={() => send({ type: 'file-chooser', id: fileChooser.id, uploadIds: [] })}>
              {'Cancel'}
            </Button>
          </div>
        ) : null}

        {dialog && dialogCopy ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60 p-4">
            <form
              className="flex w-full max-w-sm flex-col gap-3 rounded-lg border border-border bg-[var(--surface-elevated)] p-4 shadow-lg"
              onSubmit={(event) => { event.preventDefault(); respondDialog(true); }}
            >
              <span className="typography-micro text-muted-foreground">{`${hostOf(dialog.url)} says`}</span>
              <p className="max-h-48 overflow-y-auto whitespace-pre-wrap typography-meta text-foreground [text-wrap:pretty]">{dialogCopy.message}</p>
              {dialog.kind === 'prompt' ? (
                <input
                  autoFocus
                  value={promptText}
                  onChange={(event) => setPromptText(event.target.value)}
                  className="h-8 rounded-md border border-border/50 bg-background px-2 typography-meta text-foreground outline-none focus:border-[var(--interactive-focus-ring)]"
                  aria-label="Answer"
                />
              ) : null}
              <div className="flex justify-end gap-2">
                {dialogCopy.dismiss ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => respondDialog(false)}>{dialogCopy.dismiss}</Button>
                ) : null}
                <Button type="submit" size="sm" autoFocus={dialog.kind !== 'prompt'}>{dialogCopy.accept}</Button>
              </div>
            </form>
          </div>
        ) : null}

        {page.crashed ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
            <span className="typography-ui-header text-foreground">{'This page crashed'}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => send({ type: 'reload' })}>{'Reload'}</Button>
          </div>
        ) : null}

        {phase === 'unavailable' ? (
          status ? (
            <ServerBrowserSetup status={status} onRetry={() => { setStatus(null); setFailure(''); connectionRef.current?.retry(); }} onUseDevice={() => onRouteChange('device')} />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
              <span className="typography-ui-header text-foreground">{'The server browser is not available'}</span>
              {failure ? <span className="max-w-md typography-micro text-muted-foreground [text-wrap:pretty]">{failure}</span> : null}
              <Button type="button" variant="outline" size="sm" onClick={() => connectionRef.current?.retry()}>{'Try again'}</Button>
            </div>
          )
        ) : phase === 'failed' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
            <span className="typography-ui-header text-foreground">{'Could not open this tab'}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => connectionRef.current?.retry()}>{'Try again'}</Button>
          </div>
        ) : (phase === 'connecting' || phase === 'reconnecting') && !frameSize ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background typography-micro text-muted-foreground">
            {phase === 'connecting' ? 'Starting the server browser...' : 'Reconnecting to the server browser...'}
          </div>
        ) : phase === 'reconnecting' ? (
          <div className="absolute inset-x-0 top-0 border-b border-border bg-[var(--surface-elevated)] px-3 py-1.5 typography-micro text-muted-foreground">
            {'Reconnecting to the server browser...'}
          </div>
        ) : showBlank ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center-safe gap-6 overflow-y-auto bg-background p-6 text-center">
            <PiChamberLogo width={140} height={140} className="opacity-20" />
            <span className="typography-ui-header text-muted-foreground">{'Web browser'}</span>
            <span className="max-w-sm typography-micro text-muted-foreground [text-wrap:pretty]">
              {'Pages run in a browser on the PiChamber server, so localhost addresses reach the server.'}
            </span>
            <ServerBrowserDevServers directory={directory} onOpen={navigate} />
          </div>
        ) : null}
      </div>
    </div>
  );
};
