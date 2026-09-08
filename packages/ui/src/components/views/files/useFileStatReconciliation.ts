import * as React from 'react';

import type { FileStatSnapshot } from './filesViewModel';

export function didFileStatChange(previous: FileStatSnapshot, latest: FileStatSnapshot): boolean {
  // Opaque revision mismatch is authoritative when both sides carry one.
  if (typeof previous.revision === 'string' && typeof latest.revision === 'string') {
    if (previous.revision !== latest.revision) return true;
  }
  const mtimeChanged = latest.mtimeMs !== undefined
    && previous.mtimeMs !== undefined
    && latest.mtimeMs !== previous.mtimeMs;
  return mtimeChanged || latest.size !== previous.size;
}

type UseFileStatReconciliationOptions = {
  selectedPath: string | null;
  loadedPath: string | null;
  isDirty: boolean;
  readStat: (path: string, options?: { knownRevision?: string | null }) => Promise<FileStatSnapshot | null>;
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

      // Send the revision we already hold so the server can skip its
      // read+hash when metadata is unchanged (the steady-state poll case).
      const previous = lastStatRef.current;
      const knownRevision = previous && previous.path === selectedPath && typeof previous.revision === 'string'
        ? previous.revision
        : null;
      void readStat(selectedPath, { knownRevision })
        .then((latest) => {
          if (cancelled || !latest) return;

          const prior = lastStatRef.current;
          if (!prior || prior.path !== selectedPath) {
            lastStatRef.current = latest;
            return;
          }
          if (!didFileStatChange(prior, latest) || isDirtyRef.current) return;

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
