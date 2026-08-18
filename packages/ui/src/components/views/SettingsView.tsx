/* eslint-disable */
// @ts-nocheck
import React from 'react';
import { cn, getModifierLabel } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { BehaviorPage } from '@/components/sections/behavior/BehaviorPage';
import { SkillsSidebar } from '@/components/sections/skills/SkillsSidebar';
import { SkillsPage } from '@/components/sections/skills/SkillsPage';
import { ProjectsSidebar } from '@/components/sections/projects/ProjectsSidebar';
import { ProjectsPage } from '@/components/sections/projects/ProjectsPage';
import { RemoteInstancesPage } from '@/components/sections/remote-instances/RemoteInstancesPage';
import { ProvidersSidebar } from '@/components/sections/providers/ProvidersSidebar';
import { ProvidersPage } from '@/components/sections/providers/ProvidersPage';
import { MagicPromptsSidebar } from '@/components/sections/magic-prompts/MagicPromptsSidebar';
import { MagicPromptsPage } from '@/components/sections/magic-prompts/MagicPromptsPage';
import { SnippetsSidebar } from '@/components/sections/snippets/SnippetsSidebar';
import { SnippetsPage } from '@/components/sections/snippets/SnippetsPage';
import { GitPage } from '@/components/sections/git-identities/GitPage';
import type { PiChamberSection } from '@/components/sections/pichamber/types';
import { PiChamberPage } from '@/components/sections/pichamber/PiChamberPage';
import { AboutSettings } from '@/components/sections/pichamber/AboutSettings';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_SECTION_TITLE_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopLocalOriginActive, isDesktopShell, isWebRuntime } from '@/lib/desktop';
import { isWindowsArm64 as isWindowsArm64Platform } from '@/lib/platform';
import { Icon } from "@/components/icon/Icon";
import {
  SETTINGS_PAGE_METADATA,
  getSettingsNavIcon,
  getSettingsPageMeta,
  resolveSettingsSlug,
  type SettingsPageSlug,
  type SettingsRuntimeContext,
  type SettingsPageMeta,
} from '@/lib/settings/metadata';
import { buildSettingsSearchResults, type SettingsSearchResult } from '@/lib/settings/search';
import { usePiProviderSelectionStore } from '@/lib/pi/provider-selection';

// UI Kit: fixed settings navigation width
const SETTINGS_NAV_WIDTH = 256;
const SETTINGS_SPLIT_SIDEBAR_WIDTH = 280;
const SETTINGS_DETAIL_HISTORY_KEY = '__pichamberSettingsDetail';

type MobileStage = 'nav' | 'page-sidebar' | 'page-content';
type SettingsDetailHistoryEntry = {
  page: SettingsPageSlug;
  stage: 'page-content';
};

interface SettingsViewProps {
  onClose?: () => void;
  /** Force mobile layout regardless of device detection */
  forceMobile?: boolean;
  /** Rendered inside a window/dialog (skip traffic light padding) */
  isWindowed?: boolean;
  /** Restrict top-level settings navigation to a specific product surface. */
  visiblePageSlugs?: SettingsPageSlug[];
  initialMobileStage?: MobileStage;
}

const pageOrder: SettingsPageSlug[] = [
  'general',
  'appearance',
  'chat',
  'notifications',
  'sessions',
  'shortcuts',
  'about',
  'projects',
  'remote-instances',
  'tunnel',
  'git',
  'providers',
  'behavior',
  'magic-prompts',
  'snippets',
  'skills.installed',
];

const NAV_GROUP_ORDER = ['general', 'projects', 'content'] as const;


function buildRuntimeContext(isDesktop: boolean, isMobile: boolean): SettingsRuntimeContext {
  const isWeb = !isDesktop && isWebRuntime();
  return { isWeb, isDesktop, isMobile };
}

