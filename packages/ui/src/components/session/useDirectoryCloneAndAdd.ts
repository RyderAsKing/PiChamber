import React from 'react';
import { toast } from '@/components/ui';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGitIdentitiesStore } from '@/stores/useGitIdentitiesStore';
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

  const gitIdentityProfiles = useGitIdentitiesStore((s) => s.profiles);
  const globalGitIdentity = useGitIdentitiesStore((s) => s.globalIdentity);
  const defaultGitIdentityId = useGitIdentitiesStore((s) => s.defaultGitIdentityId);
  const loadGitIdentityProfiles = useGitIdentitiesStore((s) => s.loadProfiles);
  const loadGlobalGitIdentity = useGitIdentitiesStore((s) => s.loadGlobalIdentity);
  const loadDefaultGitIdentityId = useGitIdentitiesStore((s) => s.loadDefaultGitIdentityId);

  const [isConfirming, setIsConfirming] = React.useState(false);
  const [isCloneMode, setIsCloneMode] = React.useState(false);
  const [cloneRemoteUrl, setCloneRemoteUrl] = React.useState('');
  const [selectedGitIdentityId, setSelectedGitIdentityId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setIsConfirming(false);
    setIsCloneMode(false);
    setCloneRemoteUrl('');
    setSelectedGitIdentityId(null);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    void loadGitIdentityProfiles();
    void loadGlobalGitIdentity();
    void loadDefaultGitIdentityId();
  }, [loadDefaultGitIdentityId, loadGitIdentityProfiles, loadGlobalGitIdentity, open]);

  const availableGitIdentities = React.useMemo(() => {
    const unique = new Map<string, NonNullable<typeof globalGitIdentity>>();
    if (globalGitIdentity) {
      unique.set(globalGitIdentity.id, globalGitIdentity);
    }
    for (const profile of gitIdentityProfiles) {
      unique.set(profile.id, profile);
    }
    return Array.from(unique.values());
  }, [gitIdentityProfiles, globalGitIdentity]);

  React.useEffect(() => {
    if (!open || !isCloneMode || selectedGitIdentityId !== null) return;
    const defaultId = typeof defaultGitIdentityId === 'string' ? defaultGitIdentityId.trim() : '';
    if (defaultId && availableGitIdentities.some((identity) => identity.id === defaultId)) {
      setSelectedGitIdentityId(defaultId);
      return;
    }
    const firstSshIdentity = availableGitIdentities.find(
      (identity) => identity.authType === 'ssh' || identity.sshKey,
    );
    if (firstSshIdentity) {
      setSelectedGitIdentityId(firstSshIdentity.id);
    }
  }, [availableGitIdentities, defaultGitIdentityId, isCloneMode, open, selectedGitIdentityId]);

  const selectedGitIdentity = React.useMemo(
    () => availableGitIdentities.find((identity) => identity.id === selectedGitIdentityId) ?? null,
    [availableGitIdentities, selectedGitIdentityId],
  );

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
            toast.error('Enter a repository URL before cloning.');
            return;
          }
          const response = await runtimeFetch('/api/fs/clone', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              remoteUrl,
              destinationPath: target,
              gitIdentityId: selectedGitIdentity?.id ?? null,
            }),
          });
          if (!response.ok) {
            throw new Error('Failed to clone git repository');
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
            throw new Error('Failed to select directory');
          }
        }
        const project = addProject(selectedTarget);
        if (!project) {
          toast.error('Failed to add folder', {
            description: 'Please select a valid directory path.',
          });
          return;
        }
        openProjectDraft(project.id, project.path);
      } catch (error) {
        toast.error('Failed to select directory', {
          description: error instanceof Error ? error.message : 'Unknown error occurred.',
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
      selectedGitIdentity?.id,
      shouldCreateTarget,
      targetPath,
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
    ? 'Already added'
    : isCloneMode
      ? isConfirming
        ? 'Cloning...'
        : 'Clone & add'
      : isConfirming
        ? 'Adding...'
        : shouldCreateTarget
          ? 'Create & add'
          : 'Add folder';

  return {
    isConfirming,
    isCloneMode,
    setIsCloneMode,
    cloneRemoteUrl,
    setCloneRemoteUrl,
    selectedGitIdentityId,
    setSelectedGitIdentityId,
    availableGitIdentities,
    selectedGitIdentity,
    canSubmit,
    submitActionLabel,
    submitModifierLabel,
    finalizeSelection,
  };
}
