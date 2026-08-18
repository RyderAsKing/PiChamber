import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useFileSystemAccess } from '@/hooks/useFileSystemAccess';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { IdentityDropdown } from '@/components/views/git/GitHeader';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useDeviceInfo } from '@/lib/device';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { Icon } from "@/components/icon/Icon";
import { getFilesystemHome, listLocalDirectory, pickLocalDirectory } from '@/lib/fsApi';
import { canRequestNativeDirectoryAccess, requestDirectoryAccess } from '@/lib/desktop';

import {
  isFilesystemError,
  type FilesystemErrorReason,
} from '@/lib/api/files-errors';
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

interface DirectoryExplorerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type BrowseEntry = {
  name: string;
  path: string;
};

type BrowseRow =
  | { type: 'parent'; value: 'browse:up'; name: string; path: string; alreadyAdded: boolean }
  | { type: 'directory'; value: string; name: string; path: string; alreadyAdded: boolean };

const isPrimaryModifierPressed = (event: React.KeyboardEvent<HTMLInputElement>): boolean => {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
};

const focusPathInput = (input: HTMLInputElement | null): void => {
  if (!input) return;
  input.focus({ preventScroll: true });
  const valueLength = input.value.length;
  input.setSelectionRange(valueLength, valueLength);
  input.scrollLeft = input.scrollWidth;
};

const resolveFreshFilesystemHome = async (): Promise<string | null> => {
  return getFilesystemHome();
};

