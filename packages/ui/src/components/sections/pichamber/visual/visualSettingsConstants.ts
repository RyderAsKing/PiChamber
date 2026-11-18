import type { Wallpaper } from '@/lib/wallpaper';
import type { Theme, ThemeMode } from '@/types/theme';
import type { MobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import type { MobileLayoutPreference } from '@/lib/mobileLayoutPreference';
import type { FollowUpBehavior } from '@/stores/messageQueueStore';
import type { SidebarViewMode } from '@/lib/sidebarViewMode';

export interface Option<T extends string> {
  id: T;
  label: string;
  description?: string;
}

export const DIFF_LAYOUT_OPTIONS: Option<'dynamic' | 'inline' | 'side-by-side'>[] = [
  {
    id: 'dynamic',
    label: 'Dynamic',
    description: 'New inline, modified side-by-side.',
  },
  {
    id: 'inline',
    label: 'Always inline',
    description: 'Show as a single unified view.',
  },
  {
    id: 'side-by-side',
    label: 'Always side-by-side',
    description: 'Compare original and modified files.',
  },
];

export const DEFAULT_PWA_INSTALL_NAME = 'PiChamber - AI Coding Assistant';

export const PWA_ORIENTATION_OPTIONS: Option<'system' | 'portrait' | 'landscape'>[] = [
  {
    id: 'system',
    label: 'Follow system',
    description: 'Respect the device rotation setting.',
  },
  {
    id: 'portrait',
    label: 'Portrait lock',
    description: 'Install the app locked to portrait.',
  },
  {
    id: 'landscape',
    label: 'Landscape lock',
    description: 'Install the app locked to landscape.',
  },
];

export const MOBILE_KEYBOARD_MODE_OPTIONS: Option<MobileKeyboardMode>[] = [
  {
    id: 'native',
    label: 'Follow browser',
    description:
      'Use the browser default for panning and viewport changes when the keyboard opens.',
  },
  {
    id: 'resize-content',
    label: 'Resize content',
    description:
      'Ask supported browsers to shrink the app layout instead of relying only on panning.',
  },
];

export const WALLPAPER_OPTIONS: Array<{ value: Wallpaper; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'dither', label: 'Dither' },
  { value: 'ascii', label: 'ASCII' },
  { value: 'halftone', label: 'Halftone' },
  { value: 'strands', label: 'Strands' },
  { value: 'grain', label: 'Grain' },
];

export const MOBILE_LAYOUT_OPTIONS: Array<{
  value: MobileLayoutPreference;
  label: string;
}> = [
  {
    value: 'default',
    label: 'Old',
  },
  {
    value: 'new',
    label: 'New',
  },
];

export type PwaInstallNameWindow = Window & {
  __PICHAMBER_SET_PWA_INSTALL_NAME__?: (value: string) => string;
  __PICHAMBER_SET_PWA_ORIENTATION__?: (
    value: 'system' | 'portrait' | 'landscape'
  ) => 'system' | 'portrait' | 'landscape';
  __PICHAMBER_UPDATE_PWA_MANIFEST__?: () => void;
};

export const normalizePwaOrientation = (
  value: unknown
): 'system' | 'portrait' | 'landscape' => {
  return value === 'portrait' || value === 'landscape' ? value : 'system';
};

export const TIME_FORMAT_OPTIONS: Option<'auto' | '12h' | '24h'>[] = [
  {
    id: 'auto',
    label: 'Auto',
    description: 'Use system locale preference.',
  },
  {
    id: '24h',
    label: '24-hour',
    description: 'Show time as 14:15.',
  },
  {
    id: '12h',
    label: '12-hour',
    description: 'Show time as 02:15 PM.',
  },
];

export const WEEK_START_OPTIONS: Option<'auto' | 'monday' | 'sunday'>[] = [
  {
    id: 'auto',
    label: 'Auto',
    description: 'Use locale week start.',
  },
  {
    id: 'monday',
    label: 'Monday',
  },
  {
    id: 'sunday',
    label: 'Sunday',
  },
];

