import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { SETTINGS_LIST_DETAIL_CLASS, SettingsListRow } from '@/components/sections/shared/SettingsSection';
import { NativeTag } from '@/components/sections/plugins/tags';
import { useSaveReporter } from '@/components/sections/plugins/useSaveReporter';
import { Switch } from '@/components/ui/switch';
import type { PiExtensionReplacement, PiPluginView } from '@/lib/pi/protocol';
import { cn } from '@/lib/utils';
import { useExtensionConfigStore } from '@/plugins/extensionConfigStore';
import { resolvePluginIcon } from '@/plugins/icons';
import { summarizePluginImpact } from '@/plugins/impact';
import { replacementLine } from '@/plugins/replacements';
import { usePluginsStore } from '@/plugins/store';

/** The plugin's on/off switch, saved at once. */
export function PluginSwitch({ plugin, className }: { plugin: PiPluginView; className?: string }) {
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
export function PluginIcon({ plugin }: { plugin: PiPluginView }) {
  return (
    <Icon
      name={resolvePluginIcon(plugin.icon)}
      aria-hidden="true"
      className={cn('size-5 shrink-0', plugin.enabled ? 'text-foreground' : 'text-muted-foreground')}
    />
  );
}

const impactLine = (plugin: PiPluginView): string => (
  plugin.impactError ? 'Could not measure what it adds to the agent' : summarizePluginImpact(plugin.impact)
);

/**
 * One plugin in the list. The name is the row's button (stretched over the
 * row), so the whole row opens the plugin while the switch stays its own
 * control.
 */
export function PluginRow({
  plugin,
  replacement,
  showNativeTag = true,
  onOpen,
}: {
  plugin: PiPluginView;
  /** Off under the Native plugins heading, which already says it. */
  showNativeTag?: boolean;
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
      titleAccessory={plugin.bundled && showNativeTag ? <NativeTag /> : null}
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
