import React from 'react';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { getDesktopBridge, invokeDesktop, isElectronShell } from '@/lib/desktopBridge';
import { subscribeToDesktopMenuEvents } from '@/lib/desktopMenuEvents';
import { sessionEvents } from '@/lib/sessionEvents';
import { addSelectionToChat } from '@/lib/addSelectionToChat';
import { cycleSessionFolder } from '@/lib/folderCycle';
import { isPerfHudEnabled, setPerfHudEnabled } from '@/lib/perf/perfFlags';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { getSyncSessions } from '@/sync/sync-refs';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resolveGlobalSessionDirectory } from '@/lib/chat/sessionDirectory';

const openSettings = (page?: 'about' | 'general') => {
  const ui = useUIStore.getState();
  if (page) ui.setSettingsPage(page);
  ui.setSettingsDialogOpen(true);
};

const cycleSession = (direction: 1 | -1) => {
  const sessions = getSyncSessions();
  if (sessions.length < 2) return;

  const sessionUI = useSessionUIStore.getState();
  const currentIndex = sessions.findIndex((session) => session.id === sessionUI.currentSessionId);
  const startIndex = currentIndex < 0 ? (direction === 1 ? -1 : 0) : currentIndex;
  const next = sessions[(startIndex + direction + sessions.length) % sessions.length];
  if (!next) return;

  sessionUI.setCurrentSession(next.id, resolveGlobalSessionDirectory(next));
};

export function useDesktopMenuActions(): void {
  const { setThemeMode } = useThemeSystem();

  const handleAction = React.useCallback((action: string) => {
    const ui = useUIStore.getState();

    switch (action) {
      case 'about':
        openSettings('about');
        return;
      case 'settings':
        openSettings();
        return;
      case 'command-palette':
        ui.setCommandPaletteOpen(true);
        return;
      case 'new-session':
        ui.setActiveMainTab('chat');
        ui.setSessionSwitcherOpen(false);
        useSessionUIStore.getState().openNewSessionDraft();
        return;
      case 'change-workspace':
        sessionEvents.requestDirectoryDialog();
        return;
      case 'add-selection-to-chat':
        addSelectionToChat();
        return;
      case 'open-right-sidebar': {
        const directory = useDirectoryStore.getState().currentDirectory;
        if (!directory) return;
        const key = normalizeContextPanelDirectoryKey(directory);
        const panel = ui.contextPanelByDirectory[key];
        if (panel?.isOpen) return;
        if (panel?.activeTabId) ui.setActiveContextPanelTab(key, panel.activeTabId);
        else ui.openContextSurface(key, 'git');
        return;
      }
      case 'toggle-terminal': {
        const directory = useDirectoryStore.getState().currentDirectory;
        if (directory) ui.openContextSurface(normalizeContextPanelDirectoryKey(directory), 'terminal');
        return;
      }
      case 'theme-light':
        setThemeMode('light');
        return;
      case 'theme-dark':
        setThemeMode('dark');
        return;
      case 'theme-system':
        setThemeMode('system');
        return;
      case 'toggle-sidebar':
        if (ui.isMobile) ui.setSessionSwitcherOpen(!ui.isSessionSwitcherOpen);
        else ui.toggleSidebar();
        return;
      case 'toggle-memory-debug':
        setPerfHudEnabled(!isPerfHudEnabled());
        return;
      case 'go-back':
        window.history.back();
        return;
      case 'go-forward':
        window.history.forward();
        return;
      case 'previous-session':
        cycleSession(-1);
        return;
      case 'next-session':
        cycleSession(1);
        return;
      case 'previous-project':
        cycleSessionFolder(-1);
        return;
      case 'next-project':
        cycleSessionFolder(1);
        return;
      case 'help-dialog':
        ui.setHelpDialogOpen(true);
        return;
      case 'download-logs':
        openSettings('general');
        setPerfHudEnabled(true);
        return;
      case 'copy':
        // Electron performs the native copy before sending this notification.
        return;
      default:
        return;
    }
  }, [setThemeMode]);

  const handleCheckForUpdates = React.useCallback(() => {
    openSettings('about');
    void useUpdateStore.getState().checkForUpdates();
  }, []);

  const handleOpenMiniChat = React.useCallback(() => {
    const activeProject = useProjectsStore.getState().getActiveProject();
    void invokeDesktop('desktop_open_draft_mini_chat_window', {
      directory: useDirectoryStore.getState().currentDirectory || activeProject?.path || '',
      projectId: activeProject?.id ?? null,
    }).catch((error) => {
      console.warn('[desktop-menu] failed to open draft mini chat window', error);
    });
  }, []);

  React.useEffect(() => {
    if (!isElectronShell()) return;

    let disposed = false;
    let unsubscribe: () => void = () => undefined;
    void subscribeToDesktopMenuEvents(getDesktopBridge(), {
      onAction: handleAction,
      onCheckForUpdates: handleCheckForUpdates,
      onOpenMiniChat: handleOpenMiniChat,
    }).then((stop) => {
      if (disposed) stop();
      else unsubscribe = stop;
    }).catch((error) => {
      console.warn('[desktop-menu] failed to subscribe to application menu events', error);
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [handleAction, handleCheckForUpdates, handleOpenMiniChat]);
}
