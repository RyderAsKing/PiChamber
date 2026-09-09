import * as React from 'react';

import { toast } from '@/components/ui';
import type { FilesAPI } from '@/lib/api/types';
import { isFileRevisionConflict } from '@/lib/api/files-errors';
import { buildGuardedWriteOptions, isSaveScopeCurrent, type FileRevisionScope } from './fileRevisionCache';
import { shouldAllowFileDraftSave, shouldScheduleFileAutosave } from '@/lib/fileEditorAutosave';
import { serializeEditorContent, type FileLineEnding } from './filesViewModel';

export type FileEditorConflict = {
  path: string;
  currentRevision: string | null;
  exists: boolean;
};

type UseFileEditorSaveOptions = {
  autoSaveEnabled: boolean;
  selectedPath: string | null;
  loadedPath: string | null;
  fileLoading: boolean;
  isDirty: boolean;
  draftContent: string;
  fileContent: string;
  lineEnding: FileLineEnding;
  isNonEditableBinary: boolean;
  writeFile: FilesAPI['writeFile'];
  /** Opaque base revision from the last successful read/save; null = missing (create-only). */
  expectedRevision?: string | null;
  onSaved: (path: string, content: string, revision?: string | null, scope?: FileRevisionScope | null) => void;
  /** Captures the runtime/root/path/generation authority for a save started now. */
  captureSaveScope?: () => FileRevisionScope | null;
  /** Resolves the current authority for stale-completion checks at commit time. */
  currentSaveScope?: () => FileRevisionScope | null;
  onConflict?: (conflict: FileEditorConflict) => void;
};

const AUTO_SAVE_DELAY_MS = 1500;
const SAVED_STATUS_DURATION_MS = 2000;

