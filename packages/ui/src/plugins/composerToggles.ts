import type { PiPluginComposerToggle, PiPluginView } from '@/lib/pi/protocol';
import type { PluginOverrides } from './sessionStore';
import { selectPlugins, usePluginsStore } from './store';

export interface ComposerToggleItem {
  plugin: PiPluginView;
  toggle: PiPluginComposerToggle;
  /** What this session (or draft) uses. */
  on: boolean;
  /** What Settings give every session without its own value. */
  defaultOn: boolean;
}

/**
 * The composer toggles of enabled plugins, in plugin order. A toggle shows
 * only when its state key is a declared boolean. `overrides` are the
 * session's own values, over the default in `plugin.state` (the server
 * resolves a composer toggle's key to its manifest default).
 */
export const listComposerToggles = (
  plugins: readonly PiPluginView[],
  overrides: PluginOverrides = {},
): ComposerToggleItem[] => plugins.flatMap((plugin) => {
  if (!plugin.enabled) return [];
  return (plugin.contributes.composerToggles ?? []).flatMap((toggle) => {
    if (plugin.stateSchema[toggle.state]?.type !== 'boolean') return [];
    const defaultOn = plugin.state[toggle.state] === true;
    const own = overrides[plugin.id]?.[toggle.state];
    return [{ plugin, toggle, on: typeof own === 'boolean' ? own : defaultOn, defaultOn }];
  });
});

/**
 * Whether the composer shows any plugin toggle for `directory`. A boolean
 * selector, so the composer re-renders only when that answer changes.
 */
export const useHasComposerToggles = (directory?: string | null): boolean => usePluginsStore(
  (state) => listComposerToggles(selectPlugins(directory)(state)).length > 0,
);
