import { normalizeDirectoryPathKey } from '@/lib/directoryPathKey';

import { sanitizeBrowserPages, type BrowserPages } from './browserPages';

export type MainTab = 'chat' | 'git' | 'diff' | 'terminal' | 'files' | 'context' | 'diagram';
export type PendingDiffScope = 'all' | 'working' | 'staged' | 'turn' | 'branch';
export type ContextPanelMode = 'diff' | 'file' | 'context' | 'preview' | 'browser' | 'git' | 'terminal' | 'pull-requests' | 'issues' | 'extensions';
// Where a PiChamber browser page runs: in the server's Chrome, streamed to
// the device, or on the device itself (a webview or iframe).
export type BrowserRoute = 'server' | 'device';

export interface ContextPanelTab {
  id: string;
  mode: ContextPanelMode;
  targetPath: string | null;
  dedupeKey: string;
  label: string | null;
  sessionTitleFallback: string | null;
  readOnly: boolean;
  stagedDiff: boolean;
  diffScope: PendingDiffScope | null;
  // Browser tabs only: the pages in the browser's tab strip. Browser tabs
  // keep `targetPath` null; each page has its own address and route.
  browser: BrowserPages | null;
  touchedAt: number;
}

export interface ContextPanelTabDescriptor {
  mode: ContextPanelMode;
  targetPath?: string | null;
  dedupeKey?: string | null;
  label?: string | null;
  sessionTitleFallback?: string | null;
  readOnly?: boolean;
  stagedDiff?: boolean;
  diffScope?: PendingDiffScope | null;
  // Browser tabs only: the first page's route; `targetPath` is its address.
  browserRoute?: BrowserRoute | null;
}

export interface ContextPanelDirectoryState {
  isOpen: boolean;
  expanded: boolean;
  tabs: ContextPanelTab[];
  activeTabId: string | null;
  // Manual panel width (px) shared by every surface. Missing values fall back
  // to CONTEXT_SURFACE_DEFAULT_WIDTH_FRACTION.
  width?: number;
  touchedAt: number;
}

export const CONTEXT_PANEL_DEFAULT_WIDTH = 380;
export const CONTEXT_PANEL_MIN_WIDTH = 380;
export const CONTEXT_PANEL_MAX_WIDTH = 1400;
export const CONTEXT_PANEL_MAX_TABS = 12;
export const CONTEXT_PANEL_MAX_LABEL_LENGTH = 120;

export const CONTEXT_PANEL_SHARED_WIDTH_FALLBACK_MODES: ContextPanelMode[] = [
  'git',
  'file',
  'diff',
  'context',
  'terminal',
  'browser',
  'preview',
  'pull-requests',
  'issues',
  'extensions',
];

// Shared with rail/panel consumers so contextPanelByDirectory lookups agree on keys.
export const normalizeContextPanelDirectoryKey = normalizeDirectoryPathKey;

export const clampContextPanelWidth = (width: number): number => {
  if (!Number.isFinite(width)) {
    return CONTEXT_PANEL_DEFAULT_WIDTH;
  }

  return Math.min(CONTEXT_PANEL_MAX_WIDTH, Math.max(CONTEXT_PANEL_MIN_WIDTH, Math.round(width)));
};

export const resolveSharedContextPanelWidth = (candidate: {
  width?: unknown;
  widthByMode?: unknown;
}): number | undefined => {
  if (typeof candidate.width === 'number' && Number.isFinite(candidate.width)) {
    return clampContextPanelWidth(candidate.width);
  }
  if (!candidate.widthByMode || typeof candidate.widthByMode !== 'object') {
    return undefined;
  }
  const byMode = candidate.widthByMode as Record<string, unknown>;
  for (const mode of CONTEXT_PANEL_SHARED_WIDTH_FALLBACK_MODES) {
    const value = byMode[mode];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return clampContextPanelWidth(value);
    }
  }
  for (const value of Object.values(byMode)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return clampContextPanelWidth(value);
    }
  }
  return undefined;
};

export const normalizeContextTargetPath = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/\\/g, '/');
};

