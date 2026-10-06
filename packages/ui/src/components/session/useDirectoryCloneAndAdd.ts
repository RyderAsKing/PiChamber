import React from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/components/ui';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { normalizeDirectoryPath } from './directoryExplorerPaths';
import type { FilesystemErrorReason } from '@/lib/api/files-errors';

export function useDirectoryCloneAndAdd({
  open,
  onClose,
  isMobile,
  addedProjectPaths,
  targetPath,
  shouldCreateTarget,
  browseErrorReason,
  browseDirectoryAbsolutePath,
  isAlreadyAdded,
  isPickingLocation,
}: {
  open: boolean;
  onClose: () => void;
  isMobile: boolean;
  addedProjectPaths: Set<string>;
  targetPath: string;
  shouldCreateTarget: boolean;
  browseErrorReason: FilesystemErrorReason | null;
  browseDirectoryAbsolutePath: string;
  isAlreadyAdded: boolean;
  isPickingLocation: boolean;
}) {
  const addProject = useProjectsStore((s) => s.addProject);
  const setActiveMainTab = useUIStore((s) => s.setActiveMainTab);
  const setSessionSwitcherOpen = useUIStore((s) => s.setSessionSwitcherOpen);
  const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
  const { t } = useTranslation();

  const [isConfirming, setIsConfirming] = React.useState(false);
  const [isCloneMode, setIsCloneMode] = React.useState(false);
  const [cloneRemoteUrl, setCloneRemoteUrl] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    setIsConfirming(false);
    setIsCloneMode(false);
    setCloneRemoteUrl('');
  }, [open]);

  const openProjectDraft = React.useCallback(
    (projectId: string, projectPath: string) => {
      setActiveMainTab('chat');
      if (isMobile) setSessionSwitcherOpen(false);
      openNewSessionDraft({ selectedProjectId: projectId, directoryOverride: projectPath });
      onClose();
    },
    [isMobile, onClose, openNewSessionDraft, setActiveMainTab, setSessionSwitcherOpen],
  );

  const finalizeSelection = React.useCallback(
    async (target: string) => {
      if (!target || isConfirming) return;
      const normalized = normalizeDirectoryPath(target);
      if (normalized && addedProjectPaths.has(normalized)) return;
      let selectedTarget = target;

      setIsConfirming(true);
      try {
        const shouldCreateSelection =
          !isCloneMode && shouldCreateTarget && normalizeDirectoryPath(target) === normalizeDirectoryPath(targetPath);
        if (isCloneMode) {
          const remoteUrl = cloneRemoteUrl.trim();
          if (!remoteUrl) {
            toast.error(t('Enter a repository URL before cloning.'));
            return;
          }
          const response = await runtimeFetch('/api/fs/clone', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              remoteUrl,
              destinationPath: target,
            }),
          });
          if (!response.ok) {
            throw new Error(t('Failed to clone git repository'));
          }
          const data = (await response.json()) as { path?: string };
          selectedTarget = data.path || target;
        } else if (shouldCreateSelection) {
          const response = await runtimeFetch('/api/fs/mkdir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            query: browseDirectoryAbsolutePath ? { directory: browseDirectoryAbsolutePath } : undefined,
            body: JSON.stringify({ path: target }),
          });
          if (!response.ok) {
            throw new Error(t('Failed to select directory'));
          }
        }
        const project = addProject(selectedTarget);
        if (!project) {
          toast.error(t('Failed to add folder'), {
            description: t('Please select a valid directory path.'),
          });
          return;
        }
        openProjectDraft(project.id, project.path);
      } catch (error) {
        toast.error(t('Failed to select directory'), {
          description: error instanceof Error ? error.message : t('Unknown error occurred.'),
        });
      } finally {
        setIsConfirming(false);
      }
    },
    [
      addProject,
      addedProjectPaths,
      browseDirectoryAbsolutePath,
      cloneRemoteUrl,
      isCloneMode,
      isConfirming,
      openProjectDraft,
      shouldCreateTarget,
      targetPath,
      t,
    ],
  );

  const canAddFolder =
    !isConfirming &&
    !isPickingLocation &&
    !isAlreadyAdded &&
    browseErrorReason !== 'os-permission' &&
    browseErrorReason !== 'invalid-response' &&
    browseErrorReason !== 'unknown' &&
    Boolean(targetPath);

  const canSubmitClone = canAddFolder && cloneRemoteUrl.trim().length > 0;
  const canSubmit = isCloneMode ? canSubmitClone : canAddFolder;

  const submitModifierLabel =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

  const submitActionLabel = isAlreadyAdded
    ? t('Already added')
    : isCloneMode
      ? isConfirming
        ? t('Cloning...')
        : t('Clone & add')
      : isConfirming
        ? t('Adding...')
        : shouldCreateTarget
          ? t('Create & add')
          : t('Add folder');

  return {
    isConfirming,
    isCloneMode,
    setIsCloneMode,
    cloneRemoteUrl,
    setCloneRemoteUrl,
    canSubmit,
    submitActionLabel,
    submitModifierLabel,
    finalizeSelection,
  };
}