export const DirectoryExplorerDialog: React.FC<DirectoryExplorerDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const homeDirectory = useDirectoryStore((s) => s.homeDirectory);
  const projects = useProjectsStore((s) => s.projects);
  const addProject = useProjectsStore((s) => s.addProject);
  const setActiveMainTab = useUIStore((s) => s.setActiveMainTab);
  const setSessionSwitcherOpen = useUIStore((s) => s.setSessionSwitcherOpen);
  const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
  const gitIdentityProfiles = useGitIdentitiesStore((s) => s.profiles);
  const globalGitIdentity = useGitIdentitiesStore((s) => s.globalIdentity);
  const defaultGitIdentityId = useGitIdentitiesStore((s) => s.defaultGitIdentityId);
  const loadGitIdentityProfiles = useGitIdentitiesStore((s) => s.loadProfiles);
  const loadGlobalGitIdentity = useGitIdentitiesStore((s) => s.loadGlobalIdentity);
  const loadDefaultGitIdentityId = useGitIdentitiesStore((s) => s.loadDefaultGitIdentityId);
  const { canRequestAccess, startAccessing } = useFileSystemAccess();
  const { isMobile } = useDeviceInfo();
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
  const [isConfirming, setIsConfirming] = React.useState(false);
  const [isPickingLocation, setIsPickingLocation] = React.useState(false);
  const [isCloneMode, setIsCloneMode] = React.useState(false);
  const [cloneRemoteUrl, setCloneRemoteUrl] = React.useState('');
  const [selectedGitIdentityId, setSelectedGitIdentityId] = React.useState<string | null>(null);
  const [showHidden, setShowHidden] = React.useState(false);
  const [folderEnterFrom, setFolderEnterFrom] = React.useState<'left' | 'right'>('right');
  const previousBrowsePathRef = React.useRef('~/');

  const explorerRootDirectory = dialogHomeDirectory || homeDirectory;

  const addedProjectPaths = React.useMemo(() => new Set(
    projects
      .map((project) => normalizeDirectoryPath(project.path))
      .filter((path): path is string => Boolean(path))
  ), [projects]);

  React.useEffect(() => {
    if (!open) return;
    setQuery('~/');
    setEntries([]);
    setHighlightedIndex(0);
    setIsConfirming(false);
    setIsPickingLocation(false);
    setIsCloneMode(false);
    setCloneRemoteUrl('');
    setSelectedGitIdentityId(null);
    setShowHidden(false);
    previousBrowsePathRef.current = '~/';
    setFolderEnterFrom('right');
    requestAnimationFrame(() => focusPathInput(inputRef.current));

    let cancelled = false;
    const resolveHome = async () => {
      const resolved = await resolveFreshFilesystemHome();
      if (cancelled) return;
      setDialogHomeDirectory(resolved || homeDirectory || '');
      requestAnimationFrame(() => focusPathInput(inputRef.current));
    };
    void resolveHome();
    return () => {
      cancelled = true;
    };
  }, [homeDirectory, open]);

  React.useEffect(() => {
    if (!open) return;
    void loadGitIdentityProfiles();
    void loadGlobalGitIdentity();
    void loadDefaultGitIdentityId();
  }, [loadDefaultGitIdentityId, loadGitIdentityProfiles, loadGlobalGitIdentity, open]);

  const availableGitIdentities = React.useMemo(() => {
    const unique = new Map<string, NonNullable<typeof globalGitIdentity>>();
    if (globalGitIdentity) {
      unique.set(globalGitIdentity.id, globalGitIdentity);
    }
    for (const profile of gitIdentityProfiles) {
      unique.set(profile.id, profile);
    }
    return Array.from(unique.values());
  }, [gitIdentityProfiles, globalGitIdentity]);

  React.useEffect(() => {
    if (!open || !isCloneMode || selectedGitIdentityId !== null) return;
    const defaultId = typeof defaultGitIdentityId === 'string' ? defaultGitIdentityId.trim() : '';
    if (defaultId && availableGitIdentities.some((identity) => identity.id === defaultId)) {
      setSelectedGitIdentityId(defaultId);
      return;
    }
    const firstSshIdentity = availableGitIdentities.find((identity) => identity.authType === 'ssh' || identity.sshKey);
    if (firstSshIdentity) {
      setSelectedGitIdentityId(firstSshIdentity.id);
    }
  }, [availableGitIdentities, defaultGitIdentityId, isCloneMode, open, selectedGitIdentityId]);

  const selectedGitIdentity = React.useMemo(
    () => availableGitIdentities.find((identity) => identity.id === selectedGitIdentityId) ?? null,
    [availableGitIdentities, selectedGitIdentityId]
  );

  const browseDirectoryDisplayPath = React.useMemo(() => getBrowseDirectoryPath(query), [query]);
  const browseFilterQuery = React.useMemo(
    () => (hasTrailingPathSeparator(query) ? '' : getBrowseLeafPathSegment(query)),
    [query]
  );
  const browseDirectoryAbsolutePath = React.useMemo(
    () => explorerRootDirectory ? displayPathToAbsolutePath(browseDirectoryDisplayPath, explorerRootDirectory) : '',
    [browseDirectoryDisplayPath, explorerRootDirectory]
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
    return entries.filter((entry) => (
      entry.name.toLowerCase().startsWith(lowerFilter) && (includeHidden || !entry.name.startsWith('.'))
    ));
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
    targetPath
    && !isAlreadyAdded
    && (browseErrorReason === null || browseErrorReason === 'not-found')
    && (
      (hasTrailingPathSeparator(query) && isBrowseDirectoryMissing)
      || (!hasTrailingPathSeparator(query) && browseFilterQuery.trim().length > 0 && exactEntry === null)
    )
  );
  const canAddFolder = !isConfirming
    && !isPickingLocation
    && !isAlreadyAdded
    && browseErrorReason !== 'os-permission'
    && browseErrorReason !== 'invalid-response'
    && browseErrorReason !== 'unknown'
    && Boolean(targetPath);
  const canSubmitClone = canAddFolder && cloneRemoteUrl.trim().length > 0;
  const highlightedRow = rows[highlightedIndex] ?? null;
  const hasHighlightedBrowseItem = Boolean(highlightedRow);
  const submitModifierLabel = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    ? '⌘'
    : 'Ctrl';
  const submitActionLabel = isAlreadyAdded
    ? "Already added"
    : isCloneMode
      ? isConfirming
        ? "Cloning..."
        : "Clone & add"
    : isConfirming
      ? "Adding..."
    : shouldCreateTarget
      ? "Create & add"
      : "Add folder";
  const canSubmit = isCloneMode ? canSubmitClone : canAddFolder;

  React.useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.scrollLeft = input.scrollWidth;
  }, [query]);

  React.useLayoutEffect(() => {
    if (!open) return;
    focusPathInput(inputRef.current);
  }, [open]);

  React.useLayoutEffect(() => {
    const row = rows[highlightedIndex];
    if (!row) return;
    rowRefs.current.get(row.value)?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, rows]);

  const handleClose = React.useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const openProjectDraft = React.useCallback((projectId: string, projectPath: string) => {
    setActiveMainTab('chat');
    if (isMobile) setSessionSwitcherOpen(false);
    openNewSessionDraft({ selectedProjectId: projectId, directoryOverride: projectPath });
    handleClose();
  }, [handleClose, isMobile, openNewSessionDraft, setActiveMainTab, setSessionSwitcherOpen]);

  const finalizeSelection = React.useCallback(async (target: string) => {
    if (!target || isConfirming) return;
    const normalized = normalizeDirectoryPath(target);
    if (normalized && addedProjectPaths.has(normalized)) return;
    let selectedTarget = target;

    setIsConfirming(true);
    try {
      const shouldCreateSelection = !isCloneMode && shouldCreateTarget && normalizeDirectoryPath(target) === normalizeDirectoryPath(targetPath);
      if (isCloneMode) {
        const remoteUrl = cloneRemoteUrl.trim();
        if (!remoteUrl) {
          toast.error("Enter a repository URL before cloning.");
          return;
        }
        const response = await runtimeFetch('/api/git/clone', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            remoteUrl,
            destinationPath: target,
            gitIdentityId: selectedGitIdentity?.id ?? null,
          }),
        });
        if (!response.ok) {
          throw new Error('Failed to clone git repository');
        }
        const data = (await response.json()) as { path?: string };
        selectedTarget = data.path || target;
      } else if (shouldCreateSelection) {
        const response = await runtimeFetch('/api/fs/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          query: browseDirectoryAbsolutePath ? { directory: browseDirectoryAbsolutePath } : undefined,
          body: JSON.stringify({ path: target }),
        });
        if (!response.ok) {
          throw new Error("Failed to select directory");
        }
      }
      const project = addProject(selectedTarget);
      if (!project) {
        toast.error("Failed to add folder", {
          description: "Please select a valid directory path.",
        });
        return;
      }
      openProjectDraft(project.id, project.path);
    } catch (error) {
      toast.error("Failed to select directory", {
        description: error instanceof Error ? error.message : "Unknown error occurred.",
      });
    } finally {
      setIsConfirming(false);
    }
  }, [addProject, addedProjectPaths, browseDirectoryAbsolutePath, cloneRemoteUrl, isCloneMode, isConfirming, openProjectDraft, selectedGitIdentity?.id, shouldCreateTarget, targetPath]);

  const browseToDisplayPath = React.useCallback((displayPath: string) => {
    setQuery(ensureBrowseDirectoryPath(displayPath));
  }, []);

  const browseToEntry = React.useCallback((entry: BrowseEntry) => {
    setQuery(appendBrowsePathSegment(query, entry.name));
  }, [query]);

  const executeRow = React.useCallback((row: BrowseRow | null) => {
    if (!row) return;
    if (row.type === 'parent') {
      browseToDisplayPath(row.path);
      return;
    }
    browseToEntry(row);
  }, [browseToDisplayPath, browseToEntry]);

  const applyPickedLocation = React.useCallback(async (pickedPath: string) => {
    const accessResult = await startAccessing(pickedPath);
    if (!accessResult.success) {
      toast.error("Failed to open directory", {
        description: accessResult.error || "Desktop could not grant file access.",
      });
      return false;
    }
    const displayPath = explorerRootDirectory
      ? absolutePathToDisplayPath(pickedPath, explorerRootDirectory)
      : ensureBrowseDirectoryPath(normalizeSeparators(pickedPath));
    browseToDisplayPath(displayPath);
    return true;
  }, [browseToDisplayPath, explorerRootDirectory, startAccessing]);

  const handleBrowseLocation = React.useCallback(async () => {
    if (isPickingLocation) return;
    setIsPickingLocation(true);
    try {
      if (canRequestNativeDirectoryAccess()) {
        const result = await requestDirectoryAccess(targetPath);
        if (!result.success || !result.path) {
          if (result.error && result.error !== 'Directory selection cancelled') {
            toast.error("Failed to select directory", {
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
      toast.error("Failed to select directory", {
        description: error instanceof Error ? error.message : "Unknown error occurred.",
      });
    } finally {
      setIsPickingLocation(false);
    }
  }, [applyPickedLocation, isPickingLocation, targetPath]);

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightedIndex((index) => Math.min(rows.length - 1, index + 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (isPrimaryModifierPressed(event)) {
        void finalizeSelection(targetPath);
        return;
      }
      if (hasHighlightedBrowseItem) {
        executeRow(highlightedRow);
      }
      return;
    }
    if (event.key === 'Backspace' && query === '') {
      event.preventDefault();
      handleClose();
    }
  }, [executeRow, finalizeSelection, handleClose, hasHighlightedBrowseItem, highlightedRow, query, rows.length, targetPath]);

  const showHiddenToggle = (
    <button
      type="button"
      onClick={() => setShowHidden((value) => !value)}
      className="flex flex-shrink-0 items-center gap-2 rounded-lg px-2 py-1 typography-meta text-muted-foreground transition-colors hover:bg-interactive-hover/40"
    >
      {showHidden ? <Icon name="checkbox" className="h-4 w-4 text-primary" /> : <Icon name="checkbox-blank" className="h-4 w-4" />}
      {"Show hidden"}
    </button>
  );

  const inputSection = (
    <div className="py-1.5">
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Icon name="folder-3" className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/80" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(normalizeSeparators(event.target.value))}
            onKeyDown={handleKeyDown}
            placeholder={"Enter a folder path..."}
            className="border-transparent bg-transparent pl-9 font-mono typography-ui-label shadow-none focus-visible:ring-0"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
        </div>
        <Button
          variant="outline"
          size="xs"
          className="h-8 shrink-0 gap-1 px-2"
          disabled={isConfirming || isPickingLocation}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void handleBrowseLocation()}
          title={"Browse location"}
          aria-label={"Browse location"}
        >
          <Icon name="folder-open" className="h-3.5 w-3.5" />
          {isPickingLocation ? "Opening..." : "Browse"}
        </Button>
      </div>
    </div>
  );

  const hasParentRow = rows.some((row) => row.type === 'parent');

  const resultsSection = (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border/60 bg-[var(--surface-elevated)] shadow-sm">
      <div className="max-h-[min(28rem,58vh)] overflow-y-auto p-2">
        <div className="flex items-center justify-between gap-2 px-2 pb-1 pt-0.5">
          <div className="typography-meta font-medium uppercase tracking-wide text-muted-foreground/80">
            {"Directories"}
          </div>
          <Button
            variant="ghost"
            size="xs"
            className="h-6 shrink-0 gap-1 text-muted-foreground"
            aria-pressed={isCloneMode}
            disabled={isConfirming || isPickingLocation}
            onClick={() => setIsCloneMode((value) => !value)}
          >
            <Icon name="git-repository" className="h-3.5 w-3.5" />
            {"Clone"}
          </Button>
        </div>
        {isCloneMode ? (
          <div className="mb-2 space-y-1.5 px-2 pb-1">
            <p className="typography-meta text-muted-foreground">
              {"Clone into the folder path above."}
            </p>
            <div className="flex items-center gap-1.5">
              <Input
                value={cloneRemoteUrl}
                onChange={(event) => setCloneRemoteUrl(event.target.value)}
                placeholder={"Repository URL (HTTPS or SSH)"}
                className="min-w-0 flex-1 font-mono typography-ui-label"
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
              />
              <IdentityDropdown
                activeProfile={selectedGitIdentity}
                identities={availableGitIdentities}
                onSelect={(profile) => setSelectedGitIdentityId(profile.id)}
                isApplying={isConfirming}
                iconOnly
              />
            </div>
          </div>
        ) : null}
        {isAlreadyAdded ? (
          <p className="px-2 pb-2 typography-meta text-muted-foreground">
            {"This folder is already added. Open a subfolder to add that instead."}
          </p>
        ) : null}
        <div
          key={browseDirectoryDisplayPath}
          className={cn(
            'mt-3',
            'animate-in fade-in-0 duration-200 motion-reduce:animate-none',
            folderEnterFrom === 'left' ? 'slide-in-from-left-2' : 'slide-in-from-right-2'
          )}
        >
        {isLoading ? (
          <div className="py-10 text-center typography-ui-label text-muted-foreground">
            {"Loading directories..."}
          </div>
        ) : browseErrorReason && browseErrorReason !== 'not-found' ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <div className="typography-ui-label text-status-error">
              {browseErrorReason === 'os-permission'
                ? "PiChamber needs access to this folder."
                : "Could not load this folder."}
            </div>
            <div className="flex items-center gap-2">
              {browseErrorReason === 'os-permission' && canRequestAccess ? (
                <Button size="xs" onClick={() => void handleBrowseLocation()} disabled={isPickingLocation}>
                  {"Grant access"}
                </Button>
              ) : null}
              <Button variant="outline" size="xs" onClick={() => setBrowseReloadKey((key) => key + 1)}>
                {"Try again"}
              </Button>
            </div>
          </div>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center typography-ui-label text-muted-foreground">
            {"No matching directories."}
          </div>
        ) : (
          <div className="space-y-0.5">
            {rows.map((row, index) => {
              const isActive = index === highlightedIndex;
              const isChildRow = row.type === 'directory' && hasParentRow;
              return (
                <button
                  key={row.value}
                  ref={(node) => {
                    if (node) {
                      rowRefs.current.set(row.value, node);
                    } else {
                      rowRefs.current.delete(row.value);
                    }
                  }}
                  type="button"
                  aria-label={
                    row.type === 'parent'
                      ? (row.alreadyAdded ? `Go back from ${row.name}, already added` : `Go back from ${row.name}`)
                      : (row.alreadyAdded ? `Open ${row.name}, already added` : `Open ${row.name}`)
                  }
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => executeRow(row)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                    isActive && 'bg-interactive-selection text-interactive-selection-foreground',
                    !isActive && 'hover:bg-interactive-hover/50'
                  )}
                >
                  <span className={cn('flex min-w-0 flex-1 items-center gap-2', isChildRow && 'pl-4')}>
                    {row.type === 'parent' ? (
                      <Icon name="folder-open" className="h-4 w-4 flex-shrink-0 text-muted-foreground/80" />
                    ) : (
                      <Icon name="folder-6" className="h-4 w-4 flex-shrink-0 text-muted-foreground/80" />
                    )}
                    <span className="truncate typography-ui-label text-foreground">{row.name}</span>
                  </span>
                  {row.alreadyAdded ? (
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 typography-meta font-medium',
                        isActive
                          ? 'bg-interactive-selection-foreground/15 text-interactive-selection-foreground'
                          : 'bg-[var(--surface-muted)] text-foreground'
                      )}
                    >
                      {"Added"}
                    </span>
                  ) : null}
                  {row.type === 'parent' ? (
                    <Icon name="arrow-up-s" className="h-4 w-4 flex-shrink-0 text-muted-foreground/80" aria-hidden="true" />
                  ) : (
                    <Icon name="arrow-right-s" className="h-4 w-4 flex-shrink-0 text-muted-foreground/80" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>
        )}
        </div>
      </div>
    </div>
  );

  const content = (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {inputSection}
      {resultsSection}
    </div>
  );

  const footerHints = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 typography-micro text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
        <Icon name="arrow-down-s" className="-ml-1 h-3.5 w-3.5" />
        {"Navigate"}
      </span>
      <span className="inline-flex items-center gap-1">
        <Icon name="corner-down-left" className="h-3.5 w-3.5" />
        {"Open folder"}
      </span>
      <span className="inline-flex items-center gap-1">
        <span>{submitModifierLabel}</span>
        <Icon name="corner-down-left" className="h-3.5 w-3.5" />
        {"Add folder"}
      </span>
    </div>
  );

  const addFolderButton = (
    <Button
      size={isMobile ? 'xs' : 'default'}
      onClick={() => void finalizeSelection(targetPath)}
      disabled={!canSubmit}
      className={cn(isMobile && 'w-full flex-1')}
    >
      {submitActionLabel}
    </Button>
  );

  const renderFooter = () => (
    <>
      {!isMobile ? footerHints : null}
      <div className={cn('flex w-full flex-row justify-end gap-2 sm:w-auto', isMobile && 'justify-stretch')}>
        {addFolderButton}
      </div>
    </>
  );

  if (isMobile) {
    return (
      <MobileOverlayPanel
        open={open}
        onClose={handleClose}
        title={"Add folder"}
        // Height only — the width stays on MobileOverlayPanel's shared max-w-lg
        // so this sheet matches every other mobile overlay on wide screens.
        className="h-[88dvh] max-h-[720px]"
        contentMaxHeightClassName="flex-1"
        footer={<div className="flex flex-col gap-2">{renderFooter()}</div>}
      >
        <div className="flex h-full min-h-0 flex-col gap-3">
          <div className="flex justify-end">{showHiddenToggle}</div>
          {content}
        </div>
      </MobileOverlayPanel>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex w-full max-w-xl flex-col gap-0 overflow-hidden p-0 sm:max-h-[80vh]"
        initialFocus={false}
      >
        <DialogHeader className="px-5 pb-2 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <DialogTitle>{"Add folder"}</DialogTitle>
              <DialogDescription className="mt-2">{"Choose a folder from the path above, then add it."}</DialogDescription>
            </div>
            {showHiddenToggle}
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 px-5 pb-0">{content}</div>
        <DialogFooter className="flex w-full flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          {renderFooter()}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