export const normalizeContextTabLabel = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.length > CONTEXT_PANEL_MAX_LABEL_LENGTH
    ? trimmed.slice(0, CONTEXT_PANEL_MAX_LABEL_LENGTH)
    : trimmed;
};

export const normalizeBrowserRoute = (value: unknown): BrowserRoute | null => {
  return value === 'server' || value === 'device' ? value : null;
};

export const normalizePendingDiffScope = (value: unknown): PendingDiffScope | null => {
  return value === 'all' || value === 'working' || value === 'staged' || value === 'turn' || value === 'branch'
    ? value
    : null;
};

export const buildDefaultContextPanelTabDedupeKey = (
  mode: ContextPanelMode,
  targetPath: string | null,
): string => {
  if (mode === 'file') {
    return targetPath || mode;
  }

  if (mode === 'preview') {
    return targetPath || mode;
  }

  return mode;
};

export const normalizeContextPanelTabDedupeKey = (
  mode: ContextPanelMode,
  targetPath: string | null,
  dedupeKey: string | null | undefined,
): string => {
  if (mode === 'diff') {
    return mode;
  }

  // One Browser tab per project, however it was opened (the rail or a link).
  if (mode === 'browser') {
    return BROWSER_TAB_DEDUPE_KEY;
  }

  if (typeof dedupeKey === 'string') {
    const trimmed = dedupeKey.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return buildDefaultContextPanelTabDedupeKey(mode, targetPath);
};

export const buildContextPanelTabID = (mode: ContextPanelMode, dedupeKey: string): string => {
  return dedupeKey === mode ? mode : `${mode}:${dedupeKey}`;
};

// The PiChamber browser is one panel tab per project; its pages are tabs
// inside it.
export const BROWSER_TAB_DEDUPE_KEY = 'desktop-browser';
export const BROWSER_TAB_ID = `browser:${BROWSER_TAB_DEDUPE_KEY}`;

/** Applies `update` to the Browser tab's pages; unchanged when there is none. */
export const updateBrowserTabPages = (
  current: ContextPanelDirectoryState,
  update: (pages: BrowserPages) => BrowserPages,
): ContextPanelDirectoryState => {
  let changed = false;
  const tabs = current.tabs.map((tab) => {
    if (tab.id !== BROWSER_TAB_ID || !tab.browser) return tab;
    const next = update(tab.browser);
    if (next === tab.browser) return tab;
    changed = true;
    return { ...tab, browser: { pages: next.pages, activePageId: next.activePageId } };
  });
  return changed ? { ...current, tabs } : current;
};

export const createContextPanelTab = (descriptor: ContextPanelTabDescriptor): ContextPanelTab => {
  const normalizedTargetPath = normalizeContextTargetPath(descriptor.targetPath);
  const dedupeKey = normalizeContextPanelTabDedupeKey(
    descriptor.mode,
    normalizedTargetPath,
    descriptor.dedupeKey,
  );
  const id = buildContextPanelTabID(descriptor.mode, dedupeKey);
  const isBrowser = descriptor.mode === 'browser';
  return {
    id,
    mode: descriptor.mode,
    targetPath: isBrowser ? null : normalizedTargetPath,
    dedupeKey,
    label: normalizeContextTabLabel(descriptor.label),
    sessionTitleFallback: normalizeContextTabLabel(descriptor.sessionTitleFallback),
    readOnly: descriptor.readOnly === true,
    stagedDiff: descriptor.stagedDiff === true,
    diffScope: normalizePendingDiffScope(descriptor.diffScope) ?? (descriptor.stagedDiff === true ? 'staged' : 'working'),
    browser: isBrowser
      ? sanitizeBrowserPages(null, { tabId: id, url: normalizedTargetPath, route: normalizeBrowserRoute(descriptor.browserRoute) })
      : null,
    touchedAt: Date.now(),
  };
};

export const clampContextPanelTabs = (
  tabs: ContextPanelTab[],
  maxTabs: number,
  activeTabId: string | null,
): ContextPanelTab[] => {
  if (tabs.length <= maxTabs) {
    return tabs;
  }

  const tabsByTouch = [...tabs].sort((a, b) => a.touchedAt - b.touchedAt);
  const removable = tabsByTouch.filter((tab) => tab.id !== activeTabId);
  const removeCount = tabs.length - maxTabs;
  if (removeCount <= 0 || removable.length === 0) {
    return tabs.slice(-maxTabs);
  }

  const removeSet = new Set(removable.slice(0, removeCount).map((tab) => tab.id));
  return tabs.filter((tab) => !removeSet.has(tab.id));
};

export const sanitizeContextPanelTabs = (tabs: unknown): ContextPanelTab[] => {
  if (!Array.isArray(tabs)) {
    return [];
  }

  const result: ContextPanelTab[] = [];
  const seen = new Set<string>();

  for (const entry of tabs) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const candidate = entry as {
      mode?: unknown;
      targetPath?: unknown;
      dedupeKey?: unknown;
      label?: unknown;
      sessionTitleFallback?: unknown;
      readOnly?: unknown;
      stagedDiff?: unknown;
      diffScope?: unknown;
      browserRoute?: unknown;
      browser?: unknown;
      touchedAt?: unknown;
    };

    if (
      candidate.mode !== 'diff' &&
      candidate.mode !== 'file' &&
      candidate.mode !== 'context' &&
      candidate.mode !== 'preview' &&
      candidate.mode !== 'browser' &&
      candidate.mode !== 'git' &&
      candidate.mode !== 'terminal' &&
      candidate.mode !== 'pull-requests' &&
      candidate.mode !== 'issues' &&
      candidate.mode !== 'extensions'
    ) {
      continue;
    }

    const targetPath = normalizeContextTargetPath(
      typeof candidate.targetPath === 'string' ? candidate.targetPath : null,
    );
    const dedupeKey = normalizeContextPanelTabDedupeKey(
      candidate.mode,
      targetPath,
      typeof candidate.dedupeKey === 'string' ? candidate.dedupeKey : null,
    );
    const id = buildContextPanelTabID(candidate.mode, dedupeKey);
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    const isBrowser = candidate.mode === 'browser';
    // Browser tabs saved before there was only one kept their own id, which
    // also keys their page on the server; the first page keeps it.
    const savedBrowserKey = typeof candidate.dedupeKey === 'string' && candidate.dedupeKey.trim() ? candidate.dedupeKey.trim() : 'browser';
    result.push({
      id,
      mode: candidate.mode,
      targetPath: isBrowser ? null : targetPath,
      dedupeKey,
      label: normalizeContextTabLabel(typeof candidate.label === 'string' ? candidate.label : null),
      sessionTitleFallback: normalizeContextTabLabel(
        typeof candidate.sessionTitleFallback === 'string' ? candidate.sessionTitleFallback : null,
      ),
      readOnly: candidate.readOnly === true,
      stagedDiff: candidate.stagedDiff === true,
      diffScope:
        normalizePendingDiffScope(candidate.diffScope) ??
        (candidate.stagedDiff === true ? 'staged' : 'working'),
      // A browser tab saved before pages existed kept its address and route
      // on the tab itself; they become its first page.
      browser: isBrowser
        ? sanitizeBrowserPages(candidate.browser, {
          tabId: buildContextPanelTabID('browser', savedBrowserKey),
          url: targetPath,
          route: normalizeBrowserRoute(candidate.browserRoute),
        })
        : null,
      touchedAt:
        typeof candidate.touchedAt === 'number' && Number.isFinite(candidate.touchedAt)
          ? candidate.touchedAt
          : Date.now(),
    });
  }

  return result;
};

