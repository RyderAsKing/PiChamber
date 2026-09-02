import React from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipTrigger } from '@/components/ui/tooltip';
import {
  getSettingsNavIcon,
  type SettingsPageSlug,
  type SettingsPageMeta,
} from '@/lib/settings/metadata';
import type { SettingsSearchResult } from '@/lib/settings/search';

export const NAV_GROUP_ORDER = ['general', 'projects', 'agent'] as const;

export type SettingsNavProps = {
  isMobile: boolean;
  isMobileSettingsSearchOpen: boolean;
  settingsSearchQuery: string;
  setSettingsSearchQuery: (query: string) => void;
  handleSettingsSearchKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  settingsSearchResults: SettingsSearchResult[];
  groupedSettingsSearchResults: Array<{
    page: SettingsPageSlug;
    pageTitle: string;
    results: SettingsSearchResult[];
  }>;
  activeSearchResultIndex: number;
  setActiveSearchResultIndex: (index: number) => void;
  searchResultRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
  keyboardSearchNavigationRef: React.MutableRefObject<boolean>;
  openSearchResult: (result: SettingsSearchResult) => void;
  sortedFilteredPages: SettingsPageMeta[];
  settingsSlug: SettingsPageSlug;
  mobileStage: 'nav' | 'page-sidebar' | 'page-content';
  openPage: (slug: SettingsPageSlug) => void;
  getPageTitle: (slug: SettingsPageSlug) => string;
  activeRemoteLabel: string | null;
  mobileAppActions?: {
    openInstances?: () => void;
  } | null;
};

export function SettingsNav({
  isMobile,
  isMobileSettingsSearchOpen,
  settingsSearchQuery,
  setSettingsSearchQuery,
  handleSettingsSearchKeyDown,
  settingsSearchResults,
  groupedSettingsSearchResults,
  activeSearchResultIndex,
  setActiveSearchResultIndex,
  searchResultRefs,
  keyboardSearchNavigationRef,
  openSearchResult,
  sortedFilteredPages,
  settingsSlug,
  mobileStage,
  openPage,
  getPageTitle,
  activeRemoteLabel,
  mobileAppActions,
}: SettingsNavProps): React.ReactNode {
  const hasSearchQuery = settingsSearchQuery.trim().length > 0;
  const effectiveHasSearchQuery = isMobile
    ? isMobileSettingsSearchOpen && hasSearchQuery
    : hasSearchQuery;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {isMobile ? (
        !effectiveHasSearchQuery ? (
          <div className="px-3 pt-3">
            <button
              type="button"
              onClick={() => {
                if (mobileAppActions?.openInstances) {
                  mobileAppActions.openInstances();
                  return;
                }
                openPage('remote-instances');
              }}
              className={cn(
                'flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3.5 text-left shadow-sm hover:bg-interactive-hover/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                activeRemoteLabel
                  ? 'border-[var(--status-success)]/30 bg-[var(--status-success)]/10'
                  : 'border-border bg-card'
              )}
            >
              <div className="min-w-0 flex-1">
                {activeRemoteLabel ? (
                  <>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="typography-ui-label font-medium text-foreground truncate">
                        {activeRemoteLabel}
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0 typography-micro">
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-[var(--status-success)] animate-pulse"
                          aria-hidden
                        />
                        <span className="text-[var(--status-success)]">
                          Connected
                        </span>
                      </span>
                    </div>
                    <div className="typography-micro text-muted-foreground truncate">
                      Manage instances & pair devices
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="typography-ui-label font-medium text-foreground truncate">
                        Not connected
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0 typography-micro">
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-muted-foreground"
                          aria-hidden
                        />
                        <span className="text-muted-foreground">
                          Select a server
                        </span>
                      </span>
                    </div>
                    <div className="typography-micro text-muted-foreground truncate">
                      Manage instances & pair devices
                    </div>
                  </>
                )}
              </div>
              <Icon
                name="arrow-right-s"
                className="size-4 shrink-0 text-muted-foreground"
              />
            </button>
          </div>
        ) : null
      ) : (
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
      )}

      {/* Scrollable nav items */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="flex flex-col gap-0.5 px-3 pt-3 pb-2">
          {effectiveHasSearchQuery ? (
            settingsSearchResults.length > 0 ? (
              (() => {
                let resultIndex = 0;
                return groupedSettingsSearchResults.map((group) => (
                  <div key={group.page} className="space-y-0.5">
                    <div className="px-2 pb-0.5 pt-2 typography-micro font-medium text-muted-foreground/70">
                      {group.pageTitle}
                    </div>
                    {group.results.map((result) => {
                      const currentIndex = resultIndex;
                      resultIndex += 1;
                      const active =
                        currentIndex === activeSearchResultIndex;
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
                            active
                              ? 'bg-interactive-selection'
                              : 'hover:bg-interactive-hover'
                          )}
                        >
                          <span className="typography-ui-label text-foreground truncate">
                            {result.title}
                          </span>
                          {hasDescription && (
                            <span className="typography-micro text-muted-foreground/70 line-clamp-2">
                              {result.description}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ));
              })()
            ) : (
              <div className="px-2 py-6 text-center typography-ui text-muted-foreground">
                {"No matching settings"}
              </div>
            )
          ) : (
            (() => {
              const pagesByGroup = new Map<
                string,
                typeof sortedFilteredPages
              >();
              for (const page of sortedFilteredPages) {
                const group = page.group;
                const existing = pagesByGroup.get(group);
                if (existing) {
                  existing.push(page);
                } else {
                  pagesByGroup.set(group, [page]);
                }
              }

              const visibleGroups = NAV_GROUP_ORDER.map((group) => ({
                group,
                pages: pagesByGroup.get(group) ?? [],
              })).filter((entry) => entry.pages.length > 0);

              return visibleGroups.map(({ group, pages }, groupIndex) => {
                const groupLabel =
                  group === 'projects'
                    ? 'Workspace'
                    : group === 'agent'
                      ? 'Agent'
                      : null;
                return (
                  <div key={group} className="space-y-0.5">
                    {groupLabel ? (
                      <div
                        className={cn(
                          'px-3 pb-1 typography-micro font-semibold uppercase tracking-wide text-muted-foreground sm:px-2 sm:pb-0.5',
                          groupIndex === 0 ? 'pt-1' : 'pt-4 sm:pt-3'
                        )}
                      >
                        {groupLabel}
                      </div>
                    ) : null}
                    {pages.map((page) => {
                      const selected =
                        settingsSlug === page.slug &&
                        !(isMobile && mobileStage === 'nav');
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
                              <Icon
                                name={iconName}
                                className="h-[18px] w-[18px] shrink-0 sm:h-4 sm:w-4"
                              />
                              <span className="flex items-center gap-1.5 whitespace-nowrap overflow-hidden transition-opacity duration-150 opacity-100">
                                <span className="typography-ui-label font-normal truncate">
                                  {getPageTitle(page.slug)}
                                </span>
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
                );
              });
            })()
          )}
        </div>
      </div>
    </div>
  );
}
