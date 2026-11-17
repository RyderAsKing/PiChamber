import type { IconName } from '@/components/icon/icons';

/**
 * Icons a plugin manifest may name. Manifests are data, so the sprite
 * generator cannot see their icon names; this typed record puts them in the
 * sprite, and an unknown name falls back instead of drawing nothing.
 */
const PLUGIN_ICONS: Record<string, IconName> = {
  artboard: 'artboard',
  'robot-2': 'robot-2',
  puzzle: 'puzzle',
  lightbulb: 'lightbulb',
  'shield-check': 'shield-check',
  eye: 'eye',
  brain: 'brain',
  search: 'search',
};

/** Filled forms, drawn when a plugin's composer toggle is on. */
const PLUGIN_ICONS_FILLED: Record<string, IconName> = {
  artboard: 'artboard-fill',
  'robot-2': 'robot-2-fill',
  puzzle: 'puzzle-fill',
  lightbulb: 'lightbulb-fill',
  'shield-check': 'shield-check-fill',
  eye: 'eye-fill',
  brain: 'brain-fill',
  search: 'search-fill',
};

const FALLBACK_PLUGIN_ICON = 'puzzle';

const known = (name: string | undefined): string => (
  name && Object.hasOwn(PLUGIN_ICONS, name) ? name : FALLBACK_PLUGIN_ICON
);

export const resolvePluginIcon = (name: string | undefined, filled = false): IconName => (
  (filled ? PLUGIN_ICONS_FILLED : PLUGIN_ICONS)[known(name)]
);

/**
 * An icon for a control a Pi extension declares: drawn only when the name is
 * one of these, never a fallback, so an unknown name leaves the label alone.
 */
export const resolveExtensionControlIcon = (name: string | undefined, filled = false): IconName | null => (
  name && Object.hasOwn(PLUGIN_ICONS, name) ? (filled ? PLUGIN_ICONS_FILLED : PLUGIN_ICONS)[name] : null
);