export const resolveActiveContextPanelTabID = (
  tabs: ContextPanelTab[],
  activeTabId: string | null,
): string | null => {
  if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) {
    return activeTabId;
  }

  if (tabs.length === 0) {
    return null;
  }

  return tabs[tabs.length - 1].id;
};

export const touchContextPanelState = (
  prev?: ContextPanelDirectoryState,
): ContextPanelDirectoryState => {
  if (prev) {
    const tabs = sanitizeContextPanelTabs(prev.tabs);
    const activeTabId = resolveActiveContextPanelTabID(tabs, prev.activeTabId);
    return {
      ...prev,
      tabs,
      activeTabId,
      width: prev.width,
      touchedAt: Date.now(),
    };
  }

  return {
    isOpen: false,
    expanded: false,
    tabs: [],
    activeTabId: null,
    touchedAt: Date.now(),
  };
};

export const upsertContextPanelTab = (
  current: ContextPanelDirectoryState,
  descriptor: ContextPanelTabDescriptor,
): ContextPanelDirectoryState => {
  const nextTab = createContextPanelTab(descriptor);
  // A real file tab replaces the empty editor placeholder ('file' with no
  // target) that the rail can open before any file is picked.
  const baseTabs =
    nextTab.mode === 'file' && nextTab.targetPath
      ? current.tabs.filter((tab) => !(tab.mode === 'file' && !tab.targetPath))
      : current.tabs;
  const existingIndex = baseTabs.findIndex((tab) => tab.id === nextTab.id);
  const tabs =
    existingIndex === -1
      ? [...baseTabs, nextTab]
      : baseTabs.map((tab, index) =>
          index === existingIndex
            ? {
                ...tab,
                mode: nextTab.mode,
                targetPath: nextTab.targetPath || tab.targetPath,
                dedupeKey: nextTab.dedupeKey,
                label: nextTab.label,
                sessionTitleFallback: nextTab.sessionTitleFallback || tab.sessionTitleFallback,
                stagedDiff: nextTab.stagedDiff,
                diffScope: nextTab.diffScope,
                // Reopening the browser keeps its pages; callers change them
                // through the page actions.
                browser: tab.browser ?? nextTab.browser,
                readOnly: nextTab.readOnly,
                touchedAt: Date.now(),
              }
            : tab,
        );

  const activeTabId = nextTab.id;
  const clampedTabs = clampContextPanelTabs(tabs, CONTEXT_PANEL_MAX_TABS, activeTabId);

  return {
    ...current,
    isOpen: true,
    tabs: clampedTabs,
    activeTabId: resolveActiveContextPanelTabID(clampedTabs, activeTabId),
    touchedAt: Date.now(),
  };
};

