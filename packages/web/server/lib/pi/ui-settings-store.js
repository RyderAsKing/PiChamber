import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolvePiChamberDataDir } from '../pichamber-data-dir.js';
import { withCrossProcessLock } from '../server/cross-process-lock.js';

const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;
const PORTABLE_SETTINGS_MARKER = '__pichamberSettingsScope';
const PORTABLE_SETTINGS_VERSION = 'portable-v1';

// Keep this list explicit. settings.json is intended to be copied between hosts.
const PORTABLE_FIELDS = new Set([
  'themeId', 'useSystemTheme', 'themeVariant', 'lightThemeId', 'darkThemeId',
  'splashBgLight', 'splashFgLight', 'splashBgDark', 'splashFgDark',
  'showReasoningTraces', 'collapsibleThinkingBlocks', 'collapseThinkingByDefault',
  'showDeletionDialog', 'nativeNotificationsEnabled', 'notificationMode',
  'notifyOnSubtasks', 'notifyOnCompletion', 'notifyOnError', 'notifyOnQuestion',
  'notificationTemplates', 'summarizeLastMessage', 'summaryThreshold', 'summaryLength',
  'maxLastMessageLength', 'usageAutoRefresh', 'usageRefreshIntervalMs',
  'usageDisplayMode', 'usageShowPredValues', 'usageDropdownProviders',
  'usageSelectedModels', 'usageCollapsedFamilies', 'usageExpandedFamilies', 'usageModelGroups',
  'autoDeleteEnabled', 'autoSaveEnabled', 'autoDeleteAfterDays', 'sessionRetentionAction',
  'defaultModel', 'defaultVariant', 'smallModelUseDefault', 'smallModelOverride',
  'walkthroughModelOverride', 'followUpBehavior', 'queueModeEnabled', 'gitmojiEnabled',
  'defaultFileViewerPreview', 'zenModel', 'gitProviderId', 'gitModelId',
  'inputSpellcheckEnabled', 'showToolFileIcons', 'codeBlockLineWrap', 'showTurnChangedFiles',
  'showExpandedBashTools', 'showExpandedEditTools', 'timeFormatPreference',
  'weekStartPreference', 'mermaidRenderingMode', 'userMessageRenderingMode',
  'collapsibleUserMessages', 'stickyUserHeader', 'promptNavigatorEnabled',
  'expandedEditorToolbar', 'wideChatLayoutEnabled', 'showSplitAssistantMessageActions',
  'fontSize', 'terminalFontSize', 'editorFontSize', 'uiFont', 'monoFont', 'padding',
  'cornerRadius', 'inputBarOffset', 'shortcutOverrides', 'commandTriggers',
  'favoriteModels', 'hiddenModels', 'collapsedModelProviders', 'recentModels',
  'recentAgents', 'recentEfforts', 'diffLayoutPreference', 'gitChangesViewMode',
  'directoryShowHidden', 'filesViewShowGitignored', 'messageLimit',
  'responseStyleEnabled', 'responseStylePreset', 'responseStyleCustomInstructions',
  'draftStarters', 'draftStartersVisible', 'draftStartersScheduleTaskAdded',
  'autoCreateWorktree', 'globalBehaviorPrompt', 'skillCatalogs', 'messageStreamTransport',
]);

