import { isWebRuntime } from '@/lib/desktop';
import { resolveSettingsSlug, type SettingsPageSlug, type SettingsRuntimeContext } from '@/lib/settings/metadata';

export const SETTINGS_NAV_WIDTH = 256;
export const SETTINGS_SPLIT_SIDEBAR_WIDTH = 280;
export const SETTINGS_DETAIL_HISTORY_KEY = '__pichamberSettingsDetail';

export type MobileStage = 'nav' | 'page-sidebar' | 'page-content';
export type SettingsDetailHistoryEntry = {
  page: SettingsPageSlug;
  stage: 'page-content';
};

export const pageOrder: SettingsPageSlug[] = [
  'general',
  'appearance',
  'chat',
  'dictation',
  'notifications',
  'sessions',
  'shortcuts',
  'about',
  'projects',
  'remote-instances',
  'tunnel',
  'git',
  'providers',
  'behavior',
  'snippets',
  'skills.installed',
];

export function buildRuntimeContext(isDesktop: boolean, isMobile: boolean): SettingsRuntimeContext {
  const isWeb = !isDesktop && isWebRuntime();
  return { isWeb, isDesktop, isMobile };
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function nextUniqueName(baseName: string, existingNames: Iterable<string>): string {
  const existing = new Set(existingNames);
  let name = baseName;
  let counter = 1;
  while (existing.has(name)) {
    name = `${baseName}-${counter}`;
    counter += 1;
  }
  return name;
}

export function getSettingsDetailHistoryEntry(state: unknown): SettingsDetailHistoryEntry | null {
  if (!isObjectRecord(state)) {
    return null;
  }

  const detail = state[SETTINGS_DETAIL_HISTORY_KEY];
  if (!isObjectRecord(detail)) {
    return null;
  }

  const page = detail.page;
  const stage = detail.stage;
  if (typeof page !== 'string' || stage !== 'page-content') {
    return null;
  }

  const resolvedPage = resolveSettingsSlug(page);
  return { page: resolvedPage, stage };
}

export function getCurrentHistoryState(): Record<string, unknown> {
  if (typeof window === 'undefined' || !isObjectRecord(window.history.state)) {
    return {};
  }
  return window.history.state;
}