export const closeContextPanelTab = (
  current: ContextPanelDirectoryState,
  tabID: string,
): ContextPanelDirectoryState => {
  const closedTab = current.tabs.find((tab) => tab.id === tabID) ?? null;
  const nextTabs = current.tabs.filter((tab) => tab.id !== tabID);

  if (current.activeTabId !== tabID) {
    return {
      ...current,
      tabs: nextTabs,
      activeTabId: resolveActiveContextPanelTabID(nextTabs, current.activeTabId),
      isOpen: nextTabs.length > 0 ? current.isOpen : false,
      touchedAt: Date.now(),
    };
  }

  // Closing the active tab stays inside the active surface: activate the most
  // recent remaining tab of the same mode, and when it was the last one just
  // close the panel instead of jumping to another surface.
  const sameModeTabs = closedTab ? nextTabs.filter((tab) => tab.mode === closedTab.mode) : [];
  const nextSameModeTab =
    sameModeTabs.length > 0
      ? sameModeTabs.reduce((best, tab) => (tab.touchedAt >= best.touchedAt ? tab : best))
      : null;

  return {
    ...current,
    tabs: nextTabs,
    activeTabId: nextSameModeTab?.id ?? resolveActiveContextPanelTabID(nextTabs, null),
    isOpen: nextSameModeTab ? current.isOpen : false,
    touchedAt: Date.now(),
  };
};

export const reorderContextPanelTabs = (
  current: ContextPanelDirectoryState,
  activeTabID: string,
  overTabID: string,
): ContextPanelDirectoryState => {
  if (activeTabID === overTabID) {
    return current;
  }

  const fromIndex = current.tabs.findIndex((tab) => tab.id === activeTabID);
  const toIndex = current.tabs.findIndex((tab) => tab.id === overTabID);
  if (fromIndex === -1 || toIndex === -1) {
    return current;
  }

  const tabs = [...current.tabs];
  const [moved] = tabs.splice(fromIndex, 1);
  if (!moved) {
    return current;
  }

  tabs.splice(toIndex, 0, moved);

  return {
    ...current,
    tabs,
    touchedAt: Date.now(),
  };
};

