import { chmod, mkdir, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { writeFileAtomic } from '../fs/atomic-write.js';
import { resolvePiChamberDataDir } from '../pichamber-data-dir.js';
import { withCrossProcessLock } from '../server/cross-process-lock.js';
import { mergeProjectSandboxSetting, mergeSandboxDefaults, ProjectSandboxSettingError, readSandboxDefaults } from './sandbox/project-sandbox-setting.js';

const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;
const PORTABLE_SETTINGS_MARKER = '__pichamberSettingsScope';
const PORTABLE_SETTINGS_VERSION = 'portable-v1';
const DOCKER_WORKSPACE = '/home/pichamber/workspaces';

// Keep this list explicit. settings.json is intended to be copied between hosts.
// Retired keys are intentionally absent so saved values cannot restore retired
// behavior: showReasoningTraces, collapsibleThinkingBlocks,
// collapseThinkingByDefault, defaultFileViewerPreview, inputSpellcheckEnabled,
// showToolFileIcons, codeBlockLineWrap, showTurnChangedFiles,
// showExpandedBashTools, showExpandedEditTools, mermaidRenderingMode,
// userMessageRenderingMode, collapsibleUserMessages, stickyUserHeader,
// promptNavigatorEnabled, wideChatLayoutEnabled,
// showSplitAssistantMessageActions, directoryShowHidden, gitmojiEnabled,
// notifyOnSubtasks, notifyOnQuestion, notificationTemplates,
// desktopWindowControlsPosition/Style (local). persistChatDraft was local-only
// UI state and was never part of the server allowlists.
const PORTABLE_FIELDS = new Set([
  'themeId', 'useSystemTheme', 'themeVariant', 'lightThemeId', 'darkThemeId',
  'splashBgLight', 'splashFgLight', 'splashBgDark', 'splashFgDark',
  'showDeletionDialog', 'nativeNotificationsEnabled', 'notificationMode',
  'notifyOnCompletion', 'notifyOnError', 'notifyOnInputNeeded',
  'summarizeLastMessage', 'summaryThreshold', 'summaryLength',
  'maxLastMessageLength', 'usageAutoRefresh', 'usageRefreshIntervalMs',
  'usageDisplayMode', 'usageShowPredValues', 'usageDropdownProviders',
  'usageSelectedModels', 'usageCollapsedFamilies', 'usageExpandedFamilies', 'usageModelGroups',
  'autoDeleteEnabled', 'autoSaveEnabled', 'autoDeleteAfterDays', 'sessionRetentionAction',
  'defaultModel', 'defaultVariant', 'smallModelUseDefault', 'smallModelOverride',
  'walkthroughModelOverride', 'followUpBehavior', 'queueModeEnabled',
  'zenModel', 'gitProviderId', 'gitModelId',
  'timeFormatPreference',
  'weekStartPreference',
  'sidebarViewMode',
  'sidebarAutoSettleAfterDays',
  'sessionAutoArchiveAfterDays', 'sessionAutoDeleteAfterDays',
  'expandedEditorToolbar',
  'wrapLinesByDefault',
  'fontSize', 'terminalFontSize', 'editorFontSize', 'uiFont', 'monoFont', 'padding',
  'cornerRadius', 'inputBarOffset', 'shortcutOverrides', 'commandTriggers',
  'favoriteModels', 'hiddenModels', 'collapsedModelProviders', 'recentModels',
  'recentAgents', 'recentEfforts', 'diffLayoutPreference', 'gitChangesViewMode',
  'filesViewShowGitignored', 'messageLimit',
  'responseStyleEnabled', 'responseStylePreset', 'responseStyleCustomInstructions',
  'draftStarters', 'draftStartersVisible', 'draftStartersScheduleTaskAdded', 'draftWallpaper', 'draftWallpaperMotion',
  'autoCreateWorktree', 'globalBehaviorPrompt', 'skillCatalogs', 'messageStreamTransport',
]);

// These values describe one host or device. Secrets are local too, so they can
// still be consumed by the existing authenticated API without entering the
// portable file.
const LOCAL_FIELDS = new Set([
  'lastDirectory', 'homeDirectory', 'projects', 'activeProjectId', 'sandboxDefaults',
  'securityScopedBookmarks', 'pinnedDirectories', 'openInAppId',
  'terminalShell', 'terminalLoginShells', 'desktopLanAccessEnabled',
  'desktopKeepAwakeEnabled', 'desktopProcessPerformanceRecordingEnabled',
  'desktopMinimizeToTrayEnabled', 'desktopCloseToTrayEnabled', 'desktopMacMenuBarEnabled',
  'desktopUpdateChannel', 'serverUpdateChannel',
  'desktopWindowState', 'desktopLocalPort', 'desktopInstallId', 'desktopHosts',
  'desktopDefaultHostId', 'desktopInitialHostChoiceCompleted',
  'pwaAppName', 'pwaOrientation', 'mobileKeyboardMode',
  'tunnelProvider', 'tunnelMode', 'tunnelBootstrapTtlMs', 'tunnelSessionTtlMs',
  'managedLocalTunnelConfigPath', 'managedRemoteTunnelHostname',
  'managedRemoteTunnelPresets', 'managedRemoteTunnelSelectedPresetId',
  'managedRemoteTunnelToken', 'managedRemoteTunnelPresetTokens',
  'hasManagedRemoteTunnelToken', 'desktopUiPassword', 'desktopLocalClientToken',
]);

const RETENTION_FIELDS = ['sessionAutoArchiveAfterDays', 'sessionAutoDeleteAfterDays'];
const MAX_RETENTION_DAYS = 365;
const NEW_INSTALL_AUTO_ARCHIVE_DAYS = 7;
// Old "delete after N days" now archives at N and deletes this long after
// archiving, so nothing is deleted sooner than it used to be.
const MIGRATED_DELETE_AFTER_ARCHIVE_DAYS = 30;
// The old client's default when autoDeleteAfterDays was never saved.
const LEGACY_RETENTION_DAYS = 30;

const isRetentionDays = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_RETENTION_DAYS;

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

const legacyRetentionDays = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return LEGACY_RETENTION_DAYS;
  return Math.max(1, Math.min(MAX_RETENTION_DAYS, Math.round(value)));
};

