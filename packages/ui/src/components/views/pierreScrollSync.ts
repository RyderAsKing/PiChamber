/**
 * Sticky horizontal scrollbar sync for Pierre (@pierre/diffs) views.
 *
 * Pierre renders code into a `<diffs-container>` host with an open shadow
 * root; the real horizontal scroller is `[data-code]` inside that shadow
 * root (`overflow: var(--diffs-overflow-override, scroll) clip`). In panes
 * that scroll vertically (the git stacked diff view, the Files view), each
 * file's native horizontal bar sits at the very bottom of its own diff,
 * often far below the viewport. `<StickyHorizontalScrollbar>` renders a
 * thin proxy bar that sticks to the bottom of the *visible* pane
 * (`position: sticky; bottom: 0`) and drives the shadow scroller(s)
 * bidirectionally; this module owns the shadow-DOM access pattern (shared
 * with `PierreDiffViewer`, which reaches into `diffs-container.shadowRoot`
 * the same way) and the hide-native-bar CSS.
 *
 * Both `FileDiff` and `File` React components render the same
 * `diffs-container` host tag, so one finder covers diff and file views;
 * unified mode yields one `[data-code]`, split mode yields two (kept in
 * sync by Pierre internally, and by us).
 *
 * Perf contract (scroll handlers are a hot path):
 * - Scroll listeners write `scrollLeft` DOM properties directly; no React
 *   state updates per scroll. React state changes only on the
 *   hidden/visible transition.
 * - Width measurement is batched in rAF; MutationObserver/ResizeObserver
 *   callbacks only schedule a refresh (coalesced), never measure inline.
 * - Loop safety comes from equality checks (assigning an unchanged
 *   `scrollLeft` fires no event, so echoes converge) plus a synchronous
 *   re-entrancy flag for same-task dispatch.
 */

/**
 * Injected into Pierre's shadow root (`@layer unsafe`) wherever the proxy
 * bar is active. Hides the native per-file horizontal bar so there are not
 * two bars. Scoped to `[data-overflow="scroll"]` so wrap mode keeps native
 * behavior without any gating at the call site.
 */
export const PIERRE_STICKY_SCROLLBAR_HIDE_CSS = `
  [data-overflow="scroll"] [data-code] {
    scrollbar-width: none;
  }
  [data-overflow="scroll"] [data-code]::-webkit-scrollbar {
    height: 0;
  }
`;

/**
 * Find every live horizontal scroller under `host`. Covers both Pierre
 * hosts (`FileDiff` and `File` render `<diffs-container>`) and both modes
 * (unified: one `[data-code]`; split: deletions + additions).
 */
export function findPierreScrollers(host: Element | null): HTMLElement[] {
  if (!host) return [];
  const containers: Element[] = [];
  if (host.tagName === 'DIFFS-CONTAINER') containers.push(host);
  const found = host.querySelectorAll('diffs-container');
  for (const container of found) containers.push(container);
  const scrollers: HTMLElement[] = [];
  for (const container of containers) {
    const shadowRoot = (container as HTMLElement).shadowRoot;
    if (!shadowRoot) continue;
    const codes = shadowRoot.querySelectorAll('[data-code]');
    for (const code of codes) scrollers.push(code as HTMLElement);
  }
  return scrollers;
}

/** Find every Pierre shadow root under `host` (for change observation). */
export function findPierreShadowRoots(host: Element | null): ShadowRoot[] {
  if (!host) return [];
  const containers: Element[] = [];
  if (host.tagName === 'DIFFS-CONTAINER') containers.push(host);
  const found = host.querySelectorAll('diffs-container');
  for (const container of found) containers.push(container);
  const roots: ShadowRoot[] = [];
  for (const container of containers) {
    const shadowRoot = (container as HTMLElement).shadowRoot;
    if (shadowRoot) roots.push(shadowRoot);
  }
  return roots;
}

/**
 * Copy `scrollLeft` from `source` to every target whose position differs.
 * Assigning an unchanged `scrollLeft` fires no scroll event, so
 * proxy<->scroller echoes converge instead of looping.
 */
export function syncScrollLeft(
  source: Pick<HTMLElement, 'scrollLeft'>,
  targets: Array<Pick<HTMLElement, 'scrollLeft'>>,
): void {
  const value = source.scrollLeft;
  for (const target of targets) {
    if (target.scrollLeft !== value) target.scrollLeft = value;
  }
}

/**
 * Largest horizontal overflow (`scrollWidth - clientWidth`) across the
 * scrollers. The proxy is sized by overflow, not raw content width, so its
 * scroll range matches the scrollers even when they are narrower than the
 * proxy (split mode: each side is half the width). Rows may be windowed
 * (virtualized diffs only render the visible window), so this is
 * recomputed as rows render.
 */
export function maxScrollOverflowOf(
  scrollers: Array<Pick<HTMLElement, 'scrollWidth' | 'clientWidth'>>,
): number {
  let max = 0;
  for (const scroller of scrollers) {
    const overflow = scroller.scrollWidth - scroller.clientWidth;
    if (overflow > max) max = overflow;
  }
  return max;
}

/** The proxy bar is only useful when content actually overflows (1px tolerance). */
export function isHorizontallyOverflowing(overflow: number): boolean {
  return overflow > 1;
}

