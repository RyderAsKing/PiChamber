import * as React from 'react';

import { toast } from '@/components/ui';
import type { FilesAPI } from '@/lib/api/types';
import { shouldAllowFileDraftSave, shouldScheduleFileAutosave } from '@/lib/fileEditorAutosave';
import { serializeEditorContent, type FileLineEnding } from './filesViewModel';

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
  onSaved: (path: string, content: string) => void;
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
  onSaved,
}: UseFileEditorSaveOptions) {
  const [isSaving, setIsSaving] = React.useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = React.useState<'idle' | 'saved'>('idle');
  const autoSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedStatusTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const saveDraft = React.useCallback(async () => {
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
    try {
      const contentToWrite = serializeEditorContent(draftContent, lineEnding);
      const result = await writeFile(selectedPath, contentToWrite);
      if (!result?.success) {
        toast.error('Failed to write file');
        return false;
      }
      onSaved(selectedPath, draftContent);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed');
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [draftContent, fileContent, fileLoading, isDirty, isNonEditableBinary, lineEnding, loadedPath, onSaved, selectedPath, writeFile]);

  const saveNow = React.useCallback(async () => {
    cancelPendingAutosave();
    if (isSaving) return false;
    const saved = await saveDraft();
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
  }, [selectedPath]);

  React.useEffect(() => () => {
    cancelPendingAutosave();
    if (savedStatusTimerRef.current) clearTimeout(savedStatusTimerRef.current);
  }, [cancelPendingAutosave]);

  return { autoSaveStatus, cancelPendingAutosave, isSaving, saveDraft, saveNow };
}
