import React from 'react';

import {
  SETTINGS_HELPER_CLASS,
  SETTINGS_LIST_DETAIL_CLASS,
  SettingsCallout,
  SettingsChipGroup,
  SettingsControlGroup,
  SettingsList,
  SettingsListRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { reportExtensionWrite, reportPackageWrite } from '@/components/sections/plugins/extensionWriteReport';
import { PiChamberTag } from '@/components/sections/plugins/tags';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { reportSettingsSaveState } from '@/lib/persistence';
import type {
  PiExtensionConfigItem,
  PiExtensionConfigPackage,
  PiExtensionConfigResponse,
} from '@/lib/pi/protocol';
import { cn } from '@/lib/utils';
import { useExtensionConfigStore } from '@/plugins/extensionConfigStore';
import { availableUpdate, formatInstalledFacts, npmNameOf } from '@/plugins/marketplace';
import { useMarketplaceStore } from '@/plugins/marketplaceStore';
import { replacementNotes } from '@/plugins/replacements';
import { useExtensionConfig } from '@/plugins/useExtensionConfig';

type ViewScope = 'global' | 'project';

const SECTION_INFO = 'Extensions are code Pi loads into every session. This is the list the pi config command shows, and it writes the same settings, so a change here also applies in the terminal. It changes Pi on the machine that runs the PiChamber server.';
const BUILTIN_INFO = 'These ship with Pi. Its llama.cpp provider is built in too, but PiChamber does not load it, so it is not listed.';

/** What each of Pi's built-ins is for, by the name Pi lists it under. */
const BUILTIN_DETAIL: Record<string, string> = {
  mcp: 'Connects MCP servers and offers their tools',
  codemode: 'Lets the model run a script that calls the other tools',
  'tool-search': 'Lets the model find tools that are not declared to it',
};

interface ListContext {
  view: ViewScope;
  directory: string | null;
  /** Show what loads without controls. */
  readOnly: boolean;
  /** A second line per extension id: left out, or loaded in place of something. */
  notes: ReturnType<typeof replacementNotes>;
}

/** Whether Pi loads the extension in the view shown. */
const loadsIn = (item: PiExtensionConfigItem, view: ViewScope): boolean => (
  view === 'project' ? item.project?.enabled ?? item.global ?? false : item.global ?? false
);

/** "2 of 3 on", beside a group title or in a package's line. */
const countText = (items: PiExtensionConfigItem[], view: ViewScope): string => (
  `${items.filter((item) => loadsIn(item, view)).length} of ${items.length} on`
);

function GroupTitle({ title, items, view }: { title: string; items: PiExtensionConfigItem[]; view: ViewScope }) {
  return (
    <>
      {title}
      {items.length > 0 ? (
        <span className="ml-2 typography-micro font-normal tabular-nums text-muted-foreground">{countText(items, view)}</span>
      ) : null}
    </>
  );
}

/** One extension: a switch for the global setting, or for this project in a project view. */
function ExtensionRow({
  item,
  view,
  directory,
  readOnly,
  notes,
}: ListContext & { item: PiExtensionConfigItem }) {
  const setGlobal = useExtensionConfigStore((state) => state.setGlobal);
  const setProjectEnabled = useExtensionConfigStore((state) => state.setProjectEnabled);
  const busy = useExtensionConfigStore((state) => state.pending[item.id] === true);

  const loads = loadsIn(item, view);
  // A note is about what a live session loaded, so it only fits an extension that is on.
  const note = loads ? notes.get(item.id) : undefined;

  let control: React.ReactNode = null;
  if (readOnly) {
    control = <span className={SETTINGS_LIST_DETAIL_CLASS}>{loads ? 'On' : 'Off'}</span>;
  } else if (view === 'project' && item.project && directory) {
    control = (
      <Switch
        checked={item.project.enabled}
        disabled={busy}
        ariaLabel={`${item.name} in this project`}
        onChange={(next) => {
          reportSettingsSaveState('saving');
          void setProjectEnabled(item.id, next, directory).then((result) => reportExtensionWrite(result, item.name));
        }}
      />
    );
  } else if (view === 'global' && item.global !== undefined) {
    control = (
      <Switch
        checked={item.global}
        disabled={busy}
        ariaLabel={item.name}
        onChange={(next) => {
          reportSettingsSaveState('saving');
          void setGlobal(item.id, next).then((result) => reportExtensionWrite(result, item.name));
        }}
      />
    );
  }

  let detail: React.ReactNode;
  if (note) {
    detail = (
      <p className={cn('line-clamp-2 text-pretty typography-meta', note.warning ? 'text-[var(--status-warning)]' : 'text-muted-foreground')}>
        {note.text}
      </p>
    );
  } else if (view === 'project' && item.project && item.scope !== 'project' && item.project.enabled !== item.project.inherited) {
    // The one thing the switch cannot say: this project differs from the global setting.
    detail = item.project.enabled ? 'On in this project only' : 'Off in this project only';
  } else if (item.group === 'builtin') {
    detail = BUILTIN_DETAIL[item.name];
  } else if (item.group === 'settings') {
    detail = 'Listed in Pi\'s settings';
  }

  return <SettingsListRow title={item.name} dimmed={!loads} detail={detail} trailing={control} />;
}

function ExtensionList({ items, ...context }: ListContext & { items: PiExtensionConfigItem[] }) {
  return (
    <SettingsList>
      {items.map((item) => <ExtensionRow key={item.id} item={item} {...context} />)}
    </SettingsList>
  );
}

/** A package and what it loads: one list, the package on its first row. */
function PackageBlock({
  pkg,
  items,
  onRemove,
  onOpenPackage,
  ...context
}: ListContext & {
  pkg: PiExtensionConfigPackage;
  items: PiExtensionConfigItem[];
  onRemove: (pkg: PiExtensionConfigPackage) => void;
  onOpenPackage: (name: string) => void;
}) {
  const { view, readOnly, directory } = context;
  const busy = useExtensionConfigStore((state) => state.pending[pkg.id] === true);
  const updatePackage = useExtensionConfigStore((state) => state.updatePackage);
  const latest = useMarketplaceStore((state) => state.latest);
  // Remove and update act on the scope that lists the package, as `pi remove -l` does.
  const ownScope = !readOnly && pkg.scope === (view === 'project' ? 'project' : 'user');
  const update = ownScope ? availableUpdate(pkg, latest) : undefined;
  const [action, setAction] = React.useState<'remove' | 'update' | null>(null);
  const where = pkg.scope === 'project' ? 'This project' : view === 'project' ? 'Global' : null;
  const facts = [formatInstalledFacts(pkg), where, items.length > 0 ? countText(items, view) : null].filter(Boolean).join(' · ');
  const npmName = npmNameOf(pkg);

  const runUpdate = () => {
    setAction('update');
    reportSettingsSaveState('saving');
    void updatePackage(pkg.id, pkg.scope === 'project' ? directory : null).then((result) => {
      setAction(null);
      reportPackageWrite(result, npmName ?? pkg.source, 'update');
    });
  };

  return (
    <SettingsList>
      <SettingsListRow
        heading
        title={npmName ? (
          <button
            type="button"
            onClick={() => onOpenPackage(npmName)}
            aria-label={`${npmName} details`}
            className="truncate typography-ui-label font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
          >
            {npmName}
          </button>
        ) : pkg.source}
        titleAccessory={pkg.pichamber ? <PiChamberTag /> : null}
        detail={(
          <p className={cn(SETTINGS_LIST_DETAIL_CLASS, 'line-clamp-2 text-pretty')}>
            {facts}
            {pkg.installed ? null : <span className="text-[var(--status-warning)]">{' · Not installed'}</span>}
          </p>
        )}
        trailing={ownScope ? (
          <>
            {update ? (
              <Button variant="outline" size="xs" disabled={busy} onClick={runUpdate} aria-label={`Update ${pkg.source} to ${update}`}>
                {busy && action === 'update' ? 'Updating…' : `Update to ${update}`}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="xs"
              disabled={busy}
              aria-label={`Remove ${pkg.source}`}
              onClick={() => {
                setAction('remove');
                onRemove(pkg);
              }}
            >
              {busy && action !== 'update' ? 'Removing…' : 'Remove'}
            </Button>
          </>
        ) : undefined}
      />
      {items.length === 0 ? (
        <li className={cn(SETTINGS_LIST_DETAIL_CLASS, 'px-3.5 py-2.5')}>
          {pkg.installed ? 'No extensions in this package.' : 'Pi cannot load it until it is installed again.'}
        </li>
      ) : items.map((item) => <ExtensionRow key={item.id} item={item} {...context} />)}
    </SettingsList>
  );
}

function RemovePackageDialog({
  pkg,
  directory,
  onClose,
}: {
  pkg: PiExtensionConfigPackage | null;
  directory: string | null;
  onClose: () => void;
}) {
  const removePackage = useExtensionConfigStore((state) => state.removePackage);
  const [removing, setRemoving] = React.useState(false);
  // Keep the text while the dialog closes.
  const [shown, setShown] = React.useState(pkg);
  React.useEffect(() => {
    if (pkg) setShown(pkg);
  }, [pkg]);

  const confirm = async () => {
    if (!pkg) return;
    setRemoving(true);
    reportSettingsSaveState('saving');
    const result = await removePackage(pkg.id, pkg.scope === 'project' ? directory : null);
    setRemoving(false);
    reportExtensionWrite(result, pkg.source);
    onClose();
  };

  const scopeText = shown?.scope === 'project' ? 'in this project' : 'in every project';
  const filesText = shown?.kind === 'local'
    ? 'The folder itself stays where it is.'
    : 'Its installed files are deleted.';
  return (
    <Dialog open={pkg !== null} onOpenChange={(open) => { if (!open && !removing) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{'Remove package?'}</DialogTitle>
          <DialogDescription>
            {`Pi stops loading ${shown?.source ?? 'this package'} ${scopeText}. ${filesText}`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={removing}>{'Cancel'}</Button>
          <Button variant="destructive" size="sm" onClick={() => void confirm()} disabled={removing}>
            {removing ? 'Removing…' : 'Remove'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExtensionGroups({
  config,
  onRemove,
  onBrowse,
  onOpenPackage,
  ...context
}: ListContext & {
  config: PiExtensionConfigResponse;
  onRemove: (pkg: PiExtensionConfigPackage) => void;
  onBrowse: () => void;
  onOpenPackage: (name: string) => void;
}) {
  const { view } = context;
  const byPackage = new Map<string, PiExtensionConfigItem[]>();
  const own: PiExtensionConfigItem[] = [];
  const project: PiExtensionConfigItem[] = [];
  const builtin: PiExtensionConfigItem[] = [];
  for (const item of config.extensions) {
    if (item.group === 'builtin') builtin.push(item);
    else if (item.group === 'package' && item.packageId) {
      byPackage.set(item.packageId, [...(byPackage.get(item.packageId) ?? []), item]);
    } else if (item.scope === 'project') project.push(item);
    else own.push(item);
  }
  // Global packages first, as `pi config` lists them.
  const packages = [...config.packages].sort((a, b) => Number(a.scope === 'project') - Number(b.scope === 'project'));

  return (
    <div className="space-y-5">
      <SettingsControlGroup title="Packages" settingsItem="plugins.extensions.packages" contentClassName="space-y-2">
        {packages.length > 0 ? packages.map((pkg) => (
          <PackageBlock
            key={pkg.id}
            pkg={pkg}
            items={byPackage.get(pkg.id) ?? []}
            onRemove={onRemove}
            onOpenPackage={onOpenPackage}
            {...context}
          />
        )) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className={cn(SETTINGS_HELPER_CLASS, 'text-pretty')}>{'None installed yet.'}</p>
            <Button variant="link" size="xs" className="h-auto px-0 underline underline-offset-4" onClick={onBrowse}>{'Browse Pi packages'}</Button>
          </div>
        )}
      </SettingsControlGroup>

      <SettingsControlGroup
        title={<GroupTitle title={view === 'project' ? 'Global extensions' : 'Your extensions'} items={own} view={view} />}
        settingsItem="plugins.extensions.own"
      >
        {own.length > 0 ? (
          <ExtensionList items={own} {...context} />
        ) : (
          <p className={cn(SETTINGS_HELPER_CLASS, 'text-pretty')}>
            {packages.length > 0
              ? 'None outside packages.'
              : 'None yet. Pi loads the files in its extensions folder.'}
          </p>
        )}
      </SettingsControlGroup>

      {view === 'project' && project.length > 0 ? (
        <SettingsControlGroup title={<GroupTitle title="This project's extensions" items={project} view={view} />}>
          <ExtensionList items={project} {...context} />
        </SettingsControlGroup>
      ) : null}

      {builtin.length > 0 ? (
        <SettingsControlGroup
          title={<GroupTitle title="Built into Pi" items={builtin} view={view} />}
          info={BUILTIN_INFO}
          settingsItem="plugins.extensions.builtin"
        >
          <ExtensionList items={builtin} {...context} />
        </SettingsControlGroup>
      ) : null}
    </div>
  );
}

/**
 * Settings → Extensions & Plugins → Pi extensions: what `pi config`,
 * `pi list`, and `pi remove` do. The Global view reads Pi's settings without
 * a project; This project reads them for the open folder and writes only that
 * project's overrides.
 */
export function ExtensionsSection({
  directory,
  pluginNames,
  onBrowse,
  onOpenPackage,
}: {
  directory: string | null;
  /** Plugin names by id, to name a plugin an extension took the place of. */
  pluginNames: Record<string, string>;
  onBrowse: () => void;
  /** Open an npm package's marketplace page. */
  onOpenPackage: (name: string) => void;
}) {
  const [scope, setScope] = React.useState<ViewScope>('global');
  // With no folder open there is only the global view.
  const view: ViewScope = scope === 'project' && directory ? 'project' : 'global';
  const viewDirectory = view === 'project' ? directory : null;
  const entry = useExtensionConfig(viewDirectory);
  const load = useExtensionConfigStore((state) => state.load);
  const [removeTarget, setRemoveTarget] = React.useState<PiExtensionConfigPackage | null>(null);

  const config = entry?.config ?? null;
  const untrusted = view === 'project' && config !== null && !config.project.trusted;

  // Ask npm which installed packages have a newer version, once per name.
  const loadVersions = useMarketplaceStore((state) => state.loadVersions);
  const updatable = (config?.packages ?? [])
    .filter((pkg) => pkg.installed && !pkg.pinned && pkg.version)
    .map(npmNameOf)
    .filter((name): name is string => Boolean(name))
    .sort()
    .join(',');
  React.useEffect(() => {
    if (updatable) void loadVersions(updatable.split(','));
  }, [updatable, loadVersions]);

  let body: React.ReactNode;
  if (!config && entry?.status === 'error') {
    body = (
      <SettingsCallout
        title={'Could not load Pi\'s extensions from the server'}
        action={(
          <Button variant="outline" size="sm" onClick={() => void load(viewDirectory, { force: true })}>
            {'Try again'}
          </Button>
        )}
      />
    );
  } else if (!config) {
    body = <p className={SETTINGS_HELPER_CLASS}>{'Loading extensions…'}</p>;
  } else {
    body = (
      <div className="space-y-4">
        {entry?.status === 'error' ? (
          <SettingsCallout title="Could not refresh this list">{'It may be out of date.'}</SettingsCallout>
        ) : null}
        {untrusted ? (
          <SettingsCallout title="Pi does not trust this project">
            {'So it leaves out the project\'s own extensions and settings. This is the global list. Change it under Global, or trust the project to choose what loads here.'}
          </SettingsCallout>
        ) : null}
        {config.installFailures.map((failure) => (
          <SettingsCallout key={failure.source} title={`Pi could not load ${failure.source}`}>{failure.message}</SettingsCallout>
        ))}
        <ExtensionGroups
          config={config}
          // An untrusted project answers with the global list, which it cannot change.
          view={untrusted ? 'global' : view}
          readOnly={untrusted}
          directory={viewDirectory}
          notes={replacementNotes(config, pluginNames)}
          onRemove={setRemoveTarget}
          onBrowse={onBrowse}
          onOpenPackage={onOpenPackage}
        />
      </div>
    );
  }

  return (
    <SettingsSection
      title="Pi extensions"
      info={SECTION_INFO}
      settingsItem="plugins.extensions"
      headerAction={directory ? (
        <SettingsChipGroup
          aria-label="Extension settings for"
          value={view}
          onChange={setScope}
          options={[
            { value: 'global', label: 'Global' },
            { value: 'project', label: 'This project' },
          ]}
        />
      ) : undefined}
    >
      {body}
      <RemovePackageDialog pkg={removeTarget} directory={viewDirectory} onClose={() => setRemoveTarget(null)} />
    </SettingsSection>
  );
}
