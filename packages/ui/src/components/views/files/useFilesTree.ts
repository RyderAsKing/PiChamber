import React from 'react';

import type { RuntimeAPIs } from '@/lib/api/types';
import { listLocalDirectory } from '@/lib/fsApi';
import {
  isAbsolutePath,
  normalizePath,
  shouldIgnoreEntryName,
  sortNodes,
  type FileNode,
} from './filesViewModel';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

type FilesTreeOptions = {
  files: RuntimeAPIs['files'];
  root: string;
  activeDirectory?: string;
  expandedPaths: string[];
  chrome: 'desktop' | 'mobile';
  showGitignored: boolean;
  removeExpandedPathsByPrefix: (root: string, prefix: string) => void;
  /**
   * Whether this instance needs directory data at all. Desktop `editor-only`
   * surfaces render no tree (their tree column is `SidebarFilesTree`), so the
   * shared hook must issue no requests. Mobile `chrome="mobile"` always needs
   * its directory tree, even in `editor-only` mode.
   */
  enabled?: boolean;
  /**
   * Whether the surface is currently visible. Hidden surfaces keep cached rows
   * and issue no polling; they resume once on reactivation.
   */
  visible?: boolean;
};

type FilesTree = {
  childrenByDir: Record<string, FileNode[]>;
  loadErrorsByDir: Record<string, string>;
  isLoaded: (path: string) => boolean;
  loadDirectory: (path: string) => Promise<void>;
  refreshDirectory: (path: string) => Promise<void>;
  refreshRoot: () => Promise<void>;
};

type DirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
};

/**
 * Needs-tree policy for `FilesView`.
 *
 * Mobile (`chrome="mobile"`, currently always `mode="editor-only"`) owns its
 * directory browser through this hook and must stay enabled. Desktop `full`
 * mode renders `FilesTreePanel` from this hook. Desktop `editor-only` renders
 * only the file viewer — its tree column is the separate `SidebarFilesTree` —
 * so this hook is unused and must stay disabled to avoid background refresh.
 * Dirty editor drafts live in `FilesView` state, not in the tree, so gating
 * the tree never discards unsaved content; the component stays mounted.
 */
export function shouldEnableFilesTree(
  chrome: 'desktop' | 'mobile',
  mode: 'full' | 'editor-only',
): boolean {
  if (chrome === 'mobile') return true;
  return mode === 'full';
}

/**
 * Render-relevant equality for directory buckets. Every field the tree rows
 * read must participate; otherwise a "no-op" preservation would hide a visible
 * change, and an omitted field would republish on every poll.
 */
export function areFileNodesEqual(a: FileNode[], b: FileNode[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (
      left.name !== right.name
      || left.path !== right.path
      || left.type !== right.type
      || left.extension !== right.extension
      || left.relativePath !== right.relativePath
      || left.size !== right.size
    ) {
      return false;
    }
  }
  return true;
}

