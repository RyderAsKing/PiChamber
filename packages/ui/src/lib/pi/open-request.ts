import { isLoopbackBrowserUrl } from '@/components/layout/context-panel/browserRoute';

/**
 * Open requests (`session.openUrl`): something on the server machine asked
 * PiChamber to show the person a URL. Nothing opens by itself: every device
 * asks first, because opening a page can give it access (a page loaded
 * through the server in the web app shares PiChamber's origin). Pure
 * decisions here; `OpenRequestAlerts` performs them.
 */

/** A request older than this (server clock) is not shown at all; it was missed. */
export const OPEN_REQUEST_NOTICE_MS = 10 * 60_000;

interface OpenRequestInput {
  url: string;
  createdAt: number;
  serverNow: number;
}

export type OpenRequestTarget =
  /** Server-local address: the PiChamber browser, through the server. */
  | 'panel'
  /** Anything else: the device's own browser. */
  | 'external';

interface OpenRequestDecision {
  showNotice: boolean;
  target: OpenRequestTarget;
}

export const resolveOpenRequestTarget = (url: string): OpenRequestTarget => (
  isLoopbackBrowserUrl(url) ? 'panel' : 'external'
);

/** Age on the server's own clock, so device clock skew does not matter. */
const openRequestAgeMs = (request: Pick<OpenRequestInput, 'createdAt' | 'serverNow'>): number => (
  Math.max(0, request.serverNow - request.createdAt)
);

export const decideOpenRequest = (request: OpenRequestInput): OpenRequestDecision => ({
  showNotice: openRequestAgeMs(request) <= OPEN_REQUEST_NOTICE_MS,
  target: resolveOpenRequestTarget(request.url),
});

interface OpenRequestPromptContext {
  /** A phone-sized layout, which has no PiChamber browser. */
  isMobile: boolean;
  /**
   * The PiChamber browser keeps pages apart from PiChamber's own storage
   * (the desktop webview). Otherwise a page loaded through the server shares
   * PiChamber's origin and can act as the signed-in person.
   */
  isolatedBrowser: boolean;
}

interface OpenRequestPrompt {
  title: string;
  description: string;
  /** False when this device cannot show it; the notice only informs. */
  canOpen: boolean;
}

/** What the notice asking to open a request says on this device. */
export const describeOpenRequestPrompt = (
  label: string,
  target: OpenRequestTarget,
  context: OpenRequestPromptContext,
): OpenRequestPrompt => {
  if (target === 'external') {
    return { title: 'Open this page?', description: `${label}. Opens in your browser.`, canOpen: true };
  }
  if (context.isMobile) {
    return {
      title: 'A page is ready to view',
      description: `${label}. Open PiChamber on a larger screen to view it.`,
      canOpen: false,
    };
  }
  return {
    title: 'Open this page?',
    description: context.isolatedBrowser
      ? `${label}. Opens in the PiChamber browser.`
      : `${label}. It loads through the PiChamber server and can act as you in PiChamber. Open it only if you expected it.`,
    canOpen: true,
  };
};

/** A short label for a URL: host and path, without the query. */
export const describeOpenRequestUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    const label = `${parsed.host}${path}`;
    return label.length > 80 ? `${label.slice(0, 79)}…` : label;
  } catch {
    return url.slice(0, 80);
  }
};

// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`\u0000-\u001f]+/gi;

/**
 * The http(s) URLs in free text (an extension notice), unique, in order, at
 * most `limit`. Trailing punctuation unlikely to belong to the URL is dropped.
 */
export const extractOpenableUrls = (text: string, limit = 3): string[] => {
  if (!text) return [];
  const out: string[] = [];
  // Colored output puts an escape right before the URL; strip it first.
  for (const raw of text.replace(ANSI_SEQUENCE_PATTERN, ' ').match(HTTP_URL_PATTERN) ?? []) {
    const cleaned = raw.replace(/[),.;:!?'"`\]]+$/g, '');
    let parsed: URL;
    try {
      parsed = new URL(cleaned);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    if (out.includes(cleaned)) continue;
    out.push(cleaned);
    if (out.length >= limit) break;
  }
  return out;
};
