import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_DESCRIPTION_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_LIST_DETAIL_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
  SettingsCallout,
  SettingsCheckboxRow,
  SettingsFieldRow,
  SettingsList,
  SettingsListRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ExtensionsSection } from '@/components/sections/plugins/ExtensionsSection';
import { reportExtensionWrite } from '@/components/sections/plugins/extensionWriteReport';
import { InstallPackageDialog } from '@/components/sections/plugins/InstallPackageDialog';
import { MarketplacePackagePage } from '@/components/sections/plugins/MarketplacePackagePage';
import { MarketplaceView, type MarketplaceFilter } from '@/components/sections/plugins/MarketplaceView';
import { PluginIcon, PluginRow, PluginSwitch } from '@/components/sections/plugins/PluginRow';
import { useSaveReporter } from '@/components/sections/plugins/useSaveReporter';
import { NativeTag, Tag } from '@/components/sections/plugins/tags';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { reportSettingsSaveState } from '@/lib/persistence';
import type {
  PiExtensionConfigResponse,
  PiExtensionReplacement,
  PiPluginImpact,
  PiPluginStateValue,
  PiPluginView,
} from '@/lib/pi/protocol';
import { cn } from '@/lib/utils';
import { useExtensionConfigStore } from '@/plugins/extensionConfigStore';
import { getNativePluginFeatures } from '@/plugins/registry';
import { findReplacement, replacementFix, replacementReason } from '@/plugins/replacements';
import { usePluginsStore } from '@/plugins/store';
import { useExtensionConfig } from '@/plugins/useExtensionConfig';
import { usePlugins } from '@/plugins/usePlugins';

const PLUGINS_INFO = 'Plugins that come with PiChamber. Plugins you install from Browse are Pi packages and show under Pi extensions, Packages. Built-in plugins start off, and a plugin that is off adds nothing to the agent.';
const IMPACT_INFO = 'Measured by loading the plugin\'s agent code. Tools are described to the model on every request while the plugin is on. A plugin that is off adds nothing.';

type PluginFilter = 'all' | 'on' | 'off';

const FILTERS: Array<{ id: PluginFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' },
];

/** Plugins past this count get the All, On, Off filter. */
const FILTER_FROM = 7;

function PluginList({
  plugins,
  config,
  onOpen,
}: {
  plugins: PiPluginView[];
  config: PiExtensionConfigResponse | null;
  onOpen: (id: string) => void;
}) {
  const [filter, setFilter] = React.useState<PluginFilter>('all');
  const counts: Record<PluginFilter, number> = {
    all: plugins.length,
    on: plugins.filter((plugin) => plugin.enabled).length,
    off: plugins.filter((plugin) => !plugin.enabled).length,
  };
  const shown = plugins.filter((plugin) => (
    filter === 'all' || (filter === 'on' ? plugin.enabled : !plugin.enabled)
  ));

  return (
    <SettingsSection divider={false} title="Native plugins" info={PLUGINS_INFO} contentClassName="space-y-3">
      {plugins.length >= FILTER_FROM ? (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show plugins">
          {FILTERS.map(({ id, label }) => (
            <Button key={id} variant="chip" size="xs" aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
              <span className="tabular-nums text-muted-foreground">{counts[id]}</span>
            </Button>
          ))}
        </div>
      ) : null}
      {shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border/60 py-10 text-center">
          <p className="typography-meta text-muted-foreground">
            {filter === 'on' ? 'No plugins are on.' : 'Every plugin is on.'}
          </p>
          <Button variant="ghost" size="xs" onClick={() => setFilter('all')}>{'Show all'}</Button>
        </div>
      ) : (
        <SettingsList>
          {shown.map((plugin) => (
            <PluginRow
              key={plugin.id}
              plugin={plugin}
              replacement={plugin.enabled ? findReplacement(config, 'plugin', plugin.id) : undefined}
              showNativeTag={false}
              onOpen={() => onOpen(plugin.id)}
            />
          ))}
        </SettingsList>
      )}
    </SettingsSection>
  );
}