export function useFilesTree({
  files,
  root,
  activeDirectory,
  expandedPaths,
  chrome,
  showGitignored,
  removeExpandedPathsByPrefix,
  enabled = true,
  visible = true,
}: FilesTreeOptions): FilesTree {
  const [childrenByDir, setChildrenByDir] = React.useState<Record<string, FileNode[]>>({});
  const [loadErrorsByDir, setLoadErrorsByDir] = React.useState<Record<string, string>>({});
  const loadedDirsRef = React.useRef(new Set<string>());
  const inFlightDirsRef = React.useRef(new Set<string>());
  const inFlightPromisesRef = React.useRef(new Map<string, Promise<void>>());
  const activeLoadIdsRef = React.useRef(new Map<string, number>());
  const nextLoadIdRef = React.useRef(0);
  const unmountedRef = React.useRef(false);
  // Canonical runtime identity keys cache scope. The `files` object can stay
  // stable across runtime switches, so files identity must not key
  // invalidation. `getRuntimeKey()` never throws (SSR returns a stable
  // default), so no try/catch fallback that would silently alias scopes to ''.
  const [subscribedRuntimeKey, setSubscribedRuntimeKey] = React.useState<string>(() => getRuntimeKey());

  React.useEffect(() => subscribeRuntimeEndpointChanged((detail) => {
    setSubscribedRuntimeKey(detail.runtimeKey);
  }), []);

  // StrictMode runs setup-cleanup-setup on the same instance: the second
  // setup must clear the unmounted flag or every later load is dropped.
  React.useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      activeLoadIdsRef.current = new Map();
      inFlightDirsRef.current = new Set();
      inFlightPromisesRef.current = new Map();
    };
  }, []);

  const mapEntries = React.useCallback((directory: string, entries: DirectoryEntry[]): FileNode[] => {
    const nodes: FileNode[] = [];
    for (const entry of entries) {
      if (!entry?.name) continue;
      if (chrome === 'desktop' && !showGitignored && shouldIgnoreEntryName(entry.name)) continue;

      const normalizedEntryPath = normalizePath(entry.path || '');
      const path = normalizedEntryPath
        ? isAbsolutePath(normalizedEntryPath)
          ? normalizedEntryPath
          : normalizePath(`${directory}/${normalizedEntryPath}`)
        : normalizePath(`${directory}/${entry.name}`);
      const type = entry.isDirectory ? 'directory' : 'file';
      nodes.push({
        name: entry.name,
        path,
        type,
        extension: type === 'file' && entry.name.includes('.')
          ? entry.name.split('.').pop()?.toLowerCase()
          : undefined,
        size: entry.size,
      });
    }
    return sortNodes(nodes);
  }, [chrome, showGitignored]);

  const treeKey = `${subscribedRuntimeKey}|${root}|g${showGitignored ? '1' : '0'}|${chrome}`;
  // Current canonical scope, updated synchronously every render so an async
  // completion that lands after a runtime/root/filter change — even before
  // the reset effect runs — still sees the mismatch and is rejected.
  const scopeRef = React.useRef(treeKey);
  scopeRef.current = treeKey;

  const loadDirectory = React.useCallback(async (path: string) => {
    if (!enabled) return;
    const directory = normalizePath(path.trim());
    if (!directory) return;
    if (loadedDirsRef.current.has(directory)) return;
    // Coalesce concurrent same-dir loads: return the shared promise instead
    // of starting overlapping requests. Set synchronously before any await
    // so a second caller in the same tick observes it (no slot race).
    const shared = inFlightPromisesRef.current.get(directory);
    if (shared) {
      await shared;
      return;
    }

    const capturedScope = scopeRef.current;
    const requestId = nextLoadIdRef.current + 1;
    nextLoadIdRef.current = requestId;
    activeLoadIdsRef.current = new Map(activeLoadIdsRef.current).set(directory, requestId);
    inFlightDirsRef.current = new Set(inFlightDirsRef.current).add(directory);
    const isCurrent = () => !unmountedRef.current && scopeRef.current === capturedScope && activeLoadIdsRef.current.get(directory) === requestId;

    const work = (async (): Promise<void> => {
      try {
        const entries: DirectoryEntry[] = files.listDirectory
          ? (await files.listDirectory(directory)).entries.map((entry) => ({
              name: entry.name,
              path: entry.path,
              isDirectory: entry.isDirectory,
              size: entry.size,
            }))
          : (await listLocalDirectory(directory)).map((entry) => ({
              name: entry.name,
              path: entry.path,
              isDirectory: entry.isDirectory,
            }));
        if (!isCurrent()) return;

        loadedDirsRef.current = new Set(loadedDirsRef.current).add(directory);
        setLoadErrorsByDir((current) => {
          if (!current[directory]) return current;
          const next = { ...current };
          delete next[directory];
          return next;
        });
        const mapped = mapEntries(directory, entries);
        setChildrenByDir((current) => {
          const previous = current[directory];
          if (previous && areFileNodesEqual(previous, mapped)) return current;
          return { ...current, [directory]: mapped };
        });
      } catch (error) {
        if (!isCurrent()) return;
        const message = error instanceof Error ? error.message : String(error ?? '');
        if (message === 'Directory not found' && root && directory !== root) {
          removeExpandedPathsByPrefix(root, directory);
          setLoadErrorsByDir((current) => {
            if (!current[directory]) return current;
            const next = { ...current };
            delete next[directory];
            return next;
          });
        } else {
          console.error('Failed to load files directory:', error);
          setLoadErrorsByDir((current) => ({ ...current, [directory]: message }));
        }
      } finally {
        // Clear the generation slot only for the request that owns it; a
        // reset, scope change, or forcing refresh may have replaced it
        // meanwhile. In-flight set/promise cleanup lives in the outer
        // finally so the shared slot stays observable until work settles.
        if (activeLoadIdsRef.current.get(directory) === requestId) {
          activeLoadIdsRef.current = new Map(activeLoadIdsRef.current);
          activeLoadIdsRef.current.delete(directory);
        }
      }
    })();

    inFlightPromisesRef.current.set(directory, work);
    try {
      await work;
    } finally {
      if (inFlightPromisesRef.current.get(directory) === work) {
        inFlightPromisesRef.current.delete(directory);
        inFlightDirsRef.current = new Set(inFlightDirsRef.current);
        inFlightDirsRef.current.delete(directory);
      }
    }
  }, [enabled, files, mapEntries, removeExpandedPathsByPrefix, root]);

  const reset = React.useCallback(() => {
    loadedDirsRef.current = new Set();
    inFlightDirsRef.current = new Set();
    inFlightPromisesRef.current = new Map();
    activeLoadIdsRef.current = new Map();
    setLoadErrorsByDir({});
    setChildrenByDir((current) => Object.keys(current).length === 0 ? current : {});
  }, []);

  const refreshRoot = React.useCallback(async () => {
    if (!enabled || !root) return;
    reset();
    await loadDirectory(root);
  }, [enabled, loadDirectory, reset, root]);

  // Explicit refresh always forces a new fetch (it clears loaded + in-flight
  // tracking for that dir). Periodic polling and reactivation catch-up must
  // NOT call this while the dir is in-flight — they skip instead — otherwise
  // a slow poll overlaps the in-flight request and the forced duplicate
  // wastes one fetch (the older completion is rejected by generation).
  const refreshDirectory = React.useCallback(async (path: string) => {
    if (!enabled) return;
    if (!path) {
      await refreshRoot();
      return;
    }
    const directory = normalizePath(path);
    loadedDirsRef.current = new Set(loadedDirsRef.current);
    loadedDirsRef.current.delete(directory);
    inFlightDirsRef.current = new Set(inFlightDirsRef.current);
    inFlightDirsRef.current.delete(directory);
    inFlightPromisesRef.current.delete(directory);
    activeLoadIdsRef.current = new Map(activeLoadIdsRef.current);
    activeLoadIdsRef.current.delete(directory);
    await loadDirectory(directory);
  }, [enabled, loadDirectory, refreshRoot]);
  const previousTreeKeyRef = React.useRef('');
  React.useEffect(() => {
    if (previousTreeKeyRef.current === treeKey) return;
    previousTreeKeyRef.current = treeKey;
    reset();
  }, [reset, treeKey]);

  React.useEffect(() => {
    if (!enabled || !visible || !root) return;
    if (loadedDirsRef.current.has(normalizePath(root))) return;
    void loadDirectory(root);
  }, [enabled, loadDirectory, root, treeKey, visible]);

  React.useEffect(() => {
    if (!enabled || !visible || !activeDirectory) return;
    void loadDirectory(activeDirectory);
  }, [activeDirectory, enabled, loadDirectory, visible]);

  React.useEffect(() => {
    if (!enabled || !visible || !files.listDirectory) return;
    const isPollingInFlight = (path: string) => {
      const directory = normalizePath(path);
      return inFlightPromisesRef.current.has(directory) || inFlightDirsRef.current.has(directory);
    };
    const refreshExpanded = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      for (const path of expandedPaths) {
        // Slow-poll overlap guard: polling never forces while the dir is
        // already loading; the in-flight fetch already carries fresh data
        // and the next 8s tick retries. Explicit refreshDirectory still
        // forces and remains the path for user-initiated reloads.
        if (isPollingInFlight(path)) continue;
        void refreshDirectory(path);
      }
    };
    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      refreshExpanded();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }
    const interval = expandedPaths.length > 0 ? window.setInterval(refreshExpanded, 8000) : null;
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (interval !== null) window.clearInterval(interval);
    };
  }, [enabled, expandedPaths, files.listDirectory, refreshDirectory, visible]);

  const previousActiveRef = React.useRef(enabled && visible);
  React.useEffect(() => {
    const isActive = enabled && visible;
    const wasActive = previousActiveRef.current;
    previousActiveRef.current = isActive;
    if (!isActive || wasActive) return;
    if (!files.listDirectory) {
      if (root && !loadedDirsRef.current.has(normalizePath(root))) void loadDirectory(root);
      return;
    }
    if (expandedPaths.length === 0) {
      if (root && !loadedDirsRef.current.has(normalizePath(root))) void loadDirectory(root);
      return;
    }
    // Catch-up refresh coalesces with the root-ensure effect above: when
    // expandedPaths includes root, that effect may already be loading root.
    // Forcing a refresh would clear its in-flight slot and launch a
    // duplicate fetch, so skip dirs that are already loading — their
    // in-flight work already carries the fresh data this tick needs.
    for (const path of expandedPaths) {
      const directory = normalizePath(path);
      if (inFlightPromisesRef.current.has(directory) || inFlightDirsRef.current.has(directory)) continue;
      void refreshDirectory(path);
    }
  }, [enabled, expandedPaths, files.listDirectory, loadDirectory, refreshDirectory, root, visible]);

  const isLoaded = React.useCallback((path: string) => loadedDirsRef.current.has(normalizePath(path)), []);

  return { childrenByDir, loadErrorsByDir, isLoaded, loadDirectory, refreshDirectory, refreshRoot };
}
