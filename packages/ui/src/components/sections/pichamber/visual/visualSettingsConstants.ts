import type { ThemeMode } from '@/types/theme';
import type { MobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import type { MobileLayoutPreference } from '@/lib/mobileLayoutPreference';
import type { FollowUpBehavior } from '@/stores/messageQueueStore';

export interface Option<T extends string> {
  id: T;
  label: string;
  description?: string;
}

export const THEME_MODE_OPTIONS: Array<{
  value: ThemeMode;
  label: string;
  description: string;
}> = [
  {
    value: 'system',
    label: 'System',
    description: 'Follow system setting',
  },
  {
    value: 'light',
    label: 'Light',
    description: 'Always use light appearance',
  },
  {
    value: 'dark',
    label: 'Dark',
    description: 'Always use dark appearance',
  },
];

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
  | 'autoSaveEnabled';
