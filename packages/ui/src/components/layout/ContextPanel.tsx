import React from 'react';
import { ContextPanelBrowserPane } from './context-panel/BrowserPane';
import { EditorTreeColumn } from './context-panel/EditorTreeColumn';
import { PreviewPane } from './context-panel/PreviewPane';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { DiffViewIcon } from '@/components/icons/DiffIcon';
import { Button } from '@/components/ui/button';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { TerminalView } from '@/components/views/TerminalView';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';

// Heavy views stay on-demand (same as MainLayout): importing DiffView/FilesView
// or the walkthrough statically pulls the CodeMirror and @pierre/diffs stacks
// into the eager startup graph even when no such tab is open.
const DiffView = lazyWithChunkRecovery(() => import('@/components/views/DiffView').then((m) => ({ default: m.DiffView })));
const FilesView = lazyWithChunkRecovery(() => import('@/components/views/FilesView').then((m) => ({ default: m.FilesView })));
const GitView = lazyWithChunkRecovery(() => import('@/components/views/GitView').then((m) => ({ default: m.GitView })));
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { cn } from '@/lib/utils';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore, type ContextPanelMode, type PendingDiffScope } from '@/stores/useUIStore';
import { getGitRailPresentation } from '@/lib/surfaces/registry';
import { useIsGitRepo } from '@/stores/useGitStore';
import { ContextPanelContent } from './ContextSidebarTab';
import { Icon } from "@/components/icon/Icon";
import { CONTEXT_SURFACE_DEFAULT_WIDTH_FRACTION } from '@/lib/surfaces/registry';
import { isTerminalEventTarget } from '@/lib/terminalFocus';
import { normalizeDirectoryPathKey } from '@/lib/directoryPathKey';

const CONTEXT_PANEL_MIN_WIDTH = 380;
const CONTEXT_PANEL_MAX_WIDTH = 1400;
const CONTEXT_PANEL_DEFAULT_WIDTH = 600;
const RESIZE_FOLLOW_INTERVAL_MS = 100;
const CONTEXT_TAB_LABEL_MAX_CHARS = 24;

const clampWidth = (width: number): number => {
  if (!Number.isFinite(width)) {
    return CONTEXT_PANEL_DEFAULT_WIDTH;
  }

  return Math.min(CONTEXT_PANEL_MAX_WIDTH, Math.max(CONTEXT_PANEL_MIN_WIDTH, Math.round(width)));
};

const getAvailablePanelWidth = (panel: HTMLElement | null): number | null => {
  const parentWidth = panel?.parentElement?.clientWidth;
  if (!parentWidth || parentWidth <= 0) {
    return null;
  }

  return parentWidth;
};

const getRelativePathLabel = (filePath: string | null, directory: string): string => {
  if (!filePath) {
    return '';
  }
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedDir = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedDir && normalizedFile.startsWith(normalizedDir + '/')) {
    return normalizedFile.slice(normalizedDir.length + 1);
  }
  return normalizedFile;
};

const getModeLabel = (mode: ContextPanelMode, isGitRepo: boolean | null = null): string => {
  if (mode === 'file') return "Files";
  if (mode === 'diff') return "Changes";
  if (mode === 'preview') return "Preview";
  if (mode === 'browser') return "Browser";
  if (mode === 'git') return getGitRailPresentation(isGitRepo).label;
  if (mode === 'terminal') return "Terminal";
  return "Context";
};

const getFileNameFromPath = (path: string | null): string | null => {
  if (!path) {
    return null;
  }

  const normalized = path.replace(/\\/g, '/').trim();
  if (!normalized) {
    return null;
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return normalized;
  }

  return segments[segments.length - 1] || null;
};