function PluginStateFields({
  plugin,
  directory,
  disabled,
}: {
  plugin: PiPluginView;
  directory: string | null;
  disabled: boolean;
}) {
  const setState = usePluginsStore((state) => state.setState);
  const pending = usePluginsStore((state) => state.pending);
  const save = useSaveReporter();
  const keys = plugin.contributes.settings ?? Object.keys(plugin.stateSchema);

  const fields = keys.flatMap((key) => {
    const field = plugin.stateSchema[key];
    if (!field) return [];
    // A project value needs a project to belong to.
    if (field.scope === 'project' && !directory) return [];
    return [{ key, field }];
  });
  if (fields.length === 0) return null;

  const write = (key: string, value: PiPluginStateValue) => {
    void save(() => setState(plugin.id, key, value, directory));
  };
  return (
    <div className={SETTINGS_OPTION_STACK_CLASS}>
      {fields.map(({ key, field }) => {
        const value = plugin.state[key] ?? field.default;
        const busy = disabled || pending[`${plugin.id}\n${key}`] === true;
        const label = field.scope === 'project' ? `${field.label} (this project)` : field.label;
        const settingsItem = `plugins.${plugin.id}.${key}`;
        if (field.type === 'boolean') {
          return (
            <SettingsCheckboxRow
              key={key}
              checked={value === true}
              onChange={(checked) => write(key, checked)}
              label={label}
              ariaLabel={field.label}
              info={field.description}
              disabled={busy}
              settingsItem={settingsItem}
            />
          );
        }
        return (
          <SettingsFieldRow key={key} label={label} info={field.description} settingsItem={settingsItem}>
            <Select value={String(value)} onValueChange={(next) => write(key, next)} disabled={busy}>
              <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={field.label}>
                <SelectValue>
                  {(field.options ?? []).find((option) => option.value === String(value))?.label ?? String(value)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(field.options ?? []).map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsFieldRow>
        );
      })}
    </div>
  );
}

const hasOptions = (plugin: PiPluginView, directory: string | null): boolean => (
  (plugin.contributes.settings ?? Object.keys(plugin.stateSchema)).some((key) => {
    const field = plugin.stateSchema[key];
    return Boolean(field) && (field.scope !== 'project' || Boolean(directory));
  })
);

/** A text value at the end of a fact row. */
function Fact({ children }: { children: React.ReactNode }) {
  return <span className={cn(SETTINGS_LIST_DETAIL_CLASS, 'min-w-0 text-right tabular-nums')}>{children}</span>;
}

function AgentImpact({ impact, error }: { impact: PiPluginImpact | null; error?: string }) {
  if (error) {
    return <SettingsCallout title="Could not measure what this plugin adds to the agent" />;
  }
  const empty = !impact || (impact.tools.length === 0 && impact.commands.length === 0 && impact.hooks.length === 0);
  if (empty) return <p className={SETTINGS_HELPER_CLASS}>{'Nothing. This plugin only changes PiChamber.'}</p>;
  return (
    <SettingsList>
      {impact.tools.map((tool) => (
        <SettingsListRow
          key={tool.name}
          mono
          title={tool.name}
          titleAccessory={<Tag>{'Tool'}</Tag>}
          stackTrailing
          trailing={(
            <Fact>
              {tool.exposure === 'direct'
                ? `About ${tool.tokens.toLocaleString()} tokens per request`
                : 'Loaded when the model asks for it'}
            </Fact>
          )}
        />
      ))}
      {impact.commands.map((command) => (
        <SettingsListRow key={command} mono title={`/${command}`} titleAccessory={<Tag>{'Command'}</Tag>} />
      ))}
      {impact.hooks.length > 0 ? (
        <SettingsListRow wrap title="Can change the prompt or the request before it is sent" />
      ) : null}
    </SettingsList>
  );
}

function AppFeatures({ plugin }: { plugin: PiPluginView }) {
  const features = getNativePluginFeatures(plugin.contributes.ui);
  const toggles = plugin.contributes.composerToggles ?? [];
  if (features.length === 0 && toggles.length === 0) {
    return <p className={SETTINGS_HELPER_CLASS}>{'Nothing beyond what it adds to the agent.'}</p>;
  }
  return (
    <SettingsList>
      {toggles.map((toggle) => (
        <SettingsListRow
          key={toggle.id}
          wrap
          title={`A ${toggle.label} switch in the composer`}
          detail={<p className={cn(SETTINGS_LIST_DETAIL_CLASS, 'text-pretty')}>{'On in every new session. Changing it changes that session only.'}</p>}
        />
      ))}
      {features.map((feature) => <SettingsListRow key={feature} wrap title={feature} />)}
    </SettingsList>
  );
}

/**
 * Shown on a plugin that is on but not loaded: which extension took its
 * place, and a button for the one write that lets the plugin load again.
 */
function ReplacedNotice({
  replacement,
  config,
}: {
  replacement: PiExtensionReplacement;
  config: PiExtensionConfigResponse | null;
}) {
  const setGlobal = useExtensionConfigStore((state) => state.setGlobal);
  const setProjectState = useExtensionConfigStore((state) => state.setProjectState);
  const fix = replacementFix(config, replacement);
  const busy = useExtensionConfigStore((state) => (fix ? state.pending[fix.id] === true : false));

  const turnOff = () => {
    if (!fix) return;
    reportSettingsSaveState('saving');
    const write = fix.scope === 'project' && config?.directory
      ? setProjectState(fix.id, 'unload', config.directory)
      : setGlobal(fix.id, false);
    void write.then((result) => reportExtensionWrite(result, fix.name));
  };

  return (
    <SettingsCallout
      className="mb-3"
      title="Pi is not loading this plugin"
      action={fix ? (
        <Button variant="outline" size="sm" disabled={busy} onClick={turnOff}>
          {fix.scope === 'project' ? `Turn off ${fix.name} in this project` : `Turn off ${fix.name} in every project`}
        </Button>
      ) : undefined}
    >
      {replacementReason(replacement)}
      {fix ? null : ' To use this plugin, turn that extension off under Pi extensions.'}
    </SettingsCallout>
  );
}

function PluginDetail({
  plugin,
  directory,
  config,
  backLabel,
  onBack,
}: {
  plugin: PiPluginView;
  directory: string | null;
  config: PiExtensionConfigResponse | null;
  backLabel: string;
  onBack: () => void;
}) {
  const showOptions = hasOptions(plugin, directory);
  const replacement = plugin.enabled ? findReplacement(config, 'plugin', plugin.id) : undefined;
  return (
    <SettingsPageLayout
      title={plugin.name}
      titleAbove={(
        <Button variant="ghost" size="xs" onClick={onBack} className="-ml-2 gap-1 text-muted-foreground">
          <Icon name="arrow-left-s" aria-hidden="true" className="size-4" />
          {backLabel}
        </Button>
      )}
      titleLeading={<PluginIcon plugin={plugin} />}
      titleAccessory={plugin.bundled ? <NativeTag /> : null}
      description={<p className={cn(SETTINGS_DESCRIPTION_CLASS, 'text-pretty')}>{plugin.description}</p>}
    >
      {replacement ? <ReplacedNotice replacement={replacement} config={config} /> : null}

      <SettingsList className="mb-6">
        <SettingsListRow title="Enabled" trailing={<PluginSwitch plugin={plugin} />} />
      </SettingsList>

      <SettingsSection
        divider={false}
        title="What it adds to the agent"
        info={IMPACT_INFO}
        description={plugin.enabled ? undefined : 'Only while it is on. Off, it adds nothing.'}
        settingsItem={`plugins.${plugin.id}`}
      >
        <AgentImpact impact={plugin.impact} error={plugin.impactError} />
      </SettingsSection>

      <SettingsSection title="In PiChamber">
        <AppFeatures plugin={plugin} />
      </SettingsSection>

      {showOptions ? (
        <SettingsSection
          title="Options"
          description={plugin.enabled ? undefined : 'Turn the plugin on to change these.'}
        >
          <PluginStateFields plugin={plugin} directory={directory} disabled={!plugin.enabled} />
        </SettingsSection>
      ) : null}

      <SettingsSection title="About">
        <SettingsList>
          <SettingsListRow title="Source" trailing={<Fact>{plugin.bundled ? 'Native: comes with PiChamber' : 'Installed'}</Fact>} />
          <SettingsListRow title="Version" trailing={<Fact>{plugin.version}</Fact>} />
        </SettingsList>
      </SettingsSection>
    </SettingsPageLayout>
  );
}

/** What the page shows: the installed list, or one of the pages it opens. */
type PageView =
  | { kind: 'list' }
  | { kind: 'plugin'; id: string; from: 'list' | 'browse' }
  | { kind: 'browse' }
  | { kind: 'package'; name: string; from: 'list' | 'browse' };

/**
 * Settings → Extensions & Plugins. The list: PiChamber's own plugins with
 * switches, then everything Pi loads (packages, the user's extensions, Pi's
 * built-ins). Browse finds Pi packages on npm; a plugin or package opens on
 * its own page with a link back.
 */
export const PluginsPage: React.FC = () => {
  const directory = useEffectiveDirectory() ?? null;
  const { plugins, entry } = usePlugins(directory);
  const load = usePluginsStore((state) => state.load);
  const [view, setView] = React.useState<PageView>({ kind: 'list' });
  // Kept here so the search is still there when a package page goes back.
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<MarketplaceFilter>('all');
  const [installName, setInstallName] = React.useState<string | null>(null);
  // What a live session in this folder loaded says whether a plugin that is
  // on gave way to one of the user's extensions.
  const config = useExtensionConfig(directory)?.config ?? null;
  // Whether this folder can take a project install.
  const projectTrusted = directory && config ? config.project.trusted : undefined;

  const installDialog = (
    <InstallPackageDialog
      name={installName}
      directory={directory}
      projectTrusted={projectTrusted}
      onClose={() => setInstallName(null)}
    />
  );

  if (view.kind === 'plugin') {
    const open = plugins.find((plugin) => plugin.id === view.id);
    if (open) {
      return (
        <PluginDetail
          plugin={open}
          directory={directory}
          config={config}
          backLabel={view.from === 'browse' ? 'Browse' : 'Extensions & Plugins'}
          onBack={() => setView(view.from === 'browse' ? { kind: 'browse' } : { kind: 'list' })}
        />
      );
    }
  }

  if (view.kind === 'browse') {
    return (
      <>
        <MarketplaceView
          plugins={plugins}
          directory={directory}
          query={query}
          onQueryChange={setQuery}
          filter={filter}
          onFilterChange={setFilter}
          onBack={() => setView({ kind: 'list' })}
          onOpenPackage={(name) => setView({ kind: 'package', name, from: 'browse' })}
          onOpenPlugin={(id) => setView({ kind: 'plugin', id, from: 'browse' })}
          onInstall={setInstallName}
        />
        {installDialog}
      </>
    );
  }

  if (view.kind === 'package') {
    return (
      <>
        <MarketplacePackagePage
          name={view.name}
          directory={directory}
          backLabel={view.from === 'browse' ? 'Browse' : 'Extensions & Plugins'}
          onBack={() => setView(view.from === 'browse' ? { kind: 'browse' } : { kind: 'list' })}
          onInstall={setInstallName}
        />
        {installDialog}
      </>
    );
  }

  let body: React.ReactNode;
  if (!entry?.plugins && entry?.status === 'error') {
    body = (
      <SettingsSection divider={false} title="Native plugins">
        <div className="flex flex-wrap items-center gap-3">
          <p className={SETTINGS_HELPER_CLASS}>{'Could not load plugins from the server.'}</p>
          <Button variant="outline" size="sm" onClick={() => void load(directory, { force: true })}>
            {'Try again'}
          </Button>
        </div>
      </SettingsSection>
    );
  } else if (!entry?.plugins) {
    body = (
      <SettingsSection divider={false} title="Native plugins">
        <p className={SETTINGS_HELPER_CLASS}>{'Loading plugins…'}</p>
      </SettingsSection>
    );
  } else if (plugins.length === 0) {
    body = (
      <SettingsSection divider={false} title="Native plugins">
        <p className={SETTINGS_HELPER_CLASS}>{'This server has no plugins.'}</p>
      </SettingsSection>
    );
  } else {
    body = <PluginList plugins={plugins} config={config} onOpen={(id) => setView({ kind: 'plugin', id, from: 'list' })} />;
  }

  const browse = () => setView({ kind: 'browse' });
  return (
    <SettingsPageLayout
      title="Extensions & Plugins"
      description={(
        <p className={cn(SETTINGS_DESCRIPTION_CLASS, 'text-pretty')}>
          {'Plugins add features to PiChamber and the agent. Extensions are what Pi itself loads, here and in the terminal.'}
        </p>
      )}
      headerEnd={(
        <Button variant="outline" size="sm" onClick={browse} data-settings-item="plugins.browse">
          <Icon name="search" aria-hidden="true" className="size-3.5" />
          {'Browse'}
        </Button>
      )}
    >
      {body}
      <ExtensionsSection
        directory={directory}
        pluginNames={Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin.name]))}
        onBrowse={browse}
        onOpenPackage={(name) => setView({ kind: 'package', name, from: 'list' })}
      />
    </SettingsPageLayout>
  );
};
