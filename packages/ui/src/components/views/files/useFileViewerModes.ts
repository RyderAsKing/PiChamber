import * as React from 'react';

import { toast } from '@/components/ui';
import type { FilesAPI } from '@/lib/api/types';
import { isDrawioFile } from '@/lib/toolHelpers';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { isHtmlFile, isMarkdownFile, type FileStatSnapshot } from './filesViewModel';

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

type UseFileViewerModesOptions = {
  root: string;
  openPaths: string[];
  selectedPath: string | null;
  defaultPreview: boolean;
  fileContent: string;
  draftContent: string;
  setDraftContent: (content: string) => void;
  autoSaveEnabled: boolean;
  writeFile: FilesAPI['writeFile'];
  readStat: (path: string) => Promise<FileStatSnapshot | null>;
  recordStat: (stat: FileStatSnapshot | null) => void;
};

/** Owns per-file viewer choices and the Draw.io preview document lifecycle. */
export function useFileViewerModes({
  root,
  openPaths,
  selectedPath,
  defaultPreview,
  fileContent,
  draftContent,
  setDraftContent,
  autoSaveEnabled,
  writeFile,
  readStat,
  recordStat,
}: UseFileViewerModesOptions) {
  const [textViewMode, setTextViewMode] = React.useState<TextViewMode>('edit');
  const [mdViewMode, setMdViewMode] = React.useState<PreviewViewMode>('edit');
  const [jsonViewMode, setJsonViewMode] = React.useState<JsonViewMode>('tree');
  const [htmlViewMode, setHtmlViewMode] = React.useState<PreviewViewMode>('edit');
  const [drawioViewMode, setDrawioViewMode] = React.useState<PreviewViewMode>('preview');
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
    const previewDefault: PreviewViewMode = defaultPreview ? 'preview' : 'edit';
    setTextViewMode(textModesRef.current[selectedPath] ?? 'edit');
    setMdViewMode(mdModesRef.current[selectedPath]
      ?? readStoredMode<PreviewViewMode>(MD_VIEWER_MODE_KEY, ['preview', 'edit'], previewDefault));
    setHtmlViewMode(htmlModesRef.current[selectedPath]
      ?? readStoredMode<PreviewViewMode>(HTML_VIEWER_MODE_KEY, ['preview', 'edit'], previewDefault));
    setDrawioViewMode(drawioModesRef.current[selectedPath] ?? previewDefault);
    setJsonViewMode(readStoredMode<JsonViewMode>(
      JSON_VIEWER_MODE_KEY,
      ['tree', 'text'],
      defaultPreview ? 'tree' : 'text',
    ));
  }, [defaultPreview, selectedPath]);

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

  const saveDiagramXml = React.useCallback(async (path: string, xml: string) => {
    if (!writeFile || xml === diagramSavedXmlRef.current) return false;
    const result = await writeFile(path, xml);
    if (!result?.success) {
      toast.error('Failed to write file');
      return false;
    }

    recordDiagramContent(xml);
    setDraftContent(xml);
    const stat = await readStat(path).catch(() => null);
    if (stat) recordStat(stat);
    return true;
  }, [readStat, recordDiagramContent, recordStat, setDraftContent, writeFile]);

  const showDiagramSaved = React.useCallback(() => {
    setDiagramSaved(true);
    if (diagramSavedTimerRef.current) clearTimeout(diagramSavedTimerRef.current);
    diagramSavedTimerRef.current = setTimeout(() => setDiagramSaved(false), DIAGRAM_SAVED_STATUS_MS);
  }, []);

  const saveDiagramNow = React.useCallback(async (path: string, xml: string) => {
    if (diagramAutoSaveTimerRef.current) {
      clearTimeout(diagramAutoSaveTimerRef.current);
      diagramAutoSaveTimerRef.current = null;
    }
    const saved = await saveDiagramXml(path, xml);
    if (saved) showDiagramSaved();
    return saved;
  }, [saveDiagramXml, showDiagramSaved]);

  const handleDiagramChange = React.useCallback((xml: string) => {
    diagramXmlRef.current = xml;
    if (!autoSaveEnabled || !selectedPath || drawioViewMode !== 'preview' || !writeFile) return;
    if (diagramAutoSaveTimerRef.current) clearTimeout(diagramAutoSaveTimerRef.current);

    diagramAutoSaveTimerRef.current = setTimeout(() => {
      diagramAutoSaveTimerRef.current = null;
      void saveDiagramXml(selectedPath, xml).then((saved) => {
        if (!saved) return;
        showDiagramSaved();
      }).catch((error) => {
        toast.error(error instanceof Error ? error.message : 'Save failed');
      });
    }, DIAGRAM_AUTO_SAVE_DELAY_MS);
  }, [autoSaveEnabled, drawioViewMode, saveDiagramXml, selectedPath, showDiagramSaved, writeFile]);

  React.useEffect(() => cancelDiagramTransitions, [cancelDiagramTransitions, drawioViewMode, selectedPath]);
  React.useEffect(() => () => {
    if (diagramSavedTimerRef.current) clearTimeout(diagramSavedTimerRef.current);
  }, []);

  React.useEffect(() => {
    const applyDefault = (enabled: boolean) => {
      const previewMode: PreviewViewMode = enabled ? 'preview' : 'edit';
      const nextJsonMode: JsonViewMode = enabled ? 'tree' : 'text';
      for (const path of openPaths) {
        textModesRef.current[path] = 'edit';
        if (isMarkdownFile(path)) mdModesRef.current[path] = previewMode;
        if (isHtmlFile(path)) htmlModesRef.current[path] = previewMode;
        if (isDrawioFile(path)) drawioModesRef.current[path] = previewMode;
      }
      setTextViewMode('edit');
      setMdViewMode(previewMode);
      setHtmlViewMode(previewMode);
      setDrawioViewMode(previewMode);
      setJsonViewMode(nextJsonMode);
      storeMode(MD_VIEWER_MODE_KEY, previewMode);
      storeMode(HTML_VIEWER_MODE_KEY, previewMode);
      storeMode(JSON_VIEWER_MODE_KEY, nextJsonMode);
    };
    const handleChanged = (event: Event) => {
      applyDefault(Boolean((event as CustomEvent<{ enabled?: boolean }>).detail?.enabled));
    };
    window.addEventListener('pichamber:file-viewer-preview-mode-changed', handleChanged);
    return () => window.removeEventListener('pichamber:file-viewer-preview-mode-changed', handleChanged);
  }, [openPaths]);

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
