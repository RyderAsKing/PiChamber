import type { DesktopSettings } from '@/lib/desktop';
import { sanitizeStarterRefs } from '@/lib/draftStarters';
import { isFollowUpBehavior, normalizeFollowUpBehavior } from '@/stores/messageQueueStore';
import { isTerminalShell } from '@/lib/terminalShell';
import { isUiFontOption, isMonoFontOption } from '@/lib/fontOptions';
import { normalizePwaName } from '@/lib/pwaKeys';
import { sanitizeCommandTriggers } from '@/lib/pi/command-triggers';
import {
  type LegacySkillCatalog,
  type PersistedDesktopSettings,
  sanitizeSkillCatalogs,
  sanitizeShortcutOverrides,
  sanitizeStringArray,
  sanitizeRecentEfforts,
  normalizeIconBackground,
  sanitizeProjects,
  sanitizeManagedRemoteTunnelPresets,
  sanitizeManagedRemoteTunnelPresetTokens,
  sanitizeModelRefs,
  materializeAuthoritativeUiSettings,
} from './settingsFieldSanitizers';
import {
  areStringRecordsEqual,
  areCommandTriggerListsEqual,
  areModelRefsEqual,
  areStringArraysEqual,
  areRecentEffortsEqual,
} from './settingsEquality';

export {
  type LegacySkillCatalog,
  type PersistedDesktopSettings,
  sanitizeSkillCatalogs,
  sanitizeShortcutOverrides,
  sanitizeStringArray,
  sanitizeRecentEfforts,
  normalizeIconBackground,
  sanitizeProjects,
  sanitizeManagedRemoteTunnelPresets,
  sanitizeManagedRemoteTunnelPresetTokens,
  sanitizeModelRefs,
  materializeAuthoritativeUiSettings,
  areStringRecordsEqual,
  areCommandTriggerListsEqual,
  areModelRefsEqual,
  areStringArraysEqual,
  areRecentEffortsEqual,
};

