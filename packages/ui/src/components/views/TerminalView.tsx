import React from 'react';

import { useSessionUIStore } from '@/sync/session-ui-store';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { CODE_FONT_OPTION_MAP, DEFAULT_MONO_FONT } from '@/lib/fontOptions';
import { convertThemeToXterm } from '@/lib/terminalTheme';
import { TerminalTabPane } from './terminal/TerminalTabPane';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { Icon } from '@/components/icon/Icon';
import { useDeviceInfo } from '@/lib/device';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { PROJECT_ACTION_ICON_MAP, type ProjectActionIconKey } from '@/lib/projectActions';
import { TerminalQuickKeys } from './terminal/TerminalQuickKeys';
import { useTerminalSessionStream } from './terminal/useTerminalSessionStream';
import { useTerminalInputHandling } from './terminal/useTerminalInputHandling';
import { useTerminalTabsManager } from './terminal/useTerminalTabsManager';

type TerminalViewProps = {
  visible?: boolean;
  /** Main-view host only: shows a close button that exits the full-page terminal overlay. */
  onCloseView?: () => void;
};

export const TerminalView: React.FC<TerminalViewProps> = ({ visible, onCloseView }) => {
  const { terminal, runtime } = useRuntimeAPIs();
  const { currentTheme } = useThemeSystem();
  const terminalAppearanceRef = React.useRef<{
    themeMode: 'light' | 'dark';
    terminalBackground: string;
    terminalForeground: string;
  }>({
    themeMode: 'dark',
    terminalBackground: '',
    terminalForeground: '',
  });
  terminalAppearanceRef.current = {
    themeMode: currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
    terminalBackground: currentTheme.colors.surface.background,
    terminalForeground: currentTheme.colors.syntax.base.foreground,
  };
  const { monoFont } = useFontPreferences();
  const terminalFontSize = useUIStore((state) => state.terminalFontSize);
  const terminalShell = useUIStore((state) => state.terminalShell);
  const terminalLoginShell = useUIStore((state) => state.terminalLoginShells.includes(state.terminalShell));
  const { isMobile, isTablet, hasTouchOnlyPointer } = useDeviceInfo();
  const isTouchTerminal = isMobile || isTablet;
  const useTouchTerminalInput = (isTouchTerminal || hasTouchOnlyPointer) && runtime.platform === 'web';
  const enableTabs = true;
  const showTerminalQuickKeysOnDesktop = useUIStore((state) => state.showTerminalQuickKeysOnDesktop);
  const showQuickKeys = isTouchTerminal || showTerminalQuickKeysOnDesktop;

  const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
  const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
  const hasActiveContext = currentSessionId !== null || newSessionDraft?.open === true;

  const effectiveDirectory = useEffectiveDirectory() ?? null;
  const directoryTerminalState = useTerminalStore((s) =>
    effectiveDirectory ? s.sessions.get(effectiveDirectory) : undefined,
  );
  const terminalHydrated = useTerminalStore((s) => s.hasHydrated);

  const openContextPreview = useUIStore((state) => state.openContextPreview);

  const activeTabId = React.useMemo(() => {
    if (!directoryTerminalState) return null;
    if (enableTabs) {
      return directoryTerminalState.activeTabId ?? directoryTerminalState.tabs[0]?.id ?? null;
    }
    return directoryTerminalState.tabs[0]?.id ?? null;
  }, [directoryTerminalState, enableTabs]);

  const activeTab = React.useMemo(() => {
    if (!directoryTerminalState) return undefined;
    if (!activeTabId) return directoryTerminalState.tabs[0];
    return directoryTerminalState.tabs.find((tab) => tab.id === activeTabId) ?? directoryTerminalState.tabs[0];
  }, [directoryTerminalState, activeTabId]);

  const terminalTabItems = React.useMemo(() => {
    return (directoryTerminalState?.tabs ?? []).map((tab) => ({
      icon: (() => {
        const tabIconName = tab.iconKey
          ? PROJECT_ACTION_ICON_MAP[tab.iconKey as ProjectActionIconKey] ?? 'terminal'
          : 'terminal';
        return <Icon name={tabIconName} className="h-4 w-4" />;
      })(),
      id: tab.id,
      label: tab.label,
      title: tab.label,
      closeLabel: 'Close tab',
    }));
  }, [directoryTerminalState?.tabs]);

  const terminalSessionId = activeTab?.terminalSessionId ?? null;
  const terminalLifecycle = activeTab?.lifecycle ?? 'idle';
  const streamTabs = React.useMemo(
    () =>
      (directoryTerminalState?.tabs ?? []).map((tab) => ({
        id: tab.id,
        terminalSessionId: tab.terminalSessionId,
        label: tab.label,
      })),
    [directoryTerminalState?.tabs],
  );
  const isConnecting = activeTab?.isConnecting ?? false;
  const previewUrl = activeTab?.previewUrl ?? null;

  const activeMainTab = useUIStore((state) => state.activeMainTab);
  const isTerminalActive = activeMainTab === 'terminal';
  const isTerminalVisible = visible ?? isTerminalActive;
  const [hasOpenedTerminalViewport, setHasOpenedTerminalViewport] = React.useState(isTerminalVisible);

  React.useEffect(() => {
    if (isTerminalVisible) {
      setHasOpenedTerminalViewport(true);
    }
  }, [isTerminalVisible]);

  const {
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
    resetTerminalPreviewScan,
    startStream,
  } = useTerminalSessionStream({
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
    tabs: streamTabs,
    focusTerminalWhenWindowActive: () => {
      if (!useTouchTerminalInput && typeof document !== 'undefined' && document.hasFocus()) {
        terminalControllerRef.current?.focus();
      }
    },
  });

  const {
    activeModifier,
    terminalControllerRef,
    focusTerminalWhenWindowActive,
    handleViewportInput,
    handleModifierToggle,
    handleMobileKeyPress,
  } = useTerminalInputHandling({
    terminal,
    terminalIdRef,
    isReconnectPending,
    setConnectionError,
    showQuickKeys,
    isTerminalVisible,
    lastViewportSizeRef,
    terminalSessionId,
    useTouchTerminalInput,
  });

  const { isRestarting, handleRestart, handleHardRestart, handleCreateTab, handleSelectTab, handleCloseTab } =
    useTerminalTabsManager({
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
      resetTerminalPreviewScan,
      startStream,
      setConnectionError,
      setIsFatalError,
      setIsReconnectPending,
    });

  React.useEffect(() => {
    if (!isTerminalVisible || useTouchTerminalInput) {
      return;
    }

    if (typeof window === 'undefined') {
      focusTerminalWhenWindowActive();
      return;
    }

    const rafId = window.requestAnimationFrame(() => {
      focusTerminalWhenWindowActive();
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [activeTabId, focusTerminalWhenWindowActive, isTerminalVisible, useTouchTerminalInput]);

  const resolvedFontStack = React.useMemo(() => {
    const defaultStack = CODE_FONT_OPTION_MAP[DEFAULT_MONO_FONT].stack;
    if (typeof window === 'undefined') {
      const fallbackDefinition = CODE_FONT_OPTION_MAP[monoFont] ?? CODE_FONT_OPTION_MAP[DEFAULT_MONO_FONT];
      return fallbackDefinition.stack;
    }

    const root = window.getComputedStyle(document.documentElement);
    const cssStack = root.getPropertyValue('--font-family-mono');
    if (cssStack && cssStack.trim().length > 0) {
      return cssStack.trim();
    }

    const definition = CODE_FONT_OPTION_MAP[monoFont] ?? CODE_FONT_OPTION_MAP[DEFAULT_MONO_FONT];
    return definition.stack ?? defaultStack;
  }, [monoFont]);

  const xtermTheme = React.useMemo(() => convertThemeToXterm(currentTheme), [currentTheme]);
  const activeViewportKey = `${effectiveDirectory ?? 'no-dir'}::${activeTabId ?? 'no-tab'}`;

  React.useEffect(() => {
    if (!isTerminalVisible || useTouchTerminalInput) {
      return;
    }
    const controller = terminalControllerRef.current;
    if (!controller) {
      return;
    }
    const fitOnce = () => {
      controller.fit();
    };
    if (typeof window !== 'undefined') {
      const rafId = window.requestAnimationFrame(() => {
        fitOnce();
        focusTerminalWhenWindowActive();
      });
      const timeoutIds = [220, 400].map((delay) => window.setTimeout(fitOnce, delay));
      return () => {
        window.cancelAnimationFrame(rafId);
        timeoutIds.forEach((id) => window.clearTimeout(id));
      };
    }
    fitOnce();
  }, [focusTerminalWhenWindowActive, isTerminalVisible, useTouchTerminalInput, terminalControllerRef, activeViewportKey, terminalSessionId]);

  React.useEffect(() => {
    if (!isTerminalVisible || !useTouchTerminalInput) return;
    let fitFrame: number | null = null;
    const handleKeyboardSettled = () => {
      if (fitFrame !== null) window.cancelAnimationFrame(fitFrame);
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = null;
        terminalControllerRef.current?.fit();
      });
    };
    window.addEventListener('oc:keyboard-settled', handleKeyboardSettled);
    return () => {
      window.removeEventListener('oc:keyboard-settled', handleKeyboardSettled);
      if (fitFrame !== null) window.cancelAnimationFrame(fitFrame);
    };
  }, [isTerminalVisible, terminalControllerRef, activeViewportKey, useTouchTerminalInput]);

  if (!hasActiveContext) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
        {'Select a session to open the terminal.'}
      </div>
    );
  }

  if (!effectiveDirectory) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
        <p>{'No working directory available for this session.'}</p>
        <button
          onClick={handleRestart}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          {'Retry'}
        </button>
      </div>
    );
  }

  const quickKeysDisabled = !terminalSessionId || isConnecting || isRestarting || isReconnectPending;
  const shouldRenderViewport = hasOpenedTerminalViewport;
  const quickKeysControls = (
    <TerminalQuickKeys
      isTouchTerminal={isTouchTerminal}
      activeModifier={activeModifier}
      disabled={quickKeysDisabled}
      onKeyPress={handleMobileKeyPress}
      onModifierToggle={handleModifierToggle}
    />
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--surface-background)]">
      <div
        className={cn(
          'app-region-no-drag sticky top-0 z-20 shrink-0 bg-[var(--surface-background)] text-xs',
          isTouchTerminal ? 'px-3 py-1.5' : 'pl-3 pr-1.5 py-1',
        )}
      >
        {enableTabs && directoryTerminalState ? (
          <div className="flex items-center gap-2 pl-1 pr-1">
            <div className={cn('min-w-0 flex-1', isTouchTerminal ? 'h-8' : 'h-7')}>
              <SortableTabsStrip
                items={terminalTabItems}
                activeId={activeTabId}
                onSelect={handleSelectTab}
                onClose={handleCloseTab}
                layoutMode="scrollable"
                variant="default"
                className="h-full bg-transparent"
              />
            </div>

            <Button
              type="button"
              size="xs"
              variant="ghost"
              className={cn('shrink-0', isTouchTerminal ? 'h-8 w-8 p-0' : 'h-7 w-7 p-0')}
              onClick={handleCreateTab}
              title={'New tab'}
            >
              <Icon name="add" className={`${isTouchTerminal ? 'h-[18px] w-[18px]' : 'h-4 w-4'}`} />
            </Button>

            <div className="flex shrink-0 items-center gap-1 overflow-visible">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="h-7 w-7 p-0"
                onClick={() => void handleRestart()}
                disabled={isRestarting}
                title={'Restart terminal'}
                aria-label={'Restart terminal'}
              >
                <Icon name="restart" className="h-4 w-4" />
              </Button>
              {onCloseView ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  onClick={onCloseView}
                  title={'Close terminal view'}
                  aria-label={'Close terminal view'}
                >
                  <Icon name="close" className="h-4 w-4" />
                </Button>
              ) : null}
              {previewUrl ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="h-6 shrink-0 gap-1 px-2"
                  onClick={() => {
                    if (!effectiveDirectory) return;
                    openContextPreview(effectiveDirectory, previewUrl);
                  }}
                  title={'Open preview pane'}
                >
                  <Icon name="global" className="h-3.5 w-3.5 shrink-0" />
                  <span className="whitespace-nowrap">{'Preview'}</span>
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {!isTouchTerminal && showQuickKeys && enableTabs && directoryTerminalState ? (
          <div className="mt-2 flex flex-wrap items-center gap-1 pl-1 pr-1">{quickKeysControls}</div>
        ) : null}

        {!isTouchTerminal && showQuickKeys && (!enableTabs || !directoryTerminalState) ? (
          <div className="mt-2 flex flex-wrap items-center gap-1">{quickKeysControls}</div>
        ) : null}
      </div>

      <div className="relative flex-1 overflow-hidden" style={{ backgroundColor: xtermTheme.background }}>
        <div className="h-full w-full box-border pl-4 pr-1.5 pt-3 pb-4">
          {shouldRenderViewport && effectiveDirectory && directoryTerminalState
            ? directoryTerminalState.tabs.map((tab) => {
                const paneActive = tab.id === activeTabId;
                return (
                  <TerminalTabPane
                    key={tab.id}
                    directory={effectiveDirectory}
                    tabId={tab.id}
                    sessionId={tab.terminalSessionId}
                    sessionKey={`${effectiveDirectory}::${tab.id}`}
                    isActive={paneActive}
                    isTerminalVisible={isTerminalVisible}
                    terminal={terminal}
                    theme={xtermTheme}
                    fontFamily={resolvedFontStack}
                    fontSize={terminalFontSize}
                    enableTouchScroll={useTouchTerminalInput}
                    lastViewportSizeRef={lastViewportSizeRef}
                    onInput={handleViewportInput}
                    controllerRef={terminalControllerRef}
                  />
                );
              })
            : null}
        </div>
        {!isReconnectPending && connectionError && (
          <div className="absolute inset-x-0 bottom-0 bg-[var(--status-error-background)] px-3 py-2 text-xs text-[var(--status-error-foreground)] flex items-center justify-between gap-2">
            <span>{connectionError}</span>
            {isFatalError && isTouchTerminal && (
              <Button
                size="sm"
                variant="secondary"
                className="h-6 px-2 py-0 text-xs"
                onClick={handleHardRestart}
                disabled={isRestarting}
                title={'Force kill and create fresh session'}
                type="button"
              >
                {'Hard Restart'}
              </Button>
            )}
          </div>
        )}
      </div>
      {isTouchTerminal && showQuickKeys ? (
        <div
          className="shrink-0 overflow-x-auto border-t border-border/40 bg-[var(--surface-background)] px-2 pt-1.5 pb-[max(0.375rem,calc(var(--oc-app-bottom-safe,0px)-var(--oc-keyboard-inset,0px)))] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          data-no-drawer-swipe="true"
        >
          <div className="flex min-w-max items-center gap-1.5">{quickKeysControls}</div>
        </div>
      ) : null}
    </div>
  );
};