const getTabLabel = (
  tab: { mode: ContextPanelMode; label: string | null; targetPath: string | null; stagedDiff?: boolean },
  isGitRepo: boolean | null = null,
): string => {

  if (tab.label) {
    return tab.label;
  }

  if (tab.mode === 'file') {
    return getFileNameFromPath(tab.targetPath) || "Files";
  }

  if (tab.mode === 'preview') {
    const url = tab.targetPath;
    if (url) {
      try {
        const parsed = new URL(url);
        return parsed.host || parsed.hostname || "Preview";
      } catch {
        // ignore invalid URL
      }
    }
    return "Preview";
  }

  if (tab.mode === 'diff') {
    return "Changes";
  }

  return getModeLabel(tab.mode, isGitRepo);
};

const getTabIcon = (tab: { mode: ContextPanelMode; targetPath: string | null }, isGitRepo: boolean | null = null): React.ReactNode | undefined => {
  if (tab.mode === 'file') {
    return tab.targetPath
      ? <FileTypeIcon filePath={tab.targetPath} className="h-3.5 w-3.5" />
      : undefined;
  }

  if (tab.mode === 'diff') {
    return <DiffViewIcon className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'git') {
    return <Icon name={getGitRailPresentation(isGitRepo).icon} className="h-3.5 w-3.5" />;
  }


  if (tab.mode === 'terminal') {
    return <Icon name="terminal-box" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'context') {
    return <Icon name="donut-chart-fill" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'preview') {
    return <Icon name="global" className="h-3.5 w-3.5 text-[var(--status-info)]" />;
  }

  if (tab.mode === 'browser') {
    return <Icon name="global" className="h-3.5 w-3.5" />;
  }

  return undefined;
};