export const SIDEBAR_VIEW_MODE_OPTIONS: Option<SidebarViewMode>[] = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'folder', label: 'By folder' },
  { id: 'threads', label: 'Threads' },
];

/** Kept for people who use them, behind Legacy views. */
export const LEGACY_SIDEBAR_VIEW_MODE_OPTIONS: Option<SidebarViewMode>[] = [
  { id: 'timeline', label: 'Timeline' },
];

/** One line under each Sidebar view preview; the drawings are too small to say what a view does. */
export const SIDEBAR_VIEW_DESCRIPTION: Record<SidebarViewMode, string> = {
  workspace: 'Pick a folder, see its sessions.',
  folder: 'Sessions under each folder.',
  timeline: 'All sessions by date, archived too.',
  threads: 'By state, with Snoozed below.',
};

export const FOLLOW_UP_BEHAVIOR_OPTIONS: Option<FollowUpBehavior>[] = [
  {
    id: 'steer',
    label: 'Steering',
  },
  {
    id: 'queue',
    label: 'Follow-up',
  },
];

export type VisibleSetting =
  | 'theme'
  | 'pwaInstallName'
  | 'pwaOrientation'
  | 'mobileKeyboardMode'
  | 'timeFormat'
  | 'weekStart'
  | 'sidebarViewMode'
  | 'fontSize'
  | 'terminalFontSize'
  | 'terminalShell'
  | 'terminalLoginShell'
  | 'editorFontSize'
  | 'spacing'
  | 'inputBarOffset'
  | 'diffLayout'
  | 'mobileStatusBar'
  | 'followUpBehavior'
  | 'terminalQuickKeys'
  | 'fileEditorKeymap'
  | 'reportUsage'
  | 'perfHud'
  | 'expandedEditorToolbar'
  | 'wrapLinesByDefault'
  | 'autoSaveEnabled';

export const THEME_MODE_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** A theme and its other half: PiChamber is PiChamber Light and PiChamber Dark. */
export interface ThemeFamily {
  key: string;
  name: string;
  light?: Theme;
  dark?: Theme;
}

/** How many theme families show before Show all. */
export const COLLAPSED_THEME_COUNT = 5;

/** A theme's family name: its own, without a closing Light or Dark (Vitesse Dark is Vitesse). */
const familyName = (theme: Theme): string =>
  theme.metadata.name.trim().replace(/\s+(light|dark)$/i, '') || theme.metadata.name.trim();

/**
 * Themes paired up by name, in the order they first appear. A theme whose
 * family already has its variant (two custom "Ocean" dark themes) gets a
 * family of its own, so none is hidden.
 */
export function themeFamilies(themes: readonly Theme[]): ThemeFamily[] {
  const families: ThemeFamily[] = [];
  const byName = new Map<string, ThemeFamily>();
  for (const theme of themes) {
    const name = familyName(theme);
    const variant = theme.metadata.variant;
    const known = byName.get(name.toLowerCase());
    if (known && !known[variant]) {
      known[variant] = theme;
      continue;
    }
    const family: ThemeFamily = { key: known ? theme.metadata.id : name.toLowerCase(), name, [variant]: theme };
    if (!known) byName.set(name.toLowerCase(), family);
    families.push(family);
  }
  return families;
}

/** The family a theme belongs to, if any. */
export function familyOf(families: readonly ThemeFamily[], themeId: string): ThemeFamily | undefined {
  return families.find((family) => family.light?.metadata.id === themeId || family.dark?.metadata.id === themeId);
}

/**
 * The first few families, with the one in use swapped in for the last of them
 * when it is further down, so the current theme is always on screen.
 */
export function collapsedFamilies(
  families: readonly ThemeFamily[],
  currentKey: string | undefined,
  count = COLLAPSED_THEME_COUNT,
): ThemeFamily[] {
  const shown = families.slice(0, count);
  if (currentKey === undefined || shown.some((family) => family.key === currentKey)) return shown;
  const current = families.find((family) => family.key === currentKey);
  if (!current || shown.length < count) return shown;
  return [...shown.slice(0, count - 1), current];
}
