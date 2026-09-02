import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';

import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { languageByExtension, loadLanguageByExtension } from '@/lib/codemirror/languageByExtension';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { shikiHighlightExtension } from '@/lib/codemirror/shikiHighlight';
import { getResolvedShikiTheme } from '@/lib/shiki/appThemeRegistry';
import { useDeviceInfo } from '@/lib/device';
import { cn, hasModifier } from '@/lib/utils';
import { getLanguageFromExtension, getImageMimeType, isBinaryFile, isDrawioFile, isImageFile, isPdfFile, isSvgFile } from '@/lib/toolHelpers';
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
import { type FileStatus } from './files/FilesViewChrome';
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
  toComparablePath,
  type FileLineEnding,
  type FileNode,
  type FileStatSnapshot,
} from './files/filesViewModel';
import { useAssetAuthRefresh } from './files/useAssetAuthRefresh';
import { FileViewerContent } from './files/FileViewerContent';
import { useFileOperations } from './files/useFileOperations';
import { loadFileDocument } from './files/loadFileDocument';
import { useDirtyFileNavigation, type DirtyFileNavigationIntent } from './files/useDirtyFileNavigation';
import { useFileEditorNavigation } from './files/useFileEditorNavigation';
import { useFileEditorSave } from './files/useFileEditorSave';
import { useFileStatReconciliation } from './files/useFileStatReconciliation';
import { useFileViewerModes } from './files/useFileViewerModes';
import { useFilesTree } from './files/useFilesTree';
import { useFilesViewSearch } from './files/useFilesViewSearch';
import { FileTabsRow } from './files/FileTabsRow';
import { FileViewerToolbar } from './files/FileViewerToolbar';
import { UnsavedChangesDialog } from './files/UnsavedChangesDialog';
import { FilesTreePanel } from './files/FilesTreePanel';

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
  const [loadedFileLineEnding, setLoadedFileLineEnding] = React.useState<FileLineEnding>('\n');
  const diagramEditorRef = React.useRef<React.ComponentRef<typeof DiagramEditor>>(null);
  const activeFileLoadIdRef = React.useRef(0);
  const loadingFilePathRef = React.useRef<string | null>(null);
  const [contentDetectedBinary, setContentDetectedBinary] = React.useState(false);
  const autoSaveEnabled = useUIStore((state) => state.autoSaveEnabled);
  const setAutoSaveEnabled = useUIStore((state) => state.setAutoSaveEnabled);

  const editorWrapperRef = React.useRef<HTMLDivElement | null>(null);

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
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const fileEditorKeymap = useUIStore((state) => state.fileEditorKeymap);
  const settingsDefaultFileViewerPreview = useConfigStore((state) => state.settingsDefaultFileViewerPreview);
  const settingsExpandedEditorToolbar = useUIStore((state) => state.expandedEditorToolbar);

  React.useEffect(() => {
    setDraftContent('');
  }, [selectedFile?.path]);

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
  const {
    clearDiagramContent,
    diagramEditorXml,
    diagramSaved,
    drawioRemountNonce,
    drawioViewMode,
    handleDiagramChange,
    htmlViewMode,
    jsonViewMode,
    mdViewMode,
    recordDiagramContent,
    saveDiagramNow,
    saveDrawioViewMode,
    saveJsonViewMode,
    saveMdViewMode,
    saveTextViewMode,
    setTextViewMode,
    textViewMode,
  } = useFileViewerModes({
    root,
    openPaths,
    selectedPath: selectedFile?.path ?? null,
    defaultPreview: settingsDefaultFileViewerPreview,
    fileContent,
    draftContent,
    setDraftContent,
    autoSaveEnabled,
    writeFile: files.writeFile,
    readStat: readSelectedFileStat,
    recordStat: recordLoadedFileStat,
  });
  const getMdViewMode = React.useCallback(() => mdViewMode, [mdViewMode]);

  const handleFileSaved = React.useCallback((path: string, content: string) => {
    setFileContent(content);
    if (root && isPathWithinRoot(path, root)) {
      const relativePath = getDisplayPath(root, path);
      if (relativePath) {
        sessionEvents.requestGitRefresh({ directory: root, paths: [relativePath] });
      }
    }
    if (isDrawioFile(path)) recordDiagramContent(content);
    // Refresh stat after write so polling does not observe our own stale metadata.
    void readFileStat(path)
      .then((stat) => {
        if (stat) recordLoadedFileStat(stat);
      })
      .catch(() => {});
  }, [readFileStat, recordDiagramContent, recordLoadedFileStat, root]);
  const {
    autoSaveStatus,
    isSaving,
    saveDraft,
    saveNow,
  } = useFileEditorSave({
    autoSaveEnabled,
    selectedPath: selectedFile?.path ?? null,
    loadedPath: loadedFilePath,
    fileLoading,
    isDirty,
    draftContent,
    fileContent,
    lineEnding: loadedFileLineEnding,
    isNonEditableBinary: Boolean(selectedFile?.path && (isBinaryFile(selectedFile.path) || contentDetectedBinary)),
    writeFile: files.writeFile,
    onSaved: handleFileSaved,
  });
  const {
    confirmOpen: confirmDiscardOpen,
    discardAndTakeIntent,
    keepModalOpen: keepDiscardModalOpen,
    requestNavigation,
    saveAndTakeIntent,
  } = useDirtyFileNavigation({ isDirty, saveDraft });

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!hasModifier(e)) {
        return;
      }

      if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveNow();
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveNow]);

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
        recordDiagramContent(result.content);
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
  }, [expandPaths, isDirectoryLoaded, isMobile, loadDirectory, mode, readFile, readFileStat, recordDiagramContent, recordLoadedFileStat, removeOpenPathsByPrefix, root, runtime.isDesktop, searchQuery, setSelectedPath]);

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
    if (requestNavigation({ kind: 'select', file: node })) return;

    if (root) {
      setSelectedPath(root, node.path);
      void ensurePathVisible(node.path, false);
    }

    setFileError(null);
    setDesktopImageSrc('');
    setFileContent('');
    clearDiagramContent();
    setDraftContent('');
    setLoadedFilePath(null);
    if (isMobile) {
      setShowMobilePageContent(true);
    }
  }, [clearDiagramContent, ensurePathVisible, isMobile, requestNavigation, root, setSelectedPath]);

  const handleSelectFilePath = React.useCallback((path: string) => {
    void handleSelectFile(toFileNode(path));
  }, [handleSelectFile, toFileNode]);

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

  const continueNavigation = React.useCallback(async (intent: DirtyFileNavigationIntent) => {
    if (intent.kind === 'select') {
      await handleSelectFile(intent.file);
      return;
    }
    if (intent.kind === 'tab') {
      useUIStore.getState().setActiveMainTab(intent.tab);
      return;
    }

    if (root) removeOpenPath(root, intent.path);
    if (selectedFile?.path !== intent.path) return;
    if (intent.nextFile) {
      await handleSelectFile(intent.nextFile);
    } else {
      clearSelectedFile();
    }
  }, [clearSelectedFile, handleSelectFile, removeOpenPath, root, selectedFile?.path]);

  const discardAndContinue = React.useCallback(() => {
    const intent = discardAndTakeIntent();
    // Discard the draft by reverting to the last loaded content.
    setDraftContent(displayedContent);
    if (intent) void continueNavigation(intent);
  }, [continueNavigation, discardAndTakeIntent, displayedContent]);

  const saveAndContinue = React.useCallback(async () => {
    const intent = await saveAndTakeIntent();
    if (intent) await continueNavigation(intent);
  }, [continueNavigation, saveAndTakeIntent]);

  const handleCloseFile = React.useCallback((path: string) => {
    const isActive = selectedFile?.path === path;
    const intent: DirtyFileNavigationIntent = {
      kind: 'close',
      path,
      nextFile: getNextOpenFile(path, openFiles),
    };
    if (isActive && requestNavigation(intent)) return;
    void continueNavigation(intent);
  }, [continueNavigation, getNextOpenFile, openFiles, requestNavigation, selectedFile?.path]);

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

  const isSelectedImage = Boolean(selectedFile?.path && isImageFile(selectedFile.path));
  const isSelectedSvg = Boolean(selectedFile?.path && isSvgFile(selectedFile.path));
  const isSelectedPdf = Boolean(selectedFile?.path && isPdfFile(selectedFile.path));
  const isSelectedBinary = Boolean(
    selectedFile?.path
    && (isBinaryFile(selectedFile.path) || contentDetectedBinary)
  );
  const isUnsupportedBinary = isSelectedBinary && !isSelectedImage && !isSelectedPdf;

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
  const {
    editorViewRef,
    notifyEditorViewChanged,
    shouldMaskEditor: shouldMaskEditorForPendingNavigation,
  } = useFileEditorNavigation({
    root,
    selectedPath: selectedFilePath || null,
    loadedPath: loadedFilePath,
    fileLoading,
    fileError,
    isImage: isSelectedImage,
    isPdf: isSelectedPdf,
    isUnsupportedBinary,
    canEdit,
    textViewMode,
    setTextViewMode,
    draftContent,
    confirmDiscardOpen,
    selectFilePath: handleSelectFilePath,
  });
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
  }, [canEdit, setTextViewMode, textViewMode]);

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
  }, [editorViewRef, isMobile, nudgeEditorSelectionAboveKeyboard]);

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

  const handleDownloadSelectedFile = React.useCallback(() => {
    const downloadFile = files.downloadFile;
    const path = selectedFile?.path;
    if (!downloadFile || !path) return;
    void downloadFile(path).catch((error) => {
      console.error('Download failed:', error);
      toast.error("Operation failed");
    });
  }, [files.downloadFile, selectedFile?.path]);

  const renderFloatingFileControls = ({
    exitFullscreenOnly = false,
    layout = 'floating',
  }: { exitFullscreenOnly?: boolean; layout?: 'floating' | 'docked' } = {}) => {
    return (
      <FileViewerToolbar
        selectedFile={selectedFile}
        displaySelectedPath={displaySelectedPath}
        layout={layout}
        exitFullscreenOnly={exitFullscreenOnly}
        canEdit={canEdit}
        isEditingFile={isEditingFile}
        isSaving={isSaving}
        autoSaveEnabled={autoSaveEnabled}
        autoSaveStatus={autoSaveStatus}
        isDirty={isDirty}
        onSaveDraft={saveDraft}
        onToggleAutoSave={() => setAutoSaveEnabled(!autoSaveEnabled)}
        openInApps={openInApps}
        openInCacheStale={openInCacheStale}
        onOpenInApp={handleOpenInApp}
        onRefreshOpenInApps={() => loadOpenInApps(true)}
        onToolbarDropdownOpenChange={handleToolbarDropdownOpenChange}
        isSelectedImage={isSelectedImage}
        isSelectedPdf={isSelectedPdf}
        isUnsupportedBinary={isUnsupportedBinary}
        wrapLines={wrapLines}
        onToggleWrapLines={() => setWrapLines(!wrapLines)}
        textViewMode={textViewMode}
        onToggleSearch={() => setIsSearchOpen(!isSearchOpen)}
        isGoToLineOpen={isGoToLineOpen}
        onOpenGoToLineChange={setIsGoToLineOpen}
        editorView={editorViewRef.current}
        canUseShikiFileView={canUseShikiFileView}
        isJson={isJson}
        isHtml={isHtml}
        onToggleTextViewMode={() => {
          saveTextViewMode(textViewMode === 'view' ? 'edit' : 'view');
        }}
        isMarkdown={isMarkdown}
        mdViewMode={getMdViewMode()}
        onToggleMdViewMode={() => saveMdViewMode(getMdViewMode() === 'preview' ? 'edit' : 'preview')}
        isDrawio={isDrawio}
        drawioViewMode={drawioViewMode}
        onToggleDrawioViewMode={() => saveDrawioViewMode(drawioViewMode === 'preview' ? 'edit' : 'preview')}
        diagramSaved={diagramSaved}
        onSaveDiagram={async () => {
          const xml = diagramEditorRef.current?.getXml();
          if (selectedFile?.path && xml) {
            await saveDiagramNow(selectedFile.path, xml);
          }
        }}
        jsonViewMode={jsonViewMode}
        onToggleJsonViewMode={() => saveJsonViewMode(jsonViewMode === 'tree' ? 'text' : 'tree')}
        canCopy={canCopy}
        copiedContent={copiedContent}
        onCopyContent={async () => {
          const result = await copyTextToClipboard(fileContent);
          if (result.ok) {
            showCopiedContent(true);
          } else {
            toast.error("Copy failed");
          }
        }}
        canCopyPath={canCopyPath}
        copiedPath={copiedPath}
        onCopyPath={async () => {
          const result = await copyTextToClipboard(displaySelectedPath);
          if (result.ok) {
            showCopiedPath(true);
          } else {
            toast.error("Copy failed");
          }
        }}
        onDownloadFile={files.downloadFile && selectedFile ? handleDownloadSelectedFile : undefined}
        isMobile={isMobile}
        mode={mode}
        isFullscreen={isFullscreen}
        onToggleFullscreen={() => setIsFullscreen(!isFullscreen)}
        onExitFullscreen={() => setIsFullscreen(false)}
      />
    );
  };

  const handleEmbeddedEditorViewReady = React.useCallback((view: EditorView) => {
    editorViewRef.current = view;
    notifyEditorViewChanged();
    window.requestAnimationFrame(() => {
      nudgeEditorSelectionAboveKeyboard(view);
    });
  }, [editorViewRef, notifyEditorViewChanged, nudgeEditorSelectionAboveKeyboard]);

  const handleEmbeddedEditorViewDestroy = React.useCallback(() => {
    if (editorViewRef.current) editorViewRef.current = null;
    notifyEditorViewChanged();
  }, [editorViewRef, notifyEditorViewChanged]);

  const handleFullscreenEditorViewReady = React.useCallback((view: EditorView) => {
    editorViewRef.current = view;
    window.requestAnimationFrame(() => {
      nudgeEditorSelectionAboveKeyboard(view);
    });
  }, [editorViewRef, nudgeEditorSelectionAboveKeyboard]);

  const handleFullscreenEditorViewDestroy = React.useCallback(() => {
    if (editorViewRef.current) editorViewRef.current = null;
  }, [editorViewRef]);

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
      <UnsavedChangesDialog
        open={confirmDiscardOpen}
        onOpenChange={keepDiscardModalOpen}
        isSaving={isSaving}
        onSaveAndContinue={() => void saveAndContinue()}
        onDiscardAndContinue={discardAndContinue}
      />
      <div className={cn('flex flex-col flex-shrink-0', showEditorTabsRow && 'border-b border-border/40')}>
        {/* Row 1: Tabs */}
        <FileTabsRow
          showEditorTabsRow={showEditorTabsRow}
          isMobile={isMobile}
          showMobilePageContent={showMobilePageContent}
          onBackMobile={() => setShowMobilePageContent(false)}
          selectedFile={selectedFile}
          openFiles={openFiles}
          root={root}
          alwaysShowActions={alwaysShowActions}
          editorTabsOverflow={editorTabsOverflow}
          editorTabsScrollRef={editorTabsScrollRef}
          onSelectFile={handleSelectFile}
          onCloseFile={handleCloseFile}
        />

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

  const treePanel = (
    <FilesTreePanel
      root={root}
      isMobile={isMobile}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      searchInputRef={searchInputRef}
      searching={searching}
      searchResults={searchResults}
      selectedFile={selectedFile}
      onSelectFile={handleSelectFile}
      onOpenDialog={handleOpenDialog}
      currentDirectory={currentDirectory}
      refreshRoot={refreshRoot}
      childrenByDir={childrenByDir}
      loadErrorsByDir={loadErrorsByDir}
      expandedPaths={expandedPaths}
      isBrowserClient={isBrowserClient}
      alwaysShowActions={alwaysShowActions}
      getFileStatus={getFileStatus}
      getFolderBadge={getFolderBadge}
      fileRowPermissions={fileRowPermissions}
      downloadFile={files.downloadFile}
      contextMenuPath={contextMenuPath}
      setContextMenuPath={setContextMenuPath}
      rightClickMenuPath={rightClickMenuPath}
      setRightClickMenuPath={setRightClickMenuPath}
      toggleDirectory={toggleDirectory}
      handleRevealPath={handleRevealPath}
      refreshDirectory={refreshDirectory}
    />
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
