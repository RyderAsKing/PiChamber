import type { DesktopSettings } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { useMessageQueueStore, type FollowUpBehavior, isFollowUpBehavior, normalizeFollowUpBehavior } from '@/stores/messageQueueStore';
import { isTerminalShell } from '@/lib/terminalShell';
import { isUiFontOption, isMonoFontOption } from '@/lib/fontOptions';
import { sanitizeStarterRefs } from '@/lib/draftStarters';
import { normalizeMobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import { setDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { setFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import {
  areCommandTriggerListsEqual,
  areModelRefsEqual,
  areRecentEffortsEqual,
  areStringArraysEqual,
  areStringRecordsEqual,
} from './settingsSanitizers';

export const isUiAuthenticationError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
    message?: unknown;
  };
  if (candidate.status === 401 || candidate.response?.status === 401) {
    return true;
  }
  return (
    typeof candidate.message === 'string' &&
    /(?:ui )?authentication required|unauthorized|\b401\b/i.test(
      candidate.message
    )
  );
};

export const applyDesktopUiPreferences = (settings: DesktopSettings): void => {
  const store = useUIStore.getState();
  const queueStore = useMessageQueueStore.getState();

  if (
    typeof settings.showReasoningTraces === 'boolean' &&
    settings.showReasoningTraces !== store.showReasoningTraces
  ) {
    store.setShowReasoningTraces(settings.showReasoningTraces);
  }
  if (
    typeof settings.collapsibleThinkingBlocks === 'boolean' &&
    settings.collapsibleThinkingBlocks !== store.collapsibleThinkingBlocks
  ) {
    store.setCollapsibleThinkingBlocks(settings.collapsibleThinkingBlocks);
  }
  if (
    typeof settings.collapseThinkingByDefault === 'boolean' &&
    settings.collapseThinkingByDefault !== store.collapseThinkingByDefault
  ) {
    store.setCollapseThinkingByDefault(settings.collapseThinkingByDefault);
  }
  if (
    typeof settings.autoDeleteEnabled === 'boolean' &&
    settings.autoDeleteEnabled !== store.autoDeleteEnabled
  ) {
    store.setAutoDeleteEnabled(settings.autoDeleteEnabled);
  }
  if (
    typeof settings.autoSaveEnabled === 'boolean' &&
    settings.autoSaveEnabled !== store.autoSaveEnabled
  ) {
    store.setAutoSaveEnabled(settings.autoSaveEnabled);
  }
  if (
    typeof settings.autoDeleteAfterDays === 'number' &&
    Number.isFinite(settings.autoDeleteAfterDays)
  ) {
    const normalized = Math.max(1, Math.min(365, settings.autoDeleteAfterDays));
    if (normalized !== store.autoDeleteAfterDays) {
      store.setAutoDeleteAfterDays(normalized);
    }
  }
  if (
    settings.sessionRetentionAction === 'archive' ||
    settings.sessionRetentionAction === 'delete'
  ) {
    if (settings.sessionRetentionAction !== store.sessionRetentionAction) {
      store.setSessionRetentionAction(settings.sessionRetentionAction);
    }
  }

  let nextFollowUpBehavior: FollowUpBehavior | null = null;
  if (isFollowUpBehavior(settings.followUpBehavior)) {
    nextFollowUpBehavior = settings.followUpBehavior;
  } else if (typeof settings.queueModeEnabled === 'boolean') {
    nextFollowUpBehavior = normalizeFollowUpBehavior(
      undefined,
      settings.queueModeEnabled
    );
  }
  if (
    nextFollowUpBehavior &&
    nextFollowUpBehavior !== queueStore.followUpBehavior
  ) {
    queueStore.setFollowUpBehavior(nextFollowUpBehavior);
  }

  if (
    typeof settings.showDeletionDialog === 'boolean' &&
    settings.showDeletionDialog !== store.showDeletionDialog
  ) {
    store.setShowDeletionDialog(settings.showDeletionDialog);
  }
  if (
    typeof settings.nativeNotificationsEnabled === 'boolean' &&
    settings.nativeNotificationsEnabled !== store.nativeNotificationsEnabled
  ) {
    store.setNativeNotificationsEnabled(settings.nativeNotificationsEnabled);
  }
  if (
    typeof settings.notificationMode === 'string' &&
    (settings.notificationMode === 'always' ||
      settings.notificationMode === 'hidden-only')
  ) {
    if (settings.notificationMode !== store.notificationMode) {
      store.setNotificationMode(settings.notificationMode);
    }
  }
  if (
    typeof settings.notifyOnSubtasks === 'boolean' &&
    settings.notifyOnSubtasks !== store.notifyOnSubtasks
  ) {
    store.setNotifyOnSubtasks(settings.notifyOnSubtasks);
  }
  if (
    typeof settings.notifyOnCompletion === 'boolean' &&
    settings.notifyOnCompletion !== store.notifyOnCompletion
  ) {
    store.setNotifyOnCompletion(settings.notifyOnCompletion);
  }
  if (
    typeof settings.notifyOnError === 'boolean' &&
    settings.notifyOnError !== store.notifyOnError
  ) {
    store.setNotifyOnError(settings.notifyOnError);
  }
  if (
    typeof settings.notifyOnQuestion === 'boolean' &&
    settings.notifyOnQuestion !== store.notifyOnQuestion
  ) {
    store.setNotifyOnQuestion(settings.notifyOnQuestion);
  }
  if (
    settings.notificationTemplates &&
    typeof settings.notificationTemplates === 'object'
  ) {
    store.setNotificationTemplates(settings.notificationTemplates);
  }
  if (
    typeof settings.summarizeLastMessage === 'boolean' &&
    settings.summarizeLastMessage !== store.summarizeLastMessage
  ) {
    store.setSummarizeLastMessage(settings.summarizeLastMessage);
  }
  if (
    typeof settings.summaryThreshold === 'number' &&
    Number.isFinite(settings.summaryThreshold)
  ) {
    store.setSummaryThreshold(settings.summaryThreshold);
  }
  if (
    typeof settings.summaryLength === 'number' &&
    Number.isFinite(settings.summaryLength)
  ) {
    store.setSummaryLength(settings.summaryLength);
  }
  if (
    typeof settings.maxLastMessageLength === 'number' &&
    Number.isFinite(settings.maxLastMessageLength)
  ) {
    store.setMaxLastMessageLength(settings.maxLastMessageLength);
  }
  if (
    typeof settings.inputSpellcheckEnabled === 'boolean' &&
    settings.inputSpellcheckEnabled !== store.inputSpellcheckEnabled
  ) {
    store.setInputSpellcheckEnabled(settings.inputSpellcheckEnabled);
  }
  if (
    typeof settings.showToolFileIcons === 'boolean' &&
    settings.showToolFileIcons !== store.showToolFileIcons
  ) {
    store.setShowToolFileIcons(settings.showToolFileIcons);
  }
  if (
    typeof settings.codeBlockLineWrap === 'boolean' &&
    settings.codeBlockLineWrap !== store.codeBlockLineWrap
  ) {
    store.setCodeBlockLineWrap(settings.codeBlockLineWrap);
  }
  if (
    typeof settings.showTurnChangedFiles === 'boolean' &&
    settings.showTurnChangedFiles !== store.showTurnChangedFiles
  ) {
    store.setShowTurnChangedFiles(settings.showTurnChangedFiles);
  }
  if (
    typeof settings.showExpandedBashTools === 'boolean' &&
    settings.showExpandedBashTools !== store.showExpandedBashTools
  ) {
    store.setShowExpandedBashTools(settings.showExpandedBashTools);
  }
  if (
    typeof settings.showExpandedEditTools === 'boolean' &&
    settings.showExpandedEditTools !== store.showExpandedEditTools
  ) {
    store.setShowExpandedEditTools(settings.showExpandedEditTools);
  }
  if (
    typeof settings.timeFormatPreference === 'string' &&
    (settings.timeFormatPreference === 'auto' ||
      settings.timeFormatPreference === '12h' ||
      settings.timeFormatPreference === '24h')
  ) {
    if (settings.timeFormatPreference !== store.timeFormatPreference) {
      store.setTimeFormatPreference(settings.timeFormatPreference);
    }
  }
  if (
    typeof settings.weekStartPreference === 'string' &&
    (settings.weekStartPreference === 'auto' ||
      settings.weekStartPreference === 'sunday' ||
      settings.weekStartPreference === 'monday')
  ) {
    if (settings.weekStartPreference !== store.weekStartPreference) {
      store.setWeekStartPreference(settings.weekStartPreference);
    }
  }
  if (typeof settings.desktopWindowControlsPosition === 'string') {
    const nextPosition =
      settings.desktopWindowControlsPosition === 'left'
        ? 'left'
        : settings.desktopWindowControlsPosition === 'right' ||
            settings.desktopWindowControlsPosition === 'auto'
          ? 'right'
          : null;
    if (nextPosition && nextPosition !== store.desktopWindowControlsPosition) {
      store.setDesktopWindowControlsPosition(nextPosition);
    }
  }
  if (typeof settings.desktopWindowControlsStyle === 'string') {
    const nextStyle =
      settings.desktopWindowControlsStyle === 'traffic-lights'
        ? 'traffic-lights'
        : settings.desktopWindowControlsStyle === 'classic'
          ? 'classic'
          : null;
    if (nextStyle && nextStyle !== store.desktopWindowControlsStyle) {
      store.setDesktopWindowControlsStyle(nextStyle);
    }
  }
  if (
    typeof settings.mermaidRenderingMode === 'string' &&
    (settings.mermaidRenderingMode === 'svg' ||
      settings.mermaidRenderingMode === 'ascii')
  ) {
    if (settings.mermaidRenderingMode !== store.mermaidRenderingMode) {
      store.setMermaidRenderingMode(settings.mermaidRenderingMode);
    }
  }
  if (
    typeof settings.userMessageRenderingMode === 'string' &&
    (settings.userMessageRenderingMode === 'markdown' ||
      settings.userMessageRenderingMode === 'plain')
  ) {
    if (settings.userMessageRenderingMode !== store.userMessageRenderingMode) {
      store.setUserMessageRenderingMode(settings.userMessageRenderingMode);
    }
  }
  if (
    typeof settings.collapsibleUserMessages === 'boolean' &&
    settings.collapsibleUserMessages !== store.collapsibleUserMessages
  ) {
    store.setCollapsibleUserMessages(settings.collapsibleUserMessages);
  }
  if (
    typeof settings.stickyUserHeader === 'boolean' &&
    settings.stickyUserHeader !== store.stickyUserHeader
  ) {
    store.setStickyUserHeader(settings.stickyUserHeader);
  }
  if (
    typeof settings.promptNavigatorEnabled === 'boolean' &&
    settings.promptNavigatorEnabled !== store.promptNavigatorEnabled
  ) {
    store.setPromptNavigatorEnabled(settings.promptNavigatorEnabled);
  }
  if (
    typeof settings.expandedEditorToolbar === 'boolean' &&
    settings.expandedEditorToolbar !== store.expandedEditorToolbar
  ) {
    store.setExpandedEditorToolbar(settings.expandedEditorToolbar);
  }
  if (
    typeof settings.wideChatLayoutEnabled === 'boolean' &&
    settings.wideChatLayoutEnabled !== store.wideChatLayoutEnabled
  ) {
    store.setWideChatLayoutEnabled(settings.wideChatLayoutEnabled);
  }
  if (
    typeof settings.showSplitAssistantMessageActions === 'boolean' &&
    settings.showSplitAssistantMessageActions !==
      store.showSplitAssistantMessageActions
  ) {
    store.setShowSplitAssistantMessageActions(
      settings.showSplitAssistantMessageActions
    );
  }
  if (
    typeof settings.fontSize === 'number' &&
    Number.isFinite(settings.fontSize) &&
    settings.fontSize !== store.fontSize
  ) {
    store.setFontSize(settings.fontSize);
  }
  if (Array.isArray(settings.draftStarters)) {
    // Legacy skill/command starters are dropped without conversion; only
    // prompt starters survive. Comparison keeps the migration idempotent.
    const nextStarters = sanitizeStarterRefs(settings.draftStarters);
    if (
      JSON.stringify(store.globalDraftStarters) !==
      JSON.stringify(nextStarters)
    ) {
      store.setGlobalDraftStarters(nextStarters);
    }
    settings.draftStarters = nextStarters;
  }
  delete settings.draftStartersScheduleTaskAdded;
  if (
    typeof settings.draftStartersVisible === 'boolean' &&
    settings.draftStartersVisible !== store.draftStartersVisible
  ) {
    store.setDraftStartersVisible(settings.draftStartersVisible);
  }
  if (
    typeof settings.terminalFontSize === 'number' &&
    Number.isFinite(settings.terminalFontSize) &&
    settings.terminalFontSize !== store.terminalFontSize
  ) {
    store.setTerminalFontSize(settings.terminalFontSize);
  }
  if (
    isTerminalShell(settings.terminalShell) &&
    settings.terminalShell !== store.terminalShell
  ) {
    store.setTerminalShell(settings.terminalShell);
  }
  if (
    Array.isArray(settings.terminalLoginShells) &&
    (settings.terminalLoginShells.length !==
      store.terminalLoginShells.length ||
      settings.terminalLoginShells.some(
        (shell, index) => shell !== store.terminalLoginShells[index]
      ))
  ) {
    store.setTerminalLoginShells(settings.terminalLoginShells);
  }
  if (
    typeof settings.editorFontSize === 'number' &&
    Number.isFinite(settings.editorFontSize) &&
    settings.editorFontSize !== store.editorFontSize
  ) {
    store.setEditorFontSize(settings.editorFontSize);
  }
  if (isUiFontOption(settings.uiFont) && settings.uiFont !== store.uiFont) {
    store.setUiFont(settings.uiFont);
  }
  if (isMonoFontOption(settings.monoFont) && settings.monoFont !== store.monoFont) {
    store.setMonoFont(settings.monoFont);
  }
  if (
    typeof settings.padding === 'number' &&
    Number.isFinite(settings.padding) &&
    settings.padding !== store.padding
  ) {
    store.setPadding(settings.padding);
  }
  if (
    typeof settings.cornerRadius === 'number' &&
    Number.isFinite(settings.cornerRadius) &&
    settings.cornerRadius !== store.cornerRadius
  ) {
    store.setCornerRadius(settings.cornerRadius);
  }
  if (
    typeof settings.inputBarOffset === 'number' &&
    Number.isFinite(settings.inputBarOffset) &&
    settings.inputBarOffset !== store.inputBarOffset
  ) {
    store.setInputBarOffset(settings.inputBarOffset);
  }
  if (
    settings.shortcutOverrides &&
    !areStringRecordsEqual(settings.shortcutOverrides, store.shortcutOverrides)
  ) {
    useUIStore.setState({ shortcutOverrides: settings.shortcutOverrides });
  }
  if (
    settings.commandTriggers &&
    !areCommandTriggerListsEqual(
      settings.commandTriggers,
      store.commandTriggers
    )
  ) {
    useUIStore.setState({ commandTriggers: settings.commandTriggers });
  }
  if (typeof settings.mobileKeyboardMode === 'string') {
    const mode = normalizeMobileKeyboardMode(
      settings.mobileKeyboardMode,
      store.mobileKeyboardMode
    );
    if (mode !== store.mobileKeyboardMode) {
      store.setMobileKeyboardMode(mode);
    }
  }

  if (Array.isArray(settings.favoriteModels)) {
    const current = store.favoriteModels;
    const next = settings.favoriteModels;
    if (!areModelRefsEqual(current, next)) {
      useUIStore.setState({ favoriteModels: next });
    }
  }

  if (Array.isArray(settings.hiddenModels)) {
    const current = store.hiddenModels;
    const next = settings.hiddenModels;
    if (!areModelRefsEqual(current, next)) {
      useUIStore.setState({ hiddenModels: next });
    }
  }

  if (Array.isArray(settings.collapsedModelProviders)) {
    const current = store.collapsedModelProviders;
    const next = settings.collapsedModelProviders;
    if (!areStringArraysEqual(current, next)) {
      useUIStore.setState({ collapsedModelProviders: next });
    }
  }

  if (Array.isArray(settings.recentModels)) {
    const current = store.recentModels;
    const next = settings.recentModels;
    if (!areModelRefsEqual(current, next)) {
      useUIStore.setState({ recentModels: next });
    }
  }

  if (Array.isArray(settings.recentAgents)) {
    const current = store.recentAgents;
    const next = settings.recentAgents;
    if (!areStringArraysEqual(current, next)) {
      useUIStore.setState({ recentAgents: next });
    }
  }

  if (settings.recentEfforts && typeof settings.recentEfforts === 'object') {
    const current = store.recentEfforts;
    const next = settings.recentEfforts;
    if (!areRecentEffortsEqual(current, next)) {
      useUIStore.setState({ recentEfforts: next });
    }
  }
  if (
    typeof settings.diffLayoutPreference === 'string' &&
    (settings.diffLayoutPreference === 'dynamic' ||
      settings.diffLayoutPreference === 'inline' ||
      settings.diffLayoutPreference === 'side-by-side')
  ) {
    if (settings.diffLayoutPreference !== store.diffLayoutPreference) {
      store.setDiffLayoutPreference(settings.diffLayoutPreference);
    }
  }
  if (
    typeof settings.gitChangesViewMode === 'string' &&
    (settings.gitChangesViewMode === 'flat' ||
      settings.gitChangesViewMode === 'tree')
  ) {
    if (settings.gitChangesViewMode !== store.gitChangesViewMode) {
      store.setGitChangesViewMode(settings.gitChangesViewMode);
    }
  }
  if (typeof settings.directoryShowHidden === 'boolean') {
    setDirectoryShowHidden(settings.directoryShowHidden, { persist: false });
  }
  if (typeof settings.filesViewShowGitignored === 'boolean') {
    setFilesViewShowGitignored(settings.filesViewShowGitignored, {
      persist: false,
    });
  }
};
