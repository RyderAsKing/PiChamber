import React from 'react';
import { toast } from '@/components/ui';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useFileSystemAccess } from '@/hooks/useFileSystemAccess';
import { listLocalDirectory, pickLocalDirectory } from '@/lib/fsApi';
import { canRequestNativeDirectoryAccess, requestDirectoryAccess } from '@/lib/desktop';
import { isFilesystemError, type FilesystemErrorReason } from '@/lib/api/files-errors';
import {
  absolutePathToDisplayPath,
  canNavigateUp,
  displayPathToAbsolutePath,
  ensureBrowseDirectoryPath,
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
  resolveFreshFilesystemHome,
} from './directoryExplorerTypes';

/** One folder's listing, tagged with the path it was read for. */
type Listing = {
  displayDir: string;
  absoluteDir: string;
  entries: BrowseEntry[];
  error: FilesystemErrorReason | null;
};

const readListing = async (displayDir: string, absoluteDir: string): Promise<Listing> => {
  try {
    const result = await listLocalDirectory(absoluteDir);
    const entries = result
      .filter((entry) => entry.isDirectory)
      .map((entry) => ({ name: entry.name, path: normalizeSeparators(entry.path) }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return { displayDir, absoluteDir, entries, error: null };
  } catch (error) {
    return { displayDir, absoluteDir, entries: [], error: isFilesystemError(error) ? error.reason : 'unknown' };
  }
};

/** How long a folder may take to list before the list says it's loading. */
const LOADING_NOTICE_DELAY_MS = 250;

/**
 * The folder listing behind the Add folder dialog's path field.
 *
 * Moving between folders reads the next folder first and switches the path and
 * the list together, so the list never empties or flashes a loading state on
 * the way. A newer move or a typed path supersedes one still loading. While a
 * typed path is still being read, the list keeps showing the last folder read;
 * its rows carry their own targets, so they stay correct to click.
 */
export function useDirectoryBrowser({
  open,
  addedProjectPaths,
}: {
  open: boolean;
  addedProjectPaths: Set<string>;
}) {
  const homeDirectory = useDirectoryStore((s) => s.homeDirectory);
  const { canRequestAccess, startAccessing } = useFileSystemAccess();
  const [dialogHomeDirectory, setDialogHomeDirectory] = React.useState('');
  const [query, setQuery] = React.useState('~/');
  const [listing, setListing] = React.useState<Listing | null>(null);
  const [showLoading, setShowLoading] = React.useState(false);
  const [isPickingLocation, setIsPickingLocation] = React.useState(false);
  const [showHidden, setShowHidden] = React.useState(false);
  const generationRef = React.useRef(0);

  const explorerRootDirectory = dialogHomeDirectory || homeDirectory;

  React.useEffect(() => {
    if (!open) return;
    generationRef.current += 1;
    setQuery('~/');
    setListing(null);
    setIsPickingLocation(false);
    setShowHidden(false);

    let cancelled = false;
    const resolveHome = async () => {
      const resolved = await resolveFreshFilesystemHome();
      if (cancelled) return;
      setDialogHomeDirectory(resolved || homeDirectory || '');
    };
    void resolveHome();
    return () => {
      cancelled = true;
    };
  }, [homeDirectory, open]);

  const browseDirectoryDisplayPath = React.useMemo(() => getBrowseDirectoryPath(query), [query]);
  const browseFilterQuery = React.useMemo(
    () => (hasTrailingPathSeparator(query) ? '' : getBrowseLeafPathSegment(query)),
    [query],
  );
  const browseDirectoryAbsolutePath = React.useMemo(
    () => (explorerRootDirectory ? displayPathToAbsolutePath(browseDirectoryDisplayPath, explorerRootDirectory) : ''),
    [browseDirectoryDisplayPath, explorerRootDirectory],
  );

  const isSettled = Boolean(
    listing &&
      listing.displayDir === browseDirectoryDisplayPath &&
      listing.absoluteDir === browseDirectoryAbsolutePath,
  );

  // A typed path (or the first open) reads its folder here; moves made through
  // `navigate` arrive with their listing already read and skip this.
  React.useEffect(() => {
    if (!open || !browseDirectoryAbsolutePath || isSettled) return;
    const generation = ++generationRef.current;
    void readListing(browseDirectoryDisplayPath, browseDirectoryAbsolutePath).then((next) => {
      if (generation === generationRef.current) setListing(next);
    });
  }, [browseDirectoryAbsolutePath, browseDirectoryDisplayPath, isSettled, open]);

  React.useEffect(() => {
    if (isSettled || !browseDirectoryAbsolutePath) {
      setShowLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setShowLoading(true), LOADING_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [browseDirectoryAbsolutePath, isSettled]);

  /**
   * Reads `displayPath`, then shows it: path and list change together.
   * Resolves false when a newer move or typed path superseded this one.
   */
  const navigate = React.useCallback(
    async (displayPath: string): Promise<boolean> => {
      const nextQuery = ensureBrowseDirectoryPath(displayPath);
      if (!explorerRootDirectory) {
        setQuery(nextQuery);
        return true;
      }
      const generation = ++generationRef.current;
      const next = await readListing(nextQuery, displayPathToAbsolutePath(nextQuery, explorerRootDirectory));
      if (generation !== generationRef.current) return false;
      setListing(next);
      setQuery(nextQuery);
      return true;
    },
    [explorerRootDirectory],
  );

  const reload = React.useCallback(() => {
    if (!browseDirectoryAbsolutePath) return;
    const generation = ++generationRef.current;
    void readListing(browseDirectoryDisplayPath, browseDirectoryAbsolutePath).then((next) => {
      if (generation === generationRef.current) setListing(next);
    });
  }, [browseDirectoryAbsolutePath, browseDirectoryDisplayPath]);

  // Until a typed folder is read, filter the folder still shown by the part of
  // the path typed into it, so the list doesn't jump while the read finishes.
  const listedFilter = React.useMemo(() => {
    if (isSettled) return browseFilterQuery;
    if (!listing || !query.startsWith(listing.displayDir)) return '';
    return query.slice(listing.displayDir.length).split('/')[0] ?? '';
  }, [browseFilterQuery, isSettled, listing, query]);

  const filteredEntries = React.useMemo(() => {
    if (!listing) return [];
    const lowerFilter = listedFilter.toLowerCase();
    const includeHidden = showHidden || listedFilter.startsWith('.');
    return listing.entries.filter(
      (entry) =>
        entry.name.toLowerCase().startsWith(lowerFilter) && (includeHidden || !entry.name.startsWith('.')),
    );
  }, [listedFilter, listing, showHidden]);

  const rows = React.useMemo<BrowseRow[]>(() => {
    if (!listing || listing.error) return [];
    const nextRows: BrowseRow[] = [];
    const parentPath = canNavigateUp(listing.displayDir) ? getBrowseParentPath(listing.displayDir) : null;
    if (parentPath) {
      const current = normalizeDirectoryPath(listing.absoluteDir);
      nextRows.push({
        type: 'parent',
        value: 'browse:up',
        name: '..',
        path: listing.absoluteDir,
        target: parentPath,
        alreadyAdded: Boolean(current && addedProjectPaths.has(current)),
      });
    }
    for (const entry of filteredEntries) {
      const normalized = normalizeDirectoryPath(entry.path);
      nextRows.push({
        type: 'directory',
        value: `browse:${entry.path}`,
        name: entry.name,
        path: entry.path,
        target: `${ensureBrowseDirectoryPath(listing.displayDir)}${entry.name}/`,
        alreadyAdded: Boolean(normalized && addedProjectPaths.has(normalized)),
      });
    }
    return nextRows;
  }, [addedProjectPaths, filteredEntries, listing]);

  const browseErrorReason = isSettled ? (listing?.error ?? null) : null;
  const entries = React.useMemo(() => (isSettled && listing ? listing.entries : []), [isSettled, listing]);

  const targetPath = React.useMemo(() => {
    if (!explorerRootDirectory) return '';
    return trimTrailingSeparators(displayPathToAbsolutePath(query, explorerRootDirectory));
  }, [explorerRootDirectory, query]);

  const normalizedTargetPath = normalizeDirectoryPath(targetPath);
  const isAlreadyAdded = Boolean(normalizedTargetPath && addedProjectPaths.has(normalizedTargetPath));

  const exactEntry = React.useMemo(() => {
    if (!browseFilterQuery) return null;
    return entries.find((entry) => entry.name === browseFilterQuery) ?? null;
  }, [browseFilterQuery, entries]);

  const shouldCreateTarget = Boolean(
    isSettled &&
      targetPath &&
      !isAlreadyAdded &&
      (browseErrorReason === null || browseErrorReason === 'not-found') &&
      ((hasTrailingPathSeparator(query) && browseErrorReason === 'not-found') ||
        (!hasTrailingPathSeparator(query) && browseFilterQuery.trim().length > 0 && exactEntry === null)),
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
      await navigate(displayPath);
      return true;
    },
    [explorerRootDirectory, navigate, startAccessing],
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
    query,
    setQuery,
    /** False while the folder the path points at is still being read. */
    isSettled,
    /** True once a read has taken long enough to say so. */
    showLoading,
    browseErrorReason,
    reload,
    isPickingLocation,
    showHidden,
    setShowHidden,
    explorerRootDirectory,
    browseDirectoryDisplayPath,
    browseDirectoryAbsolutePath,
    browseFilterQuery,
    entries,
    rows,
    targetPath,
    isAlreadyAdded,
    shouldCreateTarget,
    canRequestAccess,
    navigate,
    handleBrowseLocation,
  };
}
