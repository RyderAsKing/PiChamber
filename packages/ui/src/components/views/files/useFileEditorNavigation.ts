import * as React from 'react';
import { EditorView } from '@codemirror/view';

import { useUIStore } from '@/stores/useUIStore';
import { normalizePath } from './filesViewModel';
import type { TextViewMode } from './useFileViewerModes';

type UseFileEditorNavigationOptions = {
  root: string;
  selectedPath: string | null;
  loadedPath: string | null;
  fileLoading: boolean;
  fileError: string | null;
  isImage: boolean;
  isPdf: boolean;
  isUnsupportedBinary: boolean;
  canEdit: boolean;
  textViewMode: TextViewMode;
  setTextViewMode: (mode: TextViewMode) => void;
  draftContent: string;
  confirmDiscardOpen: boolean;
  selectFilePath: (path: string) => void;
};

function isEditorSyncedWithDraft(view: EditorView, expected: string): boolean {
  if (view.state.doc.length !== expected.length) return false;
  if (expected.length === 0) return true;
  const sampleSize = Math.min(128, expected.length);
  if (view.state.sliceDoc(0, sampleSize) !== expected.slice(0, sampleSize)) return false;
  const endFrom = Math.max(0, expected.length - sampleSize);
  return view.state.sliceDoc(endFrom, expected.length) === expected.slice(endFrom);
}

/** Coordinates deferred file selection, editor mounting, focus, and line jumps. */
export function useFileEditorNavigation({
  root,
  selectedPath,
  loadedPath,
  fileLoading,
  fileError,
  isImage,
  isPdf,
  isUnsupportedBinary,
  canEdit,
  textViewMode,
  setTextViewMode,
  draftContent,
  confirmDiscardOpen,
  selectFilePath,
}: UseFileEditorNavigationOptions) {
  const pendingNavigation = useUIStore((state) => state.pendingFileNavigation);
  const setPendingNavigation = useUIStore((state) => state.setPendingFileNavigation);
  const pendingFocusPath = useUIStore((state) => state.pendingFileFocusPath);
  const setPendingFocusPath = useUIStore((state) => state.setPendingFileFocusPath);
  const editorViewRef = React.useRef<EditorView | null>(null);
  const [editorReadyNonce, setEditorReadyNonce] = React.useState(0);
  const retryFrameRef = React.useRef<number | null>(null);
  const cycleRef = React.useRef<{ key: string; attempts: number }>({ key: '', attempts: 0 });

  const notifyEditorViewChanged = React.useCallback(() => {
    setEditorReadyNonce((value) => value + 1);
  }, []);

  React.useEffect(() => () => {
    if (retryFrameRef.current !== null) window.cancelAnimationFrame(retryFrameRef.current);
  }, []);

  React.useEffect(() => {
    if (!pendingNavigation || !root) return;

    const scheduleRetry = () => {
      if (retryFrameRef.current !== null) return;
      retryFrameRef.current = window.requestAnimationFrame(() => {
        retryFrameRef.current = null;
        notifyEditorViewChanged();
      });
    };
    const resetNavigation = () => {
      setPendingNavigation(null);
      cycleRef.current = { key: '', attempts: 0 };
    };
    const targetPath = normalizePath(pendingNavigation.path);
    if (!targetPath) {
      resetNavigation();
      return;
    }

    const navigationKey = `${targetPath}:${pendingNavigation.line}:${pendingNavigation.column ?? 1}`;
    if (cycleRef.current.key !== navigationKey) {
      cycleRef.current = { key: navigationKey, attempts: 0 };
    }
    if (selectedPath !== targetPath) {
      if (!confirmDiscardOpen) selectFilePath(targetPath);
      return;
    }
    if (fileLoading || loadedPath !== targetPath) return;
    if (fileError || isImage || isPdf || isUnsupportedBinary) {
      resetNavigation();
      return;
    }
    if (!canEdit) return;
    if (textViewMode !== 'edit') {
      setTextViewMode('edit');
      return;
    }

    const view = editorViewRef.current;
    if (!view || !isEditorSyncedWithDraft(view, draftContent)) {
      scheduleRetry();
      return;
    }

    const lineNumber = Math.max(1, Math.min(pendingNavigation.line, view.state.doc.lines));
    const line = view.state.doc.line(lineNumber);
    const column = Math.max(1, pendingNavigation.column || 1);
    const position = line.from + Math.min(Math.max(0, line.to - line.from), column - 1);
    const isAtTarget = view.state.selection.main.head === position;
    if (!isAtTarget || cycleRef.current.attempts === 0) {
      cycleRef.current.attempts += 1;
      view.dispatch({
        selection: { anchor: position },
        effects: EditorView.scrollIntoView(position, { y: 'center' }),
      });
      view.focus();
      scheduleRetry();
      return;
    }

    window.requestAnimationFrame(() => {
      const syncedView = editorViewRef.current;
      if (!syncedView) return;
      syncedView.dispatch({
        selection: { anchor: position },
        effects: EditorView.scrollIntoView(position, { y: 'center' }),
      });
      syncedView.focus();
    });
    resetNavigation();
  }, [
    canEdit,
    confirmDiscardOpen,
    draftContent,
    editorReadyNonce,
    fileError,
    fileLoading,
    isImage,
    isPdf,
    isUnsupportedBinary,
    loadedPath,
    notifyEditorViewChanged,
    pendingNavigation,
    root,
    selectedPath,
    selectFilePath,
    setPendingNavigation,
    setTextViewMode,
    textViewMode,
  ]);

  React.useEffect(() => {
    if (!pendingFocusPath || !root) return;
    const targetPath = normalizePath(pendingFocusPath);
    if (!targetPath) {
      setPendingFocusPath(null);
      return;
    }
    // Selection belongs to tab sync or the user; a stale focus request cannot
    // steal it back while another document loads.
    if (selectedPath !== targetPath || fileLoading || loadedPath !== targetPath) return;

    if (!fileError && !isImage && !isPdf && !isUnsupportedBinary && canEdit && textViewMode === 'edit') {
      editorViewRef.current?.focus();
    }
    setPendingFocusPath(null);
  }, [
    canEdit,
    fileError,
    fileLoading,
    isImage,
    isPdf,
    isUnsupportedBinary,
    loadedPath,
    pendingFocusPath,
    root,
    selectedPath,
    setPendingFocusPath,
    textViewMode,
  ]);

  const targetPath = normalizePath(pendingNavigation?.path ?? '');
  const shouldMaskEditor = Boolean(
    pendingNavigation
      && targetPath
      && selectedPath === targetPath
      && !fileLoading
      && !fileError
      && !isImage
      && !isPdf
      && !isUnsupportedBinary,
  );

  return { editorViewRef, notifyEditorViewChanged, shouldMaskEditor };
}
