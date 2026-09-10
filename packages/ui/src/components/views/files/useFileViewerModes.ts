import * as React from 'react';

import { toast } from '@/components/ui';
import type { FileContentRevision, FilesAPI } from '@/lib/api/types';
import { isFileRevisionConflict } from '@/lib/api/files-errors';
import { isDrawioFile } from '@/lib/toolHelpers';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { buildGuardedWriteOptions, isSaveScopeCurrent, type FileRevisionScope } from './fileRevisionCache';
import type { FileEditorConflict } from './useFileEditorSave';

export type TextViewMode = 'view' | 'edit';
export type PreviewViewMode = 'preview' | 'edit';
export type JsonViewMode = 'tree' | 'text';

const MD_VIEWER_MODE_KEY = 'pichamber:files:md-viewer-mode';
const HTML_VIEWER_MODE_KEY = 'pichamber:files:html-viewer-mode';
const JSON_VIEWER_MODE_KEY = 'pichamber:files:json-viewer-mode';
const DIAGRAM_AUTO_SAVE_DELAY_MS = 1500;
const DIAGRAM_SAVED_STATUS_MS = 1500;

function readStoredMode<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    if (stored && allowed.includes(stored as T)) return stored as T;
  } catch {
    // Storage is optional.
  }
  return fallback;
}

function storeMode(key: string, mode: string) {
  try {
    localStorage.setItem(key, mode);
  } catch {
    // Storage is optional.
  }
}

export type DiagramSaveConflict = FileEditorConflict & {
  /** The diagram XML that failed to write; never cleared by the conflict. */
  xml: string;
};

type UseFileViewerModesOptions = {
  root: string;
  selectedPath: string | null;
  fileContent: string;
  draftContent: string;
  setDraftContent: (content: string) => void;
  autoSaveEnabled: boolean;
  writeFile: FilesAPI['writeFile'];
  /** Opaque base revision for guarded diagram writes; undefined = legacy. */
  expectedRevision?: FileContentRevision;
  /** Captures the runtime/root/path/generation authority for a save started now. */
  captureSaveScope?: () => FileRevisionScope | null;
  /** Resolves the current authority for stale-completion checks at commit time. */
  currentSaveScope?: () => FileRevisionScope | null;
  /** Same contract as the text editor save: revision/scope bookkeeping. */
  onSaved?: (path: string, content: string, revision?: string | null, scope?: FileRevisionScope | null) => void;
  /** Typed revision conflict; the owner surfaces the shared conflict dialog. */
  onConflict?: (conflict: DiagramSaveConflict) => void;
};