export const setContextPanelTabTargetPath = (
  current: ContextPanelDirectoryState,
  tabID: string,
  targetPath: string,
): ContextPanelDirectoryState => ({
  ...current,
  tabs: current.tabs.map((tab) => (tab.id === tabID ? { ...tab, targetPath } : tab)),
});

export const collapseDiffTabsToGit = (tabs: ContextPanelTab[]): ContextPanelTab[] => {
  const next: ContextPanelTab[] = [];
  let hasGit = false;
  for (const tab of tabs) {
    if (tab.mode !== 'diff' && tab.mode !== 'git') {
      next.push(tab);
      continue;
    }
    if (hasGit) {
      continue;
    }
    hasGit = true;
    next.push(tab.mode === 'git' ? tab : createContextPanelTab({ mode: 'git' }));
  }
  return next;
};

export const sanitizeContextPanelByDirectory = (
  value: unknown,
): Record<string, ContextPanelDirectoryState> => {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const source = value as Record<string, unknown>;
  const next: Record<string, ContextPanelDirectoryState> = {};

  for (const [rawDirectory, rawState] of Object.entries(source)) {
    const directory = normalizeDirectoryPathKey(rawDirectory);
    if (!directory || !rawState || typeof rawState !== 'object') {
      continue;
    }

    const candidate = rawState as {
      isOpen?: unknown;
      expanded?: unknown;
      tabs?: unknown;
      activeTabId?: unknown;
      width?: unknown;
      widthByMode?: unknown;
      touchedAt?: unknown;
      mode?: unknown;
      targetPath?: unknown;
      dedupeKey?: unknown;
      label?: unknown;
    };

    let tabs = collapseDiffTabsToGit(sanitizeContextPanelTabs(candidate.tabs));
    let activeTabId = typeof candidate.activeTabId === 'string' ? candidate.activeTabId : null;

    if (
      tabs.length === 0 &&
      (candidate.mode === 'diff' || candidate.mode === 'file' || candidate.mode === 'context')
    ) {
      tabs = [
        createContextPanelTab({
          mode: candidate.mode,
          targetPath: typeof candidate.targetPath === 'string' ? candidate.targetPath : null,
          dedupeKey: typeof candidate.dedupeKey === 'string' ? candidate.dedupeKey : null,
          label: typeof candidate.label === 'string' ? candidate.label : null,
        }),
      ];
      activeTabId = tabs[0]?.id ?? null;
    }

    const resolvedActiveTabId = resolveActiveContextPanelTabID(tabs, activeTabId);
    const clampedTabs = clampContextPanelTabs(tabs, CONTEXT_PANEL_MAX_TABS, resolvedActiveTabId);

    // Legacy per-surface `widthByMode` values collapse to one shared width.
    const width = resolveSharedContextPanelWidth(candidate);

    next[directory] = {
      isOpen: candidate.isOpen === true,
      expanded: candidate.expanded === true,
      tabs: clampedTabs,
      activeTabId: resolveActiveContextPanelTabID(clampedTabs, resolvedActiveTabId),
      ...(width !== undefined ? { width } : {}),
      touchedAt:
        typeof candidate.touchedAt === 'number' && Number.isFinite(candidate.touchedAt)
          ? candidate.touchedAt
          : Date.now(),
    };
  }

  return next;
};

export const clampContextPanelRoots = (
  byDirectory: Record<string, ContextPanelDirectoryState>,
  maxRoots: number,
): Record<string, ContextPanelDirectoryState> => {
  const entries = Object.entries(byDirectory);
  if (entries.length <= maxRoots) {
    return byDirectory;
  }

  entries.sort((a, b) => (b[1]?.touchedAt ?? 0) - (a[1]?.touchedAt ?? 0));
  const next: Record<string, ContextPanelDirectoryState> = {};
  for (const [directory, state] of entries.slice(0, maxRoots)) {
    next[directory] = state;
  }
  return next;
};
