import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';

import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { GoToLineDialog } from './GoToLineDialog';
import { PreviewToggleButton } from './PreviewToggleButton';
import { languageByExtension, loadLanguageByExtension } from '@/lib/codemirror/languageByExtension';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { shikiHighlightExtension } from '@/lib/codemirror/shikiHighlight';
import { getResolvedShikiTheme } from '@/lib/shiki/appThemeRegistry';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useDeviceInfo } from '@/lib/device';
import { cn, getModifierLabel, hasModifier } from '@/lib/utils';
import { getLanguageFromExtension, getImageMimeType, isBinaryFile, isDrawioFile, isImageFile, isPdfFile, isSvgFile } from '@/lib/toolHelpers';
import { shouldAllowFileDraftSave, shouldScheduleFileAutosave } from '@/lib/fileEditorAutosave';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getOutsideFileGrant } from '@/lib/outsideFileGrants';
import { DiagramEditor } from '@/components/diagram/DiagramEditor';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useUIStore } from '@/stores/useUIStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useGitStatus } from '@/stores/useGitStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useTransientValue } from '@/hooks/useTransientValue';
import { Icon } from "@/components/icon/Icon";
import { ensurePierreThemeRegistered } from '@/lib/shiki/appThemeRegistry';
import { getDefaultTheme } from '@/lib/theme/themes';
import { isBrowserClientRuntime, openDesktopFileInApp, openDesktopPath } from '@/lib/desktop';
import { useOpenInAppsStore } from '@/stores/useOpenInAppsStore';
import { eventMatchesShortcut, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { sessionEvents } from '@/lib/sessionEvents';
import { MobileFilesChrome } from './files/MobileFilesChrome';
import { Dialogs } from './files/FilesViewDialogs';
import { FileIcon, FileRow, OpenInAppListIcon, ScrollingFileName, type FileStatus } from './files/FilesViewChrome';
import {
  MAX_VIEW_CHARS,
  getAncestorPaths,
  getDisplayPath,
  getParentDirectoryPath,
  isDirectoryReadError,
  isFileMissingError,
  isHtmlFile,
  isJsonFile,
  isMarkdownFile,
  isPathWithinRoot,
  normalizePath,
  serializeEditorContent,
  toComparablePath,
  type FileLineEnding,
  type FileNode,
  type FileStatSnapshot,
} from './files/filesViewModel';
import { useAssetAuthRefresh } from './files/useAssetAuthRefresh';
import { FileViewerContent } from './files/FileViewerContent';
import { useFileOperations } from './files/useFileOperations';
import { loadFileDocument } from './files/loadFileDocument';
import { useFileStatReconciliation } from './files/useFileStatReconciliation';
import { useFilesTree } from './files/useFilesTree';
import { useFilesViewSearch } from './files/useFilesViewSearch';

interface FilesViewProps {
  mode?: 'full' | 'editor-only';
  chrome?: 'desktop' | 'mobile';
  onClose?: () => void;
}

export const FilesView: React.FC<FilesViewProps> = ({ mode = 'full', chrome = 'desktop', onClose }) => {
  const { files, runtime } = useRuntimeAPIs();
  const mobileChrome = chrome === 'mobile';
  const { currentTheme, availableThemes, lightThemeId, darkThemeId } = useThemeSystem();
  const { isMobile, isTablet, screenWidth } = useDeviceInfo();
  const isBrowserClient = isBrowserClientRuntime(runtime.platform);
  const alwaysShowActions = isMobile || isTablet;
  const showHidden = useDirectoryShowHidden();
  const showGitignored = useFilesViewShowGitignored();

  const currentDirectory = useEffectiveDirectory() ?? '';
  const root = normalizePath(currentDirectory.trim());
  // editor-only hosts (desktop context panel, the mobile Files surface) bring
  // their own chrome — the open-file tabs row is redundant there.
  const showEditorTabsRow = mode !== 'editor-only';
  const suppressFileLoadingIndicator = mode === 'editor-only' && !isMobile;
  const gitStatus = useGitStatus(currentDirectory);

  const [searchQuery, setSearchQuery] = React.useState('');
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  const [showMobilePageContent, setShowMobilePageContent] = React.useState(false);
  const [mobileDirectory, setMobileDirectory] = React.useState(root);
  const [mobileRefreshing, setMobileRefreshing] = React.useState(false);
  const [wrapLines, setWrapLines] = React.useState(true);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [isSearchOpen, setIsSearchOpen] = React.useState(false);
  const [isFloatingToolbarOpen, setIsFloatingToolbarOpen] = React.useState(false);
  const floatingToolbarRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!mobileChrome) return;
    setMobileDirectory(root);
    setSearchQuery('');
    setShowMobilePageContent(false);
  }, [mobileChrome, root]);
  const toolbarDropdownOpenCountRef = React.useRef(0);

  const handleToolbarDropdownOpenChange = React.useCallback((open: boolean) => {
    toolbarDropdownOpenCountRef.current = Math.max(
      0,
      toolbarDropdownOpenCountRef.current + (open ? 1 : -1),
    );
  }, []);

  const isClickInsidePortalledMenu = React.useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    return target.closest('[data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-item"]') !== null;
  }, []);

  React.useEffect(() => {
    if (!isFloatingToolbarOpen) return;
    const handler = (event: MouseEvent) => {
      if (toolbarDropdownOpenCountRef.current > 0) return;
      if (isClickInsidePortalledMenu(event.target)) return;
      if (floatingToolbarRef.current && !floatingToolbarRef.current.contains(event.target as Node)) {
        setIsFloatingToolbarOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isClickInsidePortalledMenu, isFloatingToolbarOpen]);
  type TextViewMode = 'view' | 'edit';
  type PreviewViewMode = 'preview' | 'edit';

  const [textViewMode, setTextViewMode] = React.useState<TextViewMode>('edit');
  const [mdViewMode, setMdViewMode] = React.useState<PreviewViewMode>('edit');
  const [jsonViewMode, setJsonViewMode] = React.useState<'tree' | 'text'>('tree');
  const [htmlViewMode, setHtmlViewMode] = React.useState<PreviewViewMode>('edit');
  const [drawioViewMode, setDrawioViewMode] = React.useState<PreviewViewMode>('preview');
  const [drawioRemountNonce, setDrawioRemountNonce] = React.useState(0);
  const textViewModeByPathRef = React.useRef<Record<string, TextViewMode>>({});
  const mdViewModeByPathRef = React.useRef<Record<string, PreviewViewMode>>({});
  const htmlViewModeByPathRef = React.useRef<Record<string, PreviewViewMode>>({});
  const drawioViewModeByPathRef = React.useRef<Record<string, PreviewViewMode>>({});

  const lightTheme = React.useMemo(
    () => availableThemes.find((theme) => theme.metadata.id === lightThemeId) ?? getDefaultTheme(false),
    [availableThemes, lightThemeId],
  );
  const darkTheme = React.useMemo(
    () => availableThemes.find((theme) => theme.metadata.id === darkThemeId) ?? getDefaultTheme(true),
    [availableThemes, darkThemeId],
  );

  React.useEffect(() => {
    ensurePierreThemeRegistered(lightTheme);
    ensurePierreThemeRegistered(darkTheme);
  }, [lightTheme, darkTheme]);

  const EMPTY_PATHS: string[] = React.useMemo(() => [], []);
  const openPaths = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.openPaths ?? EMPTY_PATHS) : EMPTY_PATHS));
  const selectedPath = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.selectedPath ?? null) : null));
  const expandedPaths = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.expandedPaths ?? EMPTY_PATHS) : EMPTY_PATHS));
  const removeOpenPath = useFilesViewTabsStore((state) => state.removeOpenPath);
  const removeOpenPathsByPrefix = useFilesViewTabsStore((state) => state.removeOpenPathsByPrefix);
  const removeExpandedPathsByPrefix = useFilesViewTabsStore((state) => state.removeExpandedPathsByPrefix);
  const setSelectedPath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const toggleExpandedPath = useFilesViewTabsStore((state) => state.toggleExpandedPath);
  const expandPaths = useFilesViewTabsStore((state) => state.expandPaths);
  const {
    childrenByDir,
    loadErrorsByDir,
    isLoaded: isDirectoryLoaded,
    loadDirectory,
    refreshDirectory,
    refreshRoot,
  } = useFilesTree({
    files,
    root,
    activeDirectory: mobileChrome ? mobileDirectory : undefined,
    expandedPaths,
    chrome,
    showHidden,
    showGitignored,
    removeExpandedPathsByPrefix,
  });

  const toFileNode = React.useCallback((path: string): FileNode => {
    const normalized = normalizePath(path);
    const parts = normalized.split('/');
    const name = parts[parts.length - 1] || normalized;
    const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
    return {
      name,
      path: normalized,
      type: 'file',
      extension,
    };
  }, []);

  const openFiles = React.useMemo(() => openPaths.map(toFileNode), [openPaths, toFileNode]);
  const effectiveSelectedPath = React.useMemo(() => {
    if (selectedPath) {
      const comparableSelected = toComparablePath(selectedPath);
      if (openPaths.some((path) => toComparablePath(path) === comparableSelected)) {
        return selectedPath;
      }
    }
    return openPaths[0] ?? null;
  }, [openPaths, selectedPath]);
  const selectedFile = React.useMemo(() => (effectiveSelectedPath ? toFileNode(effectiveSelectedPath) : null), [effectiveSelectedPath, toFileNode]);
  const selectedFilePath = selectedFile?.path ?? '';

  React.useEffect(() => {
    if (!root || !selectedPath) return;
    const comparableSelected = toComparablePath(selectedPath);
    const selectedIsOpen = openPaths.some((path) => toComparablePath(path) === comparableSelected);
    if (!selectedIsOpen) {
      setSelectedPath(root, openPaths[0] ?? null);
    }
  }, [openPaths, root, selectedPath, setSelectedPath]);

  const selectedFileIsOutsideWorkspace = Boolean(root && selectedFilePath && !isPathWithinRoot(selectedFilePath, root));
  const selectedOutsideFileGrant = selectedFileIsOutsideWorkspace ? getOutsideFileGrant(selectedFilePath) : undefined;
  const selectedFileReadOptions = React.useMemo(
    () => ({
      allowOutsideWorkspace: mode === 'editor-only' && selectedFileIsOutsideWorkspace,
      outsideFileGrant: selectedOutsideFileGrant,
      directory: root || undefined,
    }),
    [mode, selectedFileIsOutsideWorkspace, selectedOutsideFileGrant, root],
  );

  // Editor tabs horizontal scroll fades
  const editorTabsScrollRef = React.useRef<HTMLDivElement>(null);
  const [editorTabsOverflow, setEditorTabsOverflow] = React.useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  const updateEditorTabsOverflow = React.useCallback(() => {
    const el = editorTabsScrollRef.current;
    if (!el) return;
    setEditorTabsOverflow({
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    });
  }, []);
  const updateEditorTabsOverflowRef = React.useRef(updateEditorTabsOverflow);
  updateEditorTabsOverflowRef.current = updateEditorTabsOverflow;
  React.useEffect(() => {
    const el = editorTabsScrollRef.current;
    if (!el) return;
    const handler = () => updateEditorTabsOverflowRef.current();
    handler();
    el.addEventListener('scroll', handler, { passive: true });
    const ro = new ResizeObserver(handler);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', handler);
      ro.disconnect();
    };
  }, [openFiles.length]);

  const [fileContent, setFileContent] = React.useState<string>('');
  const [fileLoading, setFileLoading] = React.useState(false);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [desktopImageSrc, setDesktopImageSrc] = React.useState<string>('');
  const desktopImageBlobUrlRef = React.useRef<string>('');

  const [loadedFilePath, setLoadedFilePath] = React.useState<string | null>(null);

  const [draftContent, setDraftContent] = React.useState('');
  const [isSaving, setIsSaving] = React.useState(false);
  const [loadedFileLineEnding, setLoadedFileLineEnding] = React.useState<FileLineEnding>('\n');
  const autoSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const diagramAutoSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const diagramXmlRef = React.useRef('');
  const diagramSavedXmlRef = React.useRef('');
  const pendingDrawioPreviewFrameRef = React.useRef<number | null>(null);
  const diagramEditorRef = React.useRef<React.ComponentRef<typeof DiagramEditor>>(null);
  const activeFileLoadIdRef = React.useRef(0);
  const loadingFilePathRef = React.useRef<string | null>(null);
  const [autoSaveStatus, setAutoSaveStatus] = React.useState<'idle' | 'saved'>('idle');
  const [diagramSaved, setDiagramSaved] = React.useState(false);
  const [contentDetectedBinary, setContentDetectedBinary] = React.useState(false);
  const autoSaveEnabled = useUIStore((state) => state.autoSaveEnabled);
  const setAutoSaveEnabled = useUIStore((state) => state.setAutoSaveEnabled);

  const [confirmDiscardOpen, setConfirmDiscardOpen] = React.useState(false);
  const pendingSelectFileRef = React.useRef<FileNode | null>(null);
  const pendingTabRef = React.useRef<import('@/stores/useUIStore').MainTab | null>(null);
  const pendingClosePathRef = React.useRef<string | null>(null);
  const skipDirtyOnceRef = React.useRef(false);
  const editorViewRef = React.useRef<EditorView | null>(null);
  const editorWrapperRef = React.useRef<HTMLDivElement | null>(null);
  const [editorViewReadyNonce, setEditorViewReadyNonce] = React.useState(0);
  const pendingNavigationRafRef = React.useRef<number | null>(null);
  const pendingNavigationCycleRef = React.useRef<{ key: string; attempts: number }>({ key: '', attempts: 0 });

  React.useEffect(() => {
    return () => {
      if (pendingNavigationRafRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(pendingNavigationRafRef.current);
        pendingNavigationRafRef.current = null;
      }
    };
  }, []);

  const [contextMenuPath, setContextMenuPath] = React.useState<string | null>(null);
  const [rightClickMenuPath, setRightClickMenuPath] = React.useState<string | null>(null);
  const { value: copiedContent, show: showCopiedContent } = useTransientValue(false, 1200);
  const { value: copiedPath, show: showCopiedPath } = useTransientValue(false, 1200);
  const [isGoToLineOpen, setIsGoToLineOpen] = React.useState(false);

  const clearSelectedFile = React.useCallback(() => {
    if (root) setSelectedPath(root, null);
    setFileContent('');
    setFileError(null);
    setDesktopImageSrc('');
    setLoadedFilePath(null);
    if (isMobile) setShowMobilePageContent(false);
  }, [isMobile, root, setSelectedPath]);
  const {
    operation: activeDialog,
    target: dialogData,
    inputValue: dialogInputValue,
    setInputValue: setDialogInputValue,
    submitting: isDialogSubmitting,
    inputRef: dialogInputRef,
    open: handleOpenDialog,
    close: handleCloseDialog,
    submit: handleDialogSubmit,
    capabilities: { canCreateFile, canCreateFolder, canRename, canDelete },
  } = useFileOperations({
    files,
    root,
    selectedPath: selectedFile?.path ?? '',
    refreshDirectory,
    removeOpenPathsByPrefix,
    clearSelectedPath: clearSelectedFile,
  });
  const canReveal = Boolean(files.revealPath);
  const openInApps = useOpenInAppsStore((state) => state.availableApps);
  const openInCacheStale = useOpenInAppsStore((state) => state.isCacheStale);
  const initializeOpenInApps = useOpenInAppsStore((state) => state.initialize);
  const loadOpenInApps = useOpenInAppsStore((state) => state.loadInstalledApps);

  React.useEffect(() => {
    initializeOpenInApps();
  }, [initializeOpenInApps]);

  const handleRevealPath = React.useCallback((targetPath: string) => {
    if (!files.revealPath) return;
    void files.revealPath(targetPath).catch(() => {
      toast.error("Failed to reveal path");
    });
  }, [files]);

  const handleOpenInApp = React.useCallback(async (app: { id: string; appName: string }) => {
    if (!selectedFile?.path) {
      return;
    }

    const openedInApp = await openDesktopFileInApp(selectedFile.path, app.id, app.appName);
    if (openedInApp) {
      return;
    }

    const openedFile = await openDesktopPath(selectedFile.path, app.appName);
    if (openedFile) {
      return;
    }

    const fileDirectory = getParentDirectoryPath(selectedFile.path) || root;
    if (fileDirectory) {
      const openedDirectory = await openDesktopPath(fileDirectory, app.appName);
      if (openedDirectory) {
        return;
      }
    }
    toast.error(`Failed to open in ${app.appName}`);
  }, [root, selectedFile?.path]);

  // File navigation/editor state
  const setMainTabGuard = useUIStore((state) => state.setMainTabGuard);
  const pendingFileNavigation = useUIStore((state) => state.pendingFileNavigation);
  const setPendingFileNavigation = useUIStore((state) => state.setPendingFileNavigation);
  const pendingFileFocusPath = useUIStore((state) => state.pendingFileFocusPath);
  const setPendingFileFocusPath = useUIStore((state) => state.setPendingFileFocusPath);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const fileEditorKeymap = useUIStore((state) => state.fileEditorKeymap);
  const settingsDefaultFileViewerPreview = useConfigStore((state) => state.settingsDefaultFileViewerPreview);
  const settingsExpandedEditorToolbar = useUIStore((state) => state.expandedEditorToolbar);

  React.useEffect(() => {
    setMainTabGuard(null);
    setDraftContent('');
    setIsSaving(false);
  }, [selectedFile?.path, setMainTabGuard]);

  const lastFilesViewDirRef = React.useRef<string>('');
  React.useEffect(() => {
    if (!root || lastFilesViewDirRef.current === root) return;
    lastFilesViewDirRef.current = root;
    setFileContent('');
    setFileError(null);
    setDesktopImageSrc('');
    setLoadedFilePath(null);
    setShowMobilePageContent(false);
  }, [root]);

  const searchDirectory = mobileChrome ? mobileDirectory : currentDirectory;
  const { results: searchResults, searching } = useFilesViewSearch({
    directory: searchDirectory,
    query: searchQuery,
    chrome,
    showHidden,
    showGitignored,
  });

  const readFile = React.useCallback(async (path: string, options?: { allowOutsideWorkspace?: boolean; outsideFileGrant?: string; optional?: boolean }): Promise<string> => {
    if (files.readFile) {
      const result = await files.readFile(path, { ...(options ?? {}), directory: root || undefined });
      return result.content ?? '';
    }

    const params = new URLSearchParams({ path });
    if (options?.allowOutsideWorkspace) {
      params.set('allowOutsideWorkspace', 'true');
    }
    if (options?.outsideFileGrant) {
      params.set('outsideFileGrant', options.outsideFileGrant);
    }
    if (options?.optional) {
      params.set('optional', 'true');
    }
    if (root) {
      params.set('directory', root);
    }
    const response = await runtimeFetch(`/api/fs/read?${params.toString()}`, {
      cache: options?.optional ? 'no-store' : 'default',
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || "Failed to read file");
    }
    return response.text();
  }, [files, root]);

  const readFileStat = React.useCallback(async (path: string, options?: { allowOutsideWorkspace?: boolean; outsideFileGrant?: string }): Promise<FileStatSnapshot | null> => {
    if (files.statFile) {
      const result = await files.statFile(path, { ...(options ?? {}), directory: root || undefined });
      return {
        path: result.path,
        size: result.size,
        mtimeMs: result.mtimeMs,
      };
    }
    return null;
  }, [files, root]);

  React.useEffect(() => {
    if (!root || !files.statFile || openPaths.length === 0) {
      return;
    }

    let cancelled = false;
    const paths = [...openPaths];

    void Promise.all(paths.map(async (path) => {
      try {
        const stat = await files.statFile?.(path, { directory: root || undefined });
        if (!cancelled && stat && !stat.isFile) {
          removeOpenPathsByPrefix(root, path);
        }
      } catch (error) {
        if (!cancelled && isFileMissingError(error)) {
          removeOpenPathsByPrefix(root, path);
        }
      }
    }));

    return () => {
      cancelled = true;
    };
  }, [files, openPaths, removeOpenPathsByPrefix, root]);

  const displayedContent = React.useMemo(() =>
    fileContent.length > MAX_VIEW_CHARS
      ? `${fileContent.slice(0, MAX_VIEW_CHARS)}\n\n… truncated …`
      : fileContent,
    [fileContent]
  );

  const isDirty = draftContent !== displayedContent;
  const readSelectedFileStat = React.useCallback(
    (path: string) => readFileStat(path, selectedFileReadOptions),
    [readFileStat, selectedFileReadOptions],
  );
  const reloadExternallyChangedFile = React.useCallback(() => {
    // The selection effect observes this reset and performs exactly one reload.
    setLoadedFilePath(null);
  }, []);
  const { recordStat: recordLoadedFileStat } = useFileStatReconciliation({
    selectedPath: selectedFile?.path ?? null,
    loadedPath: loadedFilePath,
    isDirty,
    readStat: readSelectedFileStat,
    onExternalChange: reloadExternallyChangedFile,
  });

  const saveDraft = React.useCallback(async () => {
    if (!selectedFile || !files.writeFile) {
      toast.error("Saving not supported");
      return false;
    }

    const selectedIsBinary = isBinaryFile(selectedFile.path) || contentDetectedBinary;
    if (!shouldAllowFileDraftSave({
      selectedFilePath: selectedFile.path,
      loadedFilePath,
      fileLoading,
      isDirty,
      draftContent,
      fileContent,
      isNonEditableBinary: selectedIsBinary,
    })) {
      if (selectedIsBinary) {
        console.warn(`[saveDraft] refusing to save binary file "${selectedFile.path}".`);
      } else if (draftContent === '' && fileContent !== '' && loadedFilePath !== selectedFile.path) {
        console.warn(
          `[saveDraft] refusing to save empty draft for "${selectedFile.path}" (${fileContent.length} bytes were expected). ` +
          'The file may have been read during a concurrent write (O_TRUNC race). ' +
          'Try again after content finishes loading if the save was intentional.',
        );
      }
      return false;
    }

    // Clean draft: treat as success so discard/save dialogs and Ctrl+S are not stranded.
    if (!isDirty) {
      return true;
    }

    setIsSaving(true);

    try {
      const contentToWrite = serializeEditorContent(draftContent, loadedFileLineEnding);
      const result = await files.writeFile(selectedFile.path, contentToWrite);
      if (!result?.success) {
        toast.error("Failed to write file");
        return false;
      }
      setFileContent(draftContent);
      if (root && isPathWithinRoot(selectedFile.path, root)) {
        const relativePath = getDisplayPath(root, selectedFile.path);
        if (relativePath) {
          sessionEvents.requestGitRefresh({ directory: root, paths: [relativePath] });
        }
      }
      if (selectedFile?.path && isDrawioFile(selectedFile.path)) {
        diagramXmlRef.current = draftContent;
        diagramSavedXmlRef.current = draftContent;
      }
      // Refresh stat after write so polling doesn't see a stale metadata change.
      void readFileStat(selectedFile.path)
        .then((stat) => {
          if (stat) {
            recordLoadedFileStat(stat);
          }
        })
        .catch(() => {});
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Save failed");
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [contentDetectedBinary, draftContent, fileContent, fileLoading, files, isDirty, loadedFileLineEnding, loadedFilePath, readFileStat, recordLoadedFileStat, root, selectedFile]);

  React.useEffect(() => {
    if (!isDirty) {
      setMainTabGuard(null);
      return;
    }

    const guard = (_nextTab: import('@/stores/useUIStore').MainTab) => {
      if (skipDirtyOnceRef.current) {
        skipDirtyOnceRef.current = false;
        return true;
      }
      setConfirmDiscardOpen(true);
      pendingTabRef.current = _nextTab;
      return false;
    };

    setMainTabGuard(guard);

    return () => {
      const currentGuard = useUIStore.getState().mainTabGuard;
      if (currentGuard === guard) {
        setMainTabGuard(null);
      }
    };
  }, [isDirty, setMainTabGuard]);

  React.useEffect(() => {
    if (autoSaveEnabled) {
      return;
    }

    setAutoSaveStatus('idle');
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, [autoSaveEnabled]);

  // Auto-save: debounce 1.5s after user stops typing
  const AUTO_SAVE_DELAY = 1500;

  React.useEffect(() => {
    const canWrite = Boolean(selectedFile && files.writeFile);
    const selectedIsBinary = Boolean(selectedFile?.path && (isBinaryFile(selectedFile.path) || contentDetectedBinary));
    if (!shouldScheduleFileAutosave({
      autoSaveEnabled,
      isDirty,
      canWrite,
      isSaving,
      fileLoading,
      selectedFilePath: selectedFile?.path,
      loadedFilePath,
      isNonEditableBinary: selectedIsBinary,
    })) {
      return;
    }

    autoSaveTimerRef.current = setTimeout(() => {
      void saveDraft().then((saved) => {
        if (!saved) return;
        setAutoSaveStatus('saved');
        setTimeout(() => setAutoSaveStatus('idle'), 2000);
      });
    }, AUTO_SAVE_DELAY);

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [autoSaveEnabled, contentDetectedBinary, draftContent, fileLoading, isDirty, loadedFilePath, selectedFile, files.writeFile, isSaving, saveDraft]);

  // Reset auto-save status when switching files
  React.useEffect(() => {
    setAutoSaveStatus('idle');
  }, [selectedFile?.path]);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!hasModifier(e)) {
        return;
      }

      if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        // Cancel pending auto-save; user wants immediate save
        if (autoSaveTimerRef.current) {
          clearTimeout(autoSaveTimerRef.current);
          autoSaveTimerRef.current = null;
        }
        if (!isSaving) {
          void saveDraft().then((saved) => {
            if (!saved) return;
            setAutoSaveStatus('saved');
            setTimeout(() => setAutoSaveStatus('idle'), 2000);
          });
        }
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSaving, saveDraft]);

  const loadSelectedFile = React.useCallback(async (node: FileNode) => {
    const loadId = activeFileLoadIdRef.current + 1;
    activeFileLoadIdRef.current = loadId;
    const isCurrentLoad = () => {
      if (!root) return false;
      const rootState = useFilesViewTabsStore.getState().byRoot[root];
      const currentPath = rootState?.selectedPath ?? rootState?.openPaths[0] ?? null;
      return activeFileLoadIdRef.current === loadId && currentPath === node.path;
    };

    setFileError(null);
    setDesktopImageSrc('');
    setLoadedFilePath(null);
    setContentDetectedBinary(false);

    if (isMobile) {
      setShowMobilePageContent(true);
    }

    const outsideFileGrant = getOutsideFileGrant(node.path);
    const readOptions = {
      allowOutsideWorkspace: mode === 'editor-only' && Boolean(root) && !isPathWithinRoot(node.path, root),
      outsideFileGrant,
    };
    let keepDesktopImageLoading = false;
    setFileLoading(true);

    await loadFileDocument(
      node.path,
      runtime.isDesktop,
      (path) => readFile(path, readOptions),
    )
      .then((result) => {
        if (!isCurrentLoad()) return;

        if (result.kind !== 'text') {
          setFileContent('');
          setDraftContent('');
          if (result.kind === 'desktop-image') {
            keepDesktopImageLoading = true;
            return;
          }
          if (result.kind === 'binary') {
            setContentDetectedBinary(result.detectedFromContent);
          }
          setLoadedFilePath(node.path);
          return;
        }

        setLoadedFileLineEnding(result.lineEnding);
        setFileContent(result.content);
        diagramXmlRef.current = result.content;
        diagramSavedXmlRef.current = result.content;
        setDraftContent(result.draft);
        setLoadedFilePath(node.path);
        void readFileStat(node.path, readOptions)
          .then((stat) => {
            if (stat && isCurrentLoad()) {
              recordLoadedFileStat(stat);
            }
          })
          .catch(() => {});
      })
      .catch((error) => {
        if (!isCurrentLoad()) {
          return;
        }
        if (isDirectoryReadError(error)) {
          setFileLoading(false);
          if (root) {
            setSelectedPath(root, null);
          }
          setFileError(null);
          setFileContent('');
          setDraftContent('');
          setLoadedFilePath(null);
          recordLoadedFileStat(null);
          if (searchQuery.trim().length > 0) {
            setSearchQuery('');
          }
          if (isMobile) {
            setShowMobilePageContent(false);
          }
          if (root) {
            const ancestors = getAncestorPaths(node.path, root);
            const pathsToExpand = [...ancestors, node.path];
            if (pathsToExpand.length > 0) {
              expandPaths(root, pathsToExpand);
            }
            for (const path of pathsToExpand) {
              if (!isDirectoryLoaded(path)) {
                void loadDirectory(path);
              }
            }
          }
          return;
        }
        if (isFileMissingError(error)) {
          if (root) {
            removeOpenPathsByPrefix(root, node.path);
          }
          setFileContent('');
          setDraftContent('');
          setFileError(null);
          recordLoadedFileStat(null);
          if (isMobile) {
            setShowMobilePageContent(false);
          }
          return;
        }
        setFileContent('');
        setDraftContent('');
        setFileError(error instanceof Error ? error.message : "Failed to read file");
        recordLoadedFileStat(null);
      })
      .finally(() => {
        if (isCurrentLoad() && !keepDesktopImageLoading) {
          setFileLoading(false);
        }
      });
  }, [expandPaths, isDirectoryLoaded, isMobile, loadDirectory, mode, readFile, readFileStat, recordLoadedFileStat, removeOpenPathsByPrefix, root, runtime.isDesktop, searchQuery, setSelectedPath]);

  const ensurePathVisible = React.useCallback(async (targetPath: string, includeTarget: boolean) => {
    if (!root) {
      return;
    }

    const ancestors = getAncestorPaths(targetPath, root);
    const pathsToExpand = includeTarget ? [...ancestors, targetPath] : ancestors;

    if (pathsToExpand.length > 0) {
      expandPaths(root, pathsToExpand);
    }

    const loadPromises = pathsToExpand.map((path) => {
      if (!isDirectoryLoaded(path)) {
        return loadDirectory(path);
      }
      return undefined;
    }).filter(Boolean);
    await Promise.all(loadPromises);
  }, [expandPaths, isDirectoryLoaded, loadDirectory, root]);

  const getNextOpenFile = React.useCallback((path: string, filesList: FileNode[]) => {
    const index = filesList.findIndex((file) => file.path === path);
    if (index === -1 || filesList.length <= 1) {
      return null;
    }
    return filesList[index + 1] ?? filesList[index - 1] ?? null;
  }, []);

  const handleSelectFile = React.useCallback(async (node: FileNode) => {
    if (skipDirtyOnceRef.current) {
      skipDirtyOnceRef.current = false;
    } else if (isDirty) {
      setConfirmDiscardOpen(true);
      pendingSelectFileRef.current = node;
      return;
    }

    if (root) {
      setSelectedPath(root, node.path);
      void ensurePathVisible(node.path, false);
    }

    setFileError(null);
    setDesktopImageSrc('');
    setFileContent('');
    diagramXmlRef.current = '';
    diagramSavedXmlRef.current = '';
    setDraftContent('');
    setLoadedFilePath(null);
    if (isMobile) {
      setShowMobilePageContent(true);
    }
  }, [ensurePathVisible, isDirty, isMobile, root, setSelectedPath]);

  const handleMobileOpenDirectory = React.useCallback((directory: string) => {
    const normalized = normalizePath(directory);
    if (!normalized) return;
    setSearchQuery('');
    setMobileDirectory(normalized);
    setShowMobilePageContent(false);
  }, []);

  const handleMobileOpenFile = React.useCallback((path: string) => {
    const normalized = normalizePath(path);
    if (!normalized) return;
    setShowMobilePageContent(true);
    void handleSelectFile(toFileNode(normalized));
  }, [handleSelectFile, toFileNode]);

  const handleMobileRefresh = React.useCallback(async () => {
    if (!mobileDirectory || mobileRefreshing) return;
    setMobileRefreshing(true);
    try {
      await refreshDirectory(mobileDirectory);
    } finally {
      setMobileRefreshing(false);
    }
  }, [mobileDirectory, mobileRefreshing, refreshDirectory]);

  React.useEffect(() => {
    if (!selectedFile?.path) {
      return;
    }

    void ensurePathVisible(selectedFile.path, false);
  }, [ensurePathVisible, selectedFile?.path]);

  React.useEffect(() => {
    if (!selectedFile) {
      activeFileLoadIdRef.current += 1;
      loadingFilePathRef.current = null;
      setFileLoading(false);
      return;
    }

    if (loadedFilePath === selectedFile.path || loadingFilePathRef.current === selectedFile.path) {
      return;
    }

    // Selection changes are guarded; this effect is also what restores persisted tabs on mount.
    const loadingPath = selectedFile.path;
    loadingFilePathRef.current = loadingPath;
    void loadSelectedFile(selectedFile).finally(() => {
      if (loadingFilePathRef.current === loadingPath) {
        loadingFilePathRef.current = null;
      }
    });
  }, [loadSelectedFile, loadedFilePath, selectedFile]);

  const discardAndContinue = React.useCallback(() => {
    const nextFile = pendingSelectFileRef.current;
    const nextTab = pendingTabRef.current;
    const closePath = pendingClosePathRef.current;

    pendingSelectFileRef.current = null;
    pendingTabRef.current = null;
    pendingClosePathRef.current = null;

    // Allow one guarded navigation (tab/file) without re-opening dialog.
    skipDirtyOnceRef.current = true;

    setConfirmDiscardOpen(false);

    // Discard draft by reverting back to last loaded content
    setDraftContent(displayedContent);

    if (closePath) {
      if (root) {
        removeOpenPath(root, closePath);
      }
      if (selectedFile?.path === closePath) {
        if (nextFile) {
          void handleSelectFile(nextFile);
        } else {
          if (root) {
            setSelectedPath(root, null);
          }
          setFileContent('');
          setFileError(null);
          setDesktopImageSrc('');
          setLoadedFilePath(null);
          if (isMobile) {
            setShowMobilePageContent(false);
          }
        }
      }
      return;
    }

    if (nextFile) {
      void handleSelectFile(nextFile);
      return;
    }

    if (nextTab) {
      setMainTabGuard(null);
      useUIStore.getState().setActiveMainTab(nextTab);
    }
  }, [displayedContent, handleSelectFile, isMobile, removeOpenPath, root, selectedFile?.path, setMainTabGuard, setSelectedPath]);

  const saveAndContinue = React.useCallback(async () => {
    const nextFile = pendingSelectFileRef.current;
    const nextTab = pendingTabRef.current;
    const closePath = pendingClosePathRef.current;

    const saved = await saveDraft();
    if (!saved) {
      skipDirtyOnceRef.current = false;
      return;
    }

    pendingSelectFileRef.current = null;
    pendingTabRef.current = null;
    pendingClosePathRef.current = null;

    // We'll proceed after saving; suppress guard reopening.
    skipDirtyOnceRef.current = true;

    setConfirmDiscardOpen(false);

    if (closePath) {
      if (root) {
        removeOpenPath(root, closePath);
      }
      if (selectedFile?.path === closePath) {
        if (nextFile) {
          await handleSelectFile(nextFile);
        } else {
          if (root) {
            setSelectedPath(root, null);
          }
          setFileContent('');
          setFileError(null);
          setDesktopImageSrc('');
          setLoadedFilePath(null);
          if (isMobile) {
            setShowMobilePageContent(false);
          }
        }
      }
      return;
    }

    if (nextFile) {
      await handleSelectFile(nextFile);
      return;
    }

    if (nextTab) {
      setMainTabGuard(null);
      useUIStore.getState().setActiveMainTab(nextTab);
    }
  }, [handleSelectFile, isMobile, removeOpenPath, root, saveDraft, selectedFile?.path, setMainTabGuard, setSelectedPath]);

  const handleCloseFile = React.useCallback((path: string) => {
    const isActive = selectedFile?.path === path;
    const nextFile = getNextOpenFile(path, openFiles);

    if (isActive && isDirty) {
      setConfirmDiscardOpen(true);
      pendingSelectFileRef.current = nextFile;
      pendingClosePathRef.current = path;
      return;
    }

    if (root) {
      removeOpenPath(root, path);
    }

    if (!isActive) {
      return;
    }

    if (nextFile) {
      void handleSelectFile(nextFile);
      return;
    }

    if (root) {
      setSelectedPath(root, null);
    }
    setFileContent('');
    setFileError(null);
    setDesktopImageSrc('');
    setLoadedFilePath(null);
    if (isMobile) {
      setShowMobilePageContent(false);
    }
  }, [getNextOpenFile, handleSelectFile, isDirty, isMobile, openFiles, removeOpenPath, root, selectedFile?.path, setSelectedPath]);

  const getFileStatus = React.useCallback((path: string): FileStatus | null => {
    // Check open status
    if (openPaths.includes(path)) return 'open';

    // Check git status
    if (gitStatus?.files) {
      const relative = path.startsWith(root + '/') ? path.slice(root.length + 1) : path;
      const file = gitStatus.files.find(f => f.path === relative);
      if (file) {
        if (file.index === 'A' || file.working_dir === '?') return 'git-added';
        if (file.index === 'D') return 'git-deleted';
        if (file.index === 'M' || file.working_dir === 'M') return 'git-modified';
      }
    }
    return null;
  }, [openPaths, gitStatus, root]);

  const getFolderBadge = React.useCallback((dirPath: string): { modified: number; added: number } | null => {
    if (!gitStatus?.files) return null;
    const relativeDir = dirPath.startsWith(root + '/') ? dirPath.slice(root.length + 1) : dirPath;
    const prefix = relativeDir ? `${relativeDir}/` : '';

    let modified = 0, added = 0;
    for (const f of gitStatus.files) {
      if (f.path.startsWith(prefix)) {
        if (f.index === 'M' || f.working_dir === 'M') modified++;
        if (f.index === 'A' || f.working_dir === '?') added++;
      }
    }
    return modified + added > 0 ? { modified, added } : null;
  }, [gitStatus, root]);

  const toggleDirectory = React.useCallback(async (dirPath: string) => {
    const normalized = normalizePath(dirPath);
    if (!root) return;

    toggleExpandedPath(root, normalized);

    if (!isDirectoryLoaded(normalized)) {
      await loadDirectory(normalized);
    }
  }, [isDirectoryLoaded, loadDirectory, root, toggleExpandedPath]);

  const fileRowPermissions = React.useMemo(
    () => ({ canRename, canCreateFile, canCreateFolder, canDelete, canReveal }),
    [canRename, canCreateFile, canCreateFolder, canDelete, canReveal]
  );

  function renderTree(dirPath: string, depth: number): React.ReactNode {
    const nodes = childrenByDir[dirPath] ?? [];

    return nodes.map((node, index) => {
      const isDir = node.type === 'directory';
      const isExpanded = isDir && expandedPaths.includes(node.path);
      const isActive = selectedFile?.path === node.path;
      const isLast = index === nodes.length - 1;

      return (
        <li key={node.path} className="relative">
          {depth > 0 && (
            <>
              <span className="absolute top-3.5 left-[-12px] w-3 h-px bg-border/40" />
              {isLast && (
                <span className="absolute top-3.5 bottom-0 left-[-13px] w-[2px] bg-background" />
              )}
            </>
          )}
          <FileRow
            node={node}
            root={root}
            isExpanded={isExpanded}
            isActive={isActive}
            isMobile={isMobile}
            isBrowserClient={isBrowserClient}
            alwaysShowActions={alwaysShowActions}
            status={!isDir ? getFileStatus(node.path) : undefined}
            badge={isDir ? getFolderBadge(node.path) : undefined}
            permissions={fileRowPermissions}
            downloadFile={files.downloadFile}
            contextMenuPath={contextMenuPath}
            setContextMenuPath={setContextMenuPath}
            rightClickMenuPath={rightClickMenuPath}
            setRightClickMenuPath={setRightClickMenuPath}
            onSelect={handleSelectFile}
            onToggle={toggleDirectory}
            onRevealPath={handleRevealPath}
            onOpenDialog={handleOpenDialog}
          />
          {isDir && isExpanded && (
            <ul className="flex flex-col gap-1 ml-3 pl-3 border-l border-border/40 relative">
              {loadErrorsByDir[node.path] ? (
                <li className="flex items-center gap-2 px-2 py-1 typography-meta text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate text-[var(--status-error)]" title={loadErrorsByDir[node.path]}>{loadErrorsByDir[node.path]}</span>
                  <Button variant="ghost" size="xs" className="h-6 gap-1" onClick={() => void refreshDirectory(node.path)}>
                    <Icon name="refresh" className="size-3.5" />
                    {"Refresh"}
                  </Button>
                </li>
              ) : null}
              {renderTree(node.path, depth + 1)}
            </ul>
          )}
        </li>
      );
    });
  }

  const isSelectedImage = Boolean(selectedFile?.path && isImageFile(selectedFile.path));
  const isSelectedSvg = Boolean(selectedFile?.path && isSvgFile(selectedFile.path));
  const isSelectedPdf = Boolean(selectedFile?.path && isPdfFile(selectedFile.path));
  const isSelectedBinary = Boolean(
    selectedFile?.path
    && (isBinaryFile(selectedFile.path) || contentDetectedBinary)
  );
  const isUnsupportedBinary = isSelectedBinary && !isSelectedImage && !isSelectedPdf;
  const pendingNavigationTargetPath = React.useMemo(
    () => normalizePath(pendingFileNavigation?.path ?? ''),
    [pendingFileNavigation?.path],
  );
  const shouldMaskEditorForPendingNavigation = Boolean(
    pendingFileNavigation
      && pendingNavigationTargetPath
      && selectedFilePath
      && selectedFilePath === pendingNavigationTargetPath
      && !fileLoading
      && !fileError
      && !isSelectedImage
      && !isSelectedPdf
      && !isUnsupportedBinary,
  );

  const displaySelectedPath = React.useMemo(() => {
    return getDisplayPath(root, selectedFilePath);
  }, [selectedFilePath, root]);

  const canCopy = Boolean(selectedFile && (!isSelectedImage || isSelectedSvg) && !isSelectedPdf && !isUnsupportedBinary && fileContent.length > 0);
  const canCopyPath = Boolean(selectedFile && displaySelectedPath.length > 0);
  // Keep image/SVG on the preview path: `isBinaryFile` excludes `.svg`, so binary
  // alone would flip canEdit/isTextFile true and show a dead edit toggle + no-op Save.
  const canEdit = Boolean(selectedFile && !selectedFileIsOutsideWorkspace && !isSelectedBinary && !isSelectedImage && files.writeFile && fileContent.length <= MAX_VIEW_CHARS);
  const isMarkdown = Boolean(selectedFile?.path && isMarkdownFile(selectedFile.path));
  const isJson = Boolean(selectedFile?.path && isJsonFile(selectedFile.path));
  const isHtml = Boolean(selectedFile?.path && isHtmlFile(selectedFile.path));
  const isDrawio = Boolean(selectedFile?.path && isDrawioFile(selectedFile.path));
  const isTextFile = Boolean(selectedFile && !isSelectedBinary && !isSelectedImage);
  const canUseShikiFileView = isTextFile && !isMarkdown && !isDrawio && !(isHtml && htmlViewMode === 'preview');
  const isEditingFile = (isMarkdown && mdViewMode === 'edit')
    || (isHtml && htmlViewMode === 'edit')
    || (isJson && jsonViewMode === 'text')
    || (!isMarkdown && !isHtml && !isJson && textViewMode === 'edit');
  const staticLanguageExtension = React.useMemo(
    () => (selectedFilePath ? languageByExtension(selectedFilePath) : null),
    [selectedFilePath],
  );
  const [dynamicLanguageExtension, setDynamicLanguageExtension] = React.useState<Extension | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const selectedPath = selectedFile?.path;

    if (!selectedPath || staticLanguageExtension) {
      setDynamicLanguageExtension(null);
      return;
    }

    setDynamicLanguageExtension(null);
    void loadLanguageByExtension(selectedPath).then((extension) => {
      if (!cancelled) {
        setDynamicLanguageExtension(extension);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [selectedFile?.path, staticLanguageExtension]);

  React.useEffect(() => {
    if (!canEdit && textViewMode === 'edit') {
      setTextViewMode('view');
    }
  }, [canEdit, textViewMode]);

  const MD_VIEWER_MODE_KEY = 'pichamber:files:md-viewer-mode';
  const HTML_VIEWER_MODE_KEY = 'pichamber:files:html-viewer-mode';
  const JSON_VIEWER_MODE_KEY = 'pichamber:files:json-viewer-mode';

  React.useEffect(() => {
    const selectedPath = selectedFile?.path;
    if (!selectedPath) {
      return;
    }

    setTextViewMode(textViewModeByPathRef.current[selectedPath] ?? 'edit');

    // Respect per-type localStorage preference when available,
    // falling back to the setting-derived default when nothing is stored.
    let mdDefault: PreviewViewMode = settingsDefaultFileViewerPreview ? 'preview' : 'edit';
    try {
      const stored = localStorage.getItem(MD_VIEWER_MODE_KEY);
      if (stored === 'preview' || stored === 'edit') {
        mdDefault = stored;
      }
    } catch {
      // Ignore localStorage errors
    }
    setMdViewMode(mdViewModeByPathRef.current[selectedPath] ?? mdDefault);

    let htmlDefault: PreviewViewMode = settingsDefaultFileViewerPreview ? 'preview' : 'edit';
    try {
      const stored = localStorage.getItem(HTML_VIEWER_MODE_KEY);
      if (stored === 'preview' || stored === 'edit') {
        htmlDefault = stored;
      }
    } catch {
      // Ignore localStorage errors
    }
    setHtmlViewMode(htmlViewModeByPathRef.current[selectedPath] ?? htmlDefault);
    setDrawioViewMode(drawioViewModeByPathRef.current[selectedPath] ?? (settingsDefaultFileViewerPreview ? 'preview' : 'edit'));

    let jsonDefault: 'tree' | 'text' = settingsDefaultFileViewerPreview ? 'tree' : 'text';
    try {
      const stored = localStorage.getItem(JSON_VIEWER_MODE_KEY);
      if (stored === 'tree' || stored === 'text') {
        jsonDefault = stored;
      }
    } catch {
      // Ignore localStorage errors
    }
    setJsonViewMode(jsonDefault);
  }, [selectedFile?.path, settingsDefaultFileViewerPreview]);

  const saveTextViewMode = React.useCallback((mode: TextViewMode) => {
    const selectedPath = selectedFile?.path;
    if (selectedPath) {
      textViewModeByPathRef.current[selectedPath] = mode;
    }
    setTextViewMode(mode);
  }, [selectedFile?.path]);

  const saveMdViewMode = React.useCallback((mode: PreviewViewMode) => {
    const selectedPath = selectedFile?.path;
    if (selectedPath) {
      mdViewModeByPathRef.current[selectedPath] = mode;
    }
    setMdViewMode(mode);
    try {
      localStorage.setItem(MD_VIEWER_MODE_KEY, mode);
    } catch {
      // Ignore localStorage errors
    }
  }, [selectedFile?.path]);

  const getMdViewMode = React.useCallback((): PreviewViewMode => {
    return mdViewMode;
  }, [mdViewMode]);

  const saveJsonViewMode = React.useCallback((mode: 'tree' | 'text') => {
    setJsonViewMode(mode);
    try {
      localStorage.setItem(JSON_VIEWER_MODE_KEY, mode);
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  const saveHtmlViewMode = React.useCallback((mode: PreviewViewMode) => {
    const selectedPath = selectedFile?.path;
    if (selectedPath) {
      htmlViewModeByPathRef.current[selectedPath] = mode;
    }
    setHtmlViewMode(mode);
    try {
      localStorage.setItem(HTML_VIEWER_MODE_KEY, mode);
    } catch {
      // Ignore localStorage errors
    }
  }, [selectedFile?.path]);

  const saveDrawioViewMode = React.useCallback((mode: PreviewViewMode) => {
    const selectedPath = selectedFile?.path;
    if (selectedPath) {
      drawioViewModeByPathRef.current[selectedPath] = mode;
    }
    if (diagramAutoSaveTimerRef.current) {
      clearTimeout(diagramAutoSaveTimerRef.current);
      diagramAutoSaveTimerRef.current = null;
    }
    if (pendingDrawioPreviewFrameRef.current !== null) {
      cancelAnimationFrame(pendingDrawioPreviewFrameRef.current);
      pendingDrawioPreviewFrameRef.current = null;
    }
    if (mode === 'edit') {
      setDraftContent(diagramXmlRef.current || fileContent);
      setDrawioViewMode(mode);
    } else {
      diagramXmlRef.current = draftContent;
      const pathAtToggle = selectedPath;
      setDrawioViewMode('edit');
      pendingDrawioPreviewFrameRef.current = requestAnimationFrame(() => {
        pendingDrawioPreviewFrameRef.current = requestAnimationFrame(() => {
          pendingDrawioPreviewFrameRef.current = null;
          if (root && pathAtToggle && useFilesViewTabsStore.getState().byRoot[root]?.selectedPath !== pathAtToggle) {
            return;
          }
          setDrawioRemountNonce((value) => value + 1);
          setDrawioViewMode('preview');
        });
      });
      return;
    }
  }, [draftContent, fileContent, root, selectedFile?.path]);

  const saveDiagramXml = React.useCallback(async (path: string, xml: string) => {
    if (!files.writeFile || xml === diagramSavedXmlRef.current) {
      return false;
    }

    const result = await files.writeFile(path, xml);
    if (!result?.success) {
      toast.error("Failed to write file");
      return false;
    }

    diagramXmlRef.current = xml;
    diagramSavedXmlRef.current = xml;
    setDraftContent(xml);
    const stat = await readFileStat(path, selectedFileReadOptions).catch(() => null);
    if (stat) {
      recordLoadedFileStat(stat);
    }
    return true;
  }, [files, readFileStat, recordLoadedFileStat, selectedFileReadOptions]);

  React.useEffect(() => {
    return () => {
      if (diagramAutoSaveTimerRef.current) {
        clearTimeout(diagramAutoSaveTimerRef.current);
        diagramAutoSaveTimerRef.current = null;
      }
      if (pendingDrawioPreviewFrameRef.current !== null) {
        cancelAnimationFrame(pendingDrawioPreviewFrameRef.current);
        pendingDrawioPreviewFrameRef.current = null;
      }
    };
  }, [drawioViewMode, selectedFile?.path]);

  const handleDiagramChange = React.useCallback((xml: string) => {
    diagramXmlRef.current = xml;
    if (!autoSaveEnabled || !selectedFile?.path || drawioViewMode !== 'preview' || !files.writeFile) {
      return;
    }

    if (diagramAutoSaveTimerRef.current) {
      clearTimeout(diagramAutoSaveTimerRef.current);
    }

    const path = selectedFile.path;
    diagramAutoSaveTimerRef.current = setTimeout(() => {
      diagramAutoSaveTimerRef.current = null;
      void saveDiagramXml(path, xml).then((saved) => {
        if (!saved) return;
        setDiagramSaved(true);
        setTimeout(() => setDiagramSaved(false), 1500);
      }).catch((error) => {
        toast.error(error instanceof Error ? error.message : "Save failed");
      });
    }, AUTO_SAVE_DELAY);
  }, [autoSaveEnabled, drawioViewMode, files.writeFile, saveDiagramXml, selectedFile?.path]);

  const diagramEditorXml = React.useMemo(() => {
    if (!isDrawio) {
      return fileContent;
    }
    return diagramXmlRef.current || draftContent || fileContent;
  }, [draftContent, fileContent, isDrawio]);

  const getHtmlViewMode = React.useCallback((): PreviewViewMode => {
    return htmlViewMode;
  }, [htmlViewMode]);

  React.useEffect(() => {
    const applyDefaultFileViewerMode = (enabled: boolean) => {
      const previewMode: PreviewViewMode = enabled ? 'preview' : 'edit';
      const nextJsonMode: 'tree' | 'text' = enabled ? 'tree' : 'text';

      for (const path of openPaths) {
        textViewModeByPathRef.current[path] = 'edit';
        if (isMarkdownFile(path)) {
          mdViewModeByPathRef.current[path] = previewMode;
        }
        if (isHtmlFile(path)) {
          htmlViewModeByPathRef.current[path] = previewMode;
        }
        if (isDrawioFile(path)) {
          drawioViewModeByPathRef.current[path] = previewMode;
        }
      }

      setTextViewMode('edit');
      setMdViewMode(previewMode);
      setHtmlViewMode(previewMode);
      setDrawioViewMode(previewMode);
      setJsonViewMode(nextJsonMode);

      try {
        localStorage.setItem(MD_VIEWER_MODE_KEY, previewMode);
        localStorage.setItem(HTML_VIEWER_MODE_KEY, previewMode);
        localStorage.setItem(JSON_VIEWER_MODE_KEY, nextJsonMode);
      } catch {
        // Ignore localStorage errors
      }
    };

    const handleFileViewerModeChanged = (event: Event) => {
      const enabled = Boolean((event as CustomEvent<{ enabled?: boolean }>).detail?.enabled);
      applyDefaultFileViewerMode(enabled);
    };

    window.addEventListener('pichamber:file-viewer-preview-mode-changed', handleFileViewerModeChanged);
    return () => {
      window.removeEventListener('pichamber:file-viewer-preview-mode-changed', handleFileViewerModeChanged);
    };
  }, [openPaths]);

  React.useEffect(() => {
    if (!pendingFileNavigation || !root) {
      return;
    }

    const scheduleNavigationRetry = () => {
      if (typeof window === 'undefined') {
        return;
      }
      if (pendingNavigationRafRef.current !== null) {
        return;
      }

      pendingNavigationRafRef.current = window.requestAnimationFrame(() => {
        pendingNavigationRafRef.current = null;
        setEditorViewReadyNonce((value) => value + 1);
      });
    };

    const isEditorSyncedWithDraft = (view: EditorView, expectedContent: string): boolean => {
      if (view.state.doc.length !== expectedContent.length) {
        return false;
      }

      if (expectedContent.length === 0) {
        return true;
      }

      const sampleSize = Math.min(128, expectedContent.length);
      const startSample = view.state.sliceDoc(0, sampleSize);
      if (startSample !== expectedContent.slice(0, sampleSize)) {
        return false;
      }

      const endFrom = Math.max(0, expectedContent.length - sampleSize);
      const endSample = view.state.sliceDoc(endFrom, expectedContent.length);
      return endSample === expectedContent.slice(endFrom);
    };

    const targetPath = normalizePath(pendingFileNavigation.path);
    if (!targetPath) {
      setPendingFileNavigation(null);
      pendingNavigationCycleRef.current = { key: '', attempts: 0 };
      return;
    }

    const navigationKey = `${targetPath}:${pendingFileNavigation.line}:${pendingFileNavigation.column ?? 1}`;
    if (pendingNavigationCycleRef.current.key !== navigationKey) {
      pendingNavigationCycleRef.current = { key: navigationKey, attempts: 0 };
    }

    if (selectedFile?.path !== targetPath) {
      if (confirmDiscardOpen) {
        return;
      }
      void handleSelectFile(toFileNode(targetPath));
      return;
    }

    if (fileLoading || loadedFilePath !== targetPath) {
      return;
    }

    if (fileError || isSelectedImage || isSelectedPdf || isUnsupportedBinary) {
      setPendingFileNavigation(null);
      pendingNavigationCycleRef.current = { key: '', attempts: 0 };
      return;
    }

    if (!canEdit) {
      return;
    }

    if (textViewMode !== 'edit') {
      setTextViewMode('edit');
      return;
    }

    const view = editorViewRef.current;
    if (!view) {
      scheduleNavigationRetry();
      return;
    }

    if (!isEditorSyncedWithDraft(view, draftContent)) {
      scheduleNavigationRetry();
      return;
    }

    const targetLineNumber = Math.max(1, Math.min(pendingFileNavigation.line, view.state.doc.lines));
    const targetLine = view.state.doc.line(targetLineNumber);
    const targetColumn = Math.max(1, pendingFileNavigation.column || 1);
    const lineLength = Math.max(0, targetLine.to - targetLine.from);
    const clampedColumnOffset = Math.min(lineLength, targetColumn - 1);
    const targetPosition = targetLine.from + clampedColumnOffset;
    const isAtTarget = view.state.selection.main.head === targetPosition;
    const shouldDispatch = !isAtTarget || pendingNavigationCycleRef.current.attempts === 0;

    if (shouldDispatch) {
      pendingNavigationCycleRef.current.attempts += 1;
      view.dispatch({
        selection: { anchor: targetPosition },
        effects: EditorView.scrollIntoView(targetPosition, { y: 'center' }),
      });
      view.focus();
      scheduleNavigationRetry();
      return;
    }

    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        const syncedView = editorViewRef.current;
        if (!syncedView) {
          return;
        }

        syncedView.dispatch({
          selection: { anchor: targetPosition },
          effects: EditorView.scrollIntoView(targetPosition, { y: 'center' }),
        });
        syncedView.focus();
      });
    }

    setPendingFileNavigation(null);
    pendingNavigationCycleRef.current = { key: '', attempts: 0 };
  }, [
    canEdit,
    confirmDiscardOpen,
    draftContent,
    editorViewReadyNonce,
    fileError,
    fileLoading,
    isSelectedImage,
    isSelectedPdf,
    isUnsupportedBinary,
    loadedFilePath,
    handleSelectFile,
    pendingFileNavigation,
    root,
    selectedFile?.path,
    setPendingFileNavigation,
    textViewMode,
    toFileNode,
  ]);

  React.useEffect(() => {
    if (!pendingFileFocusPath || !root) {
      return;
    }

    const targetPath = normalizePath(pendingFileFocusPath);
    if (!targetPath) {
      setPendingFileFocusPath(null);
      return;
    }

    if (selectedFile?.path !== targetPath) {
      // Selection is owned by the tab sync / user. A pending focus request must
      // not steal selection back (e.g. after the user switched to another tab
      // while this file was still loading). Wait; clear once it loads or the
      // request is superseded.
      return;
    }

    if (fileLoading || loadedFilePath !== targetPath) {
      return;
    }

    // Best-effort focus: preview renderers (markdown/html preview, drawio,
    // JSON tree, images, PDFs) never mount a CodeMirror editor, so the request
    // must clear regardless — otherwise it lingers and replays on every
    // dependency change.
    if (!fileError && !isSelectedImage && !isSelectedPdf && !isUnsupportedBinary && canEdit && textViewMode === 'edit') {
      editorViewRef.current?.focus();
    }

    setPendingFileFocusPath(null);
  }, [
    canEdit,
    fileError,
    fileLoading,
    isSelectedImage,
    isSelectedPdf,
    isUnsupportedBinary,
    loadedFilePath,
    pendingFileFocusPath,
    root,
    selectedFile?.path,
    setPendingFileFocusPath,
    textViewMode,
  ]);

  const nudgeEditorSelectionAboveKeyboard = React.useCallback((view: EditorView | null) => {
    if (!isMobile || !view || !view.hasFocus || typeof window === 'undefined') {
      return;
    }

    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }

    const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
    const occludedBottom = Math.max(0, layoutHeight - (viewport.offsetTop + viewport.height));
    if (occludedBottom <= 0) {
      return;
    }

    const head = view.state.selection.main.head;
    const cursorRect = view.coordsAtPos(head);
    if (!cursorRect) {
      return;
    }

    const visibleBottom = Math.round(viewport.offsetTop + viewport.height);
    const clearance = 20;
    const overlap = cursorRect.bottom + clearance - visibleBottom;
    if (overlap <= 0) {
      return;
    }

    view.scrollDOM.scrollTop += overlap;
  }, [isMobile]);

  React.useEffect(() => {
    if (!isMobile || typeof window === 'undefined') {
      return;
    }

    const runNudge = () => {
      window.requestAnimationFrame(() => {
        nudgeEditorSelectionAboveKeyboard(editorViewRef.current);
      });
    };

    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', runNudge);
    viewport?.addEventListener('scroll', runNudge, { passive: true });
    document.addEventListener('selectionchange', runNudge);

    return () => {
      viewport?.removeEventListener('resize', runNudge);
      viewport?.removeEventListener('scroll', runNudge);
      document.removeEventListener('selectionchange', runNudge);
    };
  }, [isMobile, nudgeEditorSelectionAboveKeyboard]);

  React.useEffect(() => {
    if (!canEdit || textViewMode !== 'edit' || isMobile) {
      return;
    }

    const goToLineCombo = getEffectiveShortcutCombo('open_go_to_line', shortcutOverrides);

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      if (target?.closest('[role="dialog"]')) {
        return;
      }

      const isEditorTarget = Boolean(target?.closest('.cm-editor'));
      const isTypingTarget = Boolean(
        target?.closest('input, textarea, [contenteditable="true"], [role="textbox"]')
      );
      if (isTypingTarget && !isEditorTarget) {
        return;
      }

      const activeElement = document.activeElement as Element | null;
      const editorHasFocus = Boolean(activeElement?.closest('.cm-editor'));
      if (!editorHasFocus) {
        return;
      }

      if (eventMatchesShortcut(event, goToLineCombo)) {
        event.preventDefault();
        setIsGoToLineOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canEdit, isMobile, shortcutOverrides, textViewMode]);

  const editorFontSize = useUIStore((state) => state.editorFontSize);

  const editorExtensions = React.useMemo(() => {
    if (!selectedFile?.path) {
      return [createFlexokiCodeMirrorTheme(currentTheme, { fontSize: editorFontSize })];
    }

    // Shiki token colors (worker-backed) match the Shiki file view exactly.
    // Same language resolver as the view, so both agree on the language. When
    // Shiki is the color source, drop the lezer token colors to avoid a
    // competing highlighter (Keep the lezer language for indentation/folding).
    const shikiLanguage = getLanguageFromExtension(selectedFile.path);
    const extensions = [createFlexokiCodeMirrorTheme(currentTheme, shikiLanguage ? { syntaxColors: false, fontSize: editorFontSize } : { fontSize: editorFontSize })];
    const language = staticLanguageExtension ?? dynamicLanguageExtension;
    if (language) {
      extensions.push(language);
    }
    if (shikiLanguage) {
      extensions.push(shikiHighlightExtension({
        language: shikiLanguage,
        themeName: currentTheme.metadata.id,
        theme: getResolvedShikiTheme(currentTheme),
      }));
    }
    if (wrapLines) {
      extensions.push(EditorView.lineWrapping);
    }
    if (isMobile) {
      extensions.push(EditorView.updateListener.of((update) => {
        if (!update.view.hasFocus) {
          return;
        }
        if (!(update.selectionSet || update.focusChanged || update.viewportChanged || update.geometryChanged)) {
          return;
        }

        window.requestAnimationFrame(() => {
          nudgeEditorSelectionAboveKeyboard(update.view);
        });
      }));
    }
    return extensions;
  }, [currentTheme, selectedFile?.path, staticLanguageExtension, dynamicLanguageExtension, wrapLines, isMobile, nudgeEditorSelectionAboveKeyboard, editorFontSize]);

  const pierreTheme = React.useMemo(
    () => ({ light: lightTheme.metadata.id, dark: darkTheme.metadata.id }),
    [lightTheme.metadata.id, darkTheme.metadata.id],
  );

  const imageAssetAuthKey = selectedFile?.path && isSelectedImage && !runtime.isDesktop && !isSelectedSvg
    ? `${selectedFile.path}|${selectedFileReadOptions.allowOutsideWorkspace ? 'outside' : 'workspace'}|${selectedFileReadOptions.outsideFileGrant ?? ''}`
    : '';

  const pdfAssetAuthKey = selectedFile?.path && isSelectedPdf
    ? `${selectedFile.path}|${selectedFileReadOptions.allowOutsideWorkspace ? 'outside' : 'workspace'}|${selectedFileReadOptions.outsideFileGrant ?? ''}`
    : '';

  const htmlAssetAuthKey = selectedFile?.path && isHtml && htmlViewMode === 'preview'
    ? selectedFile.path
    : '';

  const assetAuthErrorFallback = "Failed to read file";
  const { readyKey: imageAssetAuthReadyKey, nonce: imagePreviewNonce } =
    useAssetAuthRefresh(imageAssetAuthKey, setFileError, assetAuthErrorFallback);
  const { readyKey: htmlAssetAuthReadyKey, nonce: htmlPreviewNonce } =
    useAssetAuthRefresh(htmlAssetAuthKey, setFileError, assetAuthErrorFallback);
  const { readyKey: pdfAssetAuthReadyKey, nonce: pdfPreviewNonce } =
    useAssetAuthRefresh(pdfAssetAuthKey, setFileError, assetAuthErrorFallback);

  const isImageAssetAuthLoading = Boolean(imageAssetAuthKey && imageAssetAuthReadyKey !== imageAssetAuthKey);
  const isHtmlAssetAuthLoading = Boolean(htmlAssetAuthKey && htmlAssetAuthReadyKey !== htmlAssetAuthKey);
  const isPdfAssetAuthLoading = Boolean(pdfAssetAuthKey && pdfAssetAuthReadyKey !== pdfAssetAuthKey);

  const imageSrc = selectedFile?.path && isSelectedImage
    ? (runtime.isDesktop
      ? (isSelectedSvg
        ? `data:${getImageMimeType(selectedFile.path)};utf8,${encodeURIComponent(fileContent)}`
        : desktopImageSrc)
      : (isSelectedSvg
        ? `data:${getImageMimeType(selectedFile.path)};utf8,${encodeURIComponent(fileContent)}`
        : imageAssetAuthReadyKey === imageAssetAuthKey ? getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', {
          path: selectedFile.path,
          allowOutsideWorkspace: selectedFileReadOptions.allowOutsideWorkspace ? 'true' : undefined,
          outsideFileGrant: selectedFileReadOptions.outsideFileGrant,
          directory: root || undefined,
        }) : ''))
    : '';

  const pdfSrc = selectedFile?.path && isSelectedPdf && pdfAssetAuthReadyKey === pdfAssetAuthKey
    ? getRuntimeUrlResolver().authenticatedAsset('/api/fs/raw', {
      path: selectedFile.path,
      allowOutsideWorkspace: selectedFileReadOptions.allowOutsideWorkspace ? 'true' : undefined,
      outsideFileGrant: selectedFileReadOptions.outsideFileGrant,
      directory: root || undefined,
    })
    : '';

  const htmlPreviewSrc = htmlAssetAuthKey && htmlAssetAuthReadyKey === htmlAssetAuthKey && selectedFile?.path
    ? (() => {
      const encoded = selectedFile.path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
      return getRuntimeUrlResolver().authenticatedAsset(`/api/fs/serve${encoded.startsWith('/') ? encoded : `/${encoded}`}`);
    })()
    : undefined;

  React.useEffect(() => {
    let cancelled = false;

    const resolveDesktopImage = async () => {
      if (!runtime.isDesktop || !selectedFile?.path || !isSelectedImage || isSelectedSvg) {
        if (desktopImageBlobUrlRef.current) {
          URL.revokeObjectURL(desktopImageBlobUrlRef.current);
          desktopImageBlobUrlRef.current = '';
        }
        setDesktopImageSrc('');
        return;
      }

      setFileError(null);

      if (desktopImageBlobUrlRef.current) {
        URL.revokeObjectURL(desktopImageBlobUrlRef.current);
        desktopImageBlobUrlRef.current = '';
      }

      const srcPromise = files.readFileBinary
        ? files.readFileBinary(selectedFile.path, selectedFileReadOptions).then((result) => result.dataUrl)
        : (async () => {
          const response = await runtimeFetch('/api/fs/raw', {
            query: {
              path: selectedFile.path,
              allowOutsideWorkspace: selectedFileReadOptions.allowOutsideWorkspace ? 'true' : undefined,
              outsideFileGrant: selectedFileReadOptions.outsideFileGrant,
              directory: root || undefined,
            },
          });
          if (!response.ok) {
            throw new Error("Failed to read file");
          }
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          if (cancelled) {
            URL.revokeObjectURL(url);
            return '';
          }
          desktopImageBlobUrlRef.current = url;
          return url;
        })();

      await srcPromise
        .then((src) => {
          if (!cancelled) {
            setDesktopImageSrc(src);
            setLoadedFilePath(selectedFile.path);
          }
        })
        .catch((error) => {
          if (desktopImageBlobUrlRef.current) {
            URL.revokeObjectURL(desktopImageBlobUrlRef.current);
            desktopImageBlobUrlRef.current = '';
          }
          if (!cancelled) {
            setDesktopImageSrc('');
            setFileError(error instanceof Error ? error.message : "Failed to read file");
            setLoadedFilePath(null);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setFileLoading(false);
          }
        });
    };

    void resolveDesktopImage();

    return () => {
      cancelled = true;
    };
  }, [files, isSelectedImage, isSelectedSvg, root, runtime.isDesktop, selectedFile?.path, selectedFileReadOptions]);

  React.useEffect(() => {
    return () => {
      if (desktopImageBlobUrlRef.current) {
        URL.revokeObjectURL(desktopImageBlobUrlRef.current);
        desktopImageBlobUrlRef.current = '';
      }
    };
  }, []);

  const renderFloatingFileControls = ({
    exitFullscreenOnly = false,
    layout = 'floating',
  }: { exitFullscreenOnly?: boolean; layout?: 'floating' | 'docked' } = {}) => {
    if (!selectedFile) {
      return null;
    }

    const docked = layout === 'docked';
    const wrapperCls = docked
      ? 'pointer-events-auto flex flex-wrap items-center gap-1'
      : 'pointer-events-auto flex items-center gap-1 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-1 shadow-sm';

    const withTooltip = (label: React.ReactNode, trigger: React.ReactElement) => (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            {trigger}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>{label}</TooltipContent>
      </Tooltip>
    );

    return (
      <div className={wrapperCls}>
        {canEdit && isEditingFile && (
          <>
            {isSaving ? (
              <span className="flex items-center gap-1 px-1 text-muted-foreground typography-meta">
                <Icon name="loader-4" className="size-3.5 animate-spin" />
                {"Saving..."}
              </span>
            ) : autoSaveEnabled && autoSaveStatus === 'saved' && !isDirty ? (
              <span className="flex items-center gap-1 px-1 text-[color:var(--status-success)] typography-meta">
                <Icon name="check" className="size-3.5" />
                {"Saved"}
              </span>
            ) : isDirty ? withTooltip((autoSaveEnabled ? `Save now (${getModifierLabel()}+S) - auto-saves after 1.5s` : `Save now (${getModifierLabel()}+S)`),
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void saveDraft()}
                className="h-6 gap-1 px-1 text-muted-foreground opacity-80 hover:bg-transparent hover:opacity-100 focus-visible:bg-transparent active:bg-transparent"
                title={(autoSaveEnabled ? `Save now (${getModifierLabel()}+S) - auto-saves after 1.5s` : `Save now (${getModifierLabel()}+S)`)}
                aria-label={`Save (${getModifierLabel()}+S)`}
              >
                <Icon name="save-3" className="size-4" />
              </Button>
            ) : null}
            {withTooltip(autoSaveEnabled ? "Auto-save on" : "Manual save",
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAutoSaveEnabled(!autoSaveEnabled)}
                className={cn(
                  'size-6 p-0 transition-opacity hover:bg-transparent focus-visible:bg-transparent active:bg-transparent',
                  autoSaveEnabled ? 'text-foreground opacity-100' : 'text-muted-foreground opacity-65 hover:opacity-100'
                )}
                title={autoSaveEnabled ? "Auto-save on" : "Manual save"}
                aria-label={autoSaveEnabled ? "Auto-save on" : "Manual save"}
              >
                {autoSaveEnabled ? <Icon name="file-check-fill" className="size-4" /> : <Icon name="file-check" className="size-4" />}
              </Button>
            )}
          </>
        )}

        <DropdownMenu onOpenChange={handleToolbarDropdownOpenChange}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-6 p-0 text-foreground opacity-100 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
                    title={"Open in desktop app"}
                    aria-label={"Open in desktop app"}
                  >
                    <Icon name="file-transfer" className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{"Open in desktop app"}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-56 max-h-[70vh] overflow-y-auto">
            {openInApps.map((app) => (
              <DropdownMenuItem
                key={app.id}
                className="flex items-center gap-2"
                onClick={() => void handleOpenInApp(app)}
              >
                <OpenInAppListIcon label={app.label} iconDataUrl={app.iconDataUrl} />
                <span className="typography-ui-label text-foreground">{app.label}</span>
              </DropdownMenuItem>
            ))}
            {openInCacheStale ? (
              <DropdownMenuItem
                className="flex items-center gap-2"
                onClick={() => void loadOpenInApps(true)}
              >
                <Icon name="refresh" className="size-4" />
                <span className="typography-ui-label text-foreground">{"Refresh Apps"}</span>
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>

        {!isSelectedImage && !isSelectedPdf && !isUnsupportedBinary && (
          <>
            {withTooltip(wrapLines ? "Disable line wrap" : "Enable line wrap",
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setWrapLines(!wrapLines)}
                className={cn(
                  'size-6 p-0 transition-opacity hover:bg-transparent focus-visible:bg-transparent active:bg-transparent',
                  wrapLines ? 'text-foreground opacity-100' : 'text-muted-foreground opacity-65 hover:opacity-100'
                )}
                title={wrapLines ? "Disable line wrap" : "Enable line wrap"}
              >
                <Icon name="text-wrap" className="size-4" />
              </Button>
            )}
            {textViewMode === 'edit' && (
              <>
                {withTooltip("Find in file",
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(event) => {
                      setIsSearchOpen(!isSearchOpen);
                      event.currentTarget.blur();
                    }}
                    className="size-6 p-0 text-foreground opacity-100 transition-opacity hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
                    title={"Find in file"}
                  >
                    <Icon name="search" className="size-4" />
                  </Button>
                )}
                {withTooltip("Go to line",
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(event) => {
                      setIsGoToLineOpen((open) => !open);
                      event.currentTarget.blur();
                    }}
                    className="size-6 p-0 text-foreground opacity-100 transition-opacity hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
                    title={"Go to line"}
                  >
                    <Icon name="menu-fold-2" className="size-4" />
                  </Button>
                )}
                <GoToLineDialog
                  open={isGoToLineOpen}
                  onOpenChange={setIsGoToLineOpen}
                  view={editorViewRef.current}
                  variant="inline"
                />
              </>
            )}
          </>
        )}

        {canUseShikiFileView && canEdit && !isJson && !isHtml && (
          <PreviewToggleButton
            currentMode={textViewMode === 'view' ? 'preview' : 'edit'}
            onToggle={() => {
              saveTextViewMode(textViewMode === 'view' ? 'edit' : 'view');
            }}
          />
        )}

        {isMarkdown && (
          withTooltip(
            (getMdViewMode() === 'preview' ? "Switch to edit mode" : "Switch to preview mode"),
            <Button
              variant="ghost"
              size="sm"
              onClick={() => saveMdViewMode(getMdViewMode() === 'preview' ? 'edit' : 'preview')}
              className={cn(
                'size-6 p-0 transition-colors hover:bg-[var(--interactive-hover)] focus-visible:bg-[var(--interactive-hover)] active:bg-[var(--interactive-hover)]',
                getMdViewMode() === 'preview'
                  ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)] hover:bg-[var(--interactive-selection)] focus-visible:bg-[var(--interactive-selection)] active:bg-[var(--interactive-selection)]'
                  : 'text-muted-foreground opacity-65 hover:opacity-100'
              )}
              title={(getMdViewMode() === 'preview' ? "Switch to edit mode" : "Switch to preview mode")}
              aria-label={(getMdViewMode() === 'preview' ? "Switch to edit mode" : "Switch to preview mode")}
            >
              <Icon name={getMdViewMode() === 'preview' ? 'eye' : 'eye-off'} className="size-4" />
            </Button>
          )
        )}

        {isHtmlFile(selectedFile?.path ?? '') && (
          <PreviewToggleButton
            currentMode={getHtmlViewMode()}
            onToggle={() => {
              saveHtmlViewMode(getHtmlViewMode() === 'preview' ? 'edit' : 'preview');
            }}
          />
        )}

        {isDrawio && (
          <>
            <PreviewToggleButton
              currentMode={drawioViewMode}
              onToggle={() => saveDrawioViewMode(drawioViewMode === 'preview' ? 'edit' : 'preview')}
            />
            {drawioViewMode === 'preview' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  const xml = diagramEditorRef.current?.getXml();
                  if (diagramAutoSaveTimerRef.current) {
                    clearTimeout(diagramAutoSaveTimerRef.current);
                    diagramAutoSaveTimerRef.current = null;
                  }
                  if (selectedFile?.path && xml) {
                    const saved = await saveDiagramXml(selectedFile.path, xml);
                    if (!saved) return;
                    setDiagramSaved(true);
                    setTimeout(() => setDiagramSaved(false), 1500);
                  }
                }}
                className="size-6 p-0 text-foreground hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
                title={"Save diagram"}
              >
                {diagramSaved ? (
                  <Icon name="check" className="size-4 text-[color:var(--status-success)]" />
                ) : (
                  <Icon name="save-3" className="size-4" />
                )}
              </Button>
            )}
          </>
        )}

        {isJson && (
          withTooltip(jsonViewMode === 'tree' ? "Switch to Text View" : "Switch to Tree View",
            <Button
              variant="ghost"
              size="sm"
              onClick={() => saveJsonViewMode(jsonViewMode === 'tree' ? 'text' : 'tree')}
              className="size-6 p-0 text-muted-foreground opacity-65 hover:bg-transparent hover:opacity-100 focus-visible:bg-transparent active:bg-transparent"
              title={jsonViewMode === 'tree' ? "Switch to Text View" : "Switch to Tree View"}
            >
              {jsonViewMode === 'tree' ? (
                <Icon name="code-sslash" className="size-4" />
              ) : (
                <Icon name="node-tree" className="size-4" />
              )}
            </Button>
          )
        )}

        {canCopy && (
          withTooltip("Copy file contents",
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const result = await copyTextToClipboard(fileContent);
                if (result.ok) {
                  showCopiedContent(true);
                } else {
                  toast.error("Copy failed");
                }
              }}
              className="size-6 p-0 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
              title={"Copy file contents"}
              aria-label={"Copy file contents"}
            >
              {copiedContent ? (
                <Icon name="check" className="size-4 text-[color:var(--status-success)]" />
              ) : (
                <Icon name="clipboard" className="size-4" />
              )}
            </Button>
          )
        )}

        {canCopyPath && (
          withTooltip(`Copy file path (${displaySelectedPath})`,
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const result = await copyTextToClipboard(displaySelectedPath);
                if (result.ok) {
                  showCopiedPath(true);
                } else {
                  toast.error("Copy failed");
                }
              }}
              className="size-6 p-0 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
              title={`Copy file path (${displaySelectedPath})`}
              aria-label={`Copy file path (${displaySelectedPath})`}
            >
              {copiedPath ? (
                <Icon name="check" className="size-4 text-[color:var(--status-success)]" />
              ) : (
                <Icon name="file-copy-2" className="size-4" />
              )}
            </Button>
          )
        )}

        {files.downloadFile && (
          withTooltip("Save file",
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const fn = files.downloadFile;
                if (fn) void fn(selectedFile.path).catch((error) => {
                  console.error('Download failed:', error);
                  toast.error("Operation failed");
                });
              }}
              className="size-6 p-0 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
              title={"Save file"}
              aria-label={"Save file"}
            >
              <Icon name="download" className="size-4" />
            </Button>
          )
        )}

        {exitFullscreenOnly ? (
          withTooltip("Exit fullscreen",
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsFullscreen(false)}
              className="size-6 p-0 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
              title={"Exit fullscreen"}
              aria-label={"Exit fullscreen"}
            >
              <Icon name="fullscreen-exit" className="size-4" />
            </Button>
          )
        ) : (!isMobile && mode === 'full' && (
          withTooltip(isFullscreen ? "Exit fullscreen" : "Fullscreen",
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsFullscreen(!isFullscreen)}
              className="size-6 p-0 hover:bg-transparent focus-visible:bg-transparent active:bg-transparent"
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? (
                <Icon name="fullscreen-exit" className="size-4" />
              ) : (
                <Icon name="fullscreen" className="size-4" />
              )}
            </Button>
          )
        ))}
      </div>
    );
  };

  const handleDownloadSelectedFile = React.useCallback(() => {
    const downloadFile = files.downloadFile;
    const path = selectedFile?.path;
    if (!downloadFile || !path) return;
    void downloadFile(path).catch((error) => {
      console.error('Download failed:', error);
      toast.error("Operation failed");
    });
  }, [files.downloadFile, selectedFile?.path]);

  const handleEmbeddedEditorViewReady = React.useCallback((view: EditorView) => {
    editorViewRef.current = view;
    setEditorViewReadyNonce((value) => value + 1);
    window.requestAnimationFrame(() => {
      nudgeEditorSelectionAboveKeyboard(view);
    });
  }, [nudgeEditorSelectionAboveKeyboard]);

  const handleEmbeddedEditorViewDestroy = React.useCallback(() => {
    if (editorViewRef.current) {
      editorViewRef.current = null;
    }
    setEditorViewReadyNonce((value) => value + 1);
  }, []);

  const handleFullscreenEditorViewReady = React.useCallback((view: EditorView) => {
    editorViewRef.current = view;
    window.requestAnimationFrame(() => {
      nudgeEditorSelectionAboveKeyboard(view);
    });
  }, [nudgeEditorSelectionAboveKeyboard]);

  const handleFullscreenEditorViewDestroy = React.useCallback(() => {
    if (editorViewRef.current) {
      editorViewRef.current = null;
    }
  }, []);

  const fileViewerContentProps = {
    selectedFile,
    loading: fileLoading || isImageAssetAuthLoading || isPdfAssetAuthLoading,
    suppressLoadingIndicator: suppressFileLoadingIndicator,
    fileError,
    isSelectedImage,
    imageSrc,
    imagePreviewNonce,
    isSelectedPdf,
    pdfSrc,
    pdfPreviewNonce,
    isUnsupportedBinary,
    onDownload: files.downloadFile && selectedFile ? handleDownloadSelectedFile : undefined,
    drawioViewMode,
    drawioRemountNonce,
    diagramEditorRef,
    diagramEditorXml,
    onDiagramChange: handleDiagramChange,
    jsonViewMode,
    markdownViewMode: mdViewMode,
    htmlViewMode,
    htmlLoading: isHtmlAssetAuthLoading,
    htmlPreviewNonce,
    htmlPreviewSrc,
    fileContent,
    canUseShikiFileView,
    textViewMode,
    draftContent,
    onDraftChange: setDraftContent,
    canEdit,
    vimMode: fileEditorKeymap === 'vim',
    editorExtensions,
    shouldMaskEditorForPendingNavigation,
    pierreTheme,
    shikiThemeType: currentTheme.metadata.variant === 'dark' ? 'dark' as const : 'light' as const,
    wrapLines,
  };

  const fileViewer = (
    <div
      className="relative flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden"
    >
      <Dialog open={confirmDiscardOpen} onOpenChange={(open) => {
        // Intentionally no "cancel" action. Keep dialog modal.
        if (!open) {
          setConfirmDiscardOpen(true);
        }
      }}>
        <DialogContent showCloseButton={false} className="max-w-md">
          <DialogHeader>
            <DialogTitle>{"Unsaved changes"}</DialogTitle>
            <DialogDescription>
              {"Save your edits before continuing?"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => void saveAndContinue()}
              disabled={isSaving}
              className="border-[var(--status-success-border)] bg-[var(--status-success-background)] text-[var(--status-success)] hover:bg-[rgb(var(--status-success)/0.2)]"
            >
              {"Save changes"}
            </Button>
            <Button variant="destructive" onClick={discardAndContinue}>{"Discard"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className={cn('flex flex-col flex-shrink-0', showEditorTabsRow && 'border-b border-border/40')}>
        {/* Row 1: Tabs */}
        {showEditorTabsRow ? (
        <div className="flex min-w-0 items-center px-3 py-1.5">
          {isMobile && showMobilePageContent && (
            <button
              type="button"
              onClick={() => setShowMobilePageContent(false)}
              aria-label={"Back"}
              className="inline-flex size-7 flex-shrink-0 items-center justify-center mr-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Icon name="arrow-left-s" className="size-5" />
            </button>
          )}

          {isMobile ? (
            selectedFile ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex min-w-0 max-w-full items-center gap-1 text-left typography-ui-label font-medium"
                    aria-label={"Open files"}
                  >
                    <FileTypeIcon filePath={selectedFile.path} extension={selectedFile.extension} className="size-3.5 flex-shrink-0" />
                    <ScrollingFileName name={selectedFile.name} />
                    <Icon name="arrow-down-s" className="size-4 flex-shrink-0 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-[min(24rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)]">
                  {openFiles.map((file) => {
                    const isActive = selectedFile?.path === file.path;
                    return (
                      <DropdownMenuItem
                        key={file.path}
                        onSelect={(event) => {
                          const target = event.target as HTMLElement;
                          if (target.closest('[data-close-open-file]')) {
                            event.preventDefault();
                            return;
                          }
                          if (!isActive) {
                            void handleSelectFile(file);
                          }
                        }}
                        className={cn(
                          'flex min-w-0 items-center justify-between gap-2 overflow-hidden',
                          isActive && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]'
                        )}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                          <FileTypeIcon filePath={file.path} extension={file.extension} className="size-3.5 flex-shrink-0" />
                          <ScrollingFileName name={file.name} />
                        </span>
                        <button
                          type="button"
                          data-close-open-file
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            handleCloseFile(file.path);
                          }}
                          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--surface-muted-foreground)] hover:text-[var(--surface-foreground)]"
                          aria-label={`Close ${file.name}`}
                        >
                          <Icon name="close" className="size-3.5" />
                        </button>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <div className="typography-ui-label font-medium truncate">{"Select a file"}</div>
            )
          ) : (
            openFiles.length > 0 ? (
              <div className="relative min-w-0 flex-1">
                {editorTabsOverflow.left && (
                  <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-6 z-10 bg-gradient-to-r from-background to-transparent" />
                )}
                {editorTabsOverflow.right && (
                  <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-6 z-10 bg-gradient-to-l from-background to-transparent" />
                )}
                <div
                  ref={editorTabsScrollRef}
                  className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-none"
                  style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                  data-no-drawer-swipe="true"
                >
                  {openFiles.map((file) => {
                    const isActive = selectedFile?.path === file.path;
                    return (
                      <div
                        key={file.path}
                        title={getDisplayPath(root, file.path)}
                        className={cn(
                          'group inline-flex items-center gap-1 rounded-md border px-2 py-1 typography-ui-label transition-colors whitespace-nowrap',
                          isActive
                            ? 'bg-[var(--interactive-selection)] border-[var(--primary-muted)] text-[var(--interactive-selection-foreground)]'
                            : 'bg-transparent border-[var(--interactive-border)] text-[var(--surface-muted-foreground)] hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]'
                        )}
                      >
                        <FileTypeIcon filePath={file.path} extension={file.extension} className="size-3.5 flex-shrink-0" />
                        <button
                          type="button"
                          onClick={() => {
                            if (!isActive) {
                              void handleSelectFile(file);
                            }
                          }}
                          className="max-w-[12rem] truncate text-left"
                        >
                          {file.name}
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleCloseFile(file.path);
                          }}
                          className={cn(
                            'rounded-sm p-0.5 text-[var(--surface-muted-foreground)] hover:text-[var(--surface-foreground)]',
                            !isActive && !alwaysShowActions && 'opacity-0 group-hover:opacity-100'
                          )}
                          aria-label={`Close ${file.name}`}
                        >
                          <Icon name="close" className="size-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="typography-ui-label font-medium truncate">{"Select a file"}</div>
            )
          )}
        </div>
        ) : null}

        {/* Row 2: Docked editor toolbar (expanded). Desktop opt-in; ALWAYS on
            for mobile — floating hover controls don't work with touch. */}
        {(settingsExpandedEditorToolbar || isMobile) && selectedFile ? (
          <div className="flex min-w-0 items-center gap-3 border-t border-border/40 bg-[var(--surface-subtle)] px-3 py-1">
            {/* Mobile hosts already show the file name in their own header;
                a truncated duplicate here just eats toolbar width. */}
            {displaySelectedPath && !isMobile ? (
              <span
                className="min-w-0 flex-1 truncate typography-meta text-muted-foreground"
                title={displaySelectedPath}
              >
                {displaySelectedPath}
              </span>
            ) : null}
            <div className="ml-auto min-w-0 shrink-0 overflow-x-auto">
              {renderFloatingFileControls({ layout: 'docked' })}
            </div>
          </div>
        ) : null}

      </div>

      <div className="flex-1 min-h-0 min-w-0 relative">
        {selectedFile && !isSearchOpen && !(settingsExpandedEditorToolbar || isMobile) && (
          <div
            ref={floatingToolbarRef}
            className="absolute right-3 top-3 z-30"
            onMouseLeave={() => {
              if (toolbarDropdownOpenCountRef.current > 0) return;
              setIsFloatingToolbarOpen(false);
            }}
          >
            {isFloatingToolbarOpen ? (
              renderFloatingFileControls()
            ) : (
              <div className="flex items-center gap-1">
                {isMarkdown ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => saveMdViewMode(getMdViewMode() === 'preview' ? 'edit' : 'preview')}
                          className={cn(
                            'size-8 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-0 shadow-sm transition-colors',
                            getMdViewMode() === 'preview'
                              ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)] hover:bg-[var(--interactive-selection)]'
                              : 'text-muted-foreground hover:text-foreground'
                          )}
                          aria-label={(getMdViewMode() === 'preview' ? "Switch to edit mode" : "Switch to preview mode")}
                          title={(getMdViewMode() === 'preview' ? "Switch to edit mode" : "Switch to preview mode")}
                        >
                          <Icon name={getMdViewMode() === 'preview' ? 'eye' : 'eye-off'} className="size-4" />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      {(getMdViewMode() === 'preview' ? "Switch to edit mode" : "Switch to preview mode")}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="inline-flex"
                      onMouseEnter={() => setIsFloatingToolbarOpen(true)}
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setIsFloatingToolbarOpen(true)}
                        className="size-8 rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] p-0 text-muted-foreground shadow-sm hover:text-foreground"
                        aria-label={"Show editor controls"}
                        title={"Editor controls"}
                      >
                        <Icon name="more-2-fill" className="size-4" />
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>{"Editor controls"}</TooltipContent>
                </Tooltip>
              </div>
            )}
          </div>
        )}
        <FileViewerContent
          variant="embedded"
          {...fileViewerContentProps}
          enableRichPreviews
          editorWrapperRef={editorWrapperRef}
          onEditorViewReady={handleEmbeddedEditorViewReady}
          onEditorViewDestroy={handleEmbeddedEditorViewDestroy}
          enableSearch
          searchOpen={isSearchOpen}
          onSearchOpenChange={setIsSearchOpen}
        />
      </div>
    </div>
  );

  const hasTree = Boolean(root && childrenByDir[root]);
  const rootLoadError = root ? loadErrorsByDir[root] : null;

  const treePanel = (
    <section className={cn(
      "flex min-h-0 flex-col overflow-hidden",
      isMobile ? "h-full w-full bg-background" : "h-full rounded-xl border border-border/60 bg-background/70"
    )}>
      <div className={cn("flex flex-col gap-2 py-2", isMobile ? "px-3" : "px-2")}>
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Icon name="search" className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={"Search files..."}
              className="h-8 pl-8 pr-8 typography-meta"
            />
            {searchQuery.trim().length > 0 && (
              <button
                type="button"
                aria-label={"Clear search"}
                className="absolute right-2 top-2 inline-flex size-4 items-center justify-center text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setSearchQuery('');
                  searchInputRef.current?.focus();
                }}
              >
                <Icon name="close" className="size-4" />
              </button>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex flex-shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleOpenDialog('createFile', { path: currentDirectory, type: 'directory' })}
                  className="size-8 p-0 flex-shrink-0"
                  title={"New File"}
                  aria-label={"New File"}
                >
                  <Icon name="file-add" className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{"New File"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex flex-shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleOpenDialog('createFolder', { path: currentDirectory, type: 'directory' })}
                  className="size-8 p-0 flex-shrink-0"
                  title={"New Folder"}
                  aria-label={"New Folder"}
                >
                  <Icon name="folder-add" className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{"New Folder"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex flex-shrink-0">
                <Button variant="ghost" size="sm" onClick={() => void refreshRoot()} className="size-8 p-0 flex-shrink-0" title={"Refresh"} aria-label={"Refresh"}>
                  <Icon name="refresh" className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{"Refresh"}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className={cn("py-2", isMobile ? "px-3" : "px-2")}>
        <ul className="flex flex-col">
          {searching ? (
            <li className="flex items-center gap-1.5 px-2 py-1 typography-meta text-muted-foreground">
              <Icon name="loader-4" className="size-4 animate-spin" />
              {"Searching..."}
            </li>
          ) : searchResults.length > 0 ? (
            searchResults.map((node) => {
              const isActive = selectedFile?.path === node.path;
              return (
                <li key={node.path}>
                  <button
                    type="button"
                    onClick={() => void handleSelectFile(node)}
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-foreground transition-colors',
                      isActive ? 'bg-interactive-selection/70' : 'hover:bg-interactive-hover/40'
                    )}
                  >
                    <FileIcon filePath={node.path} extension={node.extension} />
                    <span
                      className="min-w-0 flex-1 truncate typography-meta"
                      style={{ direction: 'rtl', textAlign: 'left' }}
                      title={node.path}
                    >
                      {node.relativePath ?? node.path}
                    </span>
                  </button>
                </li>
              );
            })
          ) : rootLoadError ? (
            <li className="flex flex-col gap-2 px-2 py-1 typography-meta text-muted-foreground">
              <span className="text-[var(--status-error)]">{rootLoadError}</span>
              <Button variant="outline" size="xs" className="w-fit gap-1.5" onClick={() => void refreshRoot()}>
                <Icon name="refresh" className="size-3.5" />
                {"Refresh"}
              </Button>
            </li>
          ) : hasTree ? (
            renderTree(root, 0)
          ) : (
            <li className="px-2 py-1 typography-meta text-muted-foreground">{"Loading..."}</li>
          )}
        </ul>
      </ScrollableOverlay>
    </section>
  );

  // Fullscreen file viewer overlay
  const fullscreenViewer = mode === 'full' && isFullscreen && selectedFile && (
    <div className="absolute inset-0 z-50 flex flex-col bg-background">
      {/* Fullscreen content */}
      <div className="flex-1 min-h-0 min-w-0 relative">
        <div className="absolute right-4 top-4 z-30">
          {renderFloatingFileControls({ exitFullscreenOnly: true })}
        </div>
        <FileViewerContent
          variant="fullscreen"
          {...fileViewerContentProps}
          enableRichPreviews={false}
          onEditorViewReady={handleFullscreenEditorViewReady}
          onEditorViewDestroy={handleFullscreenEditorViewDestroy}
        />
      </div>
    </div>
  );

  if (mobileChrome) {
    return (
      <MobileFilesChrome
        root={root}
        directory={mobileDirectory || root}
        entries={(mobileDirectory || root) ? childrenByDir[mobileDirectory || root] : undefined}
        query={searchQuery}
        searchResults={searchResults}
        isSearching={searching}
        directoryError={(mobileDirectory || root) ? loadErrorsByDir[mobileDirectory || root] ?? null : null}
        refreshing={mobileRefreshing}
        editorPath={showMobilePageContent ? selectedFile?.path ?? null : null}
        editor={fileViewer}
        onClose={onClose}
        onQueryChange={setSearchQuery}
        onOpenDirectory={handleMobileOpenDirectory}
        onOpenFile={handleMobileOpenFile}
        onBackFromEditor={() => setShowMobilePageContent(false)}
        onRefresh={() => void handleMobileRefresh()}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-background relative">
      <Dialogs
        activeDialog={activeDialog}
        dialogData={dialogData}
        dialogInputValue={dialogInputValue}
        onDialogInputChange={setDialogInputValue}
        isDialogSubmitting={isDialogSubmitting}
        onDialogSubmit={handleDialogSubmit}
        onClose={handleCloseDialog}
        inputRef={dialogInputRef}
      />
      {fullscreenViewer}
      {isMobile ? (
        showMobilePageContent ? (
          fileViewer
        ) : (
          treePanel
        )
       ) : mode === 'editor-only' ? (
         <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden bg-background">
             {fileViewer}
            </div>
          </div>
       ) : (
         <div className="flex flex-1 min-h-0 min-w-0 gap-3 px-3 pb-3 pt-2">
            {screenWidth >= 700 && (
              <div className="w-72 flex-shrink-0 min-h-0 overflow-hidden">
               {treePanel}
             </div>
           )}
           <div className="flex-1 min-h-0 min-w-0 overflow-hidden rounded-xl border border-border/60 bg-background">
             {fileViewer}
           </div>
         </div>
       )}
    </div>
  );
};