/** Owns per-file viewer choices and the Draw.io preview document lifecycle. Manual mode switching stays; the default is always edit. */
export function useFileViewerModes({
  root,
  selectedPath,
  fileContent,
  draftContent,
  setDraftContent,
  autoSaveEnabled,
  writeFile,
  expectedRevision,
  captureSaveScope,
  currentSaveScope,
  onSaved,
  onConflict,
}: UseFileViewerModesOptions) {
  const [textViewMode, setTextViewMode] = React.useState<TextViewMode>('edit');
  const [mdViewMode, setMdViewMode] = React.useState<PreviewViewMode>('edit');
  const [jsonViewMode, setJsonViewMode] = React.useState<JsonViewMode>('text');
  const [htmlViewMode, setHtmlViewMode] = React.useState<PreviewViewMode>('edit');
  const [drawioViewMode, setDrawioViewMode] = React.useState<PreviewViewMode>('edit');
  const [drawioRemountNonce, setDrawioRemountNonce] = React.useState(0);
  const [diagramSaved, setDiagramSaved] = React.useState(false);
  const textModesRef = React.useRef<Record<string, TextViewMode>>({});
  const mdModesRef = React.useRef<Record<string, PreviewViewMode>>({});
  const htmlModesRef = React.useRef<Record<string, PreviewViewMode>>({});
  const drawioModesRef = React.useRef<Record<string, PreviewViewMode>>({});
  const diagramXmlRef = React.useRef('');
  const diagramSavedXmlRef = React.useRef('');
  const diagramAutoSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const diagramSavedTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPreviewFrameRef = React.useRef<number | null>(null);
  // Authority callbacks are read through refs so an in-flight diagram save
  // verifies against the latest render's scope, not the closure it started in.
  const expectedRevisionRef = React.useRef(expectedRevision);
  expectedRevisionRef.current = expectedRevision;
  const captureSaveScopeRef = React.useRef(captureSaveScope);
  captureSaveScopeRef.current = captureSaveScope;
  const currentSaveScopeRef = React.useRef(currentSaveScope);
  currentSaveScopeRef.current = currentSaveScope;
  const onSavedRef = React.useRef(onSaved);
  onSavedRef.current = onSaved;
  const onConflictRef = React.useRef(onConflict);
  onConflictRef.current = onConflict;

  const cancelDiagramTransitions = React.useCallback(() => {
    if (diagramAutoSaveTimerRef.current) {
      clearTimeout(diagramAutoSaveTimerRef.current);
      diagramAutoSaveTimerRef.current = null;
    }
    if (pendingPreviewFrameRef.current !== null) {
      cancelAnimationFrame(pendingPreviewFrameRef.current);
      pendingPreviewFrameRef.current = null;
    }
  }, []);

  const recordDiagramContent = React.useCallback((content: string) => {
    diagramXmlRef.current = content;
    diagramSavedXmlRef.current = content;
  }, []);
  const clearDiagramContent = React.useCallback(() => recordDiagramContent(''), [recordDiagramContent]);

  React.useEffect(() => {
    if (!selectedPath) return;
    setTextViewMode(textModesRef.current[selectedPath] ?? 'edit');
    setMdViewMode(mdModesRef.current[selectedPath]
      ?? readStoredMode<PreviewViewMode>(MD_VIEWER_MODE_KEY, ['preview', 'edit'], 'edit'));
    setHtmlViewMode(htmlModesRef.current[selectedPath]
      ?? readStoredMode<PreviewViewMode>(HTML_VIEWER_MODE_KEY, ['preview', 'edit'], 'edit'));
    setDrawioViewMode(drawioModesRef.current[selectedPath] ?? 'edit');
    setJsonViewMode(readStoredMode<JsonViewMode>(
      JSON_VIEWER_MODE_KEY,
      ['tree', 'text'],
      'text',
    ));
  }, [selectedPath]);

  const saveTextViewMode = React.useCallback((mode: TextViewMode) => {
    if (selectedPath) textModesRef.current[selectedPath] = mode;
    setTextViewMode(mode);
  }, [selectedPath]);
  const saveMdViewMode = React.useCallback((mode: PreviewViewMode) => {
    if (selectedPath) mdModesRef.current[selectedPath] = mode;
    setMdViewMode(mode);
    storeMode(MD_VIEWER_MODE_KEY, mode);
  }, [selectedPath]);
  const saveHtmlViewMode = React.useCallback((mode: PreviewViewMode) => {
    if (selectedPath) htmlModesRef.current[selectedPath] = mode;
    setHtmlViewMode(mode);
    storeMode(HTML_VIEWER_MODE_KEY, mode);
  }, [selectedPath]);
  const saveJsonViewMode = React.useCallback((mode: JsonViewMode) => {
    setJsonViewMode(mode);
    storeMode(JSON_VIEWER_MODE_KEY, mode);
  }, []);

  const saveDrawioViewMode = React.useCallback((mode: PreviewViewMode) => {
    if (selectedPath) drawioModesRef.current[selectedPath] = mode;
    cancelDiagramTransitions();
    if (mode === 'edit') {
      setDraftContent(diagramXmlRef.current || fileContent);
      setDrawioViewMode(mode);
      return;
    }

    diagramXmlRef.current = draftContent;
    const pathAtToggle = selectedPath;
    setDrawioViewMode('edit');
    pendingPreviewFrameRef.current = requestAnimationFrame(() => {
      pendingPreviewFrameRef.current = requestAnimationFrame(() => {
        pendingPreviewFrameRef.current = null;
        if (root && pathAtToggle
          && useFilesViewTabsStore.getState().byRoot[root]?.selectedPath !== pathAtToggle) return;
        setDrawioRemountNonce((value) => value + 1);
        setDrawioViewMode('preview');
      });
    });
  }, [cancelDiagramTransitions, draftContent, fileContent, root, selectedPath, setDraftContent]);

  const isDiagramSaveCurrent = React.useCallback((saveScope: FileRevisionScope | null) => {
    if (!saveScope) return true; // No authority provider: legacy behavior.
    return isSaveScopeCurrent(saveScope, currentSaveScopeRef.current?.() ?? null);
  }, []);

  const saveDiagramXml = React.useCallback(async (path: string, xml: string, options?: { overwrite?: boolean }) => {
    if (!writeFile || xml === diagramSavedXmlRef.current) return false;
    // Capture the save authority before awaiting so the completion can be
    // verified against it; selection/reload/runtime switches invalidate it.
    const saveScope = captureSaveScopeRef.current?.() ?? null;
    if (saveScope && saveScope.path !== path) {
      // The diagram being written is no longer the selected document.
      return false;
    }
    try {
      const result = await writeFile(path, xml, buildGuardedWriteOptions(expectedRevisionRef.current, options?.overwrite));
      if (!result?.success) {
        toast.error('Failed to write file');
        return false;
      }
      if (!isDiagramSaveCurrent(saveScope)) {
        // Stale completion: the bytes are on disk, but the buffer no longer
        // owns the document. Dropping the completion keeps the newly selected
        // document's draft and stat baseline from being clobbered by the old
        // diagram.
        return false;
      }
      recordDiagramContent(xml);
      setDraftContent(xml);
      onSavedRef.current?.(path, xml, result?.revision, saveScope);
      return true;
    } catch (error) {
      if (isFileRevisionConflict(error)) {
        // Preserve the diagram edits (refs stay untouched) and surface the
        // typed conflict through the shared reload/overwrite/compare dialog.
        if (!isDiagramSaveCurrent(saveScope)) return false;
        onConflictRef.current?.({
          path,
          currentRevision: error.currentRevision ?? null,
          exists: error.exists,
          xml,
        });
        return false;
      }
      toast.error(error instanceof Error ? error.message : 'Save failed');
      return false;
    }
  }, [isDiagramSaveCurrent, recordDiagramContent, setDraftContent, writeFile]);

  const showDiagramSaved = React.useCallback(() => {
    setDiagramSaved(true);
    if (diagramSavedTimerRef.current) clearTimeout(diagramSavedTimerRef.current);
    diagramSavedTimerRef.current = setTimeout(() => setDiagramSaved(false), DIAGRAM_SAVED_STATUS_MS);
  }, []);

  const saveDiagramNow = React.useCallback(async (path: string, xml: string, options?: { overwrite?: boolean }) => {
    if (diagramAutoSaveTimerRef.current) {
      clearTimeout(diagramAutoSaveTimerRef.current);
      diagramAutoSaveTimerRef.current = null;
    }
    const saved = await saveDiagramXml(path, xml, options);
    if (saved) showDiagramSaved();
    return saved;
  }, [saveDiagramXml, showDiagramSaved]);

  const handleDiagramChange = React.useCallback((xml: string) => {
    diagramXmlRef.current = xml;
    if (!autoSaveEnabled || !selectedPath || drawioViewMode !== 'preview' || !writeFile) return;
    if (diagramAutoSaveTimerRef.current) clearTimeout(diagramAutoSaveTimerRef.current);

    diagramAutoSaveTimerRef.current = setTimeout(() => {
      diagramAutoSaveTimerRef.current = null;
      // saveDiagramXml owns error surfacing and stale-completion drops.
      void saveDiagramXml(selectedPath, xml).then((saved) => {
        if (!saved) return;
        showDiagramSaved();
      });
    }, DIAGRAM_AUTO_SAVE_DELAY_MS);
  }, [autoSaveEnabled, drawioViewMode, saveDiagramXml, selectedPath, showDiagramSaved, writeFile]);

  React.useEffect(() => cancelDiagramTransitions, [cancelDiagramTransitions, drawioViewMode, selectedPath]);
  React.useEffect(() => () => {
    if (diagramSavedTimerRef.current) clearTimeout(diagramSavedTimerRef.current);
  }, []);

  const diagramEditorXml = isDrawioFile(selectedPath ?? '')
    ? diagramXmlRef.current || draftContent || fileContent
    : fileContent;

  return {
    clearDiagramContent,
    diagramEditorXml,
    diagramSaved,
    drawioRemountNonce,
    drawioViewMode,
    handleDiagramChange,
    htmlViewMode,
    jsonViewMode,
    mdViewMode,
    recordDiagramContent,
    saveDiagramNow,
    saveDiagramXml,
    saveDrawioViewMode,
    saveHtmlViewMode,
    saveJsonViewMode,
    saveMdViewMode,
    saveTextViewMode,
    setTextViewMode,
    textViewMode,
  };
}
