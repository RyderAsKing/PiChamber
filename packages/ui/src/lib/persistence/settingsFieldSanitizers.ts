import type { DesktopSettings } from '@/lib/desktop';
import { createProjectIdFromPath } from '@/lib/projectId';
import { DEFAULT_LIGHT_THEME_ID, DEFAULT_DARK_THEME_ID } from '@/lib/theme/themes';
import { DEFAULT_OPEN_IN_APP_ID } from '@/lib/openInApps';
import { DEFAULT_FOLLOW_UP_BEHAVIOR } from '@/stores/messageQueueStore';
import { useUIStore } from '@/stores/useUIStore';

export type LegacySkillCatalog = {
  id: string;
  label: string;
  source: string;
  subpath?: string;
  gitIdentityId?: string;
};

export type PersistedDesktopSettings = DesktopSettings & {
  /** Legacy settings are still accepted from stored/web payloads for compatibility. */
  skillCatalogs?: LegacySkillCatalog[];
  autoCreateWorktree?: boolean;
  globalBehaviorPrompt?: string;
};

export const sanitizeSkillCatalogs = (
  value: unknown
): PersistedDesktopSettings['skillCatalogs'] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result: NonNullable<PersistedDesktopSettings['skillCatalogs']> = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;

    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const label =
      typeof candidate.label === 'string' ? candidate.label.trim() : '';
    const source =
      typeof candidate.source === 'string' ? candidate.source.trim() : '';
    const subpath =
      typeof candidate.subpath === 'string' ? candidate.subpath.trim() : '';
    const gitIdentityId =
      typeof candidate.gitIdentityId === 'string'
        ? candidate.gitIdentityId.trim()
        : '';

    if (!id || !label || !source) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    result.push({
      id,
      label,
      source,
      ...(subpath ? { subpath } : {}),
      ...(gitIdentityId ? { gitIdentityId } : {}),
    });
  }

  return result;
};

export const sanitizeShortcutOverrides = (
  value: unknown
): Record<string, string> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, combo] of Object.entries(value)) {
    const normalizedKey = typeof key === 'string' ? key.trim() : '';
    const normalizedCombo = typeof combo === 'string' ? combo.trim() : '';
    if (!normalizedKey || !normalizedCombo) continue;
    result[normalizedKey] = normalizedCombo;
  }
  return result;
};

export const sanitizeStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return Array.from(
    new Set(
      value.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry.length > 0
      )
    )
  );
};

