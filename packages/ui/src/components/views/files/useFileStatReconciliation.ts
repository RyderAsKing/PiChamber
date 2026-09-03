import * as React from 'react';

import type { FileStatSnapshot } from './filesViewModel';

export function didFileStatChange(previous: FileStatSnapshot, latest: FileStatSnapshot): boolean {
  const mtimeChanged = latest.mtimeMs !== undefined
    && previous.mtimeMs !== undefined
    && latest.mtimeMs !== previous.mtimeMs;
  return mtimeChanged || latest.size !== previous.size;
}

type UseFileStatReconciliationOptions = {
  selectedPath: string | null;
  loadedPath: string | null;
  isDirty: boolean;
  readStat: (path: string) => Promise<FileStatSnapshot | null>;
  onExternalChange: () => void;
  pollIntervalMs?: number;
};

/**
 * Reconciles the selected document with filesystem metadata. Failed stats are
 * ignored rather than treated as missing files; dirty drafts always win over
 * external changes until the user resolves them.
 */
export function useFileStatReconciliation({
  selectedPath,
  loadedPath,
  isDirty,
  readStat,
  onExternalChange,
  pollIntervalMs = 2000,
}: UseFileStatReconciliationOptions) {
  const lastStatRef = React.useRef<FileStatSnapshot | null>(null);
  const isDirtyRef = React.useRef(isDirty);
  isDirtyRef.current = isDirty;

  const recordStat = React.useCallback((stat: FileStatSnapshot | null) => {
    lastStatRef.current = stat;
  }, []);

  React.useEffect(() => {
    if (!selectedPath || loadedPath !== selectedPath) return;

    let cancelled = false;
    const interval = window.setInterval(() => {
      if (document.hidden) return;

      void readStat(selectedPath)
        .then((latest) => {
          if (cancelled || !latest) return;

          const previous = lastStatRef.current;
          if (!previous || previous.path !== selectedPath) {
            lastStatRef.current = latest;
            return;
          }
          if (!didFileStatChange(previous, latest) || isDirtyRef.current) return;

          lastStatRef.current = latest;
          onExternalChange();
        })
        .catch(() => {});
    }, pollIntervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [loadedPath, onExternalChange, pollIntervalMs, readStat, selectedPath]);

  return { recordStat };
}
