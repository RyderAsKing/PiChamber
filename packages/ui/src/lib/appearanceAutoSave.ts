import { useUIStore } from '@/stores/useUIStore';
import { updateDesktopSettings } from '@/lib/persistence';
import type { DesktopSettings } from '@/lib/desktop';
import type { MonoFontOption, UiFontOption } from '@/lib/fontOptions';
import type { MobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import type { TerminalShell } from '@/lib/api/types';

type AppearanceSlice = {
  showDeletionDialog: boolean;
  nativeNotificationsEnabled: boolean;
  notificationMode: 'always' | 'hidden-only';
  notifyOnCompletion: boolean;
  notifyOnError: boolean;
  summarizeLastMessage: boolean;
  summaryThreshold: number;
  summaryLength: number;
  maxLastMessageLength: number;
  autoDeleteEnabled: boolean;
  autoSaveEnabled: boolean;
  autoDeleteAfterDays: number;
  sessionRetentionAction: 'archive' | 'delete';
  fontSize: number;
  terminalFontSize: number;
  terminalShell: TerminalShell;
  terminalLoginShells: TerminalShell[];
  editorFontSize: number;
  uiFont: UiFontOption;
  monoFont: MonoFontOption;
  padding: number;
  cornerRadius: number;
  inputBarOffset: number;
  mobileKeyboardMode: MobileKeyboardMode;
  diffLayoutPreference: 'dynamic' | 'inline' | 'side-by-side';
  gitChangesViewMode: 'flat' | 'tree';
};

let activeStop: (() => void) | null = null;

export const startAppearanceAutoSave = (): (() => void) => {
  if (typeof window === 'undefined' || activeStop) {
    return () => undefined;
  }

  let previous: AppearanceSlice = {
    showDeletionDialog: useUIStore.getState().showDeletionDialog,
    nativeNotificationsEnabled: useUIStore.getState().nativeNotificationsEnabled,
    notificationMode: useUIStore.getState().notificationMode,
    notifyOnCompletion: useUIStore.getState().notifyOnCompletion,
    notifyOnError: useUIStore.getState().notifyOnError,
    summarizeLastMessage: useUIStore.getState().summarizeLastMessage,
    summaryThreshold: useUIStore.getState().summaryThreshold,
    summaryLength: useUIStore.getState().summaryLength,
    maxLastMessageLength: useUIStore.getState().maxLastMessageLength,
    autoDeleteEnabled: useUIStore.getState().autoDeleteEnabled,
    autoSaveEnabled: useUIStore.getState().autoSaveEnabled,
    autoDeleteAfterDays: useUIStore.getState().autoDeleteAfterDays,
    sessionRetentionAction: useUIStore.getState().sessionRetentionAction,
    fontSize: useUIStore.getState().fontSize,
    terminalFontSize: useUIStore.getState().terminalFontSize,
    terminalShell: useUIStore.getState().terminalShell,
    terminalLoginShells: useUIStore.getState().terminalLoginShells,
    editorFontSize: useUIStore.getState().editorFontSize,
    uiFont: useUIStore.getState().uiFont,
    monoFont: useUIStore.getState().monoFont,
    padding: useUIStore.getState().padding,
    cornerRadius: useUIStore.getState().cornerRadius,
    inputBarOffset: useUIStore.getState().inputBarOffset,
    mobileKeyboardMode: useUIStore.getState().mobileKeyboardMode,
    diffLayoutPreference: useUIStore.getState().diffLayoutPreference,
    gitChangesViewMode: useUIStore.getState().gitChangesViewMode,
  };

  const unsubscribe = useUIStore.subscribe((state) => {
    const current: AppearanceSlice = {
      showDeletionDialog: state.showDeletionDialog,
      nativeNotificationsEnabled: state.nativeNotificationsEnabled,
      notificationMode: state.notificationMode,
      notifyOnCompletion: state.notifyOnCompletion,
      notifyOnError: state.notifyOnError,
      summarizeLastMessage: state.summarizeLastMessage,
      summaryThreshold: state.summaryThreshold,
      summaryLength: state.summaryLength,
      maxLastMessageLength: state.maxLastMessageLength,
      autoDeleteEnabled: state.autoDeleteEnabled,
      autoSaveEnabled: state.autoSaveEnabled,
      autoDeleteAfterDays: state.autoDeleteAfterDays,
      sessionRetentionAction: state.sessionRetentionAction,
      fontSize: state.fontSize,
      terminalFontSize: state.terminalFontSize,
      terminalShell: state.terminalShell,
      terminalLoginShells: state.terminalLoginShells,
      editorFontSize: state.editorFontSize,
      uiFont: state.uiFont,
      monoFont: state.monoFont,
      padding: state.padding,
      cornerRadius: state.cornerRadius,
      inputBarOffset: state.inputBarOffset,
      mobileKeyboardMode: state.mobileKeyboardMode,
      diffLayoutPreference: state.diffLayoutPreference,
      gitChangesViewMode: state.gitChangesViewMode,
    };

    const diff: Partial<DesktopSettings> = {};
    if (current.showDeletionDialog !== previous.showDeletionDialog) {
      diff.showDeletionDialog = current.showDeletionDialog;
    }
    if (current.nativeNotificationsEnabled !== previous.nativeNotificationsEnabled) {
      diff.nativeNotificationsEnabled = current.nativeNotificationsEnabled;
    }
    if (current.notificationMode !== previous.notificationMode) {
      diff.notificationMode = current.notificationMode;
    }
    if (current.notifyOnCompletion !== previous.notifyOnCompletion) {
      diff.notifyOnCompletion = current.notifyOnCompletion;
    }
    if (current.notifyOnError !== previous.notifyOnError) {
      diff.notifyOnError = current.notifyOnError;
    }
    if (current.summarizeLastMessage !== previous.summarizeLastMessage) {
      diff.summarizeLastMessage = current.summarizeLastMessage;
    }
    if (current.summaryThreshold !== previous.summaryThreshold) {
      diff.summaryThreshold = current.summaryThreshold;
    }
    if (current.summaryLength !== previous.summaryLength) {
      diff.summaryLength = current.summaryLength;
    }
    if (current.maxLastMessageLength !== previous.maxLastMessageLength) {
      diff.maxLastMessageLength = current.maxLastMessageLength;
    }
    if (current.autoDeleteEnabled !== previous.autoDeleteEnabled) {
      diff.autoDeleteEnabled = current.autoDeleteEnabled;
    }
    if (current.autoSaveEnabled !== previous.autoSaveEnabled) {
      diff.autoSaveEnabled = current.autoSaveEnabled;
    }
    if (current.autoDeleteAfterDays !== previous.autoDeleteAfterDays) {
      diff.autoDeleteAfterDays = current.autoDeleteAfterDays;
    }
    if (current.sessionRetentionAction !== previous.sessionRetentionAction) {
      diff.sessionRetentionAction = current.sessionRetentionAction;
    }
    if (current.fontSize !== previous.fontSize) {
      diff.fontSize = current.fontSize;
    }
    if (current.terminalFontSize !== previous.terminalFontSize) {
      diff.terminalFontSize = current.terminalFontSize;
    }
    if (current.terminalShell !== previous.terminalShell) {
      diff.terminalShell = current.terminalShell;
    }
    if (current.terminalLoginShells !== previous.terminalLoginShells) {
      diff.terminalLoginShells = current.terminalLoginShells;
    }
    if (current.editorFontSize !== previous.editorFontSize) {
      diff.editorFontSize = current.editorFontSize;
    }
    if (current.uiFont !== previous.uiFont) {
      diff.uiFont = current.uiFont;
    }
    if (current.monoFont !== previous.monoFont) {
      diff.monoFont = current.monoFont;
    }
    if (current.padding !== previous.padding) {
      diff.padding = current.padding;
    }
    if (current.cornerRadius !== previous.cornerRadius) {
      diff.cornerRadius = current.cornerRadius;
    }
    if (current.inputBarOffset !== previous.inputBarOffset) {
      diff.inputBarOffset = current.inputBarOffset;
    }
    if (current.mobileKeyboardMode !== previous.mobileKeyboardMode) {
      diff.mobileKeyboardMode = current.mobileKeyboardMode;
    }
    if (current.diffLayoutPreference !== previous.diffLayoutPreference) {
      diff.diffLayoutPreference = current.diffLayoutPreference;
    }
    if (current.gitChangesViewMode !== previous.gitChangesViewMode) {
      diff.gitChangesViewMode = current.gitChangesViewMode;
    }

    previous = current;

    if (Object.keys(diff).length > 0) {
      void updateDesktopSettings(diff);
    }
  });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    if (activeStop === stop) activeStop = null;
  };
  activeStop = stop;
  return stop;
};
