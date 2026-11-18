import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_DESCRIPTION_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_LIST_DETAIL_CLASS,
  SETTINGS_PAGE_TITLE_CLASS,
  SettingsCallout,
  SettingsList,
  SettingsListRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { reportPackageWrite } from '@/components/sections/plugins/extensionWriteReport';
import { PiChamberTag } from '@/components/sections/plugins/tags';
import { Button } from '@/components/ui/button';
import { reportSettingsSaveState } from '@/lib/persistence';
import type { PiMarketplacePackageDetail } from '@/lib/pi/protocol';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import { installKey, useExtensionConfigStore } from '@/plugins/extensionConfigStore';
import { availableUpdate, formatCount, formatInstalledFacts, installedByName } from '@/plugins/marketplace';
import { useMarketplaceStore } from '@/plugins/marketplaceStore';
import { useExtensionConfig } from '@/plugins/useExtensionConfig';

const CONTAINS_LABEL: Record<PiMarketplacePackageDetail['contains'][number], string> = {
  extensions: 'Extensions',
  skills: 'Skills',
  prompts: 'Prompt templates',
  themes: 'Themes',
};

const CONTAINS_DETAIL: Record<PiMarketplacePackageDetail['contains'][number], string> = {
  extensions: 'Code Pi runs in every session: tools, commands, and hooks',
  skills: 'Instructions the agent can load when a task needs them',
  prompts: 'Saved prompts you start with a slash command',
  themes: 'Colours for Pi in the terminal',
};

/** A text value at the end of a fact row. */
function Fact({ children }: { children: React.ReactNode }) {
  return <span className={cn(SETTINGS_LIST_DETAIL_CLASS, 'min-w-0 truncate text-right tabular-nums')}>{children}</span>;
}

