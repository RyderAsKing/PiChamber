import React from 'react';

import { toast } from '@/components/ui';
import type { CommitFileEntry, RuntimeAPIs } from '@/lib/api/types';
import { copyTextToClipboard } from '@/lib/clipboard';

export function useGitCommitFiles(
  currentDirectory: string | null | undefined,
  git: RuntimeAPIs['git'] | undefined
) {
  const [expandedCommitHashes, setExpandedCommitHashes] = React.useState<Set<string>>(new Set());
  const [commitFilesMap, setCommitFilesMap] = React.useState<Map<string, CommitFileEntry[]>>(new Map());
  const [loadingCommitHashes, setLoadingCommitHashes] = React.useState<Set<string>>(new Set());
  const commitFilesMapRef = React.useRef<Map<string, CommitFileEntry[]>>(commitFilesMap);
  const loadingCommitHashesRef = React.useRef<Set<string>>(loadingCommitHashes);

  const handleCopyCommitHash = React.useCallback((hash: string) => {
    void copyTextToClipboard(hash).then((result) => {
      if (result.ok) {
        toast.success('Commit hash copied');
        return;
      }
      toast.error('Failed to copy');
    });
  }, []);

  const handleToggleCommit = React.useCallback((hash: string) => {
    setExpandedCommitHashes((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) {
        next.delete(hash);
      } else {
        next.add(hash);
      }
      return next;
    });
  }, []);

  React.useEffect(() => {
    commitFilesMapRef.current = commitFilesMap;
  }, [commitFilesMap]);

  React.useEffect(() => {
    loadingCommitHashesRef.current = loadingCommitHashes;
  }, [loadingCommitHashes]);

  React.useEffect(() => {
    if (!currentDirectory || !git) return;

    // Find hashes that are expanded but not yet loaded or loading
    const hashesToLoad = Array.from(expandedCommitHashes).filter(
      (hash) => !commitFilesMapRef.current.has(hash) && !loadingCommitHashesRef.current.has(hash)
    );

    if (hashesToLoad.length === 0) return;

    let cancelled = false;

    setLoadingCommitHashes((prev) => {
      const next = new Set(prev);
      for (const hash of hashesToLoad) {
        next.add(hash);
      }
      loadingCommitHashesRef.current = next;
      return next;
    });

    void Promise.all(
      hashesToLoad.map((hash) =>
        git
          .getCommitFiles(currentDirectory, hash)
          .then((response: { files: CommitFileEntry[] }) => ({ hash, files: response.files }))
          .catch((error: unknown) => {
            console.error('Failed to fetch commit files:', error);
            return { hash, files: [] as CommitFileEntry[] };
          })
      )
    ).then((results) => {
      if (cancelled) return;
      setCommitFilesMap((prev) => {
        const next = new Map(prev);
        for (const { hash, files } of results) {
          next.set(hash, files);
        }
        commitFilesMapRef.current = next;
        return next;
      });
      setLoadingCommitHashes((prev) => {
        const next = new Set(prev);
        for (const { hash } of results) {
          next.delete(hash);
        }
        loadingCommitHashesRef.current = next;
        return next;
      });
    });

    return () => {
      cancelled = true;
      setLoadingCommitHashes((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const hash of hashesToLoad) {
          if (next.delete(hash)) {
            changed = true;
          }
        }
        if (!changed) {
          return prev;
        }
        loadingCommitHashesRef.current = next;
        return next;
      });
    };
  }, [expandedCommitHashes, currentDirectory, git]);

  return {
    expandedCommitHashes,
    commitFilesMap,
    loadingCommitHashes,
    handleCopyCommitHash,
    handleToggleCommit,
  };
}
