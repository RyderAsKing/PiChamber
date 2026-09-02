import React from 'react';
import { useTerminalStore } from '@/stores/useTerminalStore';
import type { TerminalAPI, TerminalShell } from '@/lib/api/types';
import { FALLBACK_TERMINAL_SIZE } from './terminalStreamHelpers';

export function useTerminalTabsManager({
  terminal,
  effectiveDirectory,
  activeTabId,
  enableTabs,
  terminalShell,
  terminalLoginShell,
  terminalAppearanceRef,
  lastViewportSizeRef,
  directoryRef,
  activeTabIdRef,
  terminalIdRef,
  disconnectStream,
  resetTerminalPreviewScan,
  startStream,
  setConnectionError,
  setIsFatalError,
  setIsReconnectPending,
}: {
  terminal: TerminalAPI;
  effectiveDirectory: string | null;
  activeTabId: string | null;
  enableTabs: boolean;
  terminalShell: TerminalShell;
  terminalLoginShell: boolean;
  terminalAppearanceRef: React.MutableRefObject<{ themeMode: 'light' | 'dark'; terminalBackground: string; terminalForeground: string }>;
  lastViewportSizeRef: React.MutableRefObject<{ cols: number; rows: number } | null>;
  directoryRef: React.MutableRefObject<string | null>;
  activeTabIdRef: React.MutableRefObject<string | null>;
  terminalIdRef: React.MutableRefObject<string | null>;
  disconnectStream: () => void;
  resetTerminalPreviewScan: () => void;
  startStream: (directory: string, tabId: string, terminalId: string) => void;
  setConnectionError: React.Dispatch<React.SetStateAction<string | null>>;
  setIsFatalError: React.Dispatch<React.SetStateAction<boolean>>;
  setIsReconnectPending: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const createTab = useTerminalStore((s) => s.createTab);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const setTabSessionId = useTerminalStore((s) => s.setTabSessionId);
  const setTabLifecycle = useTerminalStore((s) => s.setTabLifecycle);

  const [isRestarting, setIsRestarting] = React.useState(false);

  const handleRestart = React.useCallback(async () => {
    if (!effectiveDirectory) return;
    if (isRestarting) return;

    const state = useTerminalStore.getState().getDirectoryState(effectiveDirectory);
    const tabId = enableTabs
      ? activeTabId ?? state?.activeTabId ?? state?.tabs[0]?.id ?? null
      : state?.tabs[0]?.id ?? null;
    if (!tabId) return;
    const originalSessionId = state?.tabs.find((tab) => tab.id === tabId)?.terminalSessionId ?? null;
    if (!originalSessionId || !terminal.restartSession) return;

    setIsRestarting(true);
    setConnectionError(null);
    setIsFatalError(false);
    setIsReconnectPending(false);

    disconnectStream();
    resetTerminalPreviewScan();

    try {
      const size = lastViewportSizeRef.current ?? FALLBACK_TERMINAL_SIZE;
      const restarted = await terminal.restartSession(originalSessionId, {
        cwd: effectiveDirectory,
        shell: terminalShell,
        loginShell: terminalLoginShell,
        ...size,
        ...terminalAppearanceRef.current,
      });
      const owningTab = useTerminalStore
        .getState()
        .getDirectoryState(effectiveDirectory)
        ?.tabs.find((tab) => tab.id === tabId);
      if (owningTab?.terminalSessionId !== originalSessionId) return;
      setTabSessionId(effectiveDirectory, tabId, restarted.sessionId);
      setTabLifecycle(effectiveDirectory, tabId, 'running');
      if (directoryRef.current !== effectiveDirectory || activeTabIdRef.current !== tabId) return;
      terminalIdRef.current = restarted.sessionId;
      startStream(effectiveDirectory, tabId, restarted.sessionId);
    } catch (error) {
      const owningTab = useTerminalStore
        .getState()
        .getDirectoryState(effectiveDirectory)
        ?.tabs.find((tab) => tab.id === tabId);
      if (
        owningTab?.terminalSessionId !== originalSessionId ||
        directoryRef.current !== effectiveDirectory ||
        activeTabIdRef.current !== tabId
      )
        return;
      setConnectionError(error instanceof Error ? error.message : 'Failed to restart terminal');
      setIsFatalError(false);
      setIsReconnectPending(false);
      terminalIdRef.current = originalSessionId;
      startStream(effectiveDirectory, tabId, originalSessionId);
    } finally {
      setIsRestarting(false);
    }
  }, [
    activeTabId,
    activeTabIdRef,
    directoryRef,
    disconnectStream,
    effectiveDirectory,
    enableTabs,
    isRestarting,
    lastViewportSizeRef,
    resetTerminalPreviewScan,
    setConnectionError,
    setIsFatalError,
    setIsReconnectPending,
    setTabLifecycle,
    setTabSessionId,
    startStream,
    terminal,
    terminalAppearanceRef,
    terminalIdRef,
    terminalLoginShell,
    terminalShell,
  ]);

  const handleHardRestart = React.useCallback(async () => {
    await handleRestart();
  }, [handleRestart]);

  const handleCreateTab = React.useCallback(() => {
    if (!effectiveDirectory) return;
    const tabId = createTab(effectiveDirectory);
    setActiveTab(effectiveDirectory, tabId);
    setConnectionError(null);
    setIsFatalError(false);
    setIsReconnectPending(false);
    disconnectStream();
  }, [createTab, disconnectStream, effectiveDirectory, setActiveTab, setConnectionError, setIsFatalError, setIsReconnectPending]);

  const handleSelectTab = React.useCallback(
    (tabId: string) => {
      if (!effectiveDirectory) return;
      setActiveTab(effectiveDirectory, tabId);
      setConnectionError(null);
      setIsFatalError(false);
      setIsReconnectPending(false);
      disconnectStream();
    },
    [disconnectStream, effectiveDirectory, setActiveTab, setConnectionError, setIsFatalError, setIsReconnectPending],
  );

  const handleCloseTab = React.useCallback(
    (tabId: string) => {
      if (!effectiveDirectory) return;

      if (tabId === activeTabId) {
        disconnectStream();
      }

      setConnectionError(null);
      setIsFatalError(false);
      setIsReconnectPending(false);
      const sessionId = useTerminalStore
        .getState()
        .getDirectoryState(effectiveDirectory)
        ?.tabs.find((tab) => tab.id === tabId)?.terminalSessionId;
      void (async () => {
        if (sessionId) await terminal.close(sessionId);
        closeTab(effectiveDirectory, tabId);
      })().catch((error) =>
        setConnectionError(error instanceof Error ? error.message : 'Terminal session ended'),
      );
    },
    [activeTabId, closeTab, disconnectStream, effectiveDirectory, setConnectionError, setIsFatalError, setIsReconnectPending, terminal],
  );

  return {
    isRestarting,
    handleRestart,
    handleHardRestart,
    handleCreateTab,
    handleSelectTab,
    handleCloseTab,
  };
}