/** Owns guarded writes and autosave timing for the selected text document. */
export function useFileEditorSave({
  autoSaveEnabled,
  selectedPath,
  loadedPath,
  fileLoading,
  isDirty,
  draftContent,
  fileContent,
  lineEnding,
  isNonEditableBinary,
  writeFile,
  expectedRevision,
  onSaved,
  captureSaveScope,
  currentSaveScope,
  onConflict,
}: UseFileEditorSaveOptions) {
  const [isSaving, setIsSaving] = React.useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = React.useState<'idle' | 'saved'>('idle');
  const [saveConflict, setSaveConflict] = React.useState<FileEditorConflict | null>(null);
  const autoSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedStatusTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onConflictRef = React.useRef(onConflict);
  onConflictRef.current = onConflict;
  // Authority callbacks are read through refs so an in-flight save verifies
  // against the latest render's scope, not the closure it was started in.
  const captureSaveScopeRef = React.useRef(captureSaveScope);
  captureSaveScopeRef.current = captureSaveScope;
  const currentSaveScopeRef = React.useRef(currentSaveScope);
  currentSaveScopeRef.current = currentSaveScope;

  const isSaveCompletionCurrent = React.useCallback((saveScope: FileRevisionScope | null) => {
    if (!saveScope) return true; // No authority provider: legacy behavior.
    return isSaveScopeCurrent(saveScope, currentSaveScopeRef.current?.() ?? null);
  }, []);

  const cancelPendingAutosave = React.useCallback(() => {
    if (!autoSaveTimerRef.current) return;
    clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = null;
  }, []);

  const showSavedStatus = React.useCallback(() => {
    setAutoSaveStatus('saved');
    if (savedStatusTimerRef.current) clearTimeout(savedStatusTimerRef.current);
    savedStatusTimerRef.current = setTimeout(() => {
      savedStatusTimerRef.current = null;
      setAutoSaveStatus('idle');
    }, SAVED_STATUS_DURATION_MS);
  }, []);

  const saveDraft = React.useCallback(async (options?: { overwrite?: boolean }) => {
    if (!selectedPath || !writeFile) {
      toast.error('Saving not supported');
      return false;
    }

    if (!shouldAllowFileDraftSave({
      selectedFilePath: selectedPath,
      loadedFilePath: loadedPath,
      fileLoading,
      isDirty,
      draftContent,
      fileContent,
      isNonEditableBinary,
    })) {
      if (isNonEditableBinary) {
        console.warn(`[saveDraft] refusing to save binary file "${selectedPath}".`);
      } else if (draftContent === '' && fileContent !== '' && loadedPath !== selectedPath) {
        console.warn(
          `[saveDraft] refusing to save empty draft for "${selectedPath}" (${fileContent.length} bytes were expected). `
          + 'The file may have been read during a concurrent write (O_TRUNC race). '
          + 'Try again after content finishes loading if the save was intentional.',
        );
      }
      return false;
    }

    // A clean draft is success so guarded navigation is never stranded.
    if (!isDirty) return true;

    setIsSaving(true);
    // Capture the save authority before awaiting so the completion can be
    // verified against it; selection/reload/runtime switches invalidate it.
    const saveScope = captureSaveScopeRef.current?.() ?? null;
    try {
      const contentToWrite = serializeEditorContent(draftContent, lineEnding);
      const writeOptions = buildGuardedWriteOptions(expectedRevision, options?.overwrite);
      const result = await writeFile(selectedPath, contentToWrite, writeOptions);
      if (!result?.success) {
        toast.error('Failed to write file');
        return false;
      }
      if (!isSaveCompletionCurrent(saveScope)) {
        // Stale completion: the file/runtime/generation moved on while the
        // write was in flight, so this buffer no longer owns the document.
        // The bytes are on disk; dropping the completion here keeps the
        // newly selected document from being clobbered by the old buffer.
        return false;
      }
      // Dirty text is preserved until success; conflict never reaches here.
      setSaveConflict(null);
      onSaved(selectedPath, draftContent, result?.revision, saveScope);
      return true;
    } catch (error) {
      if (isFileRevisionConflict(error)) {
        // Preserve the dirty draft, surface the typed conflict, and let
        // FilesView fetch the current version for reload/overwrite/compare.
        if (!isSaveCompletionCurrent(saveScope)) return false;
        const conflict: FileEditorConflict = {
          path: selectedPath,
          currentRevision: error.currentRevision ?? null,
          exists: error.exists,
        };
        setSaveConflict(conflict);
        onConflictRef.current?.(conflict);
        return false;
      }
      toast.error(error instanceof Error ? error.message : 'Save failed');
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [draftContent, expectedRevision, fileContent, fileLoading, isDirty, isNonEditableBinary, isSaveCompletionCurrent, lineEnding, loadedPath, onSaved, selectedPath, writeFile]);

  const saveNow = React.useCallback(async (options?: { overwrite?: boolean }) => {
    cancelPendingAutosave();
    if (isSaving) return false;
    const saved = await saveDraft(options);
    if (saved) showSavedStatus();
    return saved;
  }, [cancelPendingAutosave, isSaving, saveDraft, showSavedStatus]);

  React.useEffect(() => {
    if (!autoSaveEnabled) {
      setAutoSaveStatus('idle');
      cancelPendingAutosave();
    }
  }, [autoSaveEnabled, cancelPendingAutosave]);

  React.useEffect(() => {
    if (!shouldScheduleFileAutosave({
      autoSaveEnabled,
      isDirty,
      canWrite: Boolean(selectedPath && writeFile),
      isSaving,
      fileLoading,
      selectedFilePath: selectedPath,
      loadedFilePath: loadedPath,
      isNonEditableBinary,
    })) return;

    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null;
      void saveDraft().then((saved) => {
        if (saved) showSavedStatus();
      });
    }, AUTO_SAVE_DELAY_MS);

    return cancelPendingAutosave;
  }, [autoSaveEnabled, cancelPendingAutosave, draftContent, fileLoading, isDirty, isNonEditableBinary, isSaving, loadedPath, saveDraft, selectedPath, showSavedStatus, writeFile]);

  React.useEffect(() => {
    setAutoSaveStatus('idle');
    setIsSaving(false);
    setSaveConflict(null);
  }, [selectedPath]);

  React.useEffect(() => () => {
    cancelPendingAutosave();
    if (savedStatusTimerRef.current) clearTimeout(savedStatusTimerRef.current);
  }, [cancelPendingAutosave]);

  return { autoSaveStatus, cancelPendingAutosave, isSaving, saveConflict, clearSaveConflict: () => setSaveConflict(null), saveDraft, saveNow };
}
