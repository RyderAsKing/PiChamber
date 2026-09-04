import React from 'react';
import { useTerminalStore } from '@/stores/useTerminalStore';
import type { TerminalStreamEvent, TerminalAPI, TerminalError, TerminalShell } from '@/lib/api/types';
import { TerminalPreviewScanner, FALLBACK_TERMINAL_SIZE } from './terminalStreamHelpers';

type TabIdentity = {
  id: string;
  terminalSessionId: string | null;
  label: string;
};

export function useTerminalSessionStream({
  terminal,
  effectiveDirectory,
  activeTabId,
  terminalSessionId,
  terminalLifecycle,
  hasOpenedTerminalViewport,
  terminalHydrated,
  terminalShell,
  terminalLoginShell,
  terminalAppearanceRef,
  enableTabs,
  hasActiveContext,
  focusTerminalWhenWindowActive,
  tabs,
}: {
  terminal: TerminalAPI;
  effectiveDirectory: string | null;
  activeTabId: string | null;
  terminalSessionId: string | null;
  terminalLifecycle: string;
  hasOpenedTerminalViewport: boolean;
  terminalHydrated: boolean;
  terminalShell: TerminalShell;
  terminalLoginShell: boolean;
  terminalAppearanceRef: React.MutableRefObject<{ themeMode: 'light' | 'dark'; terminalBackground: string; terminalForeground: string }>;
  enableTabs: boolean;
  hasActiveContext: boolean;
  focusTerminalWhenWindowActive: () => void;
  tabs: TabIdentity[];
}) {
  const ensureDirectory = useTerminalStore((s) => s.ensureDirectory);
  const setTabSessionId = useTerminalStore((s) => s.setTabSessionId);
  const setTabLifecycle = useTerminalStore((s) => s.setTabLifecycle);
  const setConnecting = useTerminalStore((s) => s.setConnecting);
  const appendToBuffer = useTerminalStore((s) => s.appendToBuffer);
  const replaceBuffer = useTerminalStore((s) => s.replaceBuffer);
  const setTabPreviewUrl = useTerminalStore((s) => s.setTabPreviewUrl);

  const [connectionError, setConnectionError] = React.useState<string | null>(null);
  const [isFatalError, setIsFatalError] = React.useState(false);
  const [isReconnectPending, setIsReconnectPending] = React.useState(false);

  const subscriptionsRef = React.useRef(new Map<string, () => void>());
  const activeTerminalIdRef = React.useRef<string | null>(null);
  const activeTabIdRef = React.useRef<string | null>(activeTabId);
  const terminalIdRef = React.useRef<string | null>(terminalSessionId);
  const directoryRef = React.useRef<string | null>(effectiveDirectory);
  const lastViewportSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);
  const pendingTerminalCreatesRef = React.useRef(new Set<string>());
  const previewScannersRef = React.useRef(new Map<string, TerminalPreviewScanner>());

  const resetTerminalPreviewScan = React.useCallback(() => {
    const tabId = activeTabIdRef.current;
    if (tabId) previewScannersRef.current.get(tabId)?.reset();
  }, []);

  React.useEffect(() => {
    terminalIdRef.current = terminalSessionId;
  }, [terminalSessionId]);

  React.useEffect(() => {
    if (!terminalSessionId || !terminal.updateAppearance) return;
    void terminal.updateAppearance(terminalSessionId, terminalAppearanceRef.current).catch(() => {});
  }, [terminalAppearanceRef, terminal, terminalSessionId]);

  React.useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  React.useEffect(() => {
    directoryRef.current = effectiveDirectory;
  }, [effectiveDirectory]);

  const disconnectStream = React.useCallback(() => {
    for (const unsubscribe of subscriptionsRef.current.values()) {
      try {
        unsubscribe();
      } catch {
        /* ignored */
      }
    }
    subscriptionsRef.current.clear();
    activeTerminalIdRef.current = null;
    setIsReconnectPending(false);
  }, []);

  React.useEffect(
    () => () => {
      disconnectStream();
      terminalIdRef.current = null;
    },
    [disconnectStream],
  );

  const scanTerminalPreviewOutput = React.useCallback(
    (directory: string, tabId: string, data: string) => {
      let scanner = previewScannersRef.current.get(tabId);
      if (!scanner) {
        scanner = new TerminalPreviewScanner();
        previewScannersRef.current.set(tabId, scanner);
      }
      scanner.scan(directory, tabId, data, setTabPreviewUrl);
    },
    [setTabPreviewUrl],
  );

  const startStream = React.useCallback(
    (directory: string, tabId: string, terminalId: string) => {
      if (subscriptionsRef.current.has(terminalId)) {
        activeTerminalIdRef.current = terminalId;
        return;
      }

      const subscription = terminal.connect(terminalId, {
        onEvent: (event: TerminalStreamEvent) => {
          if (directoryRef.current !== directory) return;

          switch (event.type) {
            case 'snapshot': {
              const isActive =
                activeTabIdRef.current === tabId && terminalIdRef.current === terminalId;
              if (isActive) {
                setConnecting(directory, tabId, false);
                setConnectionError(null);
                setIsFatalError(false);
                setIsReconnectPending(false);
                focusTerminalWhenWindowActive();
              } else {
                setConnecting(directory, tabId, false);
              }

              replaceBuffer(directory, tabId, event.data ?? '', event.sequence ?? 0);
              scanTerminalPreviewOutput(directory, tabId, event.data ?? '');
              if (event.status === 'exited') setTabLifecycle(directory, tabId, 'exited');
              break;
            }
            case 'reconnecting': {
              void event;
              if (activeTabIdRef.current === tabId) {
                setConnectionError(null);
                setIsFatalError(false);
                setIsReconnectPending(true);
              }
              break;
            }
            case 'data': {
              if (event.data) {
                appendToBuffer(directory, tabId, event.data, event.sequence, event.replayData);
                scanTerminalPreviewOutput(directory, tabId, event.data);
              }
              break;
            }
            case 'exit': {
              const exitCode = typeof event.exitCode === 'number' ? event.exitCode : null;
              const signal = typeof event.signal === 'number' ? event.signal : null;
              const currentTab = useTerminalStore
                .getState()
                .getDirectoryState(directory)
                ?.tabs.find((t) => t.id === tabId);
              const isActionTab = Boolean(currentTab?.label?.startsWith('Action:'));
              appendToBuffer(
                directory,
                tabId,
                `\\r\\n[Process exited${exitCode !== null ? ` with code ${exitCode}` : ''}${
                  signal !== null ? ` (signal ${signal})` : ''
                }]\\r\\n`,
              );
              setTabLifecycle(directory, tabId, 'exited');
              if (activeTabIdRef.current === tabId) {
                setConnecting(directory, tabId, false);
                setConnectionError(isActionTab ? null : 'Terminal session ended');
                setIsFatalError(false);
                setIsReconnectPending(false);
              }
              break;
            }
          }
        },
        onError: (error: TerminalError, fatal?: boolean) => {
          if (directoryRef.current !== directory) return;
          const isActive = activeTabIdRef.current === tabId;

          if (!fatal) {
            if (isActive) {
              setConnectionError(null);
              setIsFatalError(false);
            }
            return;
          }

          if (error.code === 'SESSION_NOT_FOUND') {
            const currentTab = useTerminalStore
              .getState()
              .getDirectoryState(directory)
              ?.tabs.find((tab) => tab.id === tabId);
            if (!currentTab?.label?.startsWith('Action:')) {
              if (isActive) {
                setConnectionError(null);
                setIsFatalError(false);
                setConnecting(directory, tabId, false);
                setIsReconnectPending(false);
              }
              setTabSessionId(directory, tabId, null);
              setTabLifecycle(directory, tabId, 'idle');
              return;
            }
          }
          if (!isActive) return;
          setIsReconnectPending(false);
          setConnectionError(`Connection failed: ${error.message}`);
          setIsFatalError(true);
          setConnecting(directory, tabId, false);
          setTabLifecycle(directory, tabId, 'exited');
          setTabSessionId(directory, tabId, null);
        },
      });

      subscriptionsRef.current.set(terminalId, () => subscription.close());
      activeTerminalIdRef.current = terminalId;
    },
    [
      appendToBuffer,
      focusTerminalWhenWindowActive,
      replaceBuffer,
      scanTerminalPreviewOutput,
      setConnecting,
      setTabLifecycle,
      setTabSessionId,
      terminal,
    ],
  );

  const tabsKey = React.useMemo(
    () => tabs.map((tab) => `${tab.id}:${tab.terminalSessionId ?? ''}`).join(','),
    [tabs],
  );

  React.useEffect(() => {
    if (!terminalHydrated || !hasOpenedTerminalViewport || !effectiveDirectory) return;
    const directory = effectiveDirectory;
    const wanted = new Set<string>();
    for (const tab of tabs) {
      if (tab.terminalSessionId) {
        wanted.add(tab.terminalSessionId);
        startStream(directory, tab.id, tab.terminalSessionId);
      }
    }
    for (const [sessionId, unsubscribe] of subscriptionsRef.current) {
      if (!wanted.has(sessionId)) {
        try {
          unsubscribe();
        } catch {
          /* ignored */
        }
        subscriptionsRef.current.delete(sessionId);
      }
    }
  }, [tabsKey, tabs, effectiveDirectory, terminalHydrated, hasOpenedTerminalViewport, startStream]);

  React.useEffect(() => {
    let cancelled = false;

    if (!terminalHydrated || !hasOpenedTerminalViewport) {
      return;
    }

    if (!effectiveDirectory) {
      setConnectionError(
        hasActiveContext ? 'No working directory available for terminal.' : 'Select a session to open the terminal.',
      );
      return;
    }

    const ensureSession = async () => {
      const directory = effectiveDirectory;
      if (!directoryRef.current || directoryRef.current !== directory) return;

      const existingState = useTerminalStore.getState().getDirectoryState(directory);
      if (!existingState) {
        ensureDirectory(directory);
        return;
      }

      const state = useTerminalStore.getState().getDirectoryState(directory);
      if (!state || state.tabs.length === 0) {
        return;
      }

      const tabId = enableTabs
        ? (state.activeTabId ?? state.tabs[0]?.id ?? null)
        : (state.tabs[0]?.id ?? null);
      if (!tabId) {
        return;
      }

      const tab = state.tabs.find((t) => t.id === tabId) ?? state.tabs[0];
      const terminalId = tab?.terminalSessionId ?? null;
      const tabLifecycle = tab?.lifecycle ?? 'idle';
      const isActionTab = Boolean(tab?.label?.startsWith('Action:'));
      const buffer = useTerminalStore.getState().getBuffer(directory, tabId);
      const hasBufferedOutput = buffer.byteLength > 0 || buffer.chunks.length > 0;

      if (!terminalId) {
        if (tabLifecycle === 'exited') {
          setConnecting(directory, tabId, false);
          return;
        }

        if (isActionTab && hasBufferedOutput) {
          setConnecting(directory, tabId, false);
          return;
        }

        const createKey = `${directory}\u0000${tabId}`;
        if (pendingTerminalCreatesRef.current.has(createKey)) {
          return;
        }

        const initialSize = lastViewportSizeRef.current ?? FALLBACK_TERMINAL_SIZE;
        pendingTerminalCreatesRef.current.add(createKey);

        setConnectionError(null);
        setIsFatalError(false);
        setIsReconnectPending(false);
        setConnecting(directory, tabId, true);
        try {
          const session = await terminal.createSession({
            cwd: directory,
            sessionId: tabId,
            cols: initialSize.cols,
            rows: initialSize.rows,
            shell: terminalShell,
            loginShell: terminalLoginShell,
            ...terminalAppearanceRef.current,
          });

          const owningTab = useTerminalStore
            .getState()
            .getDirectoryState(directory)
            ?.tabs.find((entry) => entry.id === tabId);
          if (!owningTab) {
            try {
              await terminal.close(session.sessionId);
            } catch {
              /* ignored */
            }
            return;
          }

          setTabSessionId(directory, tabId, session.sessionId);

          const viewportSize = lastViewportSizeRef.current;
          if (
            viewportSize &&
            (viewportSize.cols !== initialSize.cols || viewportSize.rows !== initialSize.rows)
          ) {
            void terminal.resize({ sessionId: session.sessionId, ...viewportSize }).catch(() => {});
          }
          return;
        } catch (error) {
          const owningTab = useTerminalStore
            .getState()
            .getDirectoryState(directory)
            ?.tabs.find((entry) => entry.id === tabId);
          if (!owningTab || owningTab.terminalSessionId) return;

          setConnecting(directory, tabId, false);
          if (directoryRef.current !== directory || activeTabIdRef.current !== tabId) return;
          setConnectionError(
            error instanceof Error ? error.message : 'Failed to start terminal session',
          );
          setIsFatalError(true);
          setIsReconnectPending(false);
          return;
        } finally {
          pendingTerminalCreatesRef.current.delete(createKey);
        }
      }

      if (!terminalId || cancelled) return;
      terminalIdRef.current = terminalId;
    };

    void ensureSession();

    return () => {
      cancelled = true;
    };
  }, [
    hasActiveContext,
    effectiveDirectory,
    terminalSessionId,
    terminalLifecycle,
    activeTabId,
    hasOpenedTerminalViewport,
    enableTabs,
    terminalHydrated,
    ensureDirectory,
    setConnecting,
    setTabLifecycle,
    setTabSessionId,
    terminal,
    terminalLoginShell,
    terminalShell,
    terminalAppearanceRef,
  ]);

  return {
    connectionError,
    setConnectionError,
    isFatalError,
    setIsFatalError,
    isReconnectPending,
    setIsReconnectPending,
    terminalIdRef,
    lastViewportSizeRef,
    directoryRef,
    activeTabIdRef,
    disconnectStream,
    resetTerminalPreviewScan,
    startStream,
  };
}
