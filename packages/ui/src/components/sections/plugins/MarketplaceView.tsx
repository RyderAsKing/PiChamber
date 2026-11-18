import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_DESCRIPTION_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_LIST_DETAIL_CLASS,
  SettingsCallout,
  SettingsChipGroup,
  SettingsList,
  SettingsListRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { PluginRow } from '@/components/sections/plugins/PluginRow';
import { PiChamberTag } from '@/components/sections/plugins/tags';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { PiMarketplacePackage, PiPluginView } from '@/lib/pi/protocol';
import { cn } from '@/lib/utils';
import { installKey, useExtensionConfigStore } from '@/plugins/extensionConfigStore';
import { availableUpdate, formatCount, installedByName, matchingPlugins, npmNameOf, type InstalledPackage } from '@/plugins/marketplace';
import { searchKey, useMarketplaceStore } from '@/plugins/marketplaceStore';
import { useExtensionConfig } from '@/plugins/useExtensionConfig';

export type MarketplaceFilter = 'all' | 'pichamber';

const SEARCH_DELAY_MS = 300;

const SOURCE_INFO = 'Pi packages are npm packages with the pi-package keyword, the same list as the Pi package gallery. Searches go from the PiChamber server to npm. Featured picks come from the PiChamber project.';
const PICHAMBER_INFO = 'Every Pi package works in PiChamber. These also add features only PiChamber shows, built with the PiChamber plugin SDK. Their authors mark them with the pichamber-plugin keyword; a package\'s page checks its package.json.';

/** Version, maintainer, weekly downloads: what fits on one line. */
const packageFacts = (pkg: PiMarketplacePackage): string => [
  pkg.version ? `v${pkg.version}` : null,
  pkg.publisher ? `by ${pkg.publisher}` : null,
  pkg.weeklyDownloads !== undefined ? `${formatCount(pkg.weeklyDownloads)} a week` : null,
].filter(Boolean).join(' · ');

/** Where an installed package loads, and whether npm has a newer version. */
const installedLabel = (installed: InstalledPackage, latest: string | undefined): string => [
  installed.pkg.scope === 'project' ? 'Installed in this project' : 'Installed',
  latest && availableUpdate(installed.pkg, { [npmNameOf(installed.pkg) ?? '']: latest }) ? 'update available' : null,
].filter(Boolean).join(' · ');

/**
 * One package in Browse. The name is the row's button (stretched over the
 * row) and opens its page; Install stays its own control.
 */
