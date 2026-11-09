import React from 'react';

import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { isAlwaysHiddenPath, normalizePath, shouldIgnorePath, type FileNode } from './filesViewModel';

type FilesViewSearchOptions = {
  directory: string;
  query: string;
  chrome: 'desktop' | 'mobile';
  showGitignored: boolean;
};

type FilesViewSearchResult = {
  results: FileNode[];
  /** True from the first keystroke until results for the current query land. */
  searching: boolean;
  /** The last search failed; `results` is empty but says nothing about matches. */
  failed: boolean;
};

/**
 * Owns Files search request policy and stale-completion rejection.
 *
 * Hidden files are always searched. Desktop follows the active Files
 * gitignored preference. A failed search is local presentation failure
 * and does not replace directory tree state; `failed` keeps it from reading
 * as "no matches".
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
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    const trimmedQuery = debouncedQuery.trim();
    if (!directory || !trimmedQuery) {
      setResults([]);
      setSearching(false);
      setFailed(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    setFailed(false);

    void searchFiles(directory, trimmedQuery, chrome === 'mobile' ? 40 : 150, {
      includeHidden: true,
      respectGitignore: chrome === 'desktop' && !showGitignored,
      type: 'file',
    })
      .then((hits) => {
        if (cancelled) return;
        setResults(hits
          .filter((hit) => !isAlwaysHiddenPath(hit.relativePath ?? hit.path))
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
        if (cancelled) return;
        setResults([]);
        setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });

    return () => {
      cancelled = true;
    };
  }, [chrome, debouncedQuery, directory, searchFiles, showGitignored]);

  // Covers the debounce window too, so stale results or the tree don't flash
  // as the answer to a query that hasn't been sent yet.
  const pending = query.trim() !== '' && query.trim() !== debouncedQuery.trim();
  return { results, searching: searching || pending, failed: failed && !pending };
}
