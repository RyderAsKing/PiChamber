import React from 'react';
import type { FilesAPI, GitAPI } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { toast } from '@/components/ui';
import { isImageFile } from '@/lib/toolHelpers';
import { getContextFileOpenFailureMessage, validateContextFileOpen } from '@/lib/contextFileOpenGuard';
import { getFirstChangedModifiedLineFromPatch } from '../diffPatchUtils';
import type { DiffData } from './diffTypes';
import { getFirstChangedModifiedLine, toAbsolutePath } from './diffTurnUtils';

export function useDiffEditorOpener({
  effectiveDirectory,
  activeDiffStaged,
  git,
  files,
  setDiff,
  openContextFileAtLine,
}: {
  effectiveDirectory: string | null | undefined;
  activeDiffStaged: boolean;
  git: GitAPI;
  files: FilesAPI;
  setDiff: (dir: string, path: string, diff: any, runtimeKey?: string) => void;
  openContextFileAtLine: (dir: string, path: string, line: number, col?: number) => void;
}) {
  const [openingEditorFilePath, setOpeningEditorFilePath] = React.useState<string | null>(null);

  const openFileInEditorAtChange = React.useCallback(
    async (filePath: string, cachedDiffData: DiffData | null) => {
      if (!effectiveDirectory || !filePath) {
        return;
      }

      setOpeningEditorFilePath(filePath);
      const runtimeKey = getRuntimeKey();
      try {
        let targetLine: number | null = null;

        if (cachedDiffData?.patch && !cachedDiffData.isBinary && !isImageFile(filePath)) {
          targetLine = getFirstChangedModifiedLineFromPatch(cachedDiffData.patch);
        } else if (
          cachedDiffData &&
          cachedDiffData.contextMode === 'full' &&
          !cachedDiffData.isBinary &&
          !isImageFile(filePath)
        ) {
          targetLine = getFirstChangedModifiedLine(cachedDiffData.original, cachedDiffData.modified);
        }

        if (targetLine === null) {
          try {
            const patchResponse = await git.getGitDiff(effectiveDirectory, {
              path: filePath,
              staged: activeDiffStaged,
              contextLines: 3,
            });
            targetLine = getFirstChangedModifiedLineFromPatch(patchResponse.diff);
          } catch {
            targetLine = null;
          }
        }

        let diffForNavigation = cachedDiffData;
        if (targetLine === null || !diffForNavigation) {
          const response = await git.getGitFileDiff(effectiveDirectory, {
            path: filePath,
            staged: activeDiffStaged,
          });
          diffForNavigation = {
            original: response.original ?? '',
            modified: response.modified ?? '',
            isBinary: response.isBinary,
          };
          if (!activeDiffStaged) {
            setDiff(effectiveDirectory, filePath, diffForNavigation, runtimeKey ?? undefined);
          }
        }

        const resolvedTargetLine =
          targetLine ??
          (diffForNavigation.isBinary || isImageFile(filePath)
            ? 1
            : getFirstChangedModifiedLine(diffForNavigation.original, diffForNavigation.modified));

        const absolutePath = toAbsolutePath(effectiveDirectory, filePath);
        const openValidation = await validateContextFileOpen(files, absolutePath, {
          directory: effectiveDirectory,
        });
        if (!openValidation.ok) {
          toast.error(getContextFileOpenFailureMessage(openValidation.reason));
          return;
        }

        openContextFileAtLine(effectiveDirectory, absolutePath, resolvedTargetLine, 1);
      } finally {
        setOpeningEditorFilePath((current) => (current === filePath ? null : current));
      }
    },
    [activeDiffStaged, effectiveDirectory, files, git, openContextFileAtLine, setDiff],
  );

  return {
    openingEditorFilePath,
    openFileInEditorAtChange,
  };
}
