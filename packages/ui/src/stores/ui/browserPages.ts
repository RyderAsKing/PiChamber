import type { BrowserRoute } from './contextPanel';

/**
 * Pages in the PiChamber browser: the tabs in the strip under the Browser
 * header. A project has one Browser panel tab; it holds these pages. Pure
 * state transitions here; `useUIStore` applies them.
 */
export interface BrowserPage {
  id: string;
  /** Last address shown, or null for a new, empty page. */
  url: string | null;
  /** Null means the default route (see `resolveBrowserRoute`). */
  route: BrowserRoute | null;
  /** The page's title when the pane can read it. */
  title: string | null;
  /**
   * A popup the server is holding for this page, until the page's first
   * connection claims it. Not restored: a claim lasts seconds.
   */
  popupId?: string;
}

export interface BrowserPages {
  pages: BrowserPage[];
  activePageId: string | null;
}

/** More pages than this open in the active page instead of a new one. */
export const MAX_BROWSER_PAGES = 12;
const MAX_URL_LENGTH = 4096;
const MAX_TITLE_LENGTH = 200;
const PAGE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;

const createBrowserPageId = (): string => `page-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

const normalizeUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'about:blank') return null;
  return trimmed.slice(0, MAX_URL_LENGTH);
};

const normalizeTitle = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, MAX_TITLE_LENGTH) : null;
};

const normalizeRoute = (value: unknown): BrowserRoute | null => (value === 'server' || value === 'device' ? value : null);

const activeIdFor = (pages: BrowserPage[], preferred: string | null): string | null => {
  if (preferred && pages.some((page) => page.id === preferred)) return preferred;
  return pages[0]?.id ?? null;
};

/**
 * Restores persisted pages. A Browser tab saved before pages existed becomes
 * one page with the tab's own id, so a page already running on the server
 * (keyed by that id) reattaches.
 */
export const sanitizeBrowserPages = (
  value: unknown,
  legacy: { tabId: string; url: string | null; route: BrowserRoute | null },
): BrowserPages => {
  const raw = value && typeof value === 'object' ? value as { pages?: unknown; activePageId?: unknown } : null;
  const pages: BrowserPage[] = [];
  const seen = new Set<string>();
  if (raw && Array.isArray(raw.pages)) {
    for (const entry of raw.pages) {
      if (!entry || typeof entry !== 'object') continue;
      const candidate = entry as Record<string, unknown>;
      const id = typeof candidate.id === 'string' ? candidate.id : '';
      if (!PAGE_ID_PATTERN.test(id) || seen.has(id)) continue;
      seen.add(id);
      pages.push({
        id,
        url: normalizeUrl(candidate.url),
        route: normalizeRoute(candidate.route),
        title: normalizeTitle(candidate.title),
      });
      if (pages.length >= MAX_BROWSER_PAGES) break;
    }
  }
  if (pages.length === 0) {
    pages.push({ id: legacy.tabId, url: normalizeUrl(legacy.url), route: legacy.route, title: null });
  }
  const activePageId = typeof raw?.activePageId === 'string' ? raw.activePageId : null;
  return { pages, activePageId: activeIdFor(pages, activePageId) };
};

/**
 * A Browser tab's pages when it first opens: one page with a fresh id. The
 * id keys the page's server tab, so it is never shared with a Browser tab
 * opened before or on another device.
 */
export const createBrowserPages = (
  input: { url: string | null; route: BrowserRoute | null },
  createId: () => string = createBrowserPageId,
): BrowserPages => {
  const id = createId();
  return { pages: [{ id, url: normalizeUrl(input.url), route: normalizeRoute(input.route), title: null }], activePageId: id };
};

export type BrowserPageTarget =
  /** A new page, or the active one when it is still empty. */
  | 'new'
  /** The page showing now. */
  | 'current';

/**
 * Opens `url` (or an empty page when `url` is null). Returns the state and
 * the page it landed on.
 */
export const openBrowserPage = (
  state: BrowserPages,
  input: { url: string | null; route?: BrowserRoute | null; target: BrowserPageTarget },
  createId: () => string = createBrowserPageId,
): BrowserPages & { pageId: string } => {
  const url = normalizeUrl(input.url);
  const route = normalizeRoute(input.route);
  const active = state.pages.find((page) => page.id === state.activePageId) ?? null;
  const reuseActive = active && (
    input.target === 'current'
    || (url !== null && active.url === null)
    || state.pages.length >= MAX_BROWSER_PAGES
  );
  if (active && reuseActive) {
    // A page keeps its route unless the caller asks for another one.
    const pages = state.pages.map((page) => (page.id === active.id
      ? { ...page, url: url ?? page.url, route: route ?? page.route, title: url && url !== page.url ? null : page.title }
      : page));
    return { pages, activePageId: active.id, pageId: active.id };
  }
  const page: BrowserPage = { id: createId(), url, route, title: null };
  // New pages open next to the active one, as in a desktop browser.
  const activeIndex = active ? state.pages.indexOf(active) : state.pages.length - 1;
  const pages = [...state.pages.slice(0, activeIndex + 1), page, ...state.pages.slice(activeIndex + 1)];
  return { pages, activePageId: page.id, pageId: page.id };
};

/**
 * Opens a server page for a popup next to the page that opened it. Returns
 * null at the page limit: a popup never replaces a page.
 */
export const openBrowserPopup = (
  state: BrowserPages,
  input: { openerPageId: string; popupId: string },
  createId: () => string = createBrowserPageId,
): (BrowserPages & { pageId: string }) | null => {
  if (state.pages.length >= MAX_BROWSER_PAGES) return null;
  const page: BrowserPage = { id: createId(), url: null, route: 'server', title: null, popupId: input.popupId };
  const openerIndex = state.pages.findIndex((entry) => entry.id === input.openerPageId);
  const index = openerIndex === -1 ? state.pages.length - 1 : openerIndex;
  const pages = [...state.pages.slice(0, index + 1), page, ...state.pages.slice(index + 1)];
  return { pages, activePageId: page.id, pageId: page.id };
};

/**
 * Closes a page and shows its right neighbour, or the left one when it was
 * last. Closing the only page leaves one empty page.
 */
export const closeBrowserPage = (
  state: BrowserPages,
  pageId: string,
  createId: () => string = createBrowserPageId,
): BrowserPages => {
  const index = state.pages.findIndex((page) => page.id === pageId);
  if (index === -1) return state;
  const pages = state.pages.filter((page) => page.id !== pageId);
  if (pages.length === 0) {
    const page: BrowserPage = { id: createId(), url: null, route: state.pages[index].route, title: null };
    return { pages: [page], activePageId: page.id };
  }
  if (state.activePageId !== pageId) return { pages, activePageId: activeIdFor(pages, state.activePageId) };
  const next = pages[Math.min(index, pages.length - 1)];
  return { pages, activePageId: next.id };
};

export const activateBrowserPage = (state: BrowserPages, pageId: string): BrowserPages => (
  state.activePageId !== pageId && state.pages.some((page) => page.id === pageId) ? { ...state, activePageId: pageId } : state
);

export type BrowserPagePatch = {
  url?: string | null;
  title?: string | null;
  route?: BrowserRoute;
  /** Sets the route only while the page has none, so it never overrides a pick. */
  defaultRoute?: BrowserRoute;
  /** Drops the page's popup claim once its connection made it. */
  popupId?: null;
};

/** Records what a page shows: its address, title, or route. */
export const updateBrowserPage = (
  state: BrowserPages,
  pageId: string,
  patch: BrowserPagePatch,
): BrowserPages => {
  let changed = false;
  const pages = state.pages.map((page) => {
    if (page.id !== pageId) return page;
    const next = { ...page };
    if (patch.url !== undefined) {
      const url = normalizeUrl(patch.url);
      // An empty address never erases the last page shown.
      if (url && url !== page.url) next.url = url;
    }
    if (patch.title !== undefined) next.title = normalizeTitle(patch.title);
    if (patch.route !== undefined) next.route = normalizeRoute(patch.route) ?? page.route;
    if (patch.defaultRoute !== undefined && next.route === null) next.route = normalizeRoute(patch.defaultRoute);
    if (patch.popupId === null) delete next.popupId;
    if (next.url !== page.url || next.title !== page.title || next.route !== page.route || next.popupId !== page.popupId) changed = true;
    return changed ? next : page;
  });
  return changed ? { ...state, pages } : state;
};

/** A short label for a page in the strip. */
export const browserPageLabel = (page: BrowserPage): string => {
  if (page.title) return page.title;
  if (!page.url) return 'New tab';
  try {
    const parsed = new URL(page.url);
    return parsed.host || page.url;
  } catch {
    return page.url;
  }
};