export const sanitizeRecentEfforts = (
  value: unknown
): Record<string, string[]> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const result: Record<string, string[]> = {};
  for (const [key, variants] of Object.entries(value)) {
    if (!key || !Array.isArray(variants)) continue;
    const sanitized = sanitizeStringArray(variants);
    if (sanitized && sanitized.length > 0) {
      result[key] = sanitized.slice(0, 5);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

const HEX_COLOR_PATTERN = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/;

export const normalizeIconBackground = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
};

export const sanitizeProjects = (
  value: unknown
): DesktopSettings['projects'] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result: NonNullable<DesktopSettings['projects']> = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;

    const rawPath =
      typeof candidate.path === 'string' ? candidate.path.trim() : '';
    if (!rawPath) continue;

    const normalizedPath =
      rawPath === '/'
        ? rawPath
        : rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalizedPath) continue;

    const id = createProjectIdFromPath(normalizedPath);
    if (!id) continue;

    if (seenIds.has(id) || seenPaths.has(normalizedPath)) continue;
    seenIds.add(id);
    seenPaths.add(normalizedPath);

    const project: NonNullable<DesktopSettings['projects']>[number] = {
      id,
      path: normalizedPath,
    };

    if (
      typeof candidate.label === 'string' &&
      candidate.label.trim().length > 0
    ) {
      project.label = candidate.label.trim();
    }
    if (typeof candidate.icon === 'string' && candidate.icon.trim().length > 0) {
      project.icon = candidate.icon.trim();
    }
    if (candidate.iconImage === null) {
      (project as unknown as Record<string, unknown>).iconImage = null;
    } else if (candidate.iconImage && typeof candidate.iconImage === 'object') {
      const iconImage = candidate.iconImage as Record<string, unknown>;
      const mime =
        typeof iconImage.mime === 'string' ? iconImage.mime.trim() : '';
      const updatedAt =
        typeof iconImage.updatedAt === 'number' &&
        Number.isFinite(iconImage.updatedAt)
          ? Math.max(0, Math.round(iconImage.updatedAt))
          : 0;
      const source =
        iconImage.source === 'custom' || iconImage.source === 'auto'
          ? iconImage.source
          : null;
      if (mime && updatedAt > 0 && source) {
        (project as unknown as Record<string, unknown>).iconImage = {
          mime,
          updatedAt,
          source,
        };
      }
    }
    if (
      typeof candidate.color === 'string' &&
      candidate.color.trim().length > 0
    ) {
      project.color = candidate.color.trim();
    }
    if (candidate.iconBackground === null) {
      (project as unknown as Record<string, unknown>).iconBackground = null;
    } else {
      const iconBackground = normalizeIconBackground(candidate.iconBackground);
      if (iconBackground) {
        (project as unknown as Record<string, unknown>).iconBackground =
          iconBackground;
      }
    }
    if (
      typeof candidate.addedAt === 'number' &&
      Number.isFinite(candidate.addedAt) &&
      candidate.addedAt >= 0
    ) {
      project.addedAt = candidate.addedAt;
    }
    if (
      typeof candidate.lastOpenedAt === 'number' &&
      Number.isFinite(candidate.lastOpenedAt) &&
      candidate.lastOpenedAt >= 0
    ) {
      project.lastOpenedAt = candidate.lastOpenedAt;
    }
    if (typeof candidate.sidebarCollapsed === 'boolean') {
      (project as unknown as Record<string, unknown>).sidebarCollapsed =
        candidate.sidebarCollapsed;
    }
    result.push(project);
  }

  return result.length > 0 ? result : undefined;
};

export const sanitizeManagedRemoteTunnelPresets = (
  value: unknown
): DesktopSettings['managedRemoteTunnelPresets'] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result: NonNullable<DesktopSettings['managedRemoteTunnelPresets']> = [];
  const seenIds = new Set<string>();
  const seenHostnames = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;

    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const name =
      typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const hostname =
      typeof candidate.hostname === 'string'
        ? candidate.hostname.trim().toLowerCase()
        : '';

    if (!id || !name || !hostname) continue;
    if (seenIds.has(id) || seenHostnames.has(hostname)) continue;
    seenIds.add(id);
    seenHostnames.add(hostname);

    result.push({ id, name, hostname });
  }

  return result;
};

export const sanitizeManagedRemoteTunnelPresetTokens = (
  value: unknown
): DesktopSettings['managedRemoteTunnelPresetTokens'] | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [key, tokenValue] of Object.entries(candidate)) {
    const id = key.trim();
    const token = typeof tokenValue === 'string' ? tokenValue.trim() : '';
    if (!id || !token) continue;
    result[id] = token;
  }

  return Object.keys(result).length > 0 ? result : undefined;
};

