import React from 'react';
import { useSnippetsStore } from '@/stores/useSnippetsStore';
import { usePiProviderSelectionStore } from '@/lib/pi/provider-selection';
import { buildSettingsSearchResults, type SettingsSearchResult } from '@/lib/settings/search';
import type { SettingsPageSlug, SettingsRuntimeContext } from '@/lib/settings/metadata';
import { nextUniqueName } from './settingsViewHelpers';

export function useSettingsSearch({
  runtimeCtx,
  visiblePageSlugs,
  getPageTitle,
  openPage,
  isMobile,
  setMobileStage,
  containerRef,
  settingsSlug,
}: {
  runtimeCtx: SettingsRuntimeContext & {
    isDesktopLocalOrigin: boolean;
    isMac: boolean;
    isWindows: boolean;
    isLinux: boolean;
    isWindowsArm64: boolean;
  };
  visiblePageSlugs?: SettingsPageSlug[];
  getPageTitle: (slug: SettingsPageSlug) => string;
  openPage: (slug: SettingsPageSlug) => void;
  isMobile: boolean;
  setMobileStage: (stage: 'nav' | 'page-sidebar' | 'page-content') => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
  settingsSlug: SettingsPageSlug;
}) {
  const [settingsSearchQuery, setSettingsSearchQuery] = React.useState('');
  const [isMobileSettingsSearchOpen, setIsMobileSettingsSearchOpen] = React.useState(false);
  const mobileSettingsSearchInputRef = React.useRef<HTMLInputElement>(null);
  const [pendingSearchItemId, setPendingSearchItemId] = React.useState<string | null>(null);
  const [activeSearchResultIndex, setActiveSearchResultIndex] = React.useState(0);
  const searchResultRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const activeSearchResultIndexRef = React.useRef(0);
  const keyboardSearchNavigationRef = React.useRef(false);

  const settingsSearchResults = React.useMemo(() => {
    return buildSettingsSearchResults({
      query: settingsSearchQuery,
      runtimeCtx,
      visiblePageSlugs,
      getPageTitle,
    });
  }, [getPageTitle, runtimeCtx, settingsSearchQuery, visiblePageSlugs]);

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

  const openSearchResult = React.useCallback(
    (result: SettingsSearchResult) => {
      const targetId = prepareSettingsSearchTarget(result);
      setPendingSearchItemId(targetId);
      openPage(result.page);
      if (isMobile) {
        setMobileStage('page-content');
      }
    },
    [isMobile, openPage, prepareSettingsSearchTarget, setMobileStage],
  );

  const handleSettingsSearchKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (settingsSearchQuery.trim()) {
          setSettingsSearchQuery('');
          return;
        }
        if (isMobile && isMobileSettingsSearchOpen) {
          setIsMobileSettingsSearchOpen(false);
        }
        return;
      }

      if (!settingsSearchQuery.trim()) {
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
        setActiveSearchResultIndex(
          (current) => (current - 1 + settingsSearchResults.length) % settingsSearchResults.length,
        );
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        const safeIndex =
          ((activeSearchResultIndexRef.current % settingsSearchResults.length) + settingsSearchResults.length) %
          settingsSearchResults.length;
        const result = settingsSearchResults[safeIndex] ?? settingsSearchResults[0];
        if (result) {
          openSearchResult(result);
        }
      }
    },
    [isMobile, isMobileSettingsSearchOpen, openSearchResult, settingsSearchQuery, settingsSearchResults],
  );

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
      const escapedId =
        typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(targetId) : targetId.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
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
  }, [containerRef, pendingSearchItemId, settingsSlug]);

  return {
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
  };
}
