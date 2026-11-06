/**
 * Wire format of the server browser (`/api/server-browser/ws`). The server
 * side is `packages/web/server/lib/server-browser`; its DOCUMENTATION.md is
 * the protocol reference.
 */
import type { PreviewElementMetadata } from '@/lib/preview/screenshot-capture';

export type ServerBrowserPageState = {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed: boolean;
};

export type ServerBrowserProblem =
  | { kind: 'missing' }
  | { kind: 'missing-env'; envKey: string }
  | { kind: 'sandbox-root' }
  | { kind: 'launch-failed'; reason: 'missing-library' | 'sandbox-root' | 'sandbox-namespaces' | 'unknown'; library?: string; detail?: string };

export type ServerBrowserStatus = {
  running: boolean;
  isRoot: boolean;
  platform: string;
  allowNoSandbox: boolean;
  allowNoSandboxFromEnv: boolean;
  installCommands: string[];
  executable: { path: string; source: 'env' | 'system' | 'playwright' } | null;
  version: string | null;
  available: boolean;
  problem: ServerBrowserProblem | null;
};

export type ServerBrowserDialog = {
  kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultPrompt: string;
  url: string;
};

type ServerBrowserDownload = {
  id: string;
  filename: string;
  state: 'inProgress' | 'completed' | 'canceled';
  receivedBytes: number;
  totalBytes: number;
};

export type ServerBrowserScreenshot = {
  base64: string;
  width: number;
  height: number;
  cssWidth: number;
  cssHeight: number;
};

type ServerBrowserNotice =
  | { kind: 'blocked-server-network'; url: string }
  | { kind: 'unsupported-address'; url: string }
  | { kind: 'navigation-failed'; url: string; message?: string };

export type ServerBrowserMessage =
  | ({ type: 'state' } & ServerBrowserPageState)
  | { type: 'cursor'; cursor: string }
  | ({ type: 'dialog' } & ServerBrowserDialog)
  | { type: 'dialog-closed' }
  | { type: 'file-chooser'; id: number; multiple: boolean }
  | { type: 'file-chooser-closed'; id: number }
  | { type: 'clipboard'; text: string }
  | ({ type: 'notice' } & ServerBrowserNotice)
  | ({ type: 'download' } & ServerBrowserDownload)
  | { type: 'inspect-hover'; requestId: number; target: PreviewElementMetadata | null }
  | { type: 'inspect-pick'; requestId: number; target: PreviewElementMetadata | null; screenshot: ServerBrowserScreenshot | null }
  | { type: 'unavailable'; status: ServerBrowserStatus; message?: string };

export type FrameHeader = {
  seq: number;
  /** The page's size in CSS pixels. */
  width: number;
  height: number;
  offsetTop: number;
  pageScaleFactor: number;
};

/** Splits a binary frame into its JSON header and JPEG bytes. */
export const decodeFrame = (data: ArrayBuffer): { header: FrameHeader; jpeg: Uint8Array } | null => {
  if (data.byteLength < 4) return null;
  const headerLength = new DataView(data).getUint32(0);
  if (headerLength <= 0 || 4 + headerLength > data.byteLength) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, headerLength))) as FrameHeader;
    if (!Number.isFinite(header?.width) || !Number.isFinite(header?.height)) return null;
    return { header, jpeg: new Uint8Array(data, 4 + headerLength) };
  } catch {
    return null;
  }
};

export const parseServerBrowserMessage = (data: string): ServerBrowserMessage | null => {
  try {
    const message = JSON.parse(data) as ServerBrowserMessage;
    return message && typeof message === 'object' && typeof message.type === 'string' ? message : null;
  } catch {
    return null;
  }
};

/**
 * What a viewer does when its socket closes. Codes match `CLOSE_CODES` in
 * the server runtime.
 */
export const closeAction = (code: number): 'reconnect' | 'unavailable' | 'stop' => {
  if (code === 4003) return 'unavailable';
  if (code === 4004) return 'stop';
  // 4000 closed elsewhere, 4001 Chrome exited, 4002 restarting, and network
  // drops all reopen the tab at its last address.
  return 'reconnect';
};

export const RECONNECT_DELAYS_MS = [250, 1000, 2000, 4000, 8000];

/**
 * The server keys tabs by this string; viewers of the same PiChamber browser
 * tab on any device share one page.
 */
export const serverBrowserTabKey = (directory: string, tabID: string): string => {
  // Tab ids repeat across directories, so the key covers both. Two 32-bit
  // FNV-1a passes with different seeds keep it stable and collision-safe
  // for the handful of tabs a server holds.
  const fnv = (seed: number) => {
    let hash = seed >>> 0;
    for (const char of `${directory}\0${tabID}`) {
      hash ^= char.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36).padStart(7, '0');
  };
  return `tab-${fnv(0x811c9dc5)}${fnv(0x01000193)}`;
};

type Modifiers = { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };

export const modifiersOf = (event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): Modifiers => ({
  alt: event.altKey,
  ctrl: event.ctrlKey,
  meta: event.metaKey,
  shift: event.shiftKey,
});

/** A point in the displayed frame, in the page's CSS pixels. */
export const toPagePoint = (
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  page: { width: number; height: number },
): { x: number; y: number } | null => {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = ((clientX - rect.left) / rect.width) * page.width;
  const y = ((clientY - rect.top) / rect.height) * page.height;
  return {
    x: Math.round(Math.max(0, Math.min(page.width - 1, x)) * 100) / 100,
    y: Math.round(Math.max(0, Math.min(page.height - 1, y)) * 100) / 100,
  };
};

/**
 * Keys the device should keep: pasting reads this device's clipboard, which
 * the page then gets as text.
 */
export const isPasteShortcut = (event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, isMac: boolean): boolean => {
  if (event.key.toLowerCase() !== 'v' || event.altKey) return false;
  return isMac ? event.metaKey : event.ctrlKey;
};

/**
 * The fitted size of a page's frame inside the pane, never larger than the
 * frame itself.
 */
export const fitDeviceViewport = (
  device: { width: number; height: number },
  available: { width: number; height: number },
): { width: number; height: number; scale: number } => {
  const scale = Math.min(1, available.width / device.width, available.height / device.height);
  const safe = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return { width: Math.round(device.width * safe), height: Math.round(device.height * safe), scale: safe };
};