function isPageAvailable(page: SettingsPageMeta, ctx: SettingsRuntimeContext): boolean {
  if (!page.isAvailable) {
    return true;
  }
  return page.isAvailable(ctx);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nextUniqueName(baseName: string, existingNames: Iterable<string>): string {
  const existing = new Set(existingNames);
  let name = baseName;
  let counter = 1;
  while (existing.has(name)) {
    name = `${baseName}-${counter}`;
    counter += 1;
  }
  return name;
}

function getSettingsDetailHistoryEntry(state: unknown): SettingsDetailHistoryEntry | null {
  if (!isObjectRecord(state)) {
    return null;
  }

  const detail = state[SETTINGS_DETAIL_HISTORY_KEY];
  if (!isObjectRecord(detail)) {
    return null;
  }

  const page = detail.page;
  const stage = detail.stage;
  if (typeof page !== 'string' || stage !== 'page-content') {
    return null;
  }

  const resolvedPage = resolveSettingsSlug(page);
  return { page: resolvedPage, stage };
}

function getCurrentHistoryState(): Record<string, unknown> {
  if (typeof window === 'undefined' || !isObjectRecord(window.history.state)) {
    return {};
  }
  return window.history.state;
}


export const SettingsView: React.FC<SettingsViewProps> = ({ onClose, forceMobile, isWindowed, visiblePageSlugs, initialMobileStage = 'nav' }) => {
    const deviceInfo = useDeviceInfo();
  const isMobile = forceMobile ?? deviceInfo.isMobile;

  const settingsPageRaw = useUIStore((state) => state.settingsPage);
  const isSettingsDialogOpen = useUIStore((state) => state.isSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const settingsSlug = resolveSettingsSlug(settingsPageRaw);

  const [mobileStage, setMobileStage] = React.useState<MobileStage>(initialMobileStage);
  // Seed with the mount-time slug when opening at the nav stage: the slug
  // persists across opens, and the deep-link auto-jump below must react only
  // to slug CHANGES after mount — not re-enter the previously visited page
  // every time settings reopen.
  const autoNavSlugRef = React.useRef<string | null>(initialMobileStage === 'nav' ? settingsSlug : null);

  // No starter page on desktop: 'home' (fresh state) resolves to General.
  // settingsPage persists in the UI store, so subsequent opens restore the
  // last visited page. Mobile keeps 'home' — its entry stage is the nav list.
  React.useEffect(() => {
    if (!isMobile && settingsSlug === 'home') {
      setSettingsPage('general');
    }
  }, [isMobile, setSettingsPage, settingsSlug]);

  const [settingsSearchQuery, setSettingsSearchQuery] = React.useState('');
  const [pendingSearchItemId, setPendingSearchItemId] = React.useState<string | null>(null);
  const [activeSearchResultIndex, setActiveSearchResultIndex] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const searchResultRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const activeSearchResultIndexRef = React.useRef(0);
  const keyboardSearchNavigationRef = React.useRef(false);

  const isDesktopApp = React.useMemo(() => {
    return isDesktopShell();
  }, []);
  const isDesktopLocalOrigin = React.useMemo(() => {
    return isDesktopShell() && isDesktopLocalOriginActive();
  }, []);
  const isMac = React.useMemo(() => {
    return isDesktopShell() && typeof window !== 'undefined'
      && (window as unknown as { __PICHAMBER_PLATFORM__?: string }).__PICHAMBER_PLATFORM__ === 'darwin';
  }, []);
  const isWindows = React.useMemo(() => {
    return isDesktopShell() && typeof window !== 'undefined'
      && (window as unknown as { __PICHAMBER_PLATFORM__?: string }).__PICHAMBER_PLATFORM__ === 'win32';
  }, []);
  const isLinux = React.useMemo(() => {
    return isDesktopShell() && typeof window !== 'undefined'
      && (window as unknown as { __PICHAMBER_PLATFORM__?: string }).__PICHAMBER_PLATFORM__ === 'linux';
  }, []);
  const isWindowsArm64 = React.useMemo(() => isWindowsArm64Platform(), []);

  // keep platform check available for future window chrome tweaks

  const runtimeCtx = React.useMemo(() => buildRuntimeContext(isDesktopApp, isMobile), [isDesktopApp, isMobile]);

  const visiblePages = React.useMemo(() => {
    const allowedPages = visiblePageSlugs ? new Set<SettingsPageSlug>(visiblePageSlugs) : null;
    return SETTINGS_PAGE_METADATA
      .filter((page) => page.slug !== 'home')
      .filter((page) => !allowedPages || allowedPages.has(page.slug))
      .filter((page) => isPageAvailable(page, runtimeCtx));
  }, [runtimeCtx, visiblePageSlugs]);

  const sortedFilteredPages = React.useMemo(() => {
    const rank = new Map<SettingsPageSlug, number>(pageOrder.map((s, i) => [s, i]));
    return visiblePages
      .slice()
      .sort((a, b) => (rank.get(a.slug) ?? 999) - (rank.get(b.slug) ?? 999));
  }, [visiblePages]);

  const activeProjectId = useProjectsStore((state) => state.activeProjectId);

  // Load stores when project changes or when a page becomes active.
  React.useEffect(() => {
    if (!isSettingsDialogOpen && !isWindowed) {
      return;
    }

    if (settingsSlug === 'skills.installed') {
      void useSkillsStore.getState().loadSkills();
    }
    if (settingsSlug === 'snippets') {
      void useSnippetsStore.getState().loadSnippets();
    }
  }, [activeProjectId, isSettingsDialogOpen, isWindowed, settingsSlug]);

  const openPage = React.useCallback((slug: SettingsPageSlug) => {
    setSettingsPage(slug);
    autoNavSlugRef.current = slug;
    if (!isMobile) {
      return;
    }
    const def = getSettingsPageMeta(slug);
    if (!def || def.slug === 'home') {
      setMobileStage('nav');
      return;
    }
    setMobileStage(def.kind === 'split' ? 'page-sidebar' : 'page-content');
  }, [isMobile, setSettingsPage]);

  const activePageMeta = React.useMemo(() => {
    return getSettingsPageMeta(settingsSlug);
  }, [settingsSlug]);

  // Nav is always open (collapsed state removed)

  const openChamberSectionBySlug: Partial<Record<SettingsPageSlug, PiChamberSection>> = React.useMemo(() => ({
    general: 'general',
    appearance: 'visual',
    chat: 'chat',
    shortcuts: 'shortcuts',
    sessions: 'sessions',
    notifications: 'notifications',
    tunnel: 'tunnel',
  }), []);

  const getPageTitle = React.useCallback((slug: SettingsPageSlug): string => {
    switch (slug) {
      case 'general':
        return "General";
      case 'projects':
        return "Projects";
      case 'remote-instances':
        return "Remote Instances";
      case 'providers':
        return "Providers";
      case 'behavior':
        return "Behavior";
      case 'skills.installed':
        return "Skills";
      case 'git':
        return "Git";
      case 'appearance':
        return "Appearance";
      case 'chat':
        return "Chat";
      case 'shortcuts':
        return "Shortcuts";
      case 'sessions':
        return "Sessions";
      case 'magic-prompts':
        return "Magic Prompts";
      case 'snippets':
        return "Snippets";
      case 'notifications':
        return "Notifications";
      case 'tunnel':
        return "External Tunnel";
      case 'about':
        return "About";
      case 'home':
      default:
        return "Settings";
    }
  }, []);

  const settingsSearchResults = React.useMemo(() => {
    return buildSettingsSearchResults({
      query: settingsSearchQuery,
      runtimeCtx: { ...runtimeCtx, isDesktopLocalOrigin, isMac, isWindows, isLinux, isWindowsArm64 },
      visiblePageSlugs,
      getPageTitle,
    });
  }, [getPageTitle, isWindowsArm64, isDesktopLocalOrigin, isMac, isWindows, isLinux, runtimeCtx, settingsSearchQuery, visiblePageSlugs]);

  const prepareSettingsSearchTarget = React.useCallback((result: SettingsSearchResult): string => {
    if (result.id.startsWith('snippets.')) {
      const store = useSnippetsStore.getState();
      const name = nextUniqueName('new-snippet', store.snippets.map((snippet) => snippet.name));
      store.setSnippetDraft({ name, scope: 'global' });
      store.setSelectedSnippet(name);
      return result.id === 'snippets.create' ? 'snippets.content' : result.id;
    }

    if (result.id === 'providers.connect') {
      usePiProviderSelectionStore.getState().setSelectedProviderId(null);
    }

    return result.id;
  }, []);

  const groupedSettingsSearchResults = React.useMemo(() => {
    const groups: Array<{ page: SettingsPageSlug; pageTitle: string; results: SettingsSearchResult[] }> = [];
    const groupByPage = new Map<SettingsPageSlug, { page: SettingsPageSlug; pageTitle: string; results: SettingsSearchResult[] }>();
    for (const result of settingsSearchResults) {
      let group = groupByPage.get(result.page);
      if (!group) {
        group = { page: result.page, pageTitle: result.pageTitle, results: [] };
        groupByPage.set(result.page, group);
        groups.push(group);
      }
      group.results.push(result);
    }
    return groups;
  }, [settingsSearchResults]);

  React.useEffect(() => {
    setActiveSearchResultIndex(0);
    activeSearchResultIndexRef.current = 0;
    keyboardSearchNavigationRef.current = false;
  }, [settingsSearchQuery]);

  React.useEffect(() => {
    activeSearchResultIndexRef.current = activeSearchResultIndex;
  }, [activeSearchResultIndex]);

  React.useEffect(() => {
    searchResultRefs.current[activeSearchResultIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeSearchResultIndex]);

  React.useEffect(() => {
    if (activeSearchResultIndex >= settingsSearchResults.length) {
      setActiveSearchResultIndex(Math.max(0, settingsSearchResults.length - 1));
    }
    searchResultRefs.current.length = settingsSearchResults.length;
  }, [activeSearchResultIndex, settingsSearchResults.length]);

  const openSearchResult = React.useCallback((result: SettingsSearchResult) => {
    const targetId = prepareSettingsSearchTarget(result);
    setPendingSearchItemId(targetId);
    openPage(result.page);
    if (isMobile) {
      setMobileStage('page-content');
    }
  }, [isMobile, openPage, prepareSettingsSearchTarget]);

  const handleSettingsSearchKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!settingsSearchQuery.trim()) {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setSettingsSearchQuery('');
      return;
    }

    if (settingsSearchResults.length === 0) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      keyboardSearchNavigationRef.current = true;
      setActiveSearchResultIndex((current) => (current + 1) % settingsSearchResults.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      keyboardSearchNavigationRef.current = true;
      setActiveSearchResultIndex((current) => (current - 1 + settingsSearchResults.length) % settingsSearchResults.length);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const safeIndex = ((activeSearchResultIndexRef.current % settingsSearchResults.length) + settingsSearchResults.length) % settingsSearchResults.length;
      const result = settingsSearchResults[safeIndex] ?? settingsSearchResults[0];
      if (result) {
        openSearchResult(result);
      }
    }
  }, [openSearchResult, settingsSearchQuery, settingsSearchResults]);

  React.useEffect(() => {
    const targetId = pendingSearchItemId;
    if (!targetId) {
      return;
    }

    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      if (cancelled) {
        return;
      }
      const escapedId = typeof CSS !== 'undefined' && CSS.escape
        ? CSS.escape(targetId)
        : targetId.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      const target = containerRef.current?.querySelector<HTMLElement>(`[data-settings-item="${escapedId}"]`);
      if (!target) {
        return;
      }
      setPendingSearchItemId(null);
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.setAttribute('data-settings-search-highlight', 'true');
      window.setTimeout(() => {
        target.removeAttribute('data-settings-search-highlight');
      }, 1600);
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [pendingSearchItemId, settingsSlug]);

  const renderUnavailable = React.useCallback(() => {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-md text-center">
          <div className={SETTINGS_SECTION_TITLE_CLASS}>{"Not available"}</div>
          <p className="typography-ui text-muted-foreground mt-1">{"This settings page is not available in this runtime."}</p>
        </div>
      </div>
    );
  }, []);

  const renderPageSidebar = React.useCallback((slug: SettingsPageSlug, opts: { onItemSelect?: () => void }) => {
    switch (slug) {
      case 'projects':
        return <ProjectsSidebar onItemSelect={opts.onItemSelect} />;
      case 'skills.installed':
        return <SkillsSidebar onItemSelect={opts.onItemSelect} />;
      case 'providers':
        return <ProvidersSidebar onItemSelect={opts.onItemSelect} />;
      case 'magic-prompts':
        return <MagicPromptsSidebar onItemSelect={opts.onItemSelect} />;
      case 'snippets':
        return <SnippetsSidebar onItemSelect={opts.onItemSelect} />;
      default:
        return null;
    }
  }, []);

  const renderPageContent = React.useCallback((slug: SettingsPageSlug) => {
    const meta = getSettingsPageMeta(slug);
    if (meta && !isPageAvailable(meta, runtimeCtx)) {
      return renderUnavailable();
    }

    switch (slug) {
      case 'projects':
        return <ProjectsPage />;
      case 'remote-instances':
        return <RemoteInstancesPage />;
      case 'behavior':
        return <BehaviorPage />;
      case 'skills.installed':
        return <SkillsPage />;
      case 'providers':
        return <ProvidersPage />;
      case 'about':
        return (
          <SettingsPageLayout title={"About"} showSaveStatus={false}>
            <AboutSettings />
          </SettingsPageLayout>
        );
      case 'magic-prompts':
        return <MagicPromptsPage />;
      case 'snippets':
        return <SnippetsPage />;
      case 'git':
        return <GitPage />;
      case 'general':
      case 'appearance':
      case 'chat':
      case 'shortcuts':
      case 'sessions':
      case 'notifications':
      case 'tunnel': {
        const section = openChamberSectionBySlug[slug] ?? 'visual';
        return <PiChamberPage section={section} />;
      }
      case 'home':
      default:
        return null;
    }
  }, [openChamberSectionBySlug, renderUnavailable, runtimeCtx]);

  // Mobile: if opened via deep-link / palette to a non-home page, jump into it once.
  React.useEffect(() => {
    if (!isMobile) {
      return;
    }
    if (mobileStage !== 'nav') {
      return;
    }
    if (settingsSlug === 'home') {
      return;
    }
    if (autoNavSlugRef.current === settingsSlug) {
      return;
    }
    const def = getSettingsPageMeta(settingsSlug);
    if (!def || def.slug === 'home') {
      return;
    }
    autoNavSlugRef.current = settingsSlug;
    setMobileStage(def.kind === 'split' ? 'page-sidebar' : 'page-content');
  }, [isMobile, mobileStage, settingsSlug]);

  const showBackButton = isMobile && mobileStage !== 'nav';
  const backButtonTargetsPageSidebar = isMobile && mobileStage === 'page-content' && settingsSlug === 'skills.installed';
  const showOpenPageSidebarButton = mobileStage === 'page-content'
    && activePageMeta?.kind === 'split'
    && !backButtonTargetsPageSidebar;
  const mobileBackButtonLabel = backButtonTargetsPageSidebar
    ? "Back"
    : showBackButton
      ? "Back to Settings"
      : "Close settings";
  const shortcutKey = getModifierLabel();

  const pushMobileSplitDetailHistory = React.useCallback((slug: SettingsPageSlug) => {
    if (typeof window === 'undefined') {
      return;
    }

    const currentDetail = getSettingsDetailHistoryEntry(window.history.state);
    if (currentDetail?.page === slug && currentDetail.stage === 'page-content') {
      return;
    }

    window.history.pushState(
      {
        ...getCurrentHistoryState(),
        [SETTINGS_DETAIL_HISTORY_KEY]: { page: slug, stage: 'page-content' },
      },
      '',
      window.location.href,
    );
  }, []);

  const handleMobilePageSidebarItemSelect = React.useCallback(() => {
    setMobileStage('page-content');
    if (settingsSlug === 'skills.installed') {
      pushMobileSplitDetailHistory(settingsSlug);
    }
  }, [pushMobileSplitDetailHistory, settingsSlug]);

  const handleBack = React.useCallback(() => {
    if (backButtonTargetsPageSidebar) {
      const currentDetail = typeof window !== 'undefined'
        ? getSettingsDetailHistoryEntry(window.history.state)
        : null;
      if (currentDetail?.page === settingsSlug) {
        window.history.back();
        return;
      }
      setMobileStage('page-sidebar');
      return;
    }

    setMobileStage('nav');
  }, [backButtonTargetsPageSidebar, settingsSlug]);

  React.useEffect(() => {
    if (!isMobile) {
      return;
    }

    const handlePopState = (event: PopStateEvent) => {
      if (settingsSlug !== 'skills.installed') {
        return;
      }

      const detail = getSettingsDetailHistoryEntry(event.state);
      if (detail?.page === 'skills.installed') {
        setMobileStage('page-content');
        return;
      }

      setMobileStage((stage) => stage === 'page-content' ? 'page-sidebar' : stage);
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [isMobile, settingsSlug]);

  const handleOpenPageSidebar = React.useCallback(() => {
    setMobileStage('page-sidebar');
  }, []);

  const renderSettingsNav = () => {
    const hasSearchQuery = settingsSearchQuery.trim().length > 0;

    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="px-3 pt-3">
          <div className="flex h-10 items-center gap-1.5 rounded-md border border-border bg-transparent px-2 text-muted-foreground focus-within:ring-2 focus-within:ring-primary/40 sm:h-8">
            <Icon name="search" className="h-4 w-4 shrink-0" />
            <input
              value={settingsSearchQuery}
              onChange={(event) => setSettingsSearchQuery(event.target.value)}
              onKeyDown={handleSettingsSearchKeyDown}
              placeholder={"Search settings"}
              aria-label={"Search settings"}
              className="typography-ui-label min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/70"
            />
            {hasSearchQuery && (
              <button
                type="button"
                onClick={() => setSettingsSearchQuery('')}
                aria-label={"Clear settings search"}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground sm:h-5 sm:w-5"
              >
                <Icon name="close" className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Scrollable nav items */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          <div className="flex flex-col gap-0.5 px-3 pt-3 pb-2">
            {hasSearchQuery ? (
              settingsSearchResults.length > 0 ? (() => {
                let resultIndex = 0;
                return groupedSettingsSearchResults.map((group) => (
                  <div key={group.page} className="space-y-0.5">
                    <div className="px-2 pb-0.5 pt-2 typography-micro font-medium text-muted-foreground/70">
                      {group.pageTitle}
                    </div>
                    {group.results.map((result) => {
                      const currentIndex = resultIndex;
                      resultIndex += 1;
                      const active = currentIndex === activeSearchResultIndex;
                      const hasDescription = Boolean(result.description);
                      return (
                        <button
                          key={result.id}
                          type="button"
                          ref={(element) => {
                            searchResultRefs.current[currentIndex] = element;
                          }}
                          onMouseMove={() => {
                            keyboardSearchNavigationRef.current = false;
                            setActiveSearchResultIndex(currentIndex);
                          }}
                          onClick={() => openSearchResult(result)}
                          className={cn(
                            'flex w-full flex-col rounded-md px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                            hasDescription ? 'min-h-11 py-1.5' : 'py-2',
                            active ? 'bg-interactive-selection' : 'hover:bg-interactive-hover'
                          )}
                        >
                          <span className="typography-ui-label text-foreground truncate">{result.title}</span>
                          {hasDescription && (
                            <span className="typography-micro text-muted-foreground/70 line-clamp-2">{result.description}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ));
              })() : (
                <div className="px-2 py-6 text-center typography-ui text-muted-foreground">
                  {"No matching settings"}
                </div>
              )
            ) : (() => {
              const pagesByGroup = new Map<string, typeof sortedFilteredPages>();
              for (const page of sortedFilteredPages) {
                const group = page.group;
                const existing = pagesByGroup.get(group);
                if (existing) {
                  existing.push(page);
                } else {
                  pagesByGroup.set(group, [page]);
                }
              }

              const visibleGroups = NAV_GROUP_ORDER
                .map((group) => ({ group, pages: pagesByGroup.get(group) ?? [] }))
                .filter((entry) => entry.pages.length > 0);

              return visibleGroups.map(({ group, pages }, groupIndex) => (
                <div key={group} className="space-y-0.5">
                  <div
                    className={cn(
                      'px-3 pb-1 typography-micro font-semibold uppercase tracking-wide text-muted-foreground sm:px-2 sm:pb-0.5',
                      groupIndex === 0 ? 'pt-1' : 'pt-4 sm:pt-3',
                    )}
                  >
                    {group === 'general' ? 'PiChamber' : 'Workspace'}
                  </div>
                  {pages.map((page) => {
                    // On the mobile nav STAGE nothing is "current" — the user is
                    // choosing, and settingsSlug only remembers the last visited
                    // page. Keeping it highlighted read as a stuck selection.
                    const selected = settingsSlug === page.slug && !(isMobile && mobileStage === 'nav');
                    const iconName = getSettingsNavIcon(page.slug);
                    if (!iconName) return null;

                    return (
                      <Tooltip key={page.slug}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => openPage(page.slug)}
                            aria-current={selected ? 'page' : undefined}
                            className={cn(
                              'flex h-11 w-full items-center gap-2.5 rounded-md px-3 overflow-hidden sm:h-8 sm:gap-2 sm:px-2',
                              selected
                                ? 'bg-interactive-selection text-foreground'
                                : 'text-foreground hover:bg-interactive-hover'
                            )}
                          >
                            <Icon name={iconName} className="h-[18px] w-[18px] shrink-0 sm:h-4 sm:w-4" />
                            <span className="flex items-center gap-1.5 whitespace-nowrap overflow-hidden transition-opacity duration-150 opacity-100">
                              <span className="typography-ui-label font-normal truncate">{getPageTitle(page.slug)}</span>
                              {page.slug === 'tunnel' && (
                                <span className="shrink-0 typography-micro px-1 rounded leading-none pb-px text-[var(--status-warning)] bg-[var(--status-warning)]/10">
                                  {"beta"}
                                </span>
                              )}
                            </span>
                          </button>
                        </TooltipTrigger>
                      </Tooltip>
                    );
                  })}
                </div>
              ));
            })()}
          </div>
        </div>
      </div>
    );
  };

  const renderMobileStage = () => {
    if (mobileStage === 'nav') {
      return (
        <div className="flex-1 min-h-0 overflow-hidden bg-background">
          <div className="flex h-full min-h-0 flex-col">
            <ErrorBoundary>{renderSettingsNav()}</ErrorBoundary>
          </div>
        </div>
      );
    }

    if (!activePageMeta) {
      return <div className="flex-1 bg-background" />;
    }

    if (mobileStage === 'page-sidebar') {
      if (activePageMeta.kind !== 'split') {
        // No sidebar available; fall back to direct content.
        const fallback = renderPageContent(settingsSlug);
        return (
          <div className="flex-1 min-h-0 overflow-y-scroll overflow-x-hidden bg-background">
            <ErrorBoundary>{fallback}</ErrorBoundary>
          </div>
        );
      }
      return (
        <div className="flex-1 min-h-0 overflow-y-scroll overflow-x-hidden bg-background">
          <ErrorBoundary>
            {renderPageSidebar(settingsSlug, { onItemSelect: handleMobilePageSidebarItemSelect })}
          </ErrorBoundary>
        </div>
      );
    }

    // page-content
    const content = renderPageContent(settingsSlug);

    return (
      <div className="flex-1 min-h-0 overflow-y-scroll overflow-x-hidden bg-background">
        <ErrorBoundary>{content}</ErrorBoundary>
      </div>
    );
  };

  const renderDesktopContent = () => {
    if (!activePageMeta || settingsSlug === 'home') {
      return null;
    }

    if (activePageMeta.kind === 'split') {
      return (
        <div className="flex h-full min-h-0 overflow-hidden">
          <div className={cn('border-r', 'bg-sidebar')} style={{ width: SETTINGS_SPLIT_SIDEBAR_WIDTH, minWidth: SETTINGS_SPLIT_SIDEBAR_WIDTH, borderColor: 'var(--interactive-border)' }}>
            <ErrorBoundary>{renderPageSidebar(settingsSlug, {})}</ErrorBoundary>
          </div>
          <div className="flex-1 min-h-0 overflow-y-scroll overflow-x-hidden bg-background">
            <ErrorBoundary>{renderPageContent(settingsSlug)}</ErrorBoundary>
          </div>
        </div>
      );
    }

    return (
      <div className="h-full min-h-0 overflow-y-scroll overflow-x-hidden bg-background">
        <ErrorBoundary>{renderPageContent(settingsSlug)}</ErrorBoundary>
      </div>
    );
  };

  return (
    <div ref={containerRef} data-settings-view="true" className={cn('relative flex h-full min-h-0 flex-col overflow-hidden bg-background')}>
      {isMobile ? (
        <div
          className={cn(
            'flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-3',
            // The root nav list reads as a single quiet page — no divider and
            // no back arrow (the X on the right is the only way out); subpages
            // keep both.
            mobileStage !== 'nav' && 'border-b',
            'bg-background'
          )}
          style={mobileStage !== 'nav' ? { borderColor: 'var(--interactive-border)' } : undefined}
        >
          {showBackButton ? (
            <button
              type="button"
              onClick={handleBack}
              aria-label={mobileBackButtonLabel}
              className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Icon name="arrow-left-s" className="h-5 w-5" />
            </button>
          ) : null}

          <div className="min-w-0 flex-1 px-2 typography-ui-label font-medium text-foreground truncate">
            {mobileStage === 'nav'
              ? "Settings"
              : (activePageMeta ? getPageTitle(activePageMeta.slug) : "Settings")}
          </div>

          {showOpenPageSidebarButton && (
            <button
              type="button"
              onClick={handleOpenPageSidebar}
              aria-label={"Open section list"}
              className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Icon name="list-unordered" className="h-5 w-5" />
            </button>
          )}

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={"Close settings"}
              title={`Close Settings (${shortcutKey}+,)`}
              className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Icon name="close" className="h-5 w-5" />
            </button>
          )}
        </div>
      ) : (
        <>
          {showBackButton && (
            <div className={cn('absolute left-3 z-50', isWindowed ? 'top-2' : 'top-3')}>
              <button
                type="button"
                onClick={handleBack}
                aria-label={"Back"}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Icon name="arrow-left-s" className="h-5 w-5" />
              </button>
            </div>
          )}

        </>
      )}

      {!isMobile && (
        <div className="flex shrink-0 items-center justify-between px-5 pb-3 pt-4">
          <div className="flex items-center gap-2 typography-ui-header font-medium text-foreground">
            <Icon name="settings-3" className="size-4 text-muted-foreground" />
            <span>{"Settings"}</span>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label={"Close settings"}
              title={`Close Settings (${shortcutKey}+,)`}
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              <Icon name="close" className="size-4" />
            </button>
          )}
        </div>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {isMobile ? (
          renderMobileStage()
        ) : (
          <>
            <div
              className={cn(
                'relative flex h-full min-h-0 flex-col overflow-hidden border-r',
                isDesktopApp
                  ? 'bg-sidebar'
                  : 'bg-sidebar',
              )}
              style={{
                width: `${SETTINGS_NAV_WIDTH}px`,
                minWidth: `${SETTINGS_NAV_WIDTH}px`,
                borderColor: 'var(--interactive-border)',
              }}
            >
              <ErrorBoundary>
                {renderSettingsNav()}
              </ErrorBoundary>
            </div>

            <div className="flex-1 overflow-hidden bg-background">
              {renderDesktopContent()}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