export interface StickyScrollbarController {
  /** Re-discover scrollers and recompute width/visibility. */
  refresh: () => void;
  /** Remove every listener/observer. */
  dispose: () => void;
}

export interface StickyScrollbarControllerOptions {
  /** The sticky proxy bar (scrolls horizontally, drives the scrollers). */
  proxy: HTMLElement;
  /** Inner spacer whose width mirrors the widest scroller content. */
  spacer: HTMLElement;
  /** Pierre host subtree; called on every refresh so re-renders resolve. */
  getHost: () => Element | null;
  /** Called only on hidden/visible transitions (never per scroll). */
  onVisibilityChange: (visible: boolean) => void;
}

const sameMembers = (a: HTMLElement[], b: HTMLElement[]): boolean =>
  a.length === b.length && a.every((item, index) => b[index] === item);

/**
 * Framework-agnostic controller behind `<StickyHorizontalScrollbar>`.
 * Everything DOM-facing lives here so the sync logic is unit-testable
 * without a browser; the React wrapper is only refs + one boolean.
 */
export function createStickyScrollbarController(
  options: StickyScrollbarControllerOptions,
): StickyScrollbarController {
  const { proxy, spacer, getHost, onVisibilityChange } = options;

  let scrollers: HTMLElement[] = [];
  let detachScrollerListeners: (() => void) | null = null;
  let hostObserver: MutationObserver | null = null;
  let shadowObservers: MutationObserver[] = [];
  let sizeObserver: ResizeObserver | null = null;
  let rafId: number | null = null;
  let disposed = false;
  let visible = false;
  let syncing = false;

  const setVisible = (next: boolean): void => {
    if (next === visible) return;
    visible = next;
    onVisibilityChange(next);
  };

  const handleProxyScroll = (): void => {
    if (syncing) return;
    syncing = true;
    try {
      // One proxy drives every scroller (split mode: deletions + additions,
      // matching Pierre's own synced-panes behavior).
      syncScrollLeft(proxy, scrollers);
    } finally {
      syncing = false;
    }
  };

  const handleScrollerScroll = (source: HTMLElement): void => {
    if (syncing) return;
    syncing = true;
    try {
      syncScrollLeft(source, [proxy]);
      for (const scroller of scrollers) {
        if (scroller !== source && scroller.scrollLeft !== source.scrollLeft) {
          scroller.scrollLeft = source.scrollLeft;
        }
      }
    } finally {
      syncing = false;
    }
  };

  const refresh = (): void => {
    if (disposed) return;
    const host = getHost();
    const next = findPierreScrollers(host);
    if (!sameMembers(scrollers, next)) {
      detachScrollerListeners?.();
      scrollers = next;
      const cleanups: Array<() => void> = [];
      for (const scroller of scrollers) {
        const listener = (): void => handleScrollerScroll(scroller);
        scroller.addEventListener('scroll', listener, { passive: true });
        cleanups.push(() => scroller.removeEventListener('scroll', listener));
      }
      detachScrollerListeners = () => {
        for (const cleanup of cleanups) cleanup();
      };
      observeShadowRoots();
      observeSizes();
    }
    const overflow = maxScrollOverflowOf(scrollers);
    spacer.style.width = `${proxy.clientWidth + overflow}px`;
    setVisible(isHorizontallyOverflowing(overflow));
  };

  const scheduleRefresh = (): void => {
    if (disposed || rafId !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      rafId = requestAnimationFrame(() => {
        rafId = null;
        refresh();
      });
    } else {
      refresh();
    }
  };

  const observeShadowRoots = (): void => {
    for (const observer of shadowObservers) observer.disconnect();
    shadowObservers = [];
    if (typeof MutationObserver === 'undefined') return;
    for (const root of findPierreShadowRoots(getHost())) {
      const observer = new MutationObserver(scheduleRefresh);
      observer.observe(root, { childList: true, subtree: true });
      shadowObservers.push(observer);
    }
  };

  const observeSizes = (): void => {
    sizeObserver?.disconnect();
    if (typeof ResizeObserver === 'undefined') return;
    sizeObserver = new ResizeObserver(scheduleRefresh);
    sizeObserver.observe(proxy);
    for (const scroller of scrollers) sizeObserver.observe(scroller);
  };

  proxy.addEventListener('scroll', handleProxyScroll, { passive: true });

  if (typeof MutationObserver !== 'undefined') {
    // Pierre renders async and re-renders on highlight/virtualization;
    // re-discover `[data-code]` scrollers when the host subtree changes.
    hostObserver = new MutationObserver(scheduleRefresh);
    const host = getHost();
    if (host) hostObserver.observe(host, { childList: true, subtree: true });
  }

  refresh();

  const dispose = (): void => {
    disposed = true;
    if (rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    proxy.removeEventListener('scroll', handleProxyScroll);
    detachScrollerListeners?.();
    detachScrollerListeners = null;
    hostObserver?.disconnect();
    hostObserver = null;
    for (const observer of shadowObservers) observer.disconnect();
    shadowObservers = [];
    sizeObserver?.disconnect();
    sizeObserver = null;
  };

  return { refresh, dispose };
}
