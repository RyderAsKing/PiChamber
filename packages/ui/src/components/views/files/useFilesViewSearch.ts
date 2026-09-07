import React from 'react';

import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { normalizePath, shouldIgnorePath, type FileNode } from './filesViewModel';

type FilesViewSearchOptions = {
  directory: string;
  query: string;
  chrome: 'desktop' | 'mobile';
  showGitignored: boolean;
};

type FilesViewSearchResult = {
  results: FileNode[];
  searching: boolean;
};

/**
 * Owns Files search request policy and stale-completion rejection.
 *
 * Hidden files are always searched. Desktop follows the active Files
 * gitignored preference. A failed search is local presentation failure
 * and does not replace directory tree state.
 */
export function useFilesViewSearch({
  directory,
  query,
  chrome,
  showGitignored,
}: FilesViewSearchOptions): FilesViewSearchResult {
  const searchFiles = useFileSearchStore((state) => state.searchFiles);
  const debouncedQuery = useDebouncedValue(query, 200);
  const [results, setResults] = React.useState<FileNode[]>([]);
  const [searching, setSearching] = React.useState(false);

  React.useEffect(() => {
    const trimmedQuery = debouncedQuery.trim();
    if (!directory || !trimmedQuery) {
      setResults([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);

    void searchFiles(directory, trimmedQuery, chrome === 'mobile' ? 40 : 150, {
      includeHidden: true,
      respectGitignore: chrome === 'desktop' && !showGitignored,
      type: 'file',
    })
      .then((hits) => {
        if (cancelled) return;
        setResults(hits
          .filter((hit) => showGitignored || !shouldIgnorePath(hit.path))
          .map((hit) => ({
            name: hit.name,
            path: normalizePath(hit.path),
            type: 'file' as const,
            extension: hit.extension,
            relativePath: hit.relativePath,
          })));
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });

    return () => {
      cancelled = true;
    };
  }, [chrome, debouncedQuery, directory, searchFiles, showGitignored]);

  return { results, searching };
}