export const sanitizeWebSettings = (payload: unknown): DesktopSettings | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  const result: PersistedDesktopSettings = {};

  if (typeof candidate.themeId === 'string' && candidate.themeId.length > 0) {
    result.themeId = candidate.themeId;
  }
  if (candidate.useSystemTheme === true || candidate.useSystemTheme === false) {
    result.useSystemTheme = candidate.useSystemTheme;
  }
  if (
    typeof candidate.themeVariant === 'string' &&
    (candidate.themeVariant === 'light' || candidate.themeVariant === 'dark')
  ) {
    result.themeVariant = candidate.themeVariant;
  }
  if (
    typeof candidate.lightThemeId === 'string' &&
    candidate.lightThemeId.length > 0
  ) {
    result.lightThemeId = candidate.lightThemeId;
  }
  if (
    typeof candidate.darkThemeId === 'string' &&
    candidate.darkThemeId.length > 0
  ) {
    result.darkThemeId = candidate.darkThemeId;
  }
  if (
    typeof candidate.lastDirectory === 'string' &&
    candidate.lastDirectory.length > 0
  ) {
    result.lastDirectory = candidate.lastDirectory;
  }
  if (
    typeof candidate.homeDirectory === 'string' &&
    candidate.homeDirectory.length > 0
  ) {
    result.homeDirectory = candidate.homeDirectory;
  }

  if (typeof candidate.desktopLanAccessEnabled === 'boolean') {
    result.desktopLanAccessEnabled = candidate.desktopLanAccessEnabled;
  }
  if (typeof candidate.desktopKeepAwakeEnabled === 'boolean') {
    result.desktopKeepAwakeEnabled = candidate.desktopKeepAwakeEnabled;
  }
  if (typeof candidate.desktopProcessPerformanceRecordingEnabled === 'boolean') {
    result.desktopProcessPerformanceRecordingEnabled = candidate.desktopProcessPerformanceRecordingEnabled;
  }
  if (typeof candidate.desktopMinimizeToTrayEnabled === 'boolean') {
    result.desktopMinimizeToTrayEnabled = candidate.desktopMinimizeToTrayEnabled;
  }
  if (typeof candidate.desktopMacMenuBarEnabled === 'boolean') {
    result.desktopMacMenuBarEnabled = candidate.desktopMacMenuBarEnabled;
  }

  const projects = sanitizeProjects(candidate.projects);
  if (projects) {
    result.projects = projects;
  }
  if (
    typeof candidate.activeProjectId === 'string' &&
    candidate.activeProjectId.length > 0
  ) {
    result.activeProjectId = candidate.activeProjectId;
  }

  if (Array.isArray(candidate.securityScopedBookmarks)) {
    result.securityScopedBookmarks = candidate.securityScopedBookmarks.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0
    );
  }
  if (Array.isArray(candidate.pinnedDirectories)) {
    result.pinnedDirectories = Array.from(
      new Set(
        candidate.pinnedDirectories.filter(
          (entry): entry is string =>
            typeof entry === 'string' && entry.length > 0
        )
      )
    );
  }
  if (Array.isArray(candidate.draftStarters)) {
    result.draftStarters = sanitizeStarterRefs(candidate.draftStarters);
  }
  if (typeof candidate.draftStartersVisible === 'boolean') {
    result.draftStartersVisible = candidate.draftStartersVisible;
  }
  if (typeof candidate.draftStartersScheduleTaskAdded === 'boolean') {
    result.draftStartersScheduleTaskAdded =
      candidate.draftStartersScheduleTaskAdded;
  }
  if (typeof candidate.showReasoningTraces === 'boolean') {
    result.showReasoningTraces = candidate.showReasoningTraces;
  }
  if (typeof candidate.collapsibleThinkingBlocks === 'boolean') {
    result.collapsibleThinkingBlocks = candidate.collapsibleThinkingBlocks;
  }
  if (typeof candidate.collapseThinkingByDefault === 'boolean') {
    result.collapseThinkingByDefault = candidate.collapseThinkingByDefault;
  }
  if (typeof candidate.autoDeleteEnabled === 'boolean') {
    result.autoDeleteEnabled = candidate.autoDeleteEnabled;
  }
  if (typeof candidate.autoSaveEnabled === 'boolean') {
    result.autoSaveEnabled = candidate.autoSaveEnabled;
  }
  if (
    typeof candidate.autoDeleteAfterDays === 'number' &&
    Number.isFinite(candidate.autoDeleteAfterDays)
  ) {
    result.autoDeleteAfterDays = candidate.autoDeleteAfterDays;
  }
  if (
    candidate.sessionRetentionAction === 'archive' ||
    candidate.sessionRetentionAction === 'delete'
  ) {
    result.sessionRetentionAction = candidate.sessionRetentionAction;
  }
  if (typeof candidate.tunnelProvider === 'string') {
    const provider = candidate.tunnelProvider.trim().toLowerCase();
    if (provider.length > 0) {
      result.tunnelProvider = provider;
    }
  }
  if (typeof candidate.tunnelMode === 'string') {
    const mode = candidate.tunnelMode.trim().toLowerCase();
    if (
      mode === 'quick' ||
      mode === 'managed-remote' ||
      mode === 'managed-local'
    ) {
      result.tunnelMode = mode;
    }
  }
  if (candidate.tunnelBootstrapTtlMs === null) {
    result.tunnelBootstrapTtlMs = null;
  } else if (
    typeof candidate.tunnelBootstrapTtlMs === 'number' &&
    Number.isFinite(candidate.tunnelBootstrapTtlMs)
  ) {
    result.tunnelBootstrapTtlMs = candidate.tunnelBootstrapTtlMs;
  }
  if (
    typeof candidate.tunnelSessionTtlMs === 'number' &&
    Number.isFinite(candidate.tunnelSessionTtlMs)
  ) {
    result.tunnelSessionTtlMs = candidate.tunnelSessionTtlMs;
  }
  if (candidate.managedLocalTunnelConfigPath === null) {
    result.managedLocalTunnelConfigPath = null;
  } else if (typeof candidate.managedLocalTunnelConfigPath === 'string') {
    const trimmed = candidate.managedLocalTunnelConfigPath.trim();
    result.managedLocalTunnelConfigPath = trimmed.length > 0 ? trimmed : null;
  }
  if (typeof candidate.managedRemoteTunnelHostname === 'string') {
    result.managedRemoteTunnelHostname =
      candidate.managedRemoteTunnelHostname.trim();
  }
  if (candidate.managedRemoteTunnelToken === null) {
    result.managedRemoteTunnelToken = null;
  } else if (typeof candidate.managedRemoteTunnelToken === 'string') {
    result.managedRemoteTunnelToken =
      candidate.managedRemoteTunnelToken.trim();
  }
  const managedRemoteTunnelPresets = sanitizeManagedRemoteTunnelPresets(
    candidate.managedRemoteTunnelPresets
  );
  if (managedRemoteTunnelPresets) {
    result.managedRemoteTunnelPresets = managedRemoteTunnelPresets;
  }
  if (typeof candidate.managedRemoteTunnelSelectedPresetId === 'string') {
    const trimmed = candidate.managedRemoteTunnelSelectedPresetId.trim();
    result.managedRemoteTunnelSelectedPresetId =
      trimmed.length > 0 ? trimmed : undefined;
  }
  const managedRemoteTunnelPresetTokens =
    sanitizeManagedRemoteTunnelPresetTokens(
      candidate.managedRemoteTunnelPresetTokens
    );
  if (managedRemoteTunnelPresetTokens) {
    result.managedRemoteTunnelPresetTokens = managedRemoteTunnelPresetTokens;
  }
  if (
    typeof candidate.defaultModel === 'string' &&
    candidate.defaultModel.length > 0
  ) {
    result.defaultModel = candidate.defaultModel;
  }
  if (
    typeof candidate.defaultVariant === 'string' &&
    candidate.defaultVariant.length > 0
  ) {
    result.defaultVariant = candidate.defaultVariant;
  }
  if (typeof candidate.smallModelUseDefault === 'boolean') {
    result.smallModelUseDefault = candidate.smallModelUseDefault;
  }
  if (
    typeof candidate.smallModelOverride === 'string' &&
    candidate.smallModelOverride.length > 0
  ) {
    result.smallModelOverride = candidate.smallModelOverride;
  }
  if (
    typeof candidate.walkthroughModelOverride === 'string' &&
    candidate.walkthroughModelOverride.length > 0
  ) {
    result.walkthroughModelOverride = candidate.walkthroughModelOverride;
  }
  if (typeof candidate.autoCreateWorktree === 'boolean') {
    result.autoCreateWorktree = candidate.autoCreateWorktree;
  }
  if (typeof candidate.gitmojiEnabled === 'boolean') {
    result.gitmojiEnabled = candidate.gitmojiEnabled;
  }
  if (isFollowUpBehavior(candidate.followUpBehavior)) {
    result.followUpBehavior = candidate.followUpBehavior;
  } else if (typeof candidate.queueModeEnabled === 'boolean') {
    result.followUpBehavior = normalizeFollowUpBehavior(
      undefined,
      candidate.queueModeEnabled
    );
  }
  if (typeof candidate.showDeletionDialog === 'boolean') {
    result.showDeletionDialog = candidate.showDeletionDialog;
  }
  if (typeof candidate.nativeNotificationsEnabled === 'boolean') {
    result.nativeNotificationsEnabled = candidate.nativeNotificationsEnabled;
  }
  if (
    typeof candidate.notificationMode === 'string' &&
    (candidate.notificationMode === 'always' ||
      candidate.notificationMode === 'hidden-only')
  ) {
    result.notificationMode = candidate.notificationMode;
  }
  if (typeof candidate.notifyOnSubtasks === 'boolean') {
    result.notifyOnSubtasks = candidate.notifyOnSubtasks;
  }
  if (typeof candidate.notifyOnCompletion === 'boolean') {
    result.notifyOnCompletion = candidate.notifyOnCompletion;
  }
  if (typeof candidate.notifyOnError === 'boolean') {
    result.notifyOnError = candidate.notifyOnError;
  }
  if (typeof candidate.notifyOnQuestion === 'boolean') {
    result.notifyOnQuestion = candidate.notifyOnQuestion;
  }
  if (
    candidate.notificationTemplates &&
    typeof candidate.notificationTemplates === 'object'
  ) {
    const templates = candidate.notificationTemplates as Record<
      string,
      unknown
    >;
    const validateTemplate = (
      key: string
    ): { title: string; message: string } | undefined => {
      const value = templates[key];
      if (!value || typeof value !== 'object') return undefined;
      const obj = value as Record<string, unknown>;
      const title = typeof obj.title === 'string' ? obj.title : '';
      const message = typeof obj.message === 'string' ? obj.message : '';
      return { title, message };
    };
    const completion = validateTemplate('completion');
    const error = validateTemplate('error');
    const question = validateTemplate('question');
    const subtask = validateTemplate('subtask');
    if (completion || error || question || subtask) {
      result.notificationTemplates = {
        completion: completion ?? {
          title: 'Task Complete',
          message: 'Your task has finished.',
        },
        error: error ?? {
          title: 'Error Occurred',
          message: 'An error occurred while processing your task.',
        },
        question: question ?? {
          title: 'Input Needed',
          message: 'Please provide input to continue.',
        },
        subtask: subtask ?? {
          title: 'Subtask Complete',
          message: 'A subtask has finished.',
        },
      };
    }
  }
  if (typeof candidate.summarizeLastMessage === 'boolean') {
    result.summarizeLastMessage = candidate.summarizeLastMessage;
  }
  if (
    typeof candidate.summaryThreshold === 'number' &&
    Number.isFinite(candidate.summaryThreshold)
  ) {
    result.summaryThreshold = Math.max(
      0,
      Math.round(candidate.summaryThreshold)
    );
  }
  if (
    typeof candidate.summaryLength === 'number' &&
    Number.isFinite(candidate.summaryLength)
  ) {
    result.summaryLength = Math.max(10, Math.round(candidate.summaryLength));
  }
  if (
    typeof candidate.maxLastMessageLength === 'number' &&
    Number.isFinite(candidate.maxLastMessageLength)
  ) {
    result.maxLastMessageLength = Math.max(
      10,
      Math.round(candidate.maxLastMessageLength)
    );
  }
  if (typeof candidate.usageAutoRefresh === 'boolean') {
    result.usageAutoRefresh = candidate.usageAutoRefresh;
  }
  if (
    typeof candidate.usageRefreshIntervalMs === 'number' &&
    Number.isFinite(candidate.usageRefreshIntervalMs)
  ) {
    result.usageRefreshIntervalMs = candidate.usageRefreshIntervalMs;
  }
  if (
    candidate.usageDisplayMode === 'usage' ||
    candidate.usageDisplayMode === 'remaining'
  ) {
    result.usageDisplayMode = candidate.usageDisplayMode;
  }
  if (typeof candidate.usageShowPredValues === 'boolean') {
    result.usageShowPredValues = candidate.usageShowPredValues;
  }
  if (Array.isArray(candidate.usageDropdownProviders)) {
    result.usageDropdownProviders = candidate.usageDropdownProviders.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0
    );
  }

  if (
    candidate.usageSelectedModels &&
    typeof candidate.usageSelectedModels === 'object'
  ) {
    const selectedModels: Record<string, string[]> = {};
    for (const [providerId, models] of Object.entries(
      candidate.usageSelectedModels
    )) {
      if (Array.isArray(models)) {
        selectedModels[providerId] = models.filter(
          (m): m is string => typeof m === 'string'
        );
      }
    }
    if (Object.keys(selectedModels).length > 0) {
      result.usageSelectedModels = selectedModels;
    }
  }

  if (
    candidate.usageCollapsedFamilies &&
    typeof candidate.usageCollapsedFamilies === 'object'
  ) {
    const collapsedFamilies: Record<string, string[]> = {};
    for (const [providerId, families] of Object.entries(
      candidate.usageCollapsedFamilies
    )) {
      if (Array.isArray(families)) {
        collapsedFamilies[providerId] = families.filter(
          (f): f is string => typeof f === 'string'
        );
      }
    }
    if (Object.keys(collapsedFamilies).length > 0) {
      result.usageCollapsedFamilies = collapsedFamilies;
    }
  }

  if (
    candidate.usageExpandedFamilies &&
    typeof candidate.usageExpandedFamilies === 'object'
  ) {
    const expandedFamilies: Record<string, string[]> = {};
    for (const [providerId, families] of Object.entries(
      candidate.usageExpandedFamilies
    )) {
      if (Array.isArray(families)) {
        expandedFamilies[providerId] = families.filter(
          (f): f is string => typeof f === 'string'
        );
      }
    }
    if (Object.keys(expandedFamilies).length > 0) {
      result.usageExpandedFamilies = expandedFamilies;
    }
  }

  if (
    candidate.usageModelGroups &&
    typeof candidate.usageModelGroups === 'object'
  ) {
    const modelGroups: Record<
      string,
      {
        customGroups?: Array<{
          id: string;
          label: string;
          models: string[];
          order: number;
        }>;
        modelAssignments?: Record<string, string>;
        renamedGroups?: Record<string, string>;
      }
    > = {};
    for (const [providerId, config] of Object.entries(
      candidate.usageModelGroups
    )) {
      if (config && typeof config === 'object') {
        const typedConfig = config as Record<string, unknown>;
        const providerConfig: {
          customGroups?: Array<{
            id: string;
            label: string;
            models: string[];
            order: number;
          }>;
          modelAssignments?: Record<string, string>;
          renamedGroups?: Record<string, string>;
        } = {};

        if (Array.isArray(typedConfig.customGroups)) {
          providerConfig.customGroups = typedConfig.customGroups
            .filter(
              (g): g is Record<string, unknown> => g && typeof g === 'object'
            )
            .map((g) => ({
              id: String(g.id ?? ''),
              label: String(g.label ?? ''),
              models: Array.isArray(g.models)
                ? g.models.filter((m): m is string => typeof m === 'string')
                : [],
              order: typeof g.order === 'number' ? g.order : 0,
            }));
        }

        if (
          typedConfig.modelAssignments &&
          typeof typedConfig.modelAssignments === 'object'
        ) {
          providerConfig.modelAssignments = Object.fromEntries(
            Object.entries(
              typedConfig.modelAssignments as Record<string, unknown>
            )
              .filter(([, v]) => typeof v === 'string')
              .map(([k, v]) => [k, String(v)])
          );
        }

        if (
          typedConfig.renamedGroups &&
          typeof typedConfig.renamedGroups === 'object'
        ) {
          providerConfig.renamedGroups = Object.fromEntries(
            Object.entries(
              typedConfig.renamedGroups as Record<string, unknown>
            )
              .filter(([, v]) => typeof v === 'string')
              .map(([k, v]) => [k, String(v)])
          );
        }

        if (Object.keys(providerConfig).length > 0) {
          modelGroups[providerId] = providerConfig;
        }
      }
    }
    if (Object.keys(modelGroups).length > 0) {
      result.usageModelGroups = modelGroups;
    }
  }

  if (typeof candidate.inputSpellcheckEnabled === 'boolean') {
    result.inputSpellcheckEnabled = candidate.inputSpellcheckEnabled;
  }
  if (typeof candidate.showToolFileIcons === 'boolean') {
    result.showToolFileIcons = candidate.showToolFileIcons;
  }
  if (typeof candidate.codeBlockLineWrap === 'boolean') {
    result.codeBlockLineWrap = candidate.codeBlockLineWrap;
  }
  if (typeof candidate.showTurnChangedFiles === 'boolean') {
    result.showTurnChangedFiles = candidate.showTurnChangedFiles;
  }
  if (typeof candidate.showExpandedBashTools === 'boolean') {
    result.showExpandedBashTools = candidate.showExpandedBashTools;
  }
  if (typeof candidate.showExpandedEditTools === 'boolean') {
    result.showExpandedEditTools = candidate.showExpandedEditTools;
  }
  if (
    typeof candidate.timeFormatPreference === 'string' &&
    (candidate.timeFormatPreference === 'auto' ||
      candidate.timeFormatPreference === '12h' ||
      candidate.timeFormatPreference === '24h')
  ) {
    result.timeFormatPreference = candidate.timeFormatPreference;
  }
  if (
    typeof candidate.weekStartPreference === 'string' &&
    (candidate.weekStartPreference === 'auto' ||
      candidate.weekStartPreference === 'sunday' ||
      candidate.weekStartPreference === 'monday')
  ) {
    result.weekStartPreference = candidate.weekStartPreference;
  }
  if (typeof candidate.desktopWindowControlsPosition === 'string') {
    if (candidate.desktopWindowControlsPosition === 'left') {
      result.desktopWindowControlsPosition = 'left';
    } else if (
      candidate.desktopWindowControlsPosition === 'right' ||
      candidate.desktopWindowControlsPosition === 'auto'
    ) {
      // Legacy "auto" never read OS chrome config; treat as right.
      result.desktopWindowControlsPosition = 'right';
    }
  }
  if (typeof candidate.desktopWindowControlsStyle === 'string') {
    if (
      candidate.desktopWindowControlsStyle === 'classic' ||
      candidate.desktopWindowControlsStyle === 'traffic-lights'
    ) {
      result.desktopWindowControlsStyle = candidate.desktopWindowControlsStyle;
    }
  }
  if (
    typeof candidate.mermaidRenderingMode === 'string' &&
    (candidate.mermaidRenderingMode === 'svg' ||
      candidate.mermaidRenderingMode === 'ascii')
  ) {
    result.mermaidRenderingMode = candidate.mermaidRenderingMode;
  }
  if (
    typeof candidate.userMessageRenderingMode === 'string' &&
    (candidate.userMessageRenderingMode === 'markdown' ||
      candidate.userMessageRenderingMode === 'plain')
  ) {
    result.userMessageRenderingMode = candidate.userMessageRenderingMode;
  }
  if (typeof candidate.collapsibleUserMessages === 'boolean') {
    result.collapsibleUserMessages = candidate.collapsibleUserMessages;
  }
  if (typeof candidate.stickyUserHeader === 'boolean') {
    result.stickyUserHeader = candidate.stickyUserHeader;
  }
  if (typeof candidate.promptNavigatorEnabled === 'boolean') {
    result.promptNavigatorEnabled = candidate.promptNavigatorEnabled;
  }
  if (typeof candidate.expandedEditorToolbar === 'boolean') {
    result.expandedEditorToolbar = candidate.expandedEditorToolbar;
  }
  if (typeof candidate.wideChatLayoutEnabled === 'boolean') {
    result.wideChatLayoutEnabled = candidate.wideChatLayoutEnabled;
  }
  if (typeof candidate.showSplitAssistantMessageActions === 'boolean') {
    result.showSplitAssistantMessageActions =
      candidate.showSplitAssistantMessageActions;
  }
  if (
    typeof candidate.fontSize === 'number' &&
    Number.isFinite(candidate.fontSize)
  ) {
    result.fontSize = candidate.fontSize;
  }
  if (
    typeof candidate.terminalFontSize === 'number' &&
    Number.isFinite(candidate.terminalFontSize)
  ) {
    result.terminalFontSize = candidate.terminalFontSize;
  }
  if (isTerminalShell(candidate.terminalShell)) {
    result.terminalShell = candidate.terminalShell;
  }
  if (Array.isArray(candidate.terminalLoginShells)) {
    result.terminalLoginShells = [
      ...new Set(candidate.terminalLoginShells.filter(isTerminalShell)),
    ];
  }
  if (
    typeof candidate.editorFontSize === 'number' &&
    Number.isFinite(candidate.editorFontSize)
  ) {
    result.editorFontSize = candidate.editorFontSize;
  }
  if (isUiFontOption(candidate.uiFont)) {
    result.uiFont = candidate.uiFont;
  }
  if (isMonoFontOption(candidate.monoFont)) {
    result.monoFont = candidate.monoFont;
  }
  if (
    typeof candidate.padding === 'number' &&
    Number.isFinite(candidate.padding)
  ) {
    result.padding = candidate.padding;
  }
  if (
    typeof candidate.cornerRadius === 'number' &&
    Number.isFinite(candidate.cornerRadius)
  ) {
    result.cornerRadius = candidate.cornerRadius;
  }
  if (
    typeof candidate.inputBarOffset === 'number' &&
    Number.isFinite(candidate.inputBarOffset)
  ) {
    result.inputBarOffset = candidate.inputBarOffset;
  }
  if (
    typeof candidate.openInAppId === 'string' &&
    candidate.openInAppId.length > 0
  ) {
    result.openInAppId = candidate.openInAppId;
  }
  if (typeof candidate.pwaAppName === 'string') {
    const normalized = normalizePwaName(candidate.pwaAppName, '');
    result.pwaAppName = normalized.length > 0 ? normalized : '';
  }
  if (typeof candidate.mobileKeyboardMode === 'string') {
    if (
      candidate.mobileKeyboardMode === 'native' ||
      candidate.mobileKeyboardMode === 'resize-content'
    ) {
      result.mobileKeyboardMode = candidate.mobileKeyboardMode;
    }
  }
  const shortcutOverrides = sanitizeShortcutOverrides(
    candidate.shortcutOverrides
  );
  if (shortcutOverrides) {
    result.shortcutOverrides = shortcutOverrides;
  }
  const commandTriggers = sanitizeCommandTriggers(candidate.commandTriggers);
  if (commandTriggers) {
    result.commandTriggers = commandTriggers;
  }
  const favoriteModels = sanitizeModelRefs(candidate.favoriteModels, 50);
  if (favoriteModels) {
    result.favoriteModels = favoriteModels;
  }
  const hiddenModels = sanitizeModelRefs(candidate.hiddenModels, 200);
  if (hiddenModels) {
    result.hiddenModels = hiddenModels;
  }
  const collapsedModelProviders = sanitizeStringArray(
    candidate.collapsedModelProviders
  );
  if (collapsedModelProviders) {
    result.collapsedModelProviders = collapsedModelProviders;
  }
  const recentModels = sanitizeModelRefs(candidate.recentModels, 10);
  if (recentModels) {
    result.recentModels = recentModels;
  }
  const recentAgents = sanitizeStringArray(candidate.recentAgents);
  if (recentAgents) {
    result.recentAgents = recentAgents.slice(0, 10);
  }
  const recentEfforts = sanitizeRecentEfforts(candidate.recentEfforts);
  if (recentEfforts) {
    result.recentEfforts = recentEfforts;
  }
  if (
    typeof candidate.diffLayoutPreference === 'string' &&
    (candidate.diffLayoutPreference === 'dynamic' ||
      candidate.diffLayoutPreference === 'inline' ||
      candidate.diffLayoutPreference === 'side-by-side')
  ) {
    result.diffLayoutPreference = candidate.diffLayoutPreference;
  }
  if (
    typeof candidate.gitChangesViewMode === 'string' &&
    (candidate.gitChangesViewMode === 'flat' ||
      candidate.gitChangesViewMode === 'tree')
  ) {
    result.gitChangesViewMode = candidate.gitChangesViewMode;
  }
  if (typeof candidate.directoryShowHidden === 'boolean') {
    result.directoryShowHidden = candidate.directoryShowHidden;
  }
  if (typeof candidate.filesViewShowGitignored === 'boolean') {
    result.filesViewShowGitignored = candidate.filesViewShowGitignored;
  }

  const skillCatalogs = sanitizeSkillCatalogs(candidate.skillCatalogs);
  if (skillCatalogs) {
    result.skillCatalogs = skillCatalogs;
  }

  return Object.keys(result).length > 0 ? result : null;
};
