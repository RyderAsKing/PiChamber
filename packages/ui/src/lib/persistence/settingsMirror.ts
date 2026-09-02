import type { DesktopSettings } from '@/lib/desktop';
import { PWA_NAME_STORAGE_KEY, normalizePwaName } from '@/lib/pwaKeys';
import { setStoredMobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import { getRuntimeKey } from '@/lib/runtime-switch';

export const applyPersistedHomeDirectoryToWindow = (
  homeDirectory: string
): void => {
  if (typeof window === 'undefined') {
    return;
  }
  if (
    typeof window.__PICHAMBER_HOME__ === 'string' &&
    window.__PICHAMBER_HOME__.length > 0
  ) {
    return;
  }

  try {
    window.__PICHAMBER_HOME__ = homeDirectory;
  } catch {
    /* read-only contextBridge property — leave preload-seeded value */
  }
};

export const SETTINGS_MIRROR_INDEX_KEY = 'pichamber.settingsMirror.v2.index';
export const SETTINGS_MIRROR_KEY_PREFIX = 'pichamber.settingsMirror.v2:';
export const MAX_SETTINGS_MIRROR_RUNTIMES = 5;

export const getRuntimeSettingsMirrorStorageKey = (runtimeKey: string): string =>
  `${SETTINGS_MIRROR_KEY_PREFIX}${encodeURIComponent(runtimeKey)}`;

export const setOrRemoveLocalStorage = (
  key: string,
  value: string | null
): void => {
  if (value === null) {
    localStorage.removeItem(key);
  } else {
    localStorage.setItem(key, value);
  }
};

export const persistRuntimeSettingsMirror = (
  settings: DesktopSettings,
  runtimeKey: string
): void => {
  const mirror = {
    themeId: settings.themeId,
    themeVariant: settings.themeVariant,
    lightThemeId: settings.lightThemeId,
    darkThemeId: settings.darkThemeId,
    useSystemTheme: settings.useSystemTheme,
    lastDirectory: settings.lastDirectory,
    homeDirectory: settings.homeDirectory,
    projects: settings.projects,
    activeProjectId: settings.activeProjectId,
    pinnedDirectories: settings.pinnedDirectories,
    gitmojiEnabled: settings.gitmojiEnabled,
    directoryShowHidden: settings.directoryShowHidden,
    filesViewShowGitignored: settings.filesViewShowGitignored,
    openInAppId: settings.openInAppId,
    pwaAppName: settings.pwaAppName,
    mobileKeyboardMode: settings.mobileKeyboardMode,
  };
  localStorage.setItem(
    getRuntimeSettingsMirrorStorageKey(runtimeKey),
    JSON.stringify(mirror)
  );

  let previous: string[] = [];
  try {
    const parsed = JSON.parse(
      localStorage.getItem(SETTINGS_MIRROR_INDEX_KEY) ?? '[]'
    ) as unknown;
    if (Array.isArray(parsed))
      previous = parsed.filter(
        (entry): entry is string => typeof entry === 'string'
      );
  } catch {
    previous = [];
  }
  const runtimes = [
    runtimeKey,
    ...previous.filter((entry) => entry !== runtimeKey),
  ].slice(0, MAX_SETTINGS_MIRROR_RUNTIMES);
  for (const staleRuntime of previous) {
    if (!runtimes.includes(staleRuntime))
      localStorage.removeItem(getRuntimeSettingsMirrorStorageKey(staleRuntime));
  }
  localStorage.setItem(SETTINGS_MIRROR_INDEX_KEY, JSON.stringify(runtimes));
};

export const persistToLocalStorage = (settings: DesktopSettings): void => {
  if (typeof window === 'undefined') {
    return;
  }

  persistRuntimeSettingsMirror(settings, getRuntimeKey());
  setOrRemoveLocalStorage('selectedThemeId', settings.themeId || null);
  setOrRemoveLocalStorage(
    'selectedThemeVariant',
    settings.themeVariant || null
  );
  setOrRemoveLocalStorage('lightThemeId', settings.lightThemeId || null);
  setOrRemoveLocalStorage('darkThemeId', settings.darkThemeId || null);
  setOrRemoveLocalStorage(
    'useSystemTheme',
    typeof settings.useSystemTheme === 'boolean'
      ? String(settings.useSystemTheme)
      : null
  );
  setOrRemoveLocalStorage('lastDirectory', settings.lastDirectory || null);
  if (settings.homeDirectory) {
    localStorage.setItem('homeDirectory', settings.homeDirectory);
    applyPersistedHomeDirectoryToWindow(settings.homeDirectory);
  } else {
    localStorage.removeItem('homeDirectory');
  }
  if (Array.isArray(settings.projects) && settings.projects.length > 0) {
    localStorage.setItem('projects', JSON.stringify(settings.projects));
  } else {
    localStorage.removeItem('projects');
  }
  if (settings.activeProjectId) {
    localStorage.setItem('activeProjectId', settings.activeProjectId);
  } else {
    localStorage.removeItem('activeProjectId');
  }
  if (
    Array.isArray(settings.pinnedDirectories) &&
    settings.pinnedDirectories.length > 0
  ) {
    localStorage.setItem(
      'pinnedDirectories',
      JSON.stringify(settings.pinnedDirectories)
    );
  } else {
    localStorage.removeItem('pinnedDirectories');
  }

  if (Array.isArray(settings.projects) && settings.projects.length > 0) {
    const collapsed = settings.projects
      .filter(
        (project) =>
          (project as unknown as { sidebarCollapsed?: boolean })
            .sidebarCollapsed === true
      )
      .map((project) => project.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (collapsed.length > 0) {
      localStorage.setItem(
        'oc.sessions.projectCollapse',
        JSON.stringify(collapsed)
      );
    } else {
      localStorage.removeItem('oc.sessions.projectCollapse');
    }
  } else {
    localStorage.removeItem('oc.sessions.projectCollapse');
  }
  if (typeof settings.gitmojiEnabled === 'boolean') {
    localStorage.setItem('gitmojiEnabled', String(settings.gitmojiEnabled));
  } else {
    localStorage.removeItem('gitmojiEnabled');
  }
  if (typeof settings.directoryShowHidden === 'boolean') {
    localStorage.setItem(
      'directoryTreeShowHidden',
      settings.directoryShowHidden ? 'true' : 'false'
    );
  } else {
    localStorage.removeItem('directoryTreeShowHidden');
  }
  if (typeof settings.filesViewShowGitignored === 'boolean') {
    localStorage.setItem(
      'filesViewShowGitignored',
      settings.filesViewShowGitignored ? 'true' : 'false'
    );
  } else {
    localStorage.removeItem('filesViewShowGitignored');
  }
  setOrRemoveLocalStorage(
    'openInAppId',
    typeof settings.openInAppId === 'string' && settings.openInAppId.length > 0
      ? settings.openInAppId
      : null
  );
  if (typeof settings.pwaAppName === 'string') {
    const normalized = normalizePwaName(settings.pwaAppName, '');
    if (normalized.length > 0) {
      localStorage.setItem(PWA_NAME_STORAGE_KEY, normalized);
    } else {
      localStorage.removeItem(PWA_NAME_STORAGE_KEY);
    }
  } else {
    localStorage.removeItem(PWA_NAME_STORAGE_KEY);
  }
  setStoredMobileKeyboardMode(settings.mobileKeyboardMode);
};

export const dispatchSettingsSynced = (settings: DesktopSettings): void => {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent<DesktopSettings>('pichamber:settings-synced', {
      detail: settings,
    })
  );
};
