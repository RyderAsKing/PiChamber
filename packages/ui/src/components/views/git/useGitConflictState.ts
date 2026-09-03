import React from 'react';

export interface UseGitConflictStateParams {
  currentSessionId: string | null | undefined;
  currentDirectory: string | null | undefined;
}

export function useGitConflictState({
  currentSessionId,
  currentDirectory,
}: UseGitConflictStateParams) {
  const [conflictDialogOpen, setConflictDialogOpen] = React.useState(false);
  const [conflictFiles, setConflictFiles] = React.useState<string[]>([]);
  const [conflictOperation, setConflictOperation] = React.useState<'merge' | 'rebase'>('merge');

  // Conflict state persistence key
  const conflictStorageKey = React.useMemo(() => {
    if (!currentSessionId) return null;
    return `pichamber.conflict:${currentSessionId}`;
  }, [currentSessionId]);

  // Save conflict state to localStorage
  const persistConflictState = React.useCallback((
    directory: string,
    files: string[],
    operation: 'merge' | 'rebase'
  ) => {
    if (!conflictStorageKey || typeof window === 'undefined') return;
    const payload = { directory, conflictFiles: files, operation };
    window.localStorage.setItem(conflictStorageKey, JSON.stringify(payload));
  }, [conflictStorageKey]);

  // Clear conflict state from localStorage
  const clearConflictState = React.useCallback(() => {
    if (!conflictStorageKey || typeof window === 'undefined') return;
    window.localStorage.removeItem(conflictStorageKey);
  }, [conflictStorageKey]);

  // Restore conflict state from localStorage on mount
  React.useEffect(() => {
    if (!conflictStorageKey || typeof window === 'undefined' || !currentDirectory) return;

    const raw = window.localStorage.getItem(conflictStorageKey);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as {
        directory: string;
        conflictFiles: string[];
        operation: 'merge' | 'rebase';
      };

      // Validate the stored state matches current directory
      if (parsed.directory !== currentDirectory) {
        window.localStorage.removeItem(conflictStorageKey);
        return;
      }

      // Restore conflict state
      setConflictFiles(parsed.conflictFiles ?? []);
      setConflictOperation(parsed.operation ?? 'merge');
      setConflictDialogOpen(true);
    } catch {
      window.localStorage.removeItem(conflictStorageKey);
    }
  }, [conflictStorageKey, currentDirectory]);

  return {
    conflictDialogOpen,
    setConflictDialogOpen,
    conflictFiles,
    setConflictFiles,
    conflictOperation,
    setConflictOperation,
    persistConflictState,
    clearConflictState,
  };
}
