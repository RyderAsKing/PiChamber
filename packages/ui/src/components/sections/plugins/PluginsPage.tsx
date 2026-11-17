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
import { Switch } from '@/components/ui/switch';
import { ExtensionsSection } from '@/components/sections/plugins/ExtensionsSection';
import { reportExtensionWrite } from '@/components/sections/plugins/extensionWriteReport';
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
import { resolvePluginIcon } from '@/plugins/icons';
import { summarizePluginImpact } from '@/plugins/impact';
import { getNativePluginFeatures } from '@/plugins/registry';
import { findReplacement, replacementFix, replacementLine, replacementReason } from '@/plugins/replacements';
import { usePluginsStore } from '@/plugins/store';
import { useExtensionConfig } from '@/plugins/useExtensionConfig';
import { usePlugins } from '@/plugins/usePlugins';

const PLUGINS_INFO = 'Features that come with PiChamber. Built-in plugins start off, and a plugin that is off adds nothing to the agent.';
const IMPACT_INFO = 'Measured by loading the plugin\'s agent code. Tools are described to the model on every request while the plugin is on. A plugin that is off adds nothing.';

type PluginFilter = 'all' | 'on' | 'off';

const FILTERS: Array<{ id: PluginFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' },
];

function useSaveReporter() {
  return React.useCallback(async (write: () => Promise<boolean>) => {
    reportSettingsSaveState('saving');
    const ok = await write();
    reportSettingsSaveState(ok ? 'saved' : 'error');
    return ok;
  }, []);
}

/** The plugin's on/off switch, saved at once. */
function PluginSwitch({ plugin, className }: { plugin: PiPluginView; className?: string }) {
  const setEnabled = usePluginsStore((state) => state.setEnabled);
  const busy = usePluginsStore((state) => state.pending[plugin.id] === true);
  const save = useSaveReporter();
  return (
    <Switch
      checked={plugin.enabled}
      disabled={busy}
      ariaLabel={plugin.name}
      className={className}
      onChange={(next) => {
        void save(() => setEnabled(plugin.id, next)).then((ok) => {
          // Which extensions Pi loads can change with the plugin; read that again.
          if (ok) useExtensionConfigStore.getState().invalidate();
        });
      }}
    />
  );
}

/**
 * The plugin's mark: the bare line icon at the size of a line of text, as the
 * settings navigation draws its own, so it sits on the title's line.
 */
function PluginIcon({ plugin }: { plugin: PiPluginView }) {
  return (
    <Icon
      name={resolvePluginIcon(plugin.icon)}
      aria-hidden="true"
      className={cn('size-5 shrink-0', plugin.enabled ? 'text-foreground' : 'text-muted-foreground')}
    />
  );
}

/** A small label beside a name: where a plugin comes from, what kind of thing a row is. */
function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-2 py-0.5 typography-micro font-medium text-muted-foreground">
      {children}
    </span>
  );
}

/** Plugins past this count get the All, On, Off filter. */
const FILTER_FROM = 7;

const impactLine = (plugin: PiPluginView): string => (
  plugin.impactError ? 'Could not measure what it adds to the agent' : summarizePluginImpact(plugin.impact)
);

/**
 * One plugin in the list. The name is the row's button (stretched over the
 * row), so the whole row opens the plugin while the switch stays its own
 * control.
 */
function PluginRow({
  plugin,
  replacement,
  onOpen,
}: {
  plugin: PiPluginView;
  /** Set when the plugin is on but an extension took its place. */
  replacement?: PiExtensionReplacement;
  onOpen: () => void;
}) {
  return (
    <SettingsListRow
      interactive
      settingsItem={`plugins.${plugin.id}`}
      className="items-start py-3"
      leading={<PluginIcon plugin={plugin} />}
      title={(
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${plugin.name} settings`}
          className={cn(
            'truncate typography-ui-label font-medium text-foreground outline-none',
            "after:absolute after:inset-0 after:content-['']",
            'focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-[var(--interactive-focus-ring)]',
          )}
        >
          {plugin.name}
        </button>
      )}
      titleAccessory={plugin.bundled ? <Tag>{'Built in'}</Tag> : null}
      detail={(
        <>
          <p className={cn(SETTINGS_LIST_DETAIL_CLASS, 'line-clamp-2 text-pretty')}>{plugin.description}</p>
          {replacement ? (
            <p className="truncate typography-meta text-[var(--status-warning)]">{replacementLine(replacement)}</p>
          ) : (
            <p className="truncate typography-micro tabular-nums text-muted-foreground">
              {plugin.enabled ? impactLine(plugin) : 'Off: adds nothing to the agent'}
            </p>
          )}
        </>
      )}
      trailing={(
        <>
          <PluginSwitch plugin={plugin} className="relative z-10" />
          <Icon name="arrow-right-s" aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </>
      )}
    />
  );
}

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
    <SettingsSection divider={false} title="Plugins" info={PLUGINS_INFO} contentClassName="space-y-3">
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
  onBack,
}: {
  plugin: PiPluginView;
  directory: string | null;
  config: PiExtensionConfigResponse | null;
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
          {'Extensions & Plugins'}
        </Button>
      )}
      titleLeading={<PluginIcon plugin={plugin} />}
      titleAccessory={plugin.bundled ? <Tag>{'Built in'}</Tag> : null}
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
          <SettingsListRow title="Source" trailing={<Fact>{plugin.bundled ? 'Comes with PiChamber' : 'Installed'}</Fact>} />
          <SettingsListRow title="Version" trailing={<Fact>{plugin.version}</Fact>} />
        </SettingsList>
      </SettingsSection>
    </SettingsPageLayout>
  );
}

/**
 * Settings → Extensions & Plugins: PiChamber's plugins with switches (a row
 * opens the plugin's own page), then Pi's extensions and packages.
 */
export const PluginsPage: React.FC = () => {
  const directory = useEffectiveDirectory() ?? null;
  const { plugins, entry } = usePlugins(directory);
  const load = usePluginsStore((state) => state.load);
  const [openId, setOpenId] = React.useState<string | null>(null);
  // What a live session in this folder loaded says whether a plugin that is
  // on gave way to one of the user's extensions.
  const config = useExtensionConfig(directory)?.config ?? null;

  const open = openId ? plugins.find((plugin) => plugin.id === openId) : undefined;
  if (open) {
    return <PluginDetail plugin={open} directory={directory} config={config} onBack={() => setOpenId(null)} />;
  }

  let body: React.ReactNode;
  if (!entry?.plugins && entry?.status === 'error') {
    body = (
      <SettingsSection divider={false} title="Plugins">
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
      <SettingsSection divider={false} title="Plugins">
        <p className={SETTINGS_HELPER_CLASS}>{'Loading plugins…'}</p>
      </SettingsSection>
    );
  } else if (plugins.length === 0) {
    body = (
      <SettingsSection divider={false} title="Plugins">
        <p className={SETTINGS_HELPER_CLASS}>{'This server has no plugins.'}</p>
      </SettingsSection>
    );
  } else {
    body = <PluginList plugins={plugins} config={config} onOpen={setOpenId} />;
  }

  return (
    <SettingsPageLayout
      title="Extensions & Plugins"
      description={(
        <p className={cn(SETTINGS_DESCRIPTION_CLASS, 'text-pretty')}>
          {'Plugins add features to PiChamber and the agent. Extensions are what Pi itself loads, here and in the terminal.'}
        </p>
      )}
    >
      {body}
      <ExtensionsSection
        directory={directory}
        pluginNames={Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin.name]))}
      />
    </SettingsPageLayout>
  );
};
