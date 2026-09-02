import React from 'react';
import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDeviceInfo } from '@/lib/device';
import { useUIStore } from '@/stores/useUIStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { openExternalUrl } from '@/lib/url';
import {
  getProjectActionsState,
  type PiChamberProjectAction,
  type ProjectRef,
} from '@/lib/pichamberConfig';
import {
  normalizeProjectActionDirectory,
  PROJECT_ACTIONS_UPDATED_EVENT,
  toProjectActionRunKey,
} from '@/lib/projectActions';
import { detectDevServerCommand, readPackageJsonScripts } from '@/lib/detectDevServer';
import { waitForTerminalExit } from '@/lib/projectActionTerminal';
import {
  AUTO_DISCOVER_ACTION_ID,
  AUTO_DISCOVER_PREVIEW_WAIT_TIMEOUT_MS,
  extractBestUrl,
  normalizeManualOpenUrl,
  stripControlChars,
} from './projectActionUrlHelpers';

export type UrlWatchEntry = {
  lastSeenChunkId: number | null;
  openedUrl: boolean;
  tail: string;
  openInPreview: boolean;
};

export interface UseProjectActionsRunnerProps {
  projectRef: ProjectRef | null;
  directory: string;
  allowMobile?: boolean;
}

export function useProjectActionsRunner({
  projectRef,
  directory,
  allowMobile = false,
}: UseProjectActionsRunnerProps) {
  const { currentTheme } = useThemeSystem();
  const { terminal } = useRuntimeAPIs();
  const { isMobile } = useDeviceInfo();
  const terminalShell = useUIStore((state) => state.terminalShell);
  const terminalLoginShell = useUIStore((state) => state.terminalLoginShells.includes(state.terminalShell));
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsProjectsSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);
  const openContextPreview = useUIStore((state) => state.openContextPreview);

  const ensureDirectory = useTerminalStore((state) => state.ensureDirectory);
  const setTabLabel = useTerminalStore((state) => state.setTabLabel);
  const setTabIconKey = useTerminalStore((state) => state.setTabIconKey);
  const setActiveTab = useTerminalStore((state) => state.setActiveTab);
  const setConnecting = useTerminalStore((state) => state.setConnecting);
  const setTabSessionId = useTerminalStore((state) => state.setTabSessionId);
  const setTabPreviewUrl = useTerminalStore((state) => state.setTabPreviewUrl);
  const projectActionRuns = useTerminalStore((state) => state.projectActionRuns);
  const setProjectActionRun = useTerminalStore((state) => state.setProjectActionRun);
  const updateProjectActionRunStatus = useTerminalStore((state) => state.updateProjectActionRunStatus);
  const removeProjectActionRun = useTerminalStore((state) => state.removeProjectActionRun);

  const [actions, setActions] = React.useState<PiChamberProjectAction[]>([]);
  const [selectedActionId, setSelectedActionId] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const tabByKeyRef = React.useRef<Record<string, string>>({});
  const urlWatchByRunKeyRef = React.useRef<Record<string, UrlWatchEntry>>({});
  const streamCleanupByRunKeyRef = React.useRef<Record<string, () => void>>({});
  const previewWaitTimeoutByRunKeyRef = React.useRef<Record<string, number>>({});
  const startingRunKeysRef = React.useRef<Set<string>>(new Set());
  const loadRequestIdRef = React.useRef(0);

  const projectId = projectRef?.id ?? null;
  const projectPath = projectRef?.path ?? '';

  const stableProjectRef = React.useMemo(() => {
    if (!projectId) {
      return null;
    }
    return { id: projectId, path: projectPath };
  }, [projectId, projectPath]);

  const openExternal = React.useCallback(async (url: string) => {
    await openExternalUrl(url);
  }, []);

  const loadActions = React.useCallback(async () => {
    if (!stableProjectRef) {
      return;
    }

    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;

    setIsLoading(true);
    try {
      const state = await getProjectActionsState(stableProjectRef);
      if (loadRequestIdRef.current !== requestId) {
        return;
      }
      const filtered = state.actions;
      setActions(filtered);
      setSelectedActionId((current) => {
        if (current === AUTO_DISCOVER_ACTION_ID) {
          return current;
        }
        if (current && filtered.some((entry) => entry.id === current)) {
          return current;
        }
        return null;
      });
    } catch {
      if (loadRequestIdRef.current !== requestId) {
        return;
      }
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setIsLoading(false);
      }
    }
  }, [stableProjectRef]);

  const normalizedDirectory = React.useMemo(() => {
    return normalizeProjectActionDirectory(directory || stableProjectRef?.path || '');
  }, [directory, stableProjectRef?.path]);

  const selectedAction = React.useMemo(() => {
    if (!selectedActionId) {
      return null;
    }
    return actions.find((entry) => entry.id === selectedActionId) ?? null;
  }, [actions, selectedActionId]);

  const autoDiscoverAction = React.useMemo<PiChamberProjectAction>(() => ({
    id: AUTO_DISCOVER_ACTION_ID,
    name: "Auto-discover",
    command: '',
    icon: 'scan-2',
    autoOpenUrl: true,
  }), []);

  const canUseAutoDiscover = !isMobile;
  const displayActions = React.useMemo(
    () => canUseAutoDiscover ? [autoDiscoverAction, ...actions] : actions,
    [actions, autoDiscoverAction, canUseAutoDiscover]
  );

  React.useEffect(() => {
    void loadActions();
  }, [loadActions]);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!projectId) {
        return;
      }
      if (detail?.projectId && detail.projectId !== projectId) {
        return;
      }
      void loadActions();
    };

    window.addEventListener(PROJECT_ACTIONS_UPDATED_EVENT, handler);
    return () => {
      window.removeEventListener(PROJECT_ACTIONS_UPDATED_EVENT, handler);
    };
  }, [loadActions, projectId]);

  React.useEffect(() => {
    if (!selectedActionId) {
      return;
    }
    if (selectedActionId === AUTO_DISCOVER_ACTION_ID && canUseAutoDiscover) {
      return;
    }
    if (!actions.some((entry) => entry.id === selectedActionId)) {
      setSelectedActionId(null);
    }
  }, [actions, canUseAutoDiscover, selectedActionId]);

  React.useEffect(() => {
    const monitorRuns = () => {
      const terminalStore = useTerminalStore.getState();
      const terminalSessions = terminalStore.sessions;
      const currentRuns = terminalStore.projectActionRuns;
      for (const [runKey, entry] of Object.entries(currentRuns)) {
        const directoryState = terminalSessions.get(entry.directory);
        const tab = directoryState?.tabs.find((item) => item.id === entry.tabId);
        if (!tab || tab.terminalSessionId !== entry.sessionId) {
          removeProjectActionRun(runKey);
          continue;
        }

        const watch = urlWatchByRunKeyRef.current[runKey] ?? { lastSeenChunkId: null, openedUrl: false, tail: '', openInPreview: false };
        urlWatchByRunKeyRef.current[runKey] = watch;
        const action = displayActions.find((item) => item.id === entry.actionId);
        const bufferChunks = terminalStore.getBuffer(entry.directory, entry.tabId).chunks;
        if (!action || bufferChunks.length === 0) continue;

        const nextChunks = bufferChunks.filter((chunk) => watch.lastSeenChunkId === null || chunk.id > watch.lastSeenChunkId);
        if (nextChunks.length === 0) continue;

        const combined = nextChunks.map((chunk) => chunk.data).join('');
        const textForScan = `${watch.tail}${combined}`;
        const maybeUrl = !watch.openedUrl && action.autoOpenUrl === true ? extractBestUrl(textForScan) : null;
        const lastChunkId = nextChunks[nextChunks.length - 1]?.id ?? watch.lastSeenChunkId;

        watch.lastSeenChunkId = lastChunkId;
        watch.tail = textForScan.slice(-512);

        if (maybeUrl) {
          watch.openedUrl = true;
          if (watch.openInPreview) {
            const run = currentRuns[runKey];
            if (run) {
              setTabPreviewUrl(run.directory, run.tabId, maybeUrl, { locked: false, autoOpened: false });
              if (run.status === 'waiting-for-preview') updateProjectActionRunStatus(runKey, 'running');
              window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[runKey]);
              delete previewWaitTimeoutByRunKeyRef.current[runKey];
              openContextPreview(run.directory, maybeUrl);
            }
          } else {
            void openExternal(maybeUrl);
            toast.success("Opened URL from action output");
          }
        }
        urlWatchByRunKeyRef.current[runKey] = watch;
      }

      for (const runKey of Object.keys(urlWatchByRunKeyRef.current)) {
        if (!currentRuns[runKey]) {
          delete urlWatchByRunKeyRef.current[runKey];
          window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[runKey]);
          delete previewWaitTimeoutByRunKeyRef.current[runKey];
        }
      }
    };

    monitorRuns();
    return useTerminalStore.subscribe((state, previousState) => {
      if (state.sessions !== previousState.sessions || state.buffers !== previousState.buffers) monitorRuns();
    });
  }, [displayActions, openContextPreview, openExternal, projectActionRuns, removeProjectActionRun, setTabPreviewUrl, updateProjectActionRunStatus]);

  const getOrCreateActionTab = React.useCallback(async (action: PiChamberProjectAction, options: { revealTerminal?: boolean } = {}) => {
    if (!normalizedDirectory) {
      throw new Error("No active directory");
    }

    const key = toProjectActionRunKey(normalizedDirectory, action.id);
    ensureDirectory(normalizedDirectory);

    const currentStore = useTerminalStore.getState();
    const existingDirectoryState = currentStore.getDirectoryState(normalizedDirectory);

    let tabId = tabByKeyRef.current[key] || null;
    const hasTab = tabId
      ? Boolean(existingDirectoryState?.tabs.some((entry) => entry.id === tabId))
      : false;

    if (!tabId || !hasTab) {
      tabId = currentStore.createTab(normalizedDirectory);
      tabByKeyRef.current[key] = tabId;
    }

    setTabLabel(normalizedDirectory, tabId, `Action: ${action.name}`);
    setTabIconKey(normalizedDirectory, tabId, action.icon || 'play');
    setActiveTab(normalizedDirectory, tabId);
    if (options.revealTerminal !== false) {
      useUIStore.getState().openContextPanelTab(normalizedDirectory, { mode: 'terminal' });
    }

    const stateAfterTab = useTerminalStore.getState().getDirectoryState(normalizedDirectory);
    const tab = stateAfterTab?.tabs.find((entry) => entry.id === tabId);
    return {
      key,
      tabId,
      sessionId: tab?.terminalSessionId ?? null,
    };
  }, [
    ensureDirectory,
    normalizedDirectory,
    setActiveTab,
    setTabIconKey,
    setTabLabel,
  ]);

  const runAction = React.useCallback(async (action: PiChamberProjectAction) => {
    if (!allowMobile && isMobile) {
      return;
    }

    if (!normalizedDirectory) {
      toast.error("No active directory for action");
      return;
    }

    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const existingRun = projectActionRuns[runKey];
    if (existingRun && existingRun.status === 'running') {
      return;
    }
    if (startingRunKeysRef.current.has(runKey)) return;
    startingRunKeysRef.current.add(runKey);

    try {
      const discovered = action.id === AUTO_DISCOVER_ACTION_ID
        ? await (async (): Promise<PiChamberProjectAction> => {
          const [actionsState, scripts] = await Promise.all([
            getProjectActionsState({ id: stableProjectRef?.id ?? '', path: normalizedDirectory }),
            readPackageJsonScripts(normalizedDirectory),
          ]);
          const devServer = await detectDevServerCommand(normalizedDirectory, actionsState.actions, scripts);
          if (!devServer) {
            throw new Error("No dev server command found. Configure a project action or add a \\\"dev\\\" script to package.json.");
          }
          return {
            id: AUTO_DISCOVER_ACTION_ID,
            name: "Auto-discover",
            command: devServer.command,
            icon: 'scan-2',
            autoOpenUrl: true,
            openUrl: devServer.previewUrlHint || '',
          };
        })()
        : action;

      const hasCustomOpenUrl = discovered.autoOpenUrl === true && (discovered.openUrl || '').trim().length > 0;
      const revealTerminal = !hasCustomOpenUrl && action.id !== AUTO_DISCOVER_ACTION_ID;
      const { key, tabId, sessionId } = await getOrCreateActionTab(discovered, { revealTerminal });
      let activeSessionId = sessionId;

      if (!activeSessionId) {
        setConnecting(normalizedDirectory, tabId, true);
        try {
          const created = await terminal.createSession({
            cwd: normalizedDirectory,
            sessionId: tabId,
            shell: terminalShell,
            loginShell: terminalLoginShell,
            themeMode: currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
            terminalBackground: currentTheme.colors.surface.background,
            terminalForeground: currentTheme.colors.syntax.base.foreground,
          });
          activeSessionId = created.sessionId;
          setTabSessionId(normalizedDirectory, tabId, activeSessionId);
        } finally {
          setConnecting(normalizedDirectory, tabId, false);
        }
      }

      if (!activeSessionId) {
        throw new Error("Failed to create terminal session");
      }

      streamCleanupByRunKeyRef.current[key]?.();
      setConnecting(normalizedDirectory, tabId, true);
      const subscription = terminal.connect(
          activeSessionId,
          { onEvent: (event) => {
            if (event.type === 'snapshot') {
              useTerminalStore.getState().replaceBuffer(normalizedDirectory, tabId, event.data ?? '', event.sequence ?? 0);
              useTerminalStore.getState().setConnecting(normalizedDirectory, tabId, false);
            }
            if (event.type === 'data' && typeof event.data === 'string' && event.data.length > 0) {
              useTerminalStore.getState().appendToBuffer(normalizedDirectory, tabId, event.data, event.sequence, event.replayData);
            }
            if (event.type === 'exit') {
              useTerminalStore.getState().setTabLifecycle(normalizedDirectory, tabId, 'exited');
              useTerminalStore.getState().setConnecting(normalizedDirectory, tabId, false);
              useTerminalStore.getState().removeProjectActionRun(key);
              delete urlWatchByRunKeyRef.current[key];
              streamCleanupByRunKeyRef.current[key]?.();
              delete streamCleanupByRunKeyRef.current[key];
              window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[key]);
              delete previewWaitTimeoutByRunKeyRef.current[key];
            }
          }, onError: (_error, fatal) => {
            useTerminalStore.getState().setConnecting(normalizedDirectory, tabId, false);
            if (fatal) {
              useTerminalStore.getState().setTabLifecycle(normalizedDirectory, tabId, 'exited');
              useTerminalStore.getState().setTabSessionId(normalizedDirectory, tabId, null);
              useTerminalStore.getState().removeProjectActionRun(key);
            }
          } },
        );
      streamCleanupByRunKeyRef.current[key] = subscription.close;

      const manualOpenUrl = discovered.autoOpenUrl ? normalizeManualOpenUrl(discovered.openUrl) : null;

      setProjectActionRun({
        key,
        directory: normalizedDirectory,
        actionId: discovered.id,
        tabId,
        sessionId: activeSessionId,
        status: discovered.id === AUTO_DISCOVER_ACTION_ID && !manualOpenUrl ? 'waiting-for-preview' : 'running',
      });
      window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[key]);
      delete previewWaitTimeoutByRunKeyRef.current[key];
      if (discovered.id === AUTO_DISCOVER_ACTION_ID && !manualOpenUrl) {
        previewWaitTimeoutByRunKeyRef.current[key] = window.setTimeout(() => {
          const store = useTerminalStore.getState();
          const run = store.projectActionRuns[key];
          store.updateProjectActionRunStatus(key, 'running');
          if (run) {
            store.setActiveTab(run.directory, run.tabId);
            useUIStore.getState().openContextPanelTab(run.directory, { mode: 'terminal' });
          }
          delete previewWaitTimeoutByRunKeyRef.current[key];
        }, AUTO_DISCOVER_PREVIEW_WAIT_TIMEOUT_MS);
      }

      urlWatchByRunKeyRef.current[key] = {
        lastSeenChunkId: null,
        openedUrl: Boolean(manualOpenUrl) || hasCustomOpenUrl,
        tail: '',
        openInPreview: discovered.id === AUTO_DISCOVER_ACTION_ID,
      };

      const normalizedCommand = stripControlChars(discovered.command.trim().replace(/\r\n|\r/g, '\n'));
      await terminal.sendInput(activeSessionId, `${normalizedCommand}\r`);

      if (manualOpenUrl) {
        setTabPreviewUrl(normalizedDirectory, tabId, manualOpenUrl, { locked: true, autoOpened: true });
        openContextPreview(normalizedDirectory, manualOpenUrl);
        toast.success("Opened action URL");
      } else if (hasCustomOpenUrl) {
        setTabPreviewUrl(normalizedDirectory, tabId, null, { locked: true });
        toast.error("Invalid custom URL format");
      } else {
        setTabPreviewUrl(normalizedDirectory, tabId, null, { locked: false, autoOpened: false });
      }

    } catch (error) {
      removeProjectActionRun(runKey);
      delete urlWatchByRunKeyRef.current[runKey];
      streamCleanupByRunKeyRef.current[runKey]?.();
      delete streamCleanupByRunKeyRef.current[runKey];
      window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[runKey]);
      delete previewWaitTimeoutByRunKeyRef.current[runKey];
      toast.error(error instanceof Error ? error.message : "Failed to run action");
    } finally {
      startingRunKeysRef.current.delete(runKey);
    }
  }, [
    currentTheme.colors.surface.background,
    currentTheme.colors.syntax.base.foreground,
    currentTheme.metadata.variant,
    getOrCreateActionTab,
    allowMobile,
    isMobile,
    normalizedDirectory,
    terminalLoginShell,
    terminalShell,
    openContextPreview,
    projectActionRuns,
    removeProjectActionRun,
    setConnecting,
    setProjectActionRun,
    setTabPreviewUrl,
    setTabSessionId,
    stableProjectRef?.id,
    terminal,
  ]);

  const stopAction = React.useCallback(async (action: PiChamberProjectAction) => {
    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const activeRun = projectActionRuns[runKey];
    if (!activeRun) {
      return;
    }

    updateProjectActionRunStatus(runKey, 'stopping');

    const exitPromise = waitForTerminalExit(terminal, activeRun.sessionId, 1000);

    try {
      await terminal.sendInput(activeRun.sessionId, '\x03');
    } catch {
      // noop
    }

    const exitObserved = await exitPromise;

    const afterTab = useTerminalStore.getState().getDirectoryState(activeRun.directory)?.tabs
      .find((entry) => entry.id === activeRun.tabId);

    const sessionStillSame = afterTab?.terminalSessionId === activeRun.sessionId;

    if (sessionStillSame && !exitObserved) {
      if (typeof terminal.forceKill === 'function') {
        try {
          await terminal.forceKill({ sessionId: activeRun.sessionId });
        } catch {
          // noop
        }
      } else {
        try {
          await terminal.close(activeRun.sessionId);
        } catch {
          // noop
        }
      }
      setTabSessionId(activeRun.directory, activeRun.tabId, null);
    }

    removeProjectActionRun(runKey);
    delete urlWatchByRunKeyRef.current[runKey];
    streamCleanupByRunKeyRef.current[runKey]?.();
    delete streamCleanupByRunKeyRef.current[runKey];
    window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[runKey]);
    delete previewWaitTimeoutByRunKeyRef.current[runKey];
  }, [normalizedDirectory, projectActionRuns, removeProjectActionRun, setTabSessionId, terminal, updateProjectActionRunStatus]);

  const handlePrimaryClick = React.useCallback(() => {
    const action = selectedAction ?? displayActions[0];
    if (!action) {
      return;
    }
    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const runningEntry = projectActionRuns[runKey];
    if (runningEntry?.status === 'stopping') {
      return;
    }
    if (runningEntry) {
      void stopAction(action);
      return;
    }
    void runAction(action);
  }, [displayActions, normalizedDirectory, runAction, projectActionRuns, selectedAction, stopAction]);

  const handleSelectAction = React.useCallback((action: PiChamberProjectAction, toggleStopIfRunning = false) => {
    setSelectedActionId(action.id);

    if (!toggleStopIfRunning) {
      void runAction(action);
      return;
    }

    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const runningEntry = projectActionRuns[runKey];
    if (runningEntry?.status === 'stopping') {
      return;
    }
    if (runningEntry) {
      void stopAction(action);
      return;
    }
    void runAction(action);
  }, [normalizedDirectory, runAction, projectActionRuns, stopAction]);

  const openProjectActionsSettings = React.useCallback(() => {
    if (!stableProjectRef?.id) {
      return;
    }
    setSettingsProjectsSelectedId(stableProjectRef.id);
    setSettingsPage('projects');
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen, setSettingsPage, setSettingsProjectsSelectedId, stableProjectRef?.id]);

  const previewAction = selectedAction ?? displayActions[0] ?? null;
  const previewRun = previewAction ? projectActionRuns[toProjectActionRunKey(normalizedDirectory, previewAction.id)] : null;
  const selectedRunPreviewUrl = useTerminalStore((state) => {
    if (!previewRun) return null;
    return state.sessions.get(previewRun.directory)?.tabs.find((tab) => tab.id === previewRun.tabId)?.previewUrl ?? null;
  });

  const shouldRender = Boolean((allowMobile || !isMobile) && stableProjectRef && normalizedDirectory);
  const resolvedSelected = selectedAction ?? displayActions[0] ?? null;

  return {
    shouldRender,
    isLoading,
    normalizedDirectory,
    resolvedSelected,
    displayActions,
    projectActionRuns,
    selectedRunPreviewUrl,
    handlePrimaryClick,
    handleSelectAction,
    openProjectActionsSettings,
    openContextPreview,
  };
}