// Starting values for the auto-archive and auto-delete settings. Runs once:
// after this the portable file holds both fields and they are never removed.
// A new install (nothing saved in either file) gets 7/0. An existing install
// keeps what the old retention fields did, except "delete after N days" now
// archives at N and deletes 30 days after that.
const decideRetention = ({ portable, runtime }) => {
  const isNewInstall = Object.keys(selectFields(portable, PORTABLE_FIELDS)).length === 0
    && Object.keys(selectFields(portable, LOCAL_FIELDS)).length === 0
    && Object.keys(selectFields(runtime, LOCAL_FIELDS)).length === 0;
  if (isNewInstall) {
    return { sessionAutoArchiveAfterDays: NEW_INSTALL_AUTO_ARCHIVE_DAYS, sessionAutoDeleteAfterDays: 0 };
  }
  if (portable.autoDeleteEnabled !== true) {
    return { sessionAutoArchiveAfterDays: 0, sessionAutoDeleteAfterDays: 0 };
  }
  return {
    sessionAutoArchiveAfterDays: legacyRetentionDays(portable.autoDeleteAfterDays),
    sessionAutoDeleteAfterDays: portable.sessionRetentionAction === 'delete' ? MIGRATED_DELETE_AFTER_ARCHIVE_DAYS : 0,
  };
};

const hasRetentionDecision = (portable) => RETENTION_FIELDS.every((field) => isRetentionDays(portable[field]));

