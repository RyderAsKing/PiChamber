import React from 'react';
import { toast } from '@/components/ui';
import { useUIStore } from '@/stores/useUIStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { buildGuardedWriteOptions } from '@/components/views/files/fileRevisionCache';
import { isFileRevisionConflict } from '@/lib/api/files-errors';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { DiagramEditor, type DiagramEditorHandle } from '@/components/diagram/DiagramEditor';
import {
  FileSaveConflictDialog,
  type FileSaveConflictDetails,
} from '@/components/views/files/FileSaveConflictDialog';
import { Icon } from '@/components/icon/Icon';

type DiagramSaveConflict = FileSaveConflictDetails & {
  /** Runtime that owned the failed save; reload/overwrite must not run against a new runtime. */
  runtimeKey: string;
};

const toDisplayPath = (path: string): string => path.split('/').pop() || path;

export function DiagramView() {
  const { files } = useRuntimeAPIs();

  const [filePath, setFilePath] = React.useState<string | null>(null);
  const [xml, setXml] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [saveConflict, setSaveConflict] = React.useState<DiagramSaveConflict | null>(null);
  const [isResolvingConflict, setIsResolvingConflict] = React.useState(false);
  const [showConflictCompare, setShowConflictCompare] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [editorVersion, setEditorVersion] = React.useState(0);
  const revisionRef = React.useRef<string | null | undefined>(undefined);
  const savedXmlRef = React.useRef('');
  const loadIdRef = React.useRef(0);
  const saveOpRef = React.useRef(0);
  const resolveOpRef = React.useRef(0);
  const editorRef = React.useRef<DiagramEditorHandle>(null);
  const mountedRef = React.useRef(true);
  const filePathRef = React.useRef<string | null>(null);
  const pendingDiagramFile = useUIStore((state) => state.pendingDiagramFile);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isCurrent = React.useCallback((generation: number, runtimeKey: string, path: string): boolean => (
    mountedRef.current
    && loadIdRef.current === generation
    && getRuntimeKey() === runtimeKey
    && filePathRef.current === path
  ), []);

  const loadFile = React.useCallback(async (path: string) => {
    const loadId = loadIdRef.current + 1;
    loadIdRef.current = loadId;
    const loadRuntimeKey = getRuntimeKey();
    const readFile = files?.readFile;
    saveOpRef.current += 1;
    resolveOpRef.current += 1;
    setLoading(true);
    setFilePath(path);
    filePathRef.current = path;
    setSaveConflict(null);
    setShowConflictCompare(false);
    setIsSaving(false);
    setIsResolvingConflict(false);
    try {
      const result = await readFile?.(path);
      if (!isCurrent(loadId, loadRuntimeKey, path)) return;
      if (!result) {
        // A missing/empty read leaves the on-disk revision unknown. Never
        // offer an empty editor with an unguarded save that could overwrite
        // a potentially existing target. Surface the failure and clear the
        // active file so the user can reopen through the picker.
        toast.error('Failed to read file');
        setFilePath(null);
        filePathRef.current = null;
        savedXmlRef.current = '';
        setXml('');
        revisionRef.current = undefined;
        setLoading(false);
        return;
      }
      savedXmlRef.current = result.content;
      setXml(result.content);
      revisionRef.current = result.revision;
    } catch (error) {
      if (!isCurrent(loadId, loadRuntimeKey, path)) return;
      toast.error(error instanceof Error ? error.message : 'Failed to read file');
      setFilePath(null);
      filePathRef.current = null;
      savedXmlRef.current = '';
      setXml('');
      revisionRef.current = undefined;
      setLoading(false);
      return;
    } finally {
      if (isCurrent(loadId, loadRuntimeKey, path)) {
        setLoading(false);
      }
    }
  }, [files, isCurrent]);

  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    loadIdRef.current += 1;
    revisionRef.current = undefined;
    saveOpRef.current += 1;
    resolveOpRef.current += 1;
    if (!mountedRef.current) return;
    setSaveConflict(null);
    setShowConflictCompare(false);
    setIsSaving(false);
    setIsResolvingConflict(false);
    const currentPath = filePathRef.current;
    if (currentPath) {
      void loadFile(currentPath);
    }
  }), [loadFile]);

  React.useEffect(() => {
    if (!pendingDiagramFile) {
      return;
    }
    const pending = useUIStore.getState().consumePendingDiagramFile();
    if (pending) {
      void loadFile(pending);
    }
  }, [loadFile, pendingDiagramFile]);

  const openConflict = React.useCallback(async (
    path: string,
    dirtyXml: string,
    currentRevision: string | null,
    exists: boolean,
    saveGeneration: number,
    saveRuntimeKey: string,
  ) => {
    let currentContent: string | null = null;
    let resolvedRevision: string | null = currentRevision;
    let resolvedExists = exists;
    try {
      if (resolvedExists) {
        const entry = await files?.readFile?.(path);
        if (!isCurrent(saveGeneration, saveRuntimeKey, path)) return;
        if (entry) {
          currentContent = entry.content ?? null;
          if (typeof entry.revision === 'string') resolvedRevision = entry.revision;
          resolvedExists = entry.exists !== false;
        }
      }
    } catch {
      if (!isCurrent(saveGeneration, saveRuntimeKey, path)) return;
    }
    if (!isCurrent(saveGeneration, saveRuntimeKey, path)) return;
    setSaveConflict({
      path,
      displayPath: toDisplayPath(path),
      exists: resolvedExists,
      currentRevision: resolvedRevision,
      currentContent,
      dirtyContent: dirtyXml,
      runtimeKey: saveRuntimeKey,
    });
    setShowConflictCompare(false);
  }, [files, isCurrent]);

  const persistBytes = React.useCallback(async (
    path: string,
    content: string,
    overwrite: boolean,
    generation: number,
    runtimeKey: string,
  ): Promise<{ stale: true } | { stale: false; success: boolean; revision?: string | null }> => {
    const result = await files?.writeFile?.(
      path,
      content,
      buildGuardedWriteOptions(revisionRef.current, overwrite ? true : undefined),
    );
    if (!isCurrent(generation, runtimeKey, path)) return { stale: true };
    return { stale: false, success: Boolean(result?.success), revision: result?.revision };
  }, [files, isCurrent]);

  const commitWritten = React.useCallback((written: string, revision?: string | null) => {
    savedXmlRef.current = written;
    if (typeof revision !== 'undefined') revisionRef.current = revision;
    if (editorRef.current?.getXml() === written) {
      setXml(written);
    }
  }, []);

  const saveDiagram = React.useCallback(async () => {
    const latest = editorRef.current?.getXml();
    if (!filePath || !files?.writeFile || !latest || latest === savedXmlRef.current) return;
    if (isSaving || isResolvingConflict) return;
    const saveGeneration = loadIdRef.current;
    const saveRuntimeKey = getRuntimeKey();
    const savePath = filePath;
    const dirtyXml = latest;
    const op = saveOpRef.current + 1;
    saveOpRef.current = op;
    setIsSaving(true);
    try {
      const outcome = await persistBytes(savePath, dirtyXml, false, saveGeneration, saveRuntimeKey);
      if (outcome.stale) return;
      if (!outcome.success) {
        toast.error('Failed to write file');
        return;
      }
      commitWritten(dirtyXml, outcome.revision);
    } catch (error) {
      if (!isCurrent(saveGeneration, saveRuntimeKey, savePath)) return;
      if (isFileRevisionConflict(error)) {
        await openConflict(
          savePath,
          dirtyXml,
          error.currentRevision ?? null,
          error.exists,
          saveGeneration,
          saveRuntimeKey,
        );
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Save failed');
    } finally {
      if (saveOpRef.current === op) {
        setIsSaving(false);
      }
    }
  }, [commitWritten, filePath, files, isCurrent, isResolvingConflict, isSaving, openConflict, persistBytes]);

  const handleConflictReload = React.useCallback(async () => {
    const details = saveConflict;
    if (!details || isResolvingConflict) return;
    if (!isCurrent(loadIdRef.current, details.runtimeKey, details.path)) return;
    const reloadGeneration = loadIdRef.current;
    const reloadRuntimeKey = details.runtimeKey;
    if (!details.exists) {
      setFilePath(null);
      filePathRef.current = null;
      savedXmlRef.current = '';
      setXml('');
      revisionRef.current = undefined;
      setSaveConflict(null);
      setShowConflictCompare(false);
      return;
    }
    const op = resolveOpRef.current + 1;
    resolveOpRef.current = op;
    setIsResolvingConflict(true);
    try {
      const entry = await files?.readFile?.(details.path);
      if (!isCurrent(reloadGeneration, reloadRuntimeKey, details.path)) return;
      if (!entry) {
        toast.error('Failed to read file');
        return;
      }
      savedXmlRef.current = entry.content ?? '';
      setXml(entry.content ?? '');
      revisionRef.current = entry.revision;
      setEditorVersion((value) => value + 1);
      setSaveConflict(null);
      setShowConflictCompare(false);
    } catch (error) {
      if (!isCurrent(reloadGeneration, reloadRuntimeKey, details.path)) return;
      toast.error(error instanceof Error ? error.message : 'Failed to read file');
    } finally {
      if (resolveOpRef.current === op) {
        setIsResolvingConflict(false);
      }
    }
  }, [files, isCurrent, isResolvingConflict, saveConflict]);

  const handleConflictOverwrite = React.useCallback(async () => {
    const details = saveConflict;
    if (!details || isResolvingConflict) return;
    if (!isCurrent(loadIdRef.current, details.runtimeKey, details.path)) return;
    const overwriteGeneration = loadIdRef.current;
    const overwriteRuntimeKey = details.runtimeKey;
    const writeFile = files?.writeFile;
    if (!writeFile) {
      toast.error('Saving not supported');
      return;
    }
    const latest = editorRef.current?.getXml();
    const content = latest ?? details.dirtyContent;
    if (!content) {
      toast.error('Failed to write file');
      return;
    }
    const op = resolveOpRef.current + 1;
    resolveOpRef.current = op;
    setIsResolvingConflict(true);
    try {
      const outcome = await persistBytes(details.path, content, true, overwriteGeneration, overwriteRuntimeKey);
      if (outcome.stale) return;
      if (!outcome.success) {
        toast.error('Failed to write file');
        return;
      }
      commitWritten(content, outcome.revision);
      setSaveConflict(null);
      setShowConflictCompare(false);
    } catch (error) {
      if (!isCurrent(overwriteGeneration, overwriteRuntimeKey, details.path)) return;
      if (isFileRevisionConflict(error)) {
        await openConflict(
          details.path,
          content,
          error.currentRevision ?? details.currentRevision,
          error.exists,
          overwriteGeneration,
          overwriteRuntimeKey,
        );
        return;
      }
      toast.error(error instanceof Error ? error.message : 'Save failed');
    } finally {
      if (resolveOpRef.current === op) {
        setIsResolvingConflict(false);
      }
    }
  }, [commitWritten, files, isCurrent, isResolvingConflict, openConflict, persistBytes, saveConflict]);

  const handleConflictClose = React.useCallback(() => {
    if (isResolvingConflict || isSaving) return;
    setSaveConflict(null);
    setShowConflictCompare(false);
  }, [isResolvingConflict, isSaving]);

  const fileName = filePath ? filePath.split('/').pop() || filePath : '';

  if (!filePath) {
    return (
      <div className="flex h-full items-center justify-center p-3">
        <div className="typography-ui text-muted-foreground">
          {"Pick a file from the tree."}
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-3">
        <Icon name="loader-4" className="size-4 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/30 px-3 py-1.5">
        <Icon name="file" className="size-4 shrink-0 text-muted-foreground" />
        <span className="typography-ui text-muted-foreground truncate flex-1">{fileName}</span>
        <button
          type="button"
          onClick={() => void saveDiagram()}
          className="size-6 flex items-center justify-center rounded-md text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          title={"Save diagram"}
        >
          <Icon name="save-3" className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => useUIStore.getState().setActiveMainTab('chat')}
          className="size-6 flex items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          title={"Close diagram view"}
        >
          <Icon name="close" className="size-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <DiagramEditor
          key={editorVersion}
          ref={editorRef}
          xml={xml}
          className="h-full"
        />
      </div>
      <FileSaveConflictDialog
        open={Boolean(saveConflict)}
        conflict={saveConflict}
        isResolving={isResolvingConflict || isSaving}
        showCompare={showConflictCompare}
        onToggleCompare={() => setShowConflictCompare((value) => !value)}
        onReload={() => { void handleConflictReload(); }}
        onOverwrite={() => { void handleConflictOverwrite(); }}
        onClose={handleConflictClose}
      />
    </div>
  );
}