const truncateTabLabel = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3)}...`;
};

export const ContextPanel: React.FC = () => {
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const directoryKey = React.useMemo(() => normalizeDirectoryPathKey(effectiveDirectory), [effectiveDirectory]);

  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const closeContextPanel = useUIStore((state) => state.closeContextPanel);
  const closeContextPanelTab = useUIStore((state) => state.closeContextPanelTab);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const toggleContextPanelExpanded = useUIStore((state) => state.toggleContextPanelExpanded);
  const setContextPanelWidth = useUIStore((state) => state.setContextPanelWidth);
  const setActiveContextPanelTab = useUIStore((state) => state.setActiveContextPanelTab);
  const reorderContextPanelTabs = useUIStore((state) => state.reorderContextPanelTabs);
  const setSelectedFilePath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const openContextPreview = useUIStore((state) => state.openContextPreview);
  const contextEditorTreeVisible = useUIStore((state) => state.contextEditorTreeVisible);
  const toggleContextEditorTree = useUIStore((state) => state.toggleContextEditorTree);

  const tabs = React.useMemo(() => panelState?.tabs ?? [], [panelState?.tabs]);
  const activeTab = tabs.find((tab) => tab.id === panelState?.activeTabId) ?? tabs[tabs.length - 1] ?? null;
  const isOpen = Boolean(panelState?.isOpen && activeTab);
  const isExpanded = Boolean(isOpen && panelState?.expanded);
  const [availablePanelAreaWidth, setAvailablePanelAreaWidth] = React.useState<number | null>(null);
  const manualWidth = panelState?.width;
  const widthFraction = CONTEXT_SURFACE_DEFAULT_WIDTH_FRACTION;
  const widthFallbackBase = availablePanelAreaWidth
    ?? (typeof window !== 'undefined' ? window.innerWidth : CONTEXT_PANEL_DEFAULT_WIDTH * 2);
  const width = clampWidth(manualWidth ?? Math.round(widthFraction * widthFallbackBase));
  const isGitRepo = useIsGitRepo(directoryKey || null);

  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const resizingWidthRef = React.useRef<number | null>(null);
  const activeResizePointerIDRef = React.useRef<number | null>(null);
  const panelRef = React.useRef<HTMLElement | null>(null);
  const wasOpenRef = React.useRef(false);

  // Tracks the panel area width so fraction-based surface defaults stay
  // proportional as the window resizes; manual widths remain fixed px.
  React.useLayoutEffect(() => {
    const parent = panelRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      setAvailablePanelAreaWidth(parent.clientWidth || null);
    });
    observer.observe(parent);
    setAvailablePanelAreaWidth(parent.clientWidth || null);

    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (!isOpen || wasOpenRef.current) {
      wasOpenRef.current = isOpen;
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.focus({ preventScroll: true });
    });

    wasOpenRef.current = true;
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  // Deferred resize: reflowing the chat column and the active surface on every
  // drag frame is unavoidably janky,
  // so during the drag only a ghost guide line follows the pointer and the
  // real width is applied once on release (riding the width transition).
  const resizeAvailableWidthRef = React.useRef<number | null>(null);
  // The panel content follows the guide line lazily: the real width is
  // re-applied at most every RESIZE_FOLLOW_INTERVAL_MS and the standing
  // 200ms width transition smooths each step, VS Code-style.
  const resizeFollowTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyFollowWidth = React.useCallback(() => {
    resizeFollowTimerRef.current = null;
    const panel = panelRef.current;
    const next = resizingWidthRef.current;
    if (!panel || next === null) {
      return;
    }
    panel.style.setProperty('--oc-context-panel-width', `${next}px`);
  }, []);

  React.useEffect(() => () => {
    if (resizeFollowTimerRef.current !== null) {
      clearTimeout(resizeFollowTimerRef.current);
    }
  }, []);

  const clampWidthForDrag = React.useCallback((nextWidth: number) => {
    const clamped = clampWidth(nextWidth);
    const available = resizeAvailableWidthRef.current;
    return available === null ? clamped : Math.min(clamped, Math.max(1, available));
  }, []);

  const handleResizeStart = React.useCallback((event: React.PointerEvent) => {
    if (!isOpen || isExpanded || !directoryKey) {
      return;
    }

    activeResizePointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    resizingWidthRef.current = width;
    // Measure once per drag; no layout reads happen during pointermove.
    resizeAvailableWidthRef.current = getAvailablePanelWidth(panelRef.current);
    document.documentElement.style.cursor = 'col-resize';
    event.preventDefault();
  }, [directoryKey, isExpanded, isOpen, width]);

  const finishResize = React.useCallback(() => {
    // Apply the final width once, letting the regular 200ms width transition
    // carry the panel to the release position.
    const finalWidth = clampWidthForDrag(resizingWidthRef.current ?? width);
    resizingWidthRef.current = null;
    resizeAvailableWidthRef.current = null;
    if (resizeFollowTimerRef.current !== null) {
      clearTimeout(resizeFollowTimerRef.current);
      resizeFollowTimerRef.current = null;
    }
    document.documentElement.style.cursor = '';
    if (directoryKey) {
      setContextPanelWidth(directoryKey, finalWidth);
    }
    setIsResizing(false);
    activeResizePointerIDRef.current = null;
  }, [clampWidthForDrag, directoryKey, setContextPanelWidth, width]);

  // Window-level drag listeners: tracking the pointer via the 3px handle and
  // pointer capture is unreliable (capture can fail over iframes and a missed
  // pointerup leaves the drag stuck), so while resizing the whole window
  // tracks the pointer and any release/cancel/blur ends the drag.
  React.useEffect(() => {
    if (!isResizing) {
      return;
    }

    const handleMove = (event: PointerEvent) => {
      if (activeResizePointerIDRef.current !== event.pointerId) {
        return;
      }
      const delta = startXRef.current - event.clientX;
      const nextWidth = clampWidthForDrag(startWidthRef.current + delta);
      if (resizingWidthRef.current === nextWidth) {
        return;
      }
      resizingWidthRef.current = nextWidth;
      if (resizeFollowTimerRef.current === null) {
        resizeFollowTimerRef.current = setTimeout(applyFollowWidth, RESIZE_FOLLOW_INTERVAL_MS);
      }
    };

    const handleUp = (event: PointerEvent) => {
      if (activeResizePointerIDRef.current !== event.pointerId) {
        return;
      }
      finishResize();
    };

    const handleWindowBlur = () => {
      finishResize();
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [applyFollowWidth, clampWidthForDrag, finishResize, isResizing]);

  React.useEffect(() => {
    if (!isResizing) {
      resizingWidthRef.current = null;
      document.documentElement.style.cursor = '';
    }
  }, [isResizing]);

  const handleClose = React.useCallback(() => {
    if (!directoryKey) {
      return;
    }
    closeContextPanel(directoryKey);
  }, [closeContextPanel, directoryKey]);

  const handleToggleExpanded = React.useCallback(() => {
    if (!directoryKey) {
      return;
    }
    toggleContextPanelExpanded(directoryKey);
  }, [directoryKey, toggleContextPanelExpanded]);

  const handlePanelKeyDownCapture = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') {
      return;
    }

    // Terminal owns Escape so the PTY receives it (e.g. Vim Normal mode).
    // xterm.js listens in the bubble phase; stopping capture here would
    // swallow the key before the terminal ever sees it (issue #2644).
    if (isTerminalEventTarget(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    handleClose();
  }, [handleClose]);

  React.useEffect(() => {
    if (!directoryKey || !activeTab) {
      return;
    }

    if (activeTab.mode === 'file' && activeTab.targetPath) {
      setSelectedFilePath(directoryKey, activeTab.targetPath, { allowOutsideRoot: true });
      return;
    }

  }, [activeTab, directoryKey, setSelectedFilePath]);

  const handleDiffScopeChange = React.useCallback((nextScope: PendingDiffScope) => {
    if (!directoryKey || activeTab?.mode !== 'diff') {
      return;
    }

    openContextPanelTab(directoryKey, {
      mode: 'diff',
      targetPath: activeTab.targetPath,
      stagedDiff: nextScope === 'staged',
      diffScope: nextScope,
    });
  }, [activeTab, directoryKey, openContextPanelTab]);

  // The rail switches between surfaces. The in-panel strip lists instances of
  // the active multi-instance surface, such as open files and preview targets.
  const isMultiInstanceMode = activeTab?.mode === 'file' || activeTab?.mode === 'preview';
  const activeModeTabs = React.useMemo(
    () => (activeTab ? tabs.filter((tab) => tab.mode === activeTab.mode) : []),
    [activeTab, tabs],
  );

  const tabItems = React.useMemo(() => activeModeTabs.map((tab) => {
    const rawLabel = getTabLabel(tab, isGitRepo);
    const label = truncateTabLabel(rawLabel, CONTEXT_TAB_LABEL_MAX_CHARS);
    const tabPathLabel = getRelativePathLabel(tab.targetPath, effectiveDirectory);
    return {
      id: tab.id,
      label,
      icon: getTabIcon(tab, isGitRepo),
      title: tabPathLabel ? `${rawLabel}: ${tabPathLabel}` : rawLabel,
      closeLabel: `Close ${label} tab`,
    };
  }), [activeModeTabs, effectiveDirectory, isGitRepo]);

  const activeContent = activeTab?.mode === 'context'
        ? <ContextPanelContent />
        : activeTab?.mode === 'git'
            ? <React.Suspense fallback={null}><GitView isActive={isOpen} /></React.Suspense>
            : activeTab?.mode === 'preview'
                ? <PreviewPane rawUrl={activeTab.targetPath ?? ''} onNavigate={(url) => openContextPreview(effectiveDirectory, url)} />
                : (
                  <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                    <Icon name="global" className="h-12 w-12 text-muted-foreground/50" />
                    <div className="typography-ui-header text-foreground">{"Preview"}</div>
                    <div className="max-w-sm typography-micro text-muted-foreground">{"Use Project Actions or a terminal Preview button to open a preview."}</div>
                  </div>
                );

  const browserTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'browser'),
    [tabs],
  );
  const diffTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'diff'),
    [tabs],
  );
  const hasTerminalTab = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'terminal'),
    [tabs],
  );
  const hasFileTabs = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'file'),
    [tabs],
  );
  const hasOpenEditorFile = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'file' && tab.targetPath),
    [tabs],
  );

  const isFileTabActive = activeTab?.mode === 'file';

  const header = (
    <header className="flex h-10 items-stretch border-b border-border">
      {isMultiInstanceMode ? (
        <SortableTabsStrip
          items={tabItems}
          activeId={activeTab?.id ?? null}
          onSelect={(tabID) => {
            if (!directoryKey) {
              return;
            }
            setActiveContextPanelTab(directoryKey, tabID);
          }}
          onClose={(tabID) => {
            if (!directoryKey) {
              return;
            }
            closeContextPanelTab(directoryKey, tabID);
          }}
          onReorder={(activeTabID, overTabID) => {
            if (!directoryKey) {
              return;
            }
            reorderContextPanelTabs(directoryKey, activeTabID, overTabID);
          }}
          layoutMode="scrollable"
          variant="default"
        />
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-3">
          {activeTab ? getTabIcon(activeTab, isGitRepo) : null}
          <span className="truncate typography-ui-label text-foreground">
            {activeTab ? getModeLabel(activeTab.mode, isGitRepo) : null}
          </span>
        </div>
      )}
      <div className="flex items-center gap-1 px-1.5">
        {isFileTabActive ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={toggleContextEditorTree}
            className="h-7 w-7 p-0"
            title={"Toggle file tree"}
            aria-label={"Toggle file tree"}
            aria-pressed={contextEditorTreeVisible}
          >
            <Icon name="layout-right" className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleToggleExpanded}
          className="h-7 w-7 p-0"
          title={isExpanded ? "Collapse panel" : "Expand panel"}
          aria-label={isExpanded ? "Collapse panel" : "Expand panel"}
        >
          {isExpanded ? <Icon name="fullscreen-exit" className="h-3.5 w-3.5" /> : <Icon name="fullscreen" className="h-3.5 w-3.5" />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleClose}
          className="h-7 w-7 p-0"
          title={"Close panel"}
          aria-label={"Close panel"}
        >
          <Icon name="close" className="h-3.5 w-3.5" />
        </Button>
      </div>
    </header>
  );

  // width/min/max stay interpolable across open/close (no instant min/max
  // jumps) so the 200ms width transition matches the sidebars.
  const panelStyle: React.CSSProperties = !isOpen
    ? {
        ['--oc-context-panel-width' as string]: `${width}px`,
        width: 0,
        maxWidth: '100%',
        overflowX: 'clip',
      }
    : isExpanded
      ? {
          // px, not '100%': px↔% width changes do not interpolate, which
          // would make the expand/collapse width snap instead of animating.
          ['--oc-context-panel-width' as string]: availablePanelAreaWidth !== null ? `${availablePanelAreaWidth}px` : '100%',
          width: availablePanelAreaWidth !== null ? `${availablePanelAreaWidth}px` : '100%',
          maxWidth: '100%',
        }
      : {
          width: 'min(var(--oc-context-panel-width), 100%)',
          maxWidth: '100%',
          overflowX: 'clip',
          ['--oc-context-panel-width' as string]: `${width}px`,
        };

  return (
    <aside
      ref={panelRef}
      data-context-panel="true"
      tabIndex={-1}
      inert={!isOpen || undefined}
      className={cn(
        'flex min-h-0 flex-col overflow-hidden bg-background',
        // Right-anchored while expanded: `inset-0` would teleport the left
        // edge instantly (position does not transition), so only the width
        // animates and the panel grows leftwards from its docked position.
        isExpanded
          ? 'absolute inset-y-0 right-0 z-20 min-w-0'
          : 'relative h-full flex-shrink-0',
        !isOpen && 'pointer-events-none',
        'will-change-[width] motion-reduce:transition-none',
        'transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]'
      )}
      onKeyDownCapture={handlePanelKeyDownCapture}
      style={panelStyle}
    >
      {/* Painted divider instead of border-l: a real border eats 1px of the
          content box only while collapsed, shifting the header controls by
          1px between the collapsed and expanded states. */}
      {isOpen && !isExpanded && (
        <div aria-hidden="true" className="absolute left-0 top-0 z-40 h-full w-px bg-border" />
      )}
      {/* Divider between the panel and the icon rail on its right. */}
      {isOpen && (
        <div aria-hidden="true" className="absolute right-0 top-0 z-40 h-full w-px bg-border" />
      )}
      {!isExpanded && (
        <div
          className={cn(
            'absolute left-0 top-0 z-50 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
            isResizing && 'bg-[var(--interactive-border)]'
          )}
          onPointerDown={handleResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label={"Resize context panel"}
        />
      )}
      <div
        className={cn(
          'relative z-10 flex h-full min-h-0 shrink-0 flex-col duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
          // Width animates in sync with the panel (surface switches, resize
          // release); during the drag itself nothing resizes — only the ghost
          // guide line moves.
          'transition-[width,opacity]',
          !isOpen && 'pointer-events-none select-none opacity-0'
        )}
        // px in the expanded state too: px↔% width changes cannot interpolate,
        // so the header controls would snap instead of riding the animation.
        style={{
          width: isExpanded
            ? (availablePanelAreaWidth !== null ? `${availablePanelAreaWidth}px` : '100%')
            : 'var(--oc-context-panel-width)',
        }}
        aria-hidden={!isOpen}
      >
      {header}
      <div className={cn('relative min-h-0 flex-1 overflow-hidden', isResizing && 'pointer-events-none')}>
        {hasFileTabs ? (
          <div className={cn('absolute inset-0 flex', isFileTabActive ? 'flex' : 'hidden')}>
            <div className="h-full min-w-0 flex-1">
              {hasOpenEditorFile ? (
                <React.Suspense fallback={null}><FilesView mode="editor-only" /></React.Suspense>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                  <Icon name="file-code" className="h-12 w-12 text-muted-foreground/50" />
                  <div className="typography-ui-header text-foreground">{"No file open"}</div>
                  <div className="max-w-sm typography-micro text-muted-foreground">{"Pick a file from the tree to start editing."}</div>
                </div>
              )}
            </div>
            <EditorTreeColumn visible={contextEditorTreeVisible} />
          </div>
        ) : null}
        {browserTabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              'absolute inset-0',
              activeTab?.id !== tab.id && 'hidden'
            )}
          >
            <ContextPanelBrowserPane initialUrl={tab.targetPath ?? ''} directory={directoryKey} tabID={tab.id} />
          </div>
        ))}
        {isOpen ? diffTabs.filter((tab) => activeTab?.id === tab.id).map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
          >
            <React.Suspense fallback={null}>
              <DiffView
                hideStackedFileSidebar
                stackedDefaultCollapsedAll
                pinSelectedFileHeaderToTopOnNavigate
                showOpenInEditorAction
                diffScope={tab.diffScope ?? (tab.stagedDiff ? 'staged' : 'working')}
                onDiffScopeChange={handleDiffScopeChange}
                targetFilePath={tab.targetPath}
                flushContent
              />
            </React.Suspense>
          </div>
        )) : null}
        {hasTerminalTab ? (
          <div className={cn('absolute inset-0', activeTab?.mode === 'terminal' ? 'block' : 'hidden')}>
            <TerminalView visible={isOpen && activeTab?.mode === 'terminal'} />
          </div>
        ) : null}
        {isOpen && !isFileTabActive && activeTab?.mode !== 'browser' && activeTab?.mode !== 'diff' && activeTab?.mode !== 'terminal' ? activeContent : null}
      </div>
      </div>
    </aside>
  );
};
