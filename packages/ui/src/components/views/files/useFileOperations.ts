import React from 'react';

import { toast } from '@/components/ui';
import type { RuntimeAPIs } from '@/lib/api/types';
import { normalizePath } from './filesViewModel';

export type FileOperation = 'createFile' | 'createFolder' | 'rename' | 'delete';
export type FileOperationTarget = { path: string; name?: string; type?: 'file' | 'directory' };

type FileOperationsOptions = {
  files: RuntimeAPIs['files'];
  root: string;
  selectedPath: string;
  refreshDirectory: (path: string) => Promise<void>;
  removeOpenPathsByPrefix: (root: string, prefix: string) => void;
  clearSelectedPath: () => void;
};

export function useFileOperations({
  files,
  root,
  selectedPath,
  refreshDirectory,
  removeOpenPathsByPrefix,
  clearSelectedPath,
}: FileOperationsOptions) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [operation, setOperation] = React.useState<FileOperation | null>(null);
  const [target, setTarget] = React.useState<FileOperationTarget | null>(null);
  const [inputValue, setInputValue] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  const open = React.useCallback((nextOperation: FileOperation, nextTarget: FileOperationTarget) => {
    setOperation(nextOperation);
    setTarget(nextTarget);
    setInputValue(nextOperation === 'rename' ? nextTarget.name || '' : '');
    setSubmitting(false);
  }, []);

  const close = React.useCallback(() => setOperation(null), []);

  const submit = React.useCallback(async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!operation || !target) return;

    const name = inputValue.trim();
    if (operation === 'createFile' && !name) {
      toast.error('Filename is required');
      return;
    }
    if (operation === 'createFolder' && !name) {
      toast.error('Folder name is required');
      return;
    }
    if (operation === 'rename' && !name) {
      toast.error('Name is required');
      return;
    }
    if (operation === 'createFile' && !files.writeFile) {
      toast.error('Write not supported');
      return;
    }
    if (operation === 'rename' && !files.rename) {
      toast.error('Rename not supported');
      return;
    }
    if (operation === 'delete' && !files.delete) {
      toast.error('Delete not supported');
      return;
    }

    setSubmitting(true);
    try {
      if (operation === 'createFile') {
        const parent = target.path;
        const path = normalizePath(`${parent ? `${parent}/` : ''}${name}`);
        const result = await files.writeFile!(path, '');
        if (result.success) {
          toast.success('File created');
          await refreshDirectory(parent);
        }
      } else if (operation === 'createFolder') {
        const parent = target.path;
        const path = normalizePath(`${parent ? `${parent}/` : ''}${name}`);
        const result = await files.createDirectory(path);
        if (result.success) {
          toast.success('Folder created');
          await refreshDirectory(parent);
        }
      } else {
        const oldPath = target.path;
        const parent = oldPath.split('/').slice(0, -1).join('/');
        const affectedSelectedPath = selectedPath === oldPath || selectedPath.startsWith(`${oldPath}/`);
        const result = operation === 'rename'
          ? await files.rename!(oldPath, normalizePath(`${parent ? `${parent}/` : ''}${name}`))
          : await files.delete!(oldPath);
        if (result.success) {
          toast.success(operation === 'rename' ? 'Renamed successfully' : 'Deleted successfully');
          await refreshDirectory(parent);
          if (root) removeOpenPathsByPrefix(root, oldPath);
          if (affectedSelectedPath) clearSelectedPath();
        }
      }
      setOperation(null);
    } catch {
      toast.error('Operation failed');
    } finally {
      setSubmitting(false);
    }
  }, [clearSelectedPath, files, inputValue, operation, refreshDirectory, removeOpenPathsByPrefix, root, selectedPath, target]);

  return {
    operation,
    target,
    inputValue,
    setInputValue,
    submitting,
    inputRef,
    open,
    close,
    submit,
    capabilities: {
      canCreateFile: Boolean(files.writeFile),
      canCreateFolder: Boolean(files.createDirectory),
      canRename: Boolean(files.rename),
      canDelete: Boolean(files.delete),
    },
  };
}
