import type { ProjectEntry, TerminalShell } from '@/lib/api/types';
import type { CommandTrigger } from '@/lib/pi/command-triggers';
import type { DraftStarterRef } from '@/lib/draftStarters';
import type { MobileKeyboardMode } from '@/lib/mobileKeyboardMode';

export type ManagedRemoteTunnelPreset = {
  id: string;
  name: string;
  hostname: string;
};

export type UpdateInfo = {
  available: boolean;
  version?: string;
  currentVersion: string;
  body?: string;
  date?: string;
  releaseUrl?: string;
  downloadUrl?: string;
  nextSuggestedCheckInSec?: number;
  packageManager?: string;
  updateCommand?: string;
};

export type UpdateProgress = {
  downloaded: number;
  total?: number;
};

export type DesktopWindowControlsPosition = 'left' | 'right';
export type DesktopWindowControlsSide = 'left' | 'right';
export type DesktopWindowControlAction = 'close' | 'minimize' | 'maximize';
export type DesktopWindowControlsStyle = 'classic' | 'traffic-lights';

export type DesktopSettings = {
  themeId?: string;
  useSystemTheme?: boolean;
  themeVariant?: 'light' | 'dark';
  lightThemeId?: string;
  darkThemeId?: string;
  splashBgLight?: string;
  splashFgLight?: string;
  splashBgDark?: string;
  splashFgDark?: string;
  lastDirectory?: string;
  homeDirectory?: string;
  desktopLanAccessEnabled?: boolean;
  desktopKeepAwakeEnabled?: boolean;
  desktopProcessPerformanceRecordingEnabled?: boolean;
  desktopMinimizeToTrayEnabled?: boolean;
  desktopMacMenuBarEnabled?: boolean;
  desktopUiPassword?: string;
  projects?: ProjectEntry[];
  activeProjectId?: string;
  securityScopedBookmarks?: string[];
  pinnedDirectories?: string[];
  showReasoningTraces?: boolean;
  collapsibleThinkingBlocks?: boolean;
  collapseThinkingByDefault?: boolean;
  showDeletionDialog?: boolean;
  nativeNotificationsEnabled?: boolean;
  notificationMode?: 'always' | 'hidden-only';
  notifyOnSubtasks?: boolean;

  notifyOnCompletion?: boolean;
  notifyOnError?: boolean;
  notifyOnQuestion?: boolean;

  notificationTemplates?: {
    completion: { title: string; message: string };
    error: { title: string; message: string };
    question: { title: string; message: string };
    subtask: { title: string; message: string };
  };

  summarizeLastMessage?: boolean;
  summaryThreshold?: number;
  summaryLength?: number;
  maxLastMessageLength?: number;

  usageAutoRefresh?: boolean;
  usageRefreshIntervalMs?: number;
  usageDisplayMode?: 'usage' | 'remaining';
  usageShowPredValues?: boolean;
  usageDropdownProviders?: string[];
  usageSelectedModels?: Record<string, string[]>;
  usageCollapsedFamilies?: Record<string, string[]>;
  usageExpandedFamilies?: Record<string, string[]>;
  usageModelGroups?: Record<string, {
    customGroups?: Array<{ id: string; label: string; models: string[]; order: number }>;
    modelAssignments?: Record<string, string>;
    renamedGroups?: Record<string, string>;
  }>;
  autoDeleteEnabled?: boolean;
  autoSaveEnabled?: boolean;
  autoDeleteAfterDays?: number;
  sessionRetentionAction?: 'archive' | 'delete';
  tunnelProvider?: string;
  tunnelMode?: 'quick' | 'managed-remote' | 'managed-local';
  tunnelBootstrapTtlMs?: number | null;
  tunnelSessionTtlMs?: number;
  managedLocalTunnelConfigPath?: string | null;
  managedRemoteTunnelHostname?: string;
  managedRemoteTunnelToken?: string | null;
  hasManagedRemoteTunnelToken?: boolean;
  managedRemoteTunnelPresets?: ManagedRemoteTunnelPreset[];
  managedRemoteTunnelSelectedPresetId?: string;
  managedRemoteTunnelPresetTokens?: Record<string, string>;
  defaultModel?: string;
  defaultVariant?: string;
  smallModelUseDefault?: boolean;
  smallModelOverride?: string;
  walkthroughModelOverride?: string;
  defaultGitIdentityId?: string;
  openInAppId?: string;
  followUpBehavior?: 'steer' | 'queue';
  queueModeEnabled?: boolean;
  gitmojiEnabled?: boolean;
  defaultFileViewerPreview?: boolean;
  zenModel?: string;
  gitProviderId?: string;
  gitModelId?: string;
  pwaAppName?: string;
  pwaOrientation?: 'system' | 'portrait' | 'landscape';
  mobileKeyboardMode?: MobileKeyboardMode;
  desktopWindowControlsPosition?: DesktopWindowControlsPosition;
  desktopWindowControlsStyle?: DesktopWindowControlsStyle;
  inputSpellcheckEnabled?: boolean;
  showToolFileIcons?: boolean;
  codeBlockLineWrap?: boolean;
  showTurnChangedFiles?: boolean;
  showExpandedBashTools?: boolean;
  showExpandedEditTools?: boolean;
  timeFormatPreference?: 'auto' | '12h' | '24h';
  weekStartPreference?: 'auto' | 'sunday' | 'monday';
  mermaidRenderingMode?: 'svg' | 'ascii';
  userMessageRenderingMode?: 'markdown' | 'plain';
  collapsibleUserMessages?: boolean;
  stickyUserHeader?: boolean;
  promptNavigatorEnabled?: boolean;
  expandedEditorToolbar?: boolean;
  wideChatLayoutEnabled?: boolean;
  showSplitAssistantMessageActions?: boolean;
  fontSize?: number;
  terminalFontSize?: number;
  terminalShell?: TerminalShell;
  terminalLoginShells?: TerminalShell[];
  editorFontSize?: number;
  uiFont?: string;
  monoFont?: string;
  padding?: number;
  cornerRadius?: number;
  inputBarOffset?: number;
  shortcutOverrides?: Record<string, string>;
  commandTriggers?: CommandTrigger[];

  favoriteModels?: Array<{ providerID: string; modelID: string }>;
  hiddenModels?: Array<{ providerID: string; modelID: string }>;
  collapsedModelProviders?: string[];
  recentModels?: Array<{ providerID: string; modelID: string }>;
  recentAgents?: string[];
  recentEfforts?: Record<string, string[]>;
  diffLayoutPreference?: 'dynamic' | 'inline' | 'side-by-side';
  gitChangesViewMode?: 'flat' | 'tree';
  directoryShowHidden?: boolean;
  filesViewShowGitignored?: boolean;

  messageLimit?: number;

  responseStyleEnabled?: boolean;
  responseStylePreset?: 'concise' | 'detailed' | 'mentor' | 'pushback' | 'noFiller' | 'matchEnergy' | 'warmPeer' | 'custom';
  responseStyleCustomInstructions?: string;
  draftStarters?: DraftStarterRef[];
  draftStartersVisible?: boolean;
  draftStartersScheduleTaskAdded?: boolean;
};

export type DesktopBridgeGlobal = {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  openDialog?: (options: Record<string, unknown>) => Promise<unknown>;
  grantFileAccess?: (path: string) => Promise<unknown>;
  openExternal?: (url: string) => Promise<unknown>;
  listen?: (
    event: string,
    handler: (evt: { payload?: unknown }) => void,
  ) => Promise<() => void>;
};

export type ElectronRuntimeGlobal = {
  runtime?: string;
  arch?: string;
  trayEnabled?: boolean;
};

export type LaunchAtLoginStatus = {
  supported: boolean;
  enabled: boolean;
};

export type KeepAwakeStatus = {
  supported: boolean;
  enabled: boolean;
  active: boolean;
};

export type MinimizeToTrayStatus = {
  supported: boolean;
  enabled: boolean;
};

export type ProcessPerformanceRecordingStatus = {
  supported: boolean;
  enabled: boolean;
  active: boolean;
};

export type InstalledDesktopAppInfo = {
  name: string;
  iconDataUrl?: string | null;
};

export type FetchDesktopInstalledAppsResult = {
  apps: InstalledDesktopAppInfo[];
  success: boolean;
  hasCache: boolean;
  isCacheStale: boolean;
};