export const createDockerInitialLocalSettings = () => {
  const projectId = `path_${Buffer.from(DOCKER_WORKSPACE).toString('base64url')}`;
  return {
    projects: [{ id: projectId, path: DOCKER_WORKSPACE, label: 'Workspaces' }],
    activeProjectId: projectId,
  };
};

// A project's `sandbox` setting changes only through `setProjectSandbox`.
// Clients write the whole project list back and drop fields they do not
// know, so the stored setting is carried over by project id and any value a
// client sends is ignored. Without this an older client could turn a
// project's sandbox off just by reordering projects.
const withoutSandbox = (project) => {
  if (!isRecord(project) || !Object.hasOwn(project, 'sandbox')) return project;
  const { sandbox: _ignored, ...rest } = project;
  return rest;
};

const carrySandboxSettings = (incoming, current) => {
  if (!Array.isArray(incoming)) return incoming;
  const stored = new Map((Array.isArray(current) ? current : [])
    .filter((project) => isRecord(project) && typeof project.id === 'string' && Object.hasOwn(project, 'sandbox'))
    .map((project) => [project.id, project.sandbox]));
  return incoming.map((project) => {
    const next = withoutSandbox(project);
    return isRecord(next) && stored.has(next.id) ? { ...next, sandbox: stored.get(next.id) } : next;
  });
};

const writeRecord = async (file, value, fs) => {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_SETTINGS_BYTES) throw new Error('UI_SETTINGS_INVALID');
  await writeFileAtomic(file, serialized, { fs });
};