export const sanitizeModelRefs = (
  value: unknown,
  limit: number
): Array<{ providerID: string; modelID: string }> | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const result: Array<{ providerID: string; modelID: string }> = [];
  const seen = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const providerID =
      typeof candidate.providerID === 'string'
        ? candidate.providerID.trim()
        : '';
    const modelID =
      typeof candidate.modelID === 'string' ? candidate.modelID.trim() : '';
    if (!providerID || !modelID) continue;
    const key = `${providerID}/${modelID}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ providerID, modelID });
    if (result.length >= limit) break;
  }

  return result;
};

export const materializeAuthoritativeUiSettings = (
  settings: DesktopSettings
): DesktopSettings => {
  const defaults = useUIStore.getInitialState();

  return {
    useSystemTheme: true,
    lightThemeId: DEFAULT_LIGHT_THEME_ID,
    darkThemeId: DEFAULT_DARK_THEME_ID,
    openInAppId: DEFAULT_OPEN_IN_APP_ID,
    showReasoningTraces: defaults.showReasoningTraces,
    collapsibleThinkingBlocks: defaults.collapsibleThinkingBlocks,
    collapseThinkingByDefault: defaults.collapseThinkingByDefault,
    autoDeleteEnabled: defaults.autoDeleteEnabled,
    autoSaveEnabled: defaults.autoSaveEnabled,
    autoDeleteAfterDays: defaults.autoDeleteAfterDays,
    sessionRetentionAction: defaults.sessionRetentionAction,
    followUpBehavior: DEFAULT_FOLLOW_UP_BEHAVIOR,
    showDeletionDialog: defaults.showDeletionDialog,
    nativeNotificationsEnabled: defaults.nativeNotificationsEnabled,
    notificationMode: defaults.notificationMode,
    notifyOnSubtasks: defaults.notifyOnSubtasks,
    notifyOnCompletion: defaults.notifyOnCompletion,
    notifyOnError: defaults.notifyOnError,
    notifyOnQuestion: defaults.notifyOnQuestion,
    notificationTemplates: defaults.notificationTemplates,
    summarizeLastMessage: defaults.summarizeLastMessage,
    summaryThreshold: defaults.summaryThreshold,
    summaryLength: defaults.summaryLength,
    maxLastMessageLength: defaults.maxLastMessageLength,
    inputSpellcheckEnabled: defaults.inputSpellcheckEnabled,
    showToolFileIcons: defaults.showToolFileIcons,
    codeBlockLineWrap: defaults.codeBlockLineWrap,
    showTurnChangedFiles: defaults.showTurnChangedFiles,
    showExpandedBashTools: defaults.showExpandedBashTools,
    showExpandedEditTools: defaults.showExpandedEditTools,
    timeFormatPreference: defaults.timeFormatPreference,
    weekStartPreference: defaults.weekStartPreference,
    desktopWindowControlsPosition: defaults.desktopWindowControlsPosition,
    desktopWindowControlsStyle: defaults.desktopWindowControlsStyle,
    mermaidRenderingMode: defaults.mermaidRenderingMode,
    userMessageRenderingMode: defaults.userMessageRenderingMode,
    collapsibleUserMessages: defaults.collapsibleUserMessages,
    stickyUserHeader: defaults.stickyUserHeader,
    promptNavigatorEnabled: defaults.promptNavigatorEnabled,
    expandedEditorToolbar: defaults.expandedEditorToolbar,
    wideChatLayoutEnabled: defaults.wideChatLayoutEnabled,
    showSplitAssistantMessageActions: defaults.showSplitAssistantMessageActions,
    draftStartersVisible: defaults.draftStartersVisible,
    fontSize: defaults.fontSize,
    terminalFontSize: defaults.terminalFontSize,
    terminalShell: defaults.terminalShell,
    terminalLoginShells: defaults.terminalLoginShells,
    editorFontSize: defaults.editorFontSize,
    uiFont: defaults.uiFont,
    monoFont: defaults.monoFont,
    padding: defaults.padding,
    cornerRadius: defaults.cornerRadius,
    inputBarOffset: defaults.inputBarOffset,
    shortcutOverrides: defaults.shortcutOverrides,
    mobileKeyboardMode: 'resize-content',
    favoriteModels: defaults.favoriteModels,
    hiddenModels: defaults.hiddenModels,
    collapsedModelProviders: defaults.collapsedModelProviders,
    recentModels: defaults.recentModels,
    recentAgents: defaults.recentAgents,
    recentEfforts: defaults.recentEfforts,
    diffLayoutPreference: defaults.diffLayoutPreference,
    gitChangesViewMode: defaults.gitChangesViewMode,
    directoryShowHidden: true,
    filesViewShowGitignored: false,
    ...settings,
  };
};
