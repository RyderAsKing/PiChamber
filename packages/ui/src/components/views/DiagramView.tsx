import React from 'react';
import { toast } from '@/components/ui';
import { useUIStore } from '@/stores/useUIStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { buildGuardedWriteOptions } from '@/components/views/files/fileRevisionCache';
import { DiagramEditor, type DiagramEditorHandle } from '@/components/diagram/DiagramEditor';
import { Icon } from '@/components/icon/Icon';

export function DiagramView() {
  
  const { files } = useRuntimeAPIs();

  const [filePath, setFilePath] = React.useState<string | null>(null);
  const [xml, setXml] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  // Opaque read-content revision backing guarded writes; undefined =
  // unknown/legacy (no guard), null = missing file.
  const revisionRef = React.useRef<string | null | undefined>(undefined);
  const loadIdRef = React.useRef(0);
  const editorRef = React.useRef<DiagramEditorHandle>(null);
  const pendingDiagramFile = useUIStore((state) => state.pendingDiagramFile);

  const loadFile = React.useCallback(async (path: string) => {
    const loadId = loadIdRef.current + 1;
    loadIdRef.current = loadId;
    setLoading(true);
    setFilePath(path);
    try {
      const result = await files?.readFile?.(path);
      if (loadIdRef.current !== loadId) return;
      if (result) {
        setXml(result.content);
        revisionRef.current = result.revision;
      }
    } catch {
      if (loadIdRef.current !== loadId) return;
      setXml('');
      revisionRef.current = undefined;
    } finally {
      if (loadIdRef.current === loadId) {
        setLoading(false);
      }
    }
  }, [files]);

  React.useEffect(() => {
    if (!pendingDiagramFile) {
      return;
    }
    const pending = useUIStore.getState().consumePendingDiagramFile();
    if (pending) {
      void loadFile(pending);
    }
  }, [loadFile, pendingDiagramFile]);

  const saveDiagram = React.useCallback(async () => {
    const newXml = editorRef.current?.getXml();
    if (!filePath || !files?.writeFile || !newXml || newXml === xml) return;
    try {
      // Guarded write: an external change since the read surfaces as a typed
      // error instead of silently overwriting the file on disk.
      const result = await files.writeFile(filePath, newXml, buildGuardedWriteOptions(revisionRef.current));
      if (!result?.success) {
        toast.error('Failed to write file');
        return;
      }
      setXml(newXml);
      if (typeof result.revision !== 'undefined') revisionRef.current = result.revision;
    } catch (error) {
      // The editor keeps its content; the user can retry or reload.
      toast.error(error instanceof Error ? error.message : 'Save failed');
    }
  }, [filePath, files, xml]);

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
          ref={editorRef}
          xml={xml}
          className="h-full"
        />
      </div>
    </div>
  );
}
