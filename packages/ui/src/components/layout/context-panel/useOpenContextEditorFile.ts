import React from 'react';

import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getContextFileOpenFailureMessage, validateContextFileOpen } from '@/lib/contextFileOpenGuard';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Opens a file in the context panel's editor for the workspace `root`: checks
 * it can be opened, selects it, and adds its tab. Failures show a toast and
 * leave the current selection alone.
 */
export const useOpenContextEditorFile = (root: string) => {
  const { files } = useRuntimeAPIs();
  const openContextFile = useUIStore((state) => state.openContextFile);
  const setSelectedPath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const addOpenPath = useFilesViewTabsStore((state) => state.addOpenPath);

  return React.useCallback(async (path: string) => {
    if (!root) return;
    const openValidation = await validateContextFileOpen(files, path, { directory: root });
    if (!openValidation.ok) {
      toast.error(getContextFileOpenFailureMessage(openValidation.reason));
      return;
    }
    setSelectedPath(root, path);
    addOpenPath(root, path);
    openContextFile(root, path);
  }, [addOpenPath, files, openContextFile, root, setSelectedPath]);
};
