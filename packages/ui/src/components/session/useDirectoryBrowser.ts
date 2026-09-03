import React from 'react';
import { toast } from '@/components/ui';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useFileSystemAccess } from '@/hooks/useFileSystemAccess';
import { listLocalDirectory, pickLocalDirectory } from '@/lib/fsApi';
import { canRequestNativeDirectoryAccess, requestDirectoryAccess } from '@/lib/desktop';
import { isFilesystemError, type FilesystemErrorReason } from '@/lib/api/files-errors';
import {
  absolutePathToDisplayPath,
  appendBrowsePathSegment,
  canNavigateUp,
  displayPathToAbsolutePath,
  ensureBrowseDirectoryPath,
  getBrowseCurrentFolderName,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  normalizeDirectoryPath,
  normalizeSeparators,
  trimTrailingSeparators,
} from './directoryExplorerPaths';
import {
  type BrowseEntry,
  type BrowseRow,
  focusPathInput,
  resolveFreshFilesystemHome,
} from './directoryExplorerTypes';

export function useDirectoryBrowser({
  open,
  addedProjectPaths,
  shouldSuppressAutoFocus,
}: {
  open: boolean;
  addedProjectPaths: Set<string>;
  shouldSuppressAutoFocus: boolean;
}) {
  const homeDirectory = useDirectoryStore((s) => s.homeDirectory);
  const { canRequestAccess, startAccessing } = useFileSystemAccess();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const rowRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const [dialogHomeDirectory, setDialogHomeDirectory] = React.useState('');
  const [query, setQuery] = React.useState('~/');
  const [entries, setEntries] = React.useState<BrowseEntry[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isBrowseDirectoryMissing, setIsBrowseDirectoryMissing] = React.useState(false);
  const [browseErrorReason, setBrowseErrorReason] = React.useState<FilesystemErrorReason | null>(null);
  const [browseReloadKey, setBrowseReloadKey] = React.useState(0);
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const [isPickingLocation, setIsPickingLocation] = React.useState(false);
  const [showHidden, setShowHidden] = React.useState(false);
  const [folderEnterFrom, setFolderEnterFrom] = React.useState<'left' | 'right'>('right');
  const previousBrowsePathRef = React.useRef('~/');

  const explorerRootDirectory = dialogHomeDirectory || homeDirectory;

  React.useEffect(() => {
    if (!open) return;
    setQuery('~/');
    setEntries([]);
    setHighlightedIndex(0);
    setIsPickingLocation(false);
    setShowHidden(false);
    previousBrowsePathRef.current = '~/';
    setFolderEnterFrom('right');
    if (!shouldSuppressAutoFocus) {
      requestAnimationFrame(() => focusPathInput(inputRef.current));
    }

    let cancelled = false;
    const resolveHome = async () => {
      const resolved = await resolveFreshFilesystemHome();
      if (cancelled) return;
      setDialogHomeDirectory(resolved || homeDirectory || '');
      if (!shouldSuppressAutoFocus) {
        requestAnimationFrame(() => focusPathInput(inputRef.current));
      }
    };
    void resolveHome();
    return () => {
      cancelled = true;
    };
  }, [homeDirectory, open, shouldSuppressAutoFocus]);

  const browseDirectoryDisplayPath = React.useMemo(() => getBrowseDirectoryPath(query), [query]);
  const browseFilterQuery = React.useMemo(
    () => (hasTrailingPathSeparator(query) ? '' : getBrowseLeafPathSegment(query)),
    [query],
  );
  const browseDirectoryAbsolutePath = React.useMemo(
    () => (explorerRootDirectory ? displayPathToAbsolutePath(browseDirectoryDisplayPath, explorerRootDirectory) : ''),
    [browseDirectoryDisplayPath, explorerRootDirectory],
  );

  React.useEffect(() => {
    const previous = previousBrowsePathRef.current;
    if (previous === browseDirectoryDisplayPath) return;
    setFolderEnterFrom(browseDirectoryDisplayPath.length >= previous.length ? 'right' : 'left');
    previousBrowsePathRef.current = browseDirectoryDisplayPath;
  }, [browseDirectoryDisplayPath]);

  React.useEffect(() => {
    if (!open || !browseDirectoryAbsolutePath) {
      setEntries([]);
      setBrowseErrorReason(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setIsBrowseDirectoryMissing(false);
    setBrowseErrorReason(null);
    listLocalDirectory(browseDirectoryAbsolutePath)
      .then((result) => {
        if (cancelled) return;
        setIsBrowseDirectoryMissing(false);
        setBrowseErrorReason(null);
        const nextEntries = result
          .filter((entry) => entry.isDirectory)
          .map((entry) => ({
            name: entry.name,
            path: normalizeSeparators(entry.path),
          }))
          .sort((left, right) => left.name.localeCompare(right.name));
        setEntries(nextEntries);
      })
      .catch((error) => {
        if (!cancelled) {
          setEntries([]);
          const reason = isFilesystemError(error) ? error.reason : 'unknown';
          setBrowseErrorReason(reason);
          setIsBrowseDirectoryMissing(reason === 'not-found');
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [browseDirectoryAbsolutePath, browseReloadKey, open]);

  const filteredEntries = React.useMemo(() => {
    const lowerFilter = browseFilterQuery.toLowerCase();
    const includeHidden = showHidden || browseFilterQuery.startsWith('.');
    return entries.filter(
      (entry) =>
        entry.name.toLowerCase().startsWith(lowerFilter) && (includeHidden || !entry.name.startsWith('.')),
    );
  }, [browseFilterQuery, entries, showHidden]);

  const currentFolderName = React.useMemo(() => getBrowseCurrentFolderName(query), [query]);
  const parentPath = React.useMemo(() => getBrowseParentPath(query), [query]);

  const rows = React.useMemo<BrowseRow[]>(() => {
    const nextRows: BrowseRow[] = [];
    const currentNormalized = normalizeDirectoryPath(browseDirectoryAbsolutePath);
    if (canNavigateUp(query) && currentFolderName && parentPath) {
      nextRows.push({
        type: 'parent',
        value: 'browse:up',
        name: currentFolderName,
        path: parentPath,
        alreadyAdded: Boolean(currentNormalized && addedProjectPaths.has(currentNormalized)),
      });
    }
    for (const entry of filteredEntries) {
      const normalized = normalizeDirectoryPath(entry.path);
      nextRows.push({
        type: 'directory',
        value: `browse:${entry.path}`,
        name: entry.name,
        path: entry.path,
        alreadyAdded: Boolean(normalized && addedProjectPaths.has(normalized)),
      });
    }
    return nextRows;
  }, [addedProjectPaths, browseDirectoryAbsolutePath, currentFolderName, filteredEntries, parentPath, query]);

  React.useEffect(() => {
    setHighlightedIndex(0);
  }, [query, rows.length]);

  const targetPath = React.useMemo(() => {
    if (!explorerRootDirectory) return '';
    return trimTrailingSeparators(displayPathToAbsolutePath(query, explorerRootDirectory));
  }, [explorerRootDirectory, query]);

  const normalizedTargetPath = normalizeDirectoryPath(targetPath);
  const isAlreadyAdded = Boolean(normalizedTargetPath && addedProjectPaths.has(normalizedTargetPath));

  const exactEntry = React.useMemo(() => {
    if (!browseFilterQuery) return null;
    return filteredEntries.find((entry) => entry.name === browseFilterQuery) ?? null;
  }, [browseFilterQuery, filteredEntries]);

  const shouldCreateTarget = Boolean(
    targetPath &&
      !isAlreadyAdded &&
      (browseErrorReason === null || browseErrorReason === 'not-found') &&
      ((hasTrailingPathSeparator(query) && isBrowseDirectoryMissing) ||
        (!hasTrailingPathSeparator(query) && browseFilterQuery.trim().length > 0 && exactEntry === null)),
  );

  const highlightedRow = rows[highlightedIndex] ?? null;
  const hasHighlightedBrowseItem = Boolean(highlightedRow);

  const browseToDisplayPath = React.useCallback((displayPath: string) => {
    setQuery(ensureBrowseDirectoryPath(displayPath));
  }, []);

  const browseToEntry = React.useCallback(
    (entry: BrowseEntry) => {
      setQuery(appendBrowsePathSegment(query, entry.name));
    },
    [query],
  );

  const executeRow = React.useCallback(
    (row: BrowseRow | null) => {
      if (!row) return;
      if (row.type === 'parent') {
        browseToDisplayPath(row.path);
        return;
      }
      browseToEntry(row);
    },
    [browseToDisplayPath, browseToEntry],
  );

  const applyPickedLocation = React.useCallback(
    async (pickedPath: string) => {
      const accessResult = await startAccessing(pickedPath);
      if (!accessResult.success) {
        toast.error('Failed to open directory', {
          description: accessResult.error || 'Desktop could not grant file access.',
        });
        return false;
      }
      const displayPath = explorerRootDirectory
        ? absolutePathToDisplayPath(pickedPath, explorerRootDirectory)
        : ensureBrowseDirectoryPath(normalizeSeparators(pickedPath));
      browseToDisplayPath(displayPath);
      return true;
    },
    [browseToDisplayPath, explorerRootDirectory, startAccessing],
  );

  const handleBrowseLocation = React.useCallback(async () => {
    if (isPickingLocation) return;
    setIsPickingLocation(true);
    try {
      if (canRequestNativeDirectoryAccess()) {
        const result = await requestDirectoryAccess(targetPath);
        if (!result.success || !result.path) {
          if (result.error && result.error !== 'Directory selection cancelled') {
            toast.error('Failed to select directory', {
              description: result.error,
            });
          }
          return;
        }
        await applyPickedLocation(result.path);
        return;
      }

      const picked = await pickLocalDirectory(targetPath);
      if (picked.status === 'cancelled') return;
      if (picked.status !== 'picked') {
        toast.error("Couldn't open a folder picker", {
          description: picked.error,
        });
        return;
      }
      await applyPickedLocation(picked.path);
    } catch (error) {
      toast.error('Failed to select directory', {
        description: error instanceof Error ? error.message : 'Unknown error occurred.',
      });
    } finally {
      setIsPickingLocation(false);
    }
  }, [applyPickedLocation, isPickingLocation, targetPath]);

  return {
    inputRef,
    rowRefs,
    query,
    setQuery,
    isLoading,
    isBrowseDirectoryMissing,
    browseErrorReason,
    browseReloadKey,
    setBrowseReloadKey,
    highlightedIndex,
    setHighlightedIndex,
    isPickingLocation,
    showHidden,
    setShowHidden,
    folderEnterFrom,
    explorerRootDirectory,
    browseDirectoryDisplayPath,
    browseDirectoryAbsolutePath,
    browseFilterQuery,
    filteredEntries,
    rows,
    targetPath,
    isAlreadyAdded,
    shouldCreateTarget,
    highlightedRow,
    hasHighlightedBrowseItem,
    canRequestAccess,
    browseToDisplayPath,
    browseToEntry,
    executeRow,
    applyPickedLocation,
    handleBrowseLocation,
  };
}
