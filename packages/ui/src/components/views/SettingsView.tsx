/* eslint-disable */
import React from 'react';
import { cn, getModifierLabel } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import type { PiChamberSection } from '@/components/sections/pichamber/types';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopLocalOriginActive, isDesktopShell } from '@/lib/desktop';
import { isWindowsArm64 as isWindowsArm64Platform } from '@/lib/platform';
import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_PAGE_METADATA,
  getSettingsPageMeta,
  resolveSettingsSlug,
  type SettingsPageSlug,
} from '@/lib/settings/metadata';
import { SettingsPageContent, isPageAvailable } from './settings/SettingsPageContent';
import { SettingsNav } from './settings/SettingsNav';
import {
  SETTINGS_NAV_WIDTH,
  SETTINGS_SPLIT_SIDEBAR_WIDTH,
  pageOrder,
  buildRuntimeContext,
  type MobileStage,
} from './settings/settingsViewHelpers';
import { useActiveRemoteLabel } from './settings/useActiveRemoteLabel';
import { useSettingsSearch } from './settings/useSettingsSearch';
import { MobileSettingsHeader } from './settings/MobileSettingsHeader';

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

export const SettingsView: React.FC<SettingsViewProps> = ({
  onClose,
  forceMobile,
  isWindowed,
  visiblePageSlugs,
  initialMobileStage = 'nav',
}) => {
  const deviceInfo = useDeviceInfo();
  const isMobile = forceMobile ?? deviceInfo.isMobile;
  const mobileAppActions = useMobileAppActions();
  const activeRemoteLabel = useActiveRemoteLabel(mobileAppActions?.instanceLabel);

  const settingsPageRaw = useUIStore((state) => state.settingsPage);
  const isSettingsDialogOpen = useUIStore((state) => state.isSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const settingsSlug = resolveSettingsSlug(settingsPageRaw);

  const [mobileStage, setMobileStage] = React.useState<MobileStage>(initialMobileStage);
  const autoNavSlugRef = React.useRef<string | null>(initialMobileStage === 'nav' ? settingsSlug : null);

  React.useEffect(() => {
    if (!isMobile && settingsSlug === 'home') {
      setSettingsPage('general');
    }
  }, [isMobile, setSettingsPage, settingsSlug]);

  const containerRef = React.useRef<HTMLDivElement>(null);

  const isDesktopApp = React.useMemo(() => isDesktopShell(), []);
  const isDesktopLocalOrigin = React.useMemo(
    () => isDesktopShell() && isDesktopLocalOriginActive(),
    [],
  );
  const isMac = React.useMemo(
    () =>
      isDesktopShell() &&
      typeof window !== 'undefined' &&
      (window as unknown as { __PICHAMBER_PLATFORM__?: string }).__PICHAMBER_PLATFORM__ === 'darwin',
    [],
  );
  const isWindows = React.useMemo(
    () =>
      isDesktopShell() &&
      typeof window !== 'undefined' &&
      (window as unknown as { __PICHAMBER_PLATFORM__?: string }).__PICHAMBER_PLATFORM__ === 'win32',
    [],
  );
  const isLinux = React.useMemo(
    () =>
      isDesktopShell() &&
      typeof window !== 'undefined' &&
      (window as unknown as { __PICHAMBER_PLATFORM__?: string }).__PICHAMBER_PLATFORM__ === 'linux',
    [],
  );
  const isWindowsArm64 = React.useMemo(() => isWindowsArm64Platform(), []);

  const runtimeCtx = React.useMemo(
    () => buildRuntimeContext(isDesktopApp, isMobile),
    [isDesktopApp, isMobile],
  );

  const visiblePages = React.useMemo(() => {
    const allowedPages = visiblePageSlugs ? new Set<SettingsPageSlug>(visiblePageSlugs) : null;
    return SETTINGS_PAGE_METADATA
      .filter((page) => page.slug !== 'home')
      .filter((page) => !allowedPages || allowedPages.has(page.slug))
      .filter((page) => isPageAvailable(page, runtimeCtx))
      .filter((page) => !(isMobile && page.slug === 'remote-instances'));
  }, [isMobile, runtimeCtx, visiblePageSlugs]);

  const sortedFilteredPages = React.useMemo(() => {
    const rank = new Map<SettingsPageSlug, number>(pageOrder.map((s, i) => [s, i]));
    return visiblePages
      .slice()
      .sort((a, b) => (rank.get(a.slug) ?? 999) - (rank.get(b.slug) ?? 999));
  }, [visiblePages]);

  const activeProjectId = useProjectsStore((state) => state.activeProjectId);

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

  const openPage = React.useCallback(
    (slug: SettingsPageSlug) => {
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
    },
    [isMobile, setSettingsPage],
  );

  const activePageMeta = React.useMemo(() => {
    return getSettingsPageMeta(settingsSlug);
  }, [settingsSlug]);

  const openChamberSectionBySlug: Partial<Record<SettingsPageSlug, PiChamberSection>> = React.useMemo(
    () => ({
      general: 'general',
      appearance: 'visual',
      chat: 'chat',
      shortcuts: 'shortcuts',
      sessions: 'sessions',
      notifications: 'notifications',
      tunnel: 'tunnel',
    }),
    [],
  );

  const getPageTitle = React.useCallback((slug: SettingsPageSlug): string => {
    switch (slug) {
      case 'general':
        return 'General';
      case 'projects':
        return 'Projects';
      case 'remote-instances':
        return 'Remote Instances';
      case 'providers':
        return 'Providers';
      case 'behavior':
        return 'Behavior';
      case 'skills.installed':
        return 'Skills';
      case 'git':
        return 'Git';
      case 'appearance':
        return 'Appearance';
      case 'chat':
        return 'Chat';
      case 'dictation':
        return 'Dictation';
      case 'shortcuts':
        return 'Shortcuts';
      case 'sessions':
        return 'Sessions';
      case 'snippets':
        return 'Snippets';
      case 'notifications':
        return 'Notifications';
      case 'tunnel':
        return 'External Tunnel';
      case 'about':
        return 'About';
      case 'home':
      default:
        return 'Settings';
    }
  }, []);

  const searchRuntimeCtx = React.useMemo(
    () => ({
      ...runtimeCtx,
      isDesktopLocalOrigin,
      isMac,
      isWindows,
      isLinux,
      isWindowsArm64,
    }),
    [isDesktopLocalOrigin, isLinux, isMac, isWindows, isWindowsArm64, runtimeCtx],
  );

  const {
    settingsSearchQuery,
    setSettingsSearchQuery,
    isMobileSettingsSearchOpen,
    setIsMobileSettingsSearchOpen,
    mobileSettingsSearchInputRef,
    activeSearchResultIndex,
    setActiveSearchResultIndex,
    searchResultRefs,
    keyboardSearchNavigationRef,
    settingsSearchResults,
    groupedSettingsSearchResults,
    openSearchResult,
    handleSettingsSearchKeyDown,
  } = useSettingsSearch({
    runtimeCtx: searchRuntimeCtx,
    visiblePageSlugs,
    getPageTitle,
    openPage,
    isMobile,
    setMobileStage,
    containerRef,
    settingsSlug,
  });

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
  const showOpenPageSidebarButton =
    mobileStage === 'page-content' && activePageMeta?.kind === 'split';
  const mobileBackButtonLabel = showBackButton ? 'Back to Settings' : 'Close settings';
  const shortcutKey = getModifierLabel();

  const handleMobilePageSidebarItemSelect = React.useCallback(() => {
    setMobileStage('page-content');
  }, []);

  const handleBack = React.useCallback(() => {
    setMobileStage('nav');
  }, []);

  const handleOpenPageSidebar = React.useCallback(() => {
    setMobileStage('page-sidebar');
  }, []);

  React.useEffect(() => {
    if (!isMobile || mobileStage !== 'nav') {
      setIsMobileSettingsSearchOpen(false);
    }
  }, [isMobile, mobileStage, setIsMobileSettingsSearchOpen]);

  const renderPageSidebar = React.useCallback(
    (_slug: SettingsPageSlug, _opts: { onItemSelect?: () => void }) => null,
    [],
  );

  const renderSettingsNav = () => (
    <SettingsNav
      isMobile={isMobile}
      isMobileSettingsSearchOpen={isMobileSettingsSearchOpen}
      settingsSearchQuery={settingsSearchQuery}
      setSettingsSearchQuery={setSettingsSearchQuery}
      handleSettingsSearchKeyDown={handleSettingsSearchKeyDown}
      settingsSearchResults={settingsSearchResults}
      groupedSettingsSearchResults={groupedSettingsSearchResults}
      activeSearchResultIndex={activeSearchResultIndex}
      setActiveSearchResultIndex={setActiveSearchResultIndex}
      searchResultRefs={searchResultRefs}
      keyboardSearchNavigationRef={keyboardSearchNavigationRef}
      openSearchResult={openSearchResult}
      sortedFilteredPages={sortedFilteredPages}
      settingsSlug={settingsSlug}
      mobileStage={mobileStage}
      openPage={openPage}
      getPageTitle={getPageTitle}
      activeRemoteLabel={activeRemoteLabel}
      mobileAppActions={mobileAppActions}
    />
  );

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
        const fallback = (
          <SettingsPageContent
            slug={settingsSlug}
            isMobile={isMobile}
            runtimeCtx={runtimeCtx}
            openChamberSectionBySlug={openChamberSectionBySlug}
          />
        );
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

    return (
      <div className="flex-1 min-h-0 overflow-y-scroll overflow-x-hidden bg-background">
        <ErrorBoundary>
          <SettingsPageContent
            slug={settingsSlug}
            isMobile={isMobile}
            runtimeCtx={runtimeCtx}
            openChamberSectionBySlug={openChamberSectionBySlug}
          />
        </ErrorBoundary>
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
          <div
            className={cn('border-r', 'bg-sidebar')}
            style={{
              width: SETTINGS_SPLIT_SIDEBAR_WIDTH,
              minWidth: SETTINGS_SPLIT_SIDEBAR_WIDTH,
              borderColor: 'var(--interactive-border)',
            }}
          >
            <ErrorBoundary>{renderPageSidebar(settingsSlug, {})}</ErrorBoundary>
          </div>
          <div className="flex-1 min-h-0 overflow-y-scroll overflow-x-hidden bg-background">
            <ErrorBoundary>
              <SettingsPageContent
                slug={settingsSlug}
                isMobile={isMobile}
                runtimeCtx={runtimeCtx}
                openChamberSectionBySlug={openChamberSectionBySlug}
              />
            </ErrorBoundary>
          </div>
        </div>
      );
    }

    return (
      <div className="h-full min-h-0 overflow-y-scroll overflow-x-hidden bg-background">
        <ErrorBoundary>
          <SettingsPageContent
            slug={settingsSlug}
            isMobile={isMobile}
            runtimeCtx={runtimeCtx}
            openChamberSectionBySlug={openChamberSectionBySlug}
          />
        </ErrorBoundary>
      </div>
    );
  };

  return (
    <div
      ref={containerRef}
      data-settings-view="true"
      className={cn('relative flex h-full min-h-0 flex-col overflow-hidden bg-background')}
    >
      {isMobile ? (
        <MobileSettingsHeader
          mobileStage={mobileStage}
          activePageMeta={activePageMeta}
          getPageTitle={getPageTitle}
          showBackButton={showBackButton}
          mobileBackButtonLabel={mobileBackButtonLabel}
          onBack={handleBack}
          showOpenPageSidebarButton={Boolean(showOpenPageSidebarButton)}
          onOpenPageSidebar={handleOpenPageSidebar}
          isMobileSettingsSearchOpen={isMobileSettingsSearchOpen}
          setIsMobileSettingsSearchOpen={setIsMobileSettingsSearchOpen}
          mobileSettingsSearchInputRef={mobileSettingsSearchInputRef}
          settingsSearchQuery={settingsSearchQuery}
          setSettingsSearchQuery={setSettingsSearchQuery}
          handleSettingsSearchKeyDown={handleSettingsSearchKeyDown}
          onClose={onClose}
          shortcutKey={shortcutKey}
        />
      ) : (
        <>
          {showBackButton && (
            <div className={cn('absolute left-3 z-50', isWindowed ? 'top-2' : 'top-3')}>
              <button
                type="button"
                onClick={handleBack}
                aria-label={'Back'}
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Icon name="arrow-left-s" className="h-5 w-5" />
              </button>
            </div>
          )}
        </>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {isMobile ? (
          renderMobileStage()
        ) : (
          <>
            <div
              className={cn(
                'relative flex h-full min-h-0 flex-col overflow-hidden border-r',
                isDesktopApp ? 'bg-sidebar' : 'bg-sidebar',
              )}
              style={{
                width: `${SETTINGS_NAV_WIDTH}px`,
                minWidth: `${SETTINGS_NAV_WIDTH}px`,
                borderColor: 'var(--interactive-border)',
              }}
            >
              <ErrorBoundary>{renderSettingsNav()}</ErrorBoundary>
            </div>

            <div className="flex-1 overflow-hidden bg-background">{renderDesktopContent()}</div>
          </>
        )}
      </div>
    </div>
  );
};