// These values describe one host or device. Secrets are local too, so they can
// still be consumed by the existing authenticated API without entering the
// portable file.
const LOCAL_FIELDS = new Set([
  'lastDirectory', 'homeDirectory', 'projects', 'activeProjectId',
  'securityScopedBookmarks', 'pinnedDirectories', 'defaultGitIdentityId', 'openInAppId',
  'terminalShell', 'terminalLoginShells', 'desktopLanAccessEnabled',
  'desktopKeepAwakeEnabled', 'desktopProcessPerformanceRecordingEnabled',
  'desktopMinimizeToTrayEnabled', 'desktopMacMenuBarEnabled',
  'desktopWindowControlsPosition', 'desktopWindowControlsStyle',
  'desktopWindowState', 'desktopLocalPort', 'desktopInstallId', 'desktopHosts',
  'desktopDefaultHostId', 'desktopInitialHostChoiceCompleted',
  'pwaAppName', 'pwaOrientation', 'mobileKeyboardMode',
  'tunnelProvider', 'tunnelMode', 'tunnelBootstrapTtlMs', 'tunnelSessionTtlMs',
  'managedLocalTunnelConfigPath', 'managedRemoteTunnelHostname',
  'managedRemoteTunnelPresets', 'managedRemoteTunnelSelectedPresetId',
  'managedRemoteTunnelToken', 'managedRemoteTunnelPresetTokens',
  'hasManagedRemoteTunnelToken', 'desktopUiPassword', 'desktopLocalClientToken',
]);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const validateValue = (value, depth = 0) => {
  if (depth > 64) throw new Error('UI_SETTINGS_INVALID');
  if (Array.isArray(value)) {
    for (const entry of value) validateValue(entry, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new Error('UI_SETTINGS_INVALID');
    validateValue(entry, depth + 1);
  }
};

const validateRecord = (value) => {
  if (!isRecord(value)) throw new Error('UI_SETTINGS_INVALID');
  validateValue(value);
  return value;
};

const selectFields = (value, fields) => Object.fromEntries(
  Object.entries(value).filter(([key]) => fields.has(key)),
);

const readRecord = async (file, fs) => {
  try {
    const raw = await fs.readFile(file, 'utf8');
    if (Buffer.byteLength(raw) > MAX_SETTINGS_BYTES) throw new Error('UI_SETTINGS_INVALID');
    return validateRecord(JSON.parse(raw));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    if (error?.message === 'UI_SETTINGS_INVALID') throw error;
    throw new Error('UI_SETTINGS_INVALID');
  }
};

const writeRecord = async (file, value, fs) => {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_SETTINGS_BYTES) throw new Error('UI_SETTINGS_INVALID');
  const parent = dirname(file);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
  if (process.platform !== 'win32') await fs.chmod(file, 0o600);
};

export const createPiUiSettingsStore = ({
  file = join(resolvePiChamberDataDir(), 'settings.json'),
  runtimeFile = join(dirname(file), 'runtime-state.json'),
  fs = { chmod, mkdir, readFile, rename, writeFile },
} = {}) => {
  let mutation = Promise.resolve();

  const readLocked = async () => {
    const portableRoot = await readRecord(file, fs);
    const runtimeRoot = await readRecord(runtimeFile, fs);
    const migrated = portableRoot[PORTABLE_SETTINGS_MARKER] === PORTABLE_SETTINGS_VERSION;

    if (!migrated) {
      const migratedRuntime = {
        ...selectFields(runtimeRoot, LOCAL_FIELDS),
        ...selectFields(portableRoot, LOCAL_FIELDS),
      };
      const migratedPortable = {
        [PORTABLE_SETTINGS_MARKER]: PORTABLE_SETTINGS_VERSION,
        ...selectFields(portableRoot, PORTABLE_FIELDS),
      };
      // Local state goes first. A failure cannot strand host state only in a
      // portable file that a later successful write might replace.
      await writeRecord(runtimeFile, migratedRuntime, fs);
      await writeRecord(file, migratedPortable, fs);
      return { ...selectFields(migratedPortable, PORTABLE_FIELDS), ...selectFields(migratedRuntime, LOCAL_FIELDS) };
    }

    return {
      ...selectFields(portableRoot, PORTABLE_FIELDS),
      ...selectFields(runtimeRoot, LOCAL_FIELDS),
    };
  };

  const runMutation = (operation) => {
    const next = mutation.then(() => withCrossProcessLock(`${file}.lock`, operation));
    mutation = next.catch(() => {});
    return next;
  };

  const read = () => runMutation(readLocked);

  const write = async (changes) => {
    validateRecord(changes);
    return runMutation(async () => {
      const current = await readLocked();
      const portableChanges = selectFields(changes, PORTABLE_FIELDS);
      const localChanges = selectFields(changes, LOCAL_FIELDS);
      const nextPortable = {
        [PORTABLE_SETTINGS_MARKER]: PORTABLE_SETTINGS_VERSION,
        ...selectFields(current, PORTABLE_FIELDS),
        ...portableChanges,
      };
      const nextRuntime = {
        ...selectFields(current, LOCAL_FIELDS),
        ...localChanges,
      };
      await writeRecord(runtimeFile, nextRuntime, fs);
      await writeRecord(file, nextPortable, fs);
      return { ...selectFields(nextPortable, PORTABLE_FIELDS), ...selectFields(nextRuntime, LOCAL_FIELDS) };
    });
  };

  return { file, runtimeFile, read, write };
};