function LinkRow({ title, url }: { title: string; url: string }) {
  return (
    <SettingsListRow
      interactive
      title={(
        <button
          type="button"
          onClick={() => void openExternalUrl(url)}
          className={cn(
            'truncate typography-ui-label text-foreground outline-none',
            "after:absolute after:inset-0 after:content-['']",
            'focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-[var(--interactive-focus-ring)]',
          )}
        >
          {title}
        </button>
      )}
      trailing={(
        <>
          <Fact>{url.replace(/^https?:\/\//, '')}</Fact>
          <Icon name="external-link" aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </>
      )}
    />
  );
}

const dateText = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/**
 * One npm package's page: what it adds, whether it supports PiChamber (read
 * from its manifest, not its keywords), and Install, or Update when an
 * installed copy is behind.
 */
export function MarketplacePackagePage({
  name,
  directory,
  backLabel,
  onBack,
  onInstall,
}: {
  name: string;
  directory: string | null;
  backLabel: string;
  onBack: () => void;
  onInstall: (name: string) => void;
}) {
  const detail = useMarketplaceStore((state) => state.details[name]);
  const latest = useMarketplaceStore((state) => state.latest);
  const loadDetail = useMarketplaceStore((state) => state.loadDetail);
  const pending = useExtensionConfigStore((state) => state.pending);
  const updatePackage = useExtensionConfigStore((state) => state.updatePackage);
  const globalConfig = useExtensionConfig(null)?.config;
  const projectConfig = useExtensionConfig(directory)?.config;

  React.useEffect(() => {
    void loadDetail(name);
  }, [name, loadDetail]);

  const installed = installedByName([
    { config: globalConfig, view: 'global' },
    ...(directory ? [{ config: projectConfig, view: 'project' as const }] : []),
  ]).get(name);
  const data = detail?.data ?? null;
  const update = installed ? availableUpdate(installed.pkg, latest) : undefined;
  const installing = pending[installKey(name)] === true;
  const updating = installed ? pending[installed.pkg.id] === true : false;

  const backLink = (
    <Button variant="ghost" size="xs" onClick={onBack} className="-ml-2 gap-1 text-muted-foreground">
      <Icon name="arrow-left-s" aria-hidden="true" className="size-4" />
      {backLabel}
    </Button>
  );

  const runUpdate = () => {
    if (!installed) return;
    reportSettingsSaveState('saving');
    void updatePackage(installed.pkg.id, installed.pkg.scope === 'project' ? directory : null)
      .then((result) => reportPackageWrite(result, name, 'update'));
  };

  let action: React.ReactNode;
  if (installing) {
    action = <Button variant="solid" size="sm" disabled>{'Installing…'}</Button>;
  } else if (installed && update) {
    action = (
      <Button variant="outline" size="sm" disabled={updating} onClick={runUpdate}>
        {updating ? 'Updating…' : `Update to ${update}`}
      </Button>
    );
  } else if (!installed) {
    action = <Button variant="solid" size="sm" onClick={() => onInstall(name)}>{'Install'}</Button>;
  }

  let statusTitle = 'Not installed';
  let statusDetail: string | undefined;
  if (installed) {
    statusTitle = installed.pkg.scope === 'project' ? 'Installed in this project' : 'Installed in every project';
    statusDetail = formatInstalledFacts(installed.pkg) || undefined;
  } else if (installing) {
    statusTitle = 'Installing';
    statusDetail = 'npm is downloading it. This can take a minute.';
  }

  let body: React.ReactNode;
  if (!data && detail?.status === 'error') {
    body = (
      <SettingsCallout
        title="Could not load this package from npm"
        action={<Button variant="outline" size="sm" onClick={() => void loadDetail(name, { force: true })}>{'Try again'}</Button>}
      >
        {'It may have been removed, or the PiChamber server cannot reach npm.'}
      </SettingsCallout>
    );
  } else if (!data) {
    body = <p className={SETTINGS_HELPER_CLASS}>{'Loading from npm…'}</p>;
  } else {
    body = (
      <>
        {!data.isPiPackage ? (
          <SettingsCallout className="mb-3" title="Not marked as a Pi package">
            {'It lacks the pi-package keyword, so Pi may find nothing to load in it.'}
          </SettingsCallout>
        ) : null}

        <SettingsSection divider={false} title="What it adds to Pi">
          {data.contains.length > 0 ? (
            <SettingsList>
              {data.contains.map((type) => (
                <SettingsListRow key={type} title={CONTAINS_LABEL[type]} detail={CONTAINS_DETAIL[type]} />
              ))}
            </SettingsList>
          ) : (
            <p className={cn(SETTINGS_HELPER_CLASS, 'text-pretty')}>
              {'Its package.json does not say. Pi loads what it finds in the package\'s extensions, skills, prompts, and themes folders.'}
            </p>
          )}
        </SettingsSection>

        <SettingsSection title="In PiChamber">
          <p className={cn(SETTINGS_HELPER_CLASS, 'text-pretty')}>
            {data.pichamber
              ? 'Enhanced for PiChamber: built with the PiChamber plugin SDK to add features only PiChamber shows. PiChamber does not load those extras from packages it does not ship yet, so for now it runs as a plain Pi package, here and in the terminal.'
              : 'A plain Pi package. It works in PiChamber as it does in the terminal.'}
          </p>
        </SettingsSection>

        <SettingsSection title="About">
          <SettingsList>
            {data.version ? <SettingsListRow title="Latest version" trailing={<Fact>{data.version}</Fact>} /> : null}
            {data.date ? <SettingsListRow title="Published" trailing={<Fact>{dateText(data.date)}</Fact>} /> : null}
            {data.publisher ? <SettingsListRow title="Maintainer" trailing={<Fact>{data.publisher}</Fact>} /> : null}
            {data.license ? <SettingsListRow title="License" trailing={<Fact>{data.license}</Fact>} /> : null}
            {data.weeklyDownloads !== undefined ? (
              <SettingsListRow title="Downloads" trailing={<Fact>{`${formatCount(data.weeklyDownloads)} a week`}</Fact>} />
            ) : null}
          </SettingsList>
        </SettingsSection>

        <SettingsSection title="Links">
          <SettingsList>
            <LinkRow title="npm" url={data.links.npm} />
            {data.links.repository ? <LinkRow title="Source code" url={data.links.repository} /> : null}
            {data.links.homepage ? <LinkRow title="Homepage" url={data.links.homepage} /> : null}
          </SettingsList>
        </SettingsSection>
      </>
    );
  }

  return (
    <SettingsPageLayout
      // Built here rather than by the layout so a long scoped name wraps
      // instead of being cut off, with the tag beside it.
      title={(
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h1 className={cn(SETTINGS_PAGE_TITLE_CLASS, 'min-w-0 break-all')}>{name}</h1>
          {data?.pichamber ? <PiChamberTag /> : null}
        </div>
      )}
      titleAbove={backLink}
      description={data?.description ? (
        <p className={cn(SETTINGS_DESCRIPTION_CLASS, 'text-pretty')}>{data.description}</p>
      ) : undefined}
    >
      <SettingsList className="mb-6">
        <SettingsListRow
          title={statusTitle}
          detail={statusDetail}
          trailing={action}
        />
      </SettingsList>
      {body}
    </SettingsPageLayout>
  );
}
