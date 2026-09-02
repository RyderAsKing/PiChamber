import React from 'react';
import { useTerminalStore } from '@/stores/useTerminalStore';
import type { TerminalStreamEvent, TerminalAPI, TerminalError, TerminalShell } from '@/lib/api/types';
import { TerminalPreviewScanner, FALLBACK_TERMINAL_SIZE } from './terminalStreamHelpers';

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
  useTouchTerminalInput,
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
  useTouchTerminalInput: boolean;
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

  const streamCleanupRef = React.useRef<(() => void) | null>(null);
  const activeTerminalIdRef = React.useRef<string | null>(null);
  const activeTabIdRef = React.useRef<string | null>(activeTabId);
  const terminalIdRef = React.useRef<string | null>(terminalSessionId);
  const directoryRef = React.useRef<string | null>(effectiveDirectory);
  const lastViewportSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);
  const pendingTerminalCreatesRef = React.useRef(new Set<string>());
  const previewScannerRef = React.useRef(new TerminalPreviewScanner());

  const resetTerminalPreviewScan = React.useCallback(() => {
    previewScannerRef.current.reset();
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
    resetTerminalPreviewScan();
  }, [activeTabId, resetTerminalPreviewScan]);

  React.useEffect(() => {
    directoryRef.current = effectiveDirectory;
  }, [effectiveDirectory]);

  const disconnectStream = React.useCallback(() => {
    streamCleanupRef.current?.();
    streamCleanupRef.current = null;
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
      previewScannerRef.current.scan(directory, tabId, data, setTabPreviewUrl);
    },
    [setTabPreviewUrl],
  );

  const startStream = React.useCallback(
    (directory: string, tabId: string, terminalId: string) => {
      if (activeTerminalIdRef.current === terminalId) {
        return;
      }

      disconnectStream();
      activeTerminalIdRef.current = terminalId;

      const subscription = terminal.connect(terminalId, {
        onEvent: (event: TerminalStreamEvent) => {
          if (activeTerminalIdRef.current !== terminalId) {
            return;
          }

          switch (event.type) {
            case 'snapshot': {
              setConnecting(directory, tabId, false);
              setConnectionError(null);
              setIsFatalError(false);
              setIsReconnectPending(false);
              focusTerminalWhenWindowActive();

              replaceBuffer(directory, tabId, event.data ?? '', event.sequence ?? 0);
              scanTerminalPreviewOutput(directory, tabId, event.data ?? '');
              if (event.status === 'exited') setTabLifecycle(directory, tabId, 'exited');
              break;
            }
            case 'reconnecting': {
              void event;
              setConnectionError(null);
              setIsFatalError(false);
              setIsReconnectPending(true);
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
              setConnecting(directory, tabId, false);
              setConnectionError(isActionTab ? null : 'Terminal session ended');
              setIsFatalError(false);
              setIsReconnectPending(false);
              disconnectStream();
              break;
            }
          }
        },
        onError: (error: TerminalError, fatal?: boolean) => {
          if (activeTerminalIdRef.current !== terminalId) {
            return;
          }

          if (!fatal) {
            setConnectionError(null);
            setIsFatalError(false);
            return;
          }

          setIsReconnectPending(false);
          if (error.code === 'SESSION_NOT_FOUND') {
            const currentTab = useTerminalStore
              .getState()
              .getDirectoryState(directory)
              ?.tabs.find((tab) => tab.id === tabId);
            if (!currentTab?.label?.startsWith('Action:')) {
              setConnectionError(null);
              setIsFatalError(false);
              setConnecting(directory, tabId, false);
              setTabSessionId(directory, tabId, null);
              setTabLifecycle(directory, tabId, 'idle');
              disconnectStream();
              return;
            }
          }
          setConnectionError(`Connection failed: ${error.message}`);
          setIsFatalError(true);
          setConnecting(directory, tabId, false);
          setTabLifecycle(directory, tabId, 'exited');
          setTabSessionId(directory, tabId, null);
          disconnectStream();
        },
      });

      streamCleanupRef.current = () => {
        subscription.close();
        activeTerminalIdRef.current = null;
      };
    },
    [
      appendToBuffer,
      disconnectStream,
      focusTerminalWhenWindowActive,
      replaceBuffer,
      scanTerminalPreviewOutput,
      setConnecting,
      setTabLifecycle,
      setTabSessionId,
      terminal,
    ],
  );

  React.useEffect(() => {
    let cancelled = false;

    if (!terminalHydrated || !hasOpenedTerminalViewport) {
      return;
    }

    if (!effectiveDirectory) {
      setConnectionError(
        hasActiveContext ? 'No working directory available for terminal.' : 'Select a session to open the terminal.',
      );
      disconnectStream();
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
      const terminalLifecycle = tab?.lifecycle ?? 'idle';
      const isActionTab = Boolean(tab?.label?.startsWith('Action:'));
      const buffer = useTerminalStore.getState().getBuffer(directory, tabId);
      const hasBufferedOutput = buffer.byteLength > 0 || buffer.chunks.length > 0;

      if (!terminalId) {
        if (terminalLifecycle === 'exited') {
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

          const stillActive =
            !cancelled && directoryRef.current === directory && activeTabIdRef.current === tabId;

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
          if (!stillActive) return;

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
      startStream(directory, tabId, terminalId);
    };

    void ensureSession();

    return () => {
      cancelled = true;
      terminalIdRef.current = null;
      disconnectStream();
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
    startStream,
    disconnectStream,
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