function PackageRow({
  pkg,
  installed,
  installing,
  onOpen,
  onInstall,
}: {
  pkg: PiMarketplacePackage;
  installed?: InstalledPackage;
  installing: boolean;
  onOpen: () => void;
  onInstall: () => void;
}) {
  const facts = pkg.unavailable ? 'npm did not answer for this package' : packageFacts(pkg);
  const text = pkg.note ?? pkg.description;
  let trailing: React.ReactNode;
  if (installing) {
    trailing = <Button variant="outline" size="xs" disabled className="relative z-10">{'Installing…'}</Button>;
  } else if (installed) {
    trailing = <span className={cn(SETTINGS_LIST_DETAIL_CLASS, 'shrink-0')}>{installedLabel(installed, pkg.version)}</span>;
  } else {
    trailing = (
      <Button variant="outline" size="xs" className="relative z-10" aria-label={`Install ${pkg.name}`} onClick={onInstall}>
        {'Install'}
      </Button>
    );
  }
  return (
    <SettingsListRow
      interactive
      className="items-start py-3"
      title={(
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${pkg.name} details`}
          className={cn(
            'truncate typography-ui-label font-medium text-foreground outline-none',
            "after:absolute after:inset-0 after:content-['']",
            'focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-[var(--interactive-focus-ring)]',
          )}
        >
          {pkg.name}
        </button>
      )}
      titleAccessory={pkg.pichamberKeyword ? <PiChamberTag /> : null}
      detail={(
        <>
          {text ? <p className={cn(SETTINGS_LIST_DETAIL_CLASS, 'line-clamp-2 text-pretty')}>{text}</p> : null}
          {facts ? <p className="truncate typography-micro tabular-nums text-muted-foreground">{facts}</p> : null}
        </>
      )}
      trailing={trailing}
    />
  );
}

function PackageList({
  packages,
  installed,
  onOpenPackage,
  onInstall,
}: {
  packages: PiMarketplacePackage[];
  installed: Map<string, InstalledPackage>;
  onOpenPackage: (name: string) => void;
  onInstall: (name: string) => void;
}) {
  const pending = useExtensionConfigStore((state) => state.pending);
  return (
    <SettingsList>
      {packages.map((pkg) => (
        <PackageRow
          key={pkg.name}
          pkg={pkg}
          installed={installed.get(pkg.name)}
          installing={pending[installKey(pkg.name)] === true}
          onOpen={() => onOpenPackage(pkg.name)}
          onInstall={() => onInstall(pkg.name)}
        />
      ))}
    </SettingsList>
  );
}

/** The search text, applied after the user stops typing. */
function useSettledValue(value: string, delayMs: number): string {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    if (value.trim() === '') {
      setSettled(value);
      return;
    }
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/**
 * Settings → Extensions & Plugins → Browse: Pi packages on npm. Without a
 * search it shows the featured picks and the most popular packages. A search
 * that matches a built-in plugin shows that plugin first, with its switch:
 * nothing to install. Built-in plugins are never in the npm results.
 */
export function MarketplaceView({
  plugins,
  directory,
  query,
  onQueryChange,
  filter,
  onFilterChange,
  onBack,
  onOpenPackage,
  onOpenPlugin,
  onInstall,
}: {
  plugins: PiPluginView[];
  directory: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  filter: MarketplaceFilter;
  onFilterChange: (filter: MarketplaceFilter) => void;
  onBack: () => void;
  onOpenPackage: (name: string) => void;
  onOpenPlugin: (id: string) => void;
  onInstall: (name: string) => void;
}) {
  const settledQuery = useSettledValue(query, SEARCH_DELAY_MS).trim();
  const pichamberOnly = filter === 'pichamber';
  const featured = useMarketplaceStore((state) => state.featured);
  const loadFeatured = useMarketplaceStore((state) => state.loadFeatured);
  const search = useMarketplaceStore((state) => state.search);
  const results = useMarketplaceStore((state) => state.searches[searchKey(settledQuery, pichamberOnly)]);

  // Installed in every project, and in this folder (which also lists the global ones).
  const globalConfig = useExtensionConfig(null)?.config;
  const projectConfig = useExtensionConfig(directory)?.config;
  const installed = React.useMemo(() => installedByName([
    { config: globalConfig, view: 'global' },
    ...(directory ? [{ config: projectConfig, view: 'project' as const }] : []),
  ]), [globalConfig, projectConfig, directory]);

  const showFeatured = settledQuery === '' && !pichamberOnly;
  React.useEffect(() => {
    if (showFeatured) void loadFeatured();
  }, [showFeatured, loadFeatured]);
  React.useEffect(() => {
    void search(settledQuery, pichamberOnly);
  }, [settledQuery, pichamberOnly, search]);

  const suggestions = matchingPlugins(plugins, settledQuery);
  const featuredNames = new Set(showFeatured ? (featured.data?.packages ?? []).map((pkg) => pkg.name) : []);
  // A featured package is not listed again under it.
  const listed = (results?.packages ?? []).filter((pkg) => !featuredNames.has(pkg.name));

  let resultsBody: React.ReactNode;
  if (!results || (results.status === 'loading' && results.packages.length === 0)) {
    resultsBody = <p className={SETTINGS_HELPER_CLASS}>{settledQuery ? 'Searching npm…' : 'Loading packages from npm…'}</p>;
  } else if (results.status === 'error' && results.packages.length === 0) {
    resultsBody = (
      <SettingsCallout
        title="Could not reach npm"
        action={(
          <Button variant="outline" size="sm" onClick={() => void search(settledQuery, pichamberOnly, { force: true })}>
            {'Try again'}
          </Button>
        )}
      >
        {'The PiChamber server could not get the package list. Check its network connection.'}
      </SettingsCallout>
    );
  } else if (listed.length === 0) {
    let empty: string;
    if (pichamberOnly) {
      empty = settledQuery
        ? `No packages that support PiChamber match “${settledQuery}”.`
        : 'No packages say they support PiChamber yet.';
    } else {
      empty = settledQuery ? `No Pi packages match “${settledQuery}”.` : 'npm listed no Pi packages.';
    }
    resultsBody = <p className={cn(SETTINGS_HELPER_CLASS, 'text-pretty')}>{empty}</p>;
  } else {
    resultsBody = (
      <div className="space-y-3">
        {results.status === 'error' ? (
          <SettingsCallout title="Could not refresh these results">{'They may be out of date.'}</SettingsCallout>
        ) : null}
        <PackageList packages={listed} installed={installed} onOpenPackage={onOpenPackage} onInstall={onInstall} />
        {results.nextFrom !== null ? (
          <div className="flex flex-wrap items-center justify-center gap-3">
            {results.moreFailed ? <span className={SETTINGS_HELPER_CLASS}>{'Could not load more.'}</span> : null}
            <Button
              variant="ghost"
              size="sm"
              disabled={results.loadingMore}
              onClick={() => void search(settledQuery, pichamberOnly, { more: true })}
            >
              {results.loadingMore ? 'Loading…' : results.moreFailed ? 'Try again' : 'Show more'}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  const resultsTitle = settledQuery ? 'Results' : pichamberOnly ? 'Enhanced for PiChamber' : 'Popular';
  const resultsCount = !settledQuery && results?.total !== undefined && !pichamberOnly ? (
    <span className="typography-micro tabular-nums text-muted-foreground">
      {`${results.total.toLocaleString()} Pi packages`}
    </span>
  ) : null;

  let sectionIndex = 0;
  const divider = () => {
    sectionIndex += 1;
    return sectionIndex > 1;
  };

  return (
    <SettingsPageLayout
      title="Browse"
      titleAbove={(
        <Button variant="ghost" size="xs" onClick={onBack} className="-ml-2 gap-1 text-muted-foreground">
          <Icon name="arrow-left-s" aria-hidden="true" className="size-4" />
          {'Extensions & Plugins'}
        </Button>
      )}
      description={(
        <p className={cn(SETTINGS_DESCRIPTION_CLASS, 'text-pretty')}>
          {'Pi packages from npm. Pi loads an installed package here and in the terminal.'}
        </p>
      )}
    >
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <div className="relative w-full min-w-0 max-w-[24rem]">
          <Icon
            name="search"
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search Pi packages"
            aria-label="Search Pi packages"
            className="h-9 w-full pl-8 pr-8"
            autoFocus
          />
          {query ? (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
            >
              <Icon name="close" className="size-4" />
            </button>
          ) : null}
        </div>
        <SettingsChipGroup
          aria-label="Show packages"
          value={filter}
          onChange={onFilterChange}
          options={[
            { value: 'all', label: 'All' },
            { value: 'pichamber', label: 'Enhanced for PiChamber' },
          ]}
        />
      </div>

      {suggestions.length > 0 ? (
        <SettingsSection
          divider={divider()}
          title="Built into PiChamber"
          description="Already here. Turn it on; there is nothing to install."
        >
          <SettingsList>
            {suggestions.map((plugin) => (
              <PluginRow key={plugin.id} plugin={plugin} onOpen={() => onOpenPlugin(plugin.id)} />
            ))}
          </SettingsList>
        </SettingsSection>
      ) : null}

      {showFeatured ? (
        <SettingsSection divider={divider()} title="Featured" info={SOURCE_INFO}>
          {featured.data && featured.data.packages.length > 0 ? (
            <PackageList
              packages={featured.data.packages}
              installed={installed}
              onOpenPackage={onOpenPackage}
              onInstall={onInstall}
            />
          ) : featured.status === 'error' ? (
            <p className={SETTINGS_HELPER_CLASS}>{'Could not load the featured packages.'}</p>
          ) : featured.data ? (
            <p className={SETTINGS_HELPER_CLASS}>{'Nothing is featured right now.'}</p>
          ) : (
            <p className={SETTINGS_HELPER_CLASS}>{'Loading…'}</p>
          )}
        </SettingsSection>
      ) : null}

      <SettingsSection
        divider={divider()}
        title={resultsTitle}
        titleAccessory={resultsCount}
        info={pichamberOnly ? PICHAMBER_INFO : showFeatured ? undefined : SOURCE_INFO}
      >
        {resultsBody}
      </SettingsSection>
    </SettingsPageLayout>
  );
}
