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

type FilesTreeOptions = {
  files: RuntimeAPIs['files'];
  root: string;
  activeDirectory?: string;
  expandedPaths: string[];
  chrome: 'desktop' | 'mobile';
  showHidden: boolean;
  showGitignored: boolean;
  removeExpandedPathsByPrefix: (root: string, prefix: string) => void;
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

export function useFilesTree({
  files,
  root,
  activeDirectory,
  expandedPaths,
  chrome,
  showHidden,
  showGitignored,
  removeExpandedPathsByPrefix,
}: FilesTreeOptions): FilesTree {
  const [childrenByDir, setChildrenByDir] = React.useState<Record<string, FileNode[]>>({});
  const [loadErrorsByDir, setLoadErrorsByDir] = React.useState<Record<string, string>>({});
  const loadedDirsRef = React.useRef(new Set<string>());
  const inFlightDirsRef = React.useRef(new Set<string>());
  const activeLoadIdsRef = React.useRef(new Map<string, number>());
  const nextLoadIdRef = React.useRef(0);

  const mapEntries = React.useCallback((directory: string, entries: DirectoryEntry[]): FileNode[] => {
    const nodes: FileNode[] = [];
    for (const entry of entries) {
      if (!entry?.name) continue;
      if (chrome === 'desktop' && !showHidden && entry.name.startsWith('.')) continue;
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
  }, [chrome, showGitignored, showHidden]);

  const loadDirectory = React.useCallback(async (path: string) => {
    const directory = normalizePath(path.trim());
    if (!directory || loadedDirsRef.current.has(directory) || inFlightDirsRef.current.has(directory)) return;

    inFlightDirsRef.current = new Set(inFlightDirsRef.current).add(directory);
    const requestId = nextLoadIdRef.current + 1;
    nextLoadIdRef.current = requestId;
    activeLoadIdsRef.current = new Map(activeLoadIdsRef.current).set(directory, requestId);
    const isCurrent = () => activeLoadIdsRef.current.get(directory) === requestId;

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
      setChildrenByDir((current) => ({ ...current, [directory]: mapEntries(directory, entries) }));
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
      if (isCurrent()) {
        activeLoadIdsRef.current = new Map(activeLoadIdsRef.current);
        activeLoadIdsRef.current.delete(directory);
        inFlightDirsRef.current = new Set(inFlightDirsRef.current);
        inFlightDirsRef.current.delete(directory);
      }
    }
  }, [files, mapEntries, removeExpandedPathsByPrefix, root]);

  const reset = React.useCallback(() => {
    loadedDirsRef.current = new Set();
    inFlightDirsRef.current = new Set();
    activeLoadIdsRef.current = new Map();
    setLoadErrorsByDir({});
    setChildrenByDir((current) => Object.keys(current).length === 0 ? current : {});
  }, []);

  const refreshRoot = React.useCallback(async () => {
    if (!root) return;
    reset();
    await loadDirectory(root);
  }, [loadDirectory, reset, root]);

  const refreshDirectory = React.useCallback(async (path: string) => {
    if (!path) {
      await refreshRoot();
      return;
    }
    const directory = normalizePath(path);
    loadedDirsRef.current = new Set(loadedDirsRef.current);
    loadedDirsRef.current.delete(directory);
    inFlightDirsRef.current = new Set(inFlightDirsRef.current);
    inFlightDirsRef.current.delete(directory);
    await loadDirectory(directory);
  }, [loadDirectory, refreshRoot]);

  const treeKey = `${root}|h${showHidden ? '1' : '0'}|g${showGitignored ? '1' : '0'}|${chrome}`;
  const previousTreeKeyRef = React.useRef('');
  React.useEffect(() => {
    if (!root || previousTreeKeyRef.current === treeKey) return;
    previousTreeKeyRef.current = treeKey;
    reset();
    void loadDirectory(root);
  }, [loadDirectory, reset, root, treeKey]);

  React.useEffect(() => {
    if (activeDirectory) void loadDirectory(activeDirectory);
  }, [activeDirectory, loadDirectory]);

  React.useEffect(() => {
    if (!files.listDirectory) return;
    const refreshExpanded = () => {
      if (document.hidden) return;
      for (const path of expandedPaths) void refreshDirectory(path);
    };
    const handleVisibilityChange = () => refreshExpanded();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const interval = expandedPaths.length > 0 ? window.setInterval(refreshExpanded, 8000) : null;
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (interval !== null) window.clearInterval(interval);
    };
  }, [expandedPaths, files.listDirectory, refreshDirectory]);

  const isLoaded = React.useCallback((path: string) => loadedDirsRef.current.has(normalizePath(path)), []);

  return { childrenByDir, loadErrorsByDir, isLoaded, loadDirectory, refreshDirectory, refreshRoot };
}