export const createPiUiSettingsStore = ({
  file = join(resolvePiChamberDataDir(), 'settings.json'),
  runtimeFile = join(dirname(file), 'runtime-state.json'),
  initialLocalSettings = {},
  fs = { chmod, mkdir, readFile, readlink, realpath, rename, rm, writeFile },
} = {}) => {
  let mutation = Promise.resolve();

  const readLocked = async () => {
    const portableRoot = await readRecord(file, fs);
    const runtimeRoot = await readRecord(runtimeFile, fs);
    const migrated = portableRoot[PORTABLE_SETTINGS_MARKER] === PORTABLE_SETTINGS_VERSION;
    const retention = hasRetentionDecision(portableRoot)
      ? null
      : decideRetention({ portable: portableRoot, runtime: runtimeRoot });

    if (!migrated) {
      const isFreshStore = Object.keys(portableRoot).length === 0 && Object.keys(runtimeRoot).length === 0;
      const migratedRuntime = {
        ...(isFreshStore ? selectFields(validateRecord(initialLocalSettings), LOCAL_FIELDS) : {}),
        ...selectFields(runtimeRoot, LOCAL_FIELDS),
        ...selectFields(portableRoot, LOCAL_FIELDS),
      };
      // A legacy flat settings.json may have come from another machine; a
      // sandbox setting is only ever made on this host.
      delete migratedRuntime.sandboxDefaults;
      if (Object.hasOwn(runtimeRoot, 'sandboxDefaults')) migratedRuntime.sandboxDefaults = runtimeRoot.sandboxDefaults;
      if (Object.hasOwn(selectFields(portableRoot, LOCAL_FIELDS), 'projects')) {
        migratedRuntime.projects = carrySandboxSettings(portableRoot.projects, runtimeRoot.projects);
      }
      const migratedPortable = {
        [PORTABLE_SETTINGS_MARKER]: PORTABLE_SETTINGS_VERSION,
        ...selectFields(portableRoot, PORTABLE_FIELDS),
        ...retention,
      };
      // Local state goes first. A failure cannot strand host state only in a
      // portable file that a later successful write might replace.
      await writeRecord(runtimeFile, migratedRuntime, fs);
      await writeRecord(file, migratedPortable, fs);
      return { ...selectFields(migratedPortable, PORTABLE_FIELDS), ...selectFields(migratedRuntime, LOCAL_FIELDS) };
    }

    if (retention) {
      // Rewrite only the portable file; local state is already in its own file.
      const decidedPortable = { ...portableRoot, ...retention };
      await writeRecord(file, decidedPortable, fs);
      return {
        ...selectFields(decidedPortable, PORTABLE_FIELDS),
        ...selectFields(runtimeRoot, LOCAL_FIELDS),
      };
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
    for (const field of ['desktopUpdateChannel', 'serverUpdateChannel']) {
      if (Object.hasOwn(changes, field)
        && changes[field] !== 'stable'
        && changes[field] !== 'rc') {
        throw new Error('UI_SETTINGS_INVALID');
      }
    }
    for (const field of RETENTION_FIELDS) {
      if (Object.hasOwn(changes, field) && !isRetentionDays(changes[field])) {
        throw new Error('UI_SETTINGS_INVALID');
      }
    }
    return runMutation(async () => {
      const current = await readLocked();
      const portableChanges = selectFields(changes, PORTABLE_FIELDS);
      const localChanges = selectFields(changes, LOCAL_FIELDS);
      if (Object.hasOwn(localChanges, 'projects')) {
        localChanges.projects = carrySandboxSettings(localChanges.projects, current.projects);
      }
      // Like a project's setting, the sandbox default changes only through
      // `setSandboxDefaults`.
      delete localChanges.sandboxDefaults;
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

  /**
   * Save one project's sandbox setting (host-local only). `patch` holds
   * `mode`, `allowHosts`, `allowLocalPorts`, `extraFolders`, or several; a
   * field it leaves out keeps the stored value. The merge happens under the
   * store lock, so a device that only adds a host cannot turn off a sandbox
   * another device just turned on.
   */
  const setProjectSandbox = async (projectId, patch) => {
    // Refuse a malformed patch before taking the lock.
    mergeProjectSandboxSetting(null, patch);
    return runMutation(async () => {
      const current = await readLocked();
      const projects = Array.isArray(current.projects) ? current.projects : [];
      const stored = typeof projectId === 'string'
        ? projects.find((project) => isRecord(project) && project.id === projectId)
        : undefined;
      if (!stored) throw new ProjectSandboxSettingError(undefined, 'PROJECT_NOT_FOUND');
      const sandbox = mergeProjectSandboxSetting(stored, patch);
      const nextRuntime = {
        ...selectFields(current, LOCAL_FIELDS),
        projects: projects.map((project) => (isRecord(project) && project.id === projectId ? { ...project, sandbox } : project)),
      };
      await writeRecord(runtimeFile, nextRuntime, fs);
      return { ...selectFields(current, PORTABLE_FIELDS), ...selectFields(nextRuntime, LOCAL_FIELDS) };
    });
  };

  /**
   * Save the host's sandbox default (host-local only). `patch` holds `mode`,
   * `allowHosts`, or both; a field it leaves out keeps the stored value. The
   * merge happens under the store lock, so a device that only adds a host
   * cannot undo a mode another device just set.
   */
  const setSandboxDefaults = async (patch) => {
    // Refuse a malformed patch before taking the lock.
    mergeSandboxDefaults(readSandboxDefaults({}).defaults, patch);
    return runMutation(async () => {
      const current = await readLocked();
      const stored = readSandboxDefaults(current);
      // The mode of an unreadable stored default is a placeholder (off),
      // while projects that follow it stay closed. A patch without a mode
      // would store that placeholder and run them unsandboxed.
      if (stored.invalid && patch.mode === undefined) throw new ProjectSandboxSettingError('MODE');
      const sandboxDefaults = mergeSandboxDefaults(stored.defaults, patch);
      const nextRuntime = { ...selectFields(current, LOCAL_FIELDS), sandboxDefaults };
      await writeRecord(runtimeFile, nextRuntime, fs);
      return { ...selectFields(current, PORTABLE_FIELDS), ...selectFields(nextRuntime, LOCAL_FIELDS) };
    });
  };

  return { file, runtimeFile, read, write, setProjectSandbox, setSandboxDefaults };
};
