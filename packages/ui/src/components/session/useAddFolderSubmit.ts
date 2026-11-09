import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { trimTrailingSeparators } from './directoryExplorerPaths';

export type AddFolderPending = 'add' | 'clone' | 'create';

const readError = async (response: Response, fallback: string): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) return body.error.trim();
  } catch {
    // Not JSON; the fallback says what failed.
  }
  return fallback;
};

const postJson = (path: string, body: unknown, query?: Record<string, string>) =>
  runtimeFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    query,
    body: JSON.stringify(body),
  });

/**
 * The Add folder dialog's three ways to finish: add a folder (creating it
 * first when it doesn't exist), clone a repository, or start a new project.
 * Each one ends by adding the folder and opening a new session draft in it.
 *
 * Failures stay in the dialog as `error` so the user can fix the input and
 * retry. Every step is safe to repeat: creating an existing folder and
 * initializing an existing repository both succeed without changes, and a
 * clone refuses a destination that already exists.
 */
export function useAddFolderSubmit({
  open,
  onClose,
  isMobile,
}: {
  open: boolean;
  onClose: () => void;
  isMobile: boolean;
}) {
  const addProject = useProjectsStore((s) => s.addProject);
  const setActiveMainTab = useUIStore((s) => s.setActiveMainTab);
  const setSessionSwitcherOpen = useUIStore((s) => s.setSessionSwitcherOpen);
  const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);

  const [pending, setPending] = React.useState<AddFolderPending | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setPending(null);
    setError(null);
  }, [open]);

  const addAndOpen = React.useCallback(
    (path: string): boolean => {
      const project = addProject(path);
      if (!project) {
        setError('PiChamber couldn’t add this folder. Check that the path is a folder.');
        return false;
      }
      setActiveMainTab('chat');
      if (isMobile) setSessionSwitcherOpen(false);
      openNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.path });
      onClose();
      return true;
    },
    [addProject, isMobile, onClose, openNewSessionDraft, setActiveMainTab, setSessionSwitcherOpen],
  );

  const run = React.useCallback(
    async (kind: AddFolderPending, task: () => Promise<void>) => {
      if (pending) return;
      setPending(kind);
      setError(null);
      try {
        await task();
      } catch (cause) {
        setError(cause instanceof Error && cause.message ? cause.message : 'Something went wrong. Try again.');
      } finally {
        setPending(null);
      }
    },
    [pending],
  );

  /** `create` makes the folder first; `location` is the folder it goes in. */
  const addFolder = React.useCallback(
    (target: string, options: { create: boolean; location: string }) =>
      run('add', async () => {
        if (options.create) {
          const response = await postJson('/api/fs/mkdir', { path: target }, { directory: options.location });
          if (!response.ok) throw new Error(await readError(response, 'Couldn’t create the folder.'));
        }
        addAndOpen(target);
      }),
    [addAndOpen, run],
  );

  /** Clones into a new folder inside `location`, named after the repository. */
  const cloneRepository = React.useCallback(
    (remoteUrl: string, location: string) =>
      run('clone', async () => {
        const response = await postJson('/api/fs/clone', {
          remoteUrl: remoteUrl.trim(),
          destinationPath: `${trimTrailingSeparators(location)}/`,
        });
        if (!response.ok) {
          // git prefixes its reason with progress and "fatal:"; the reason is what helps.
          const reason = (await readError(response, 'The clone failed.'))
            .replace(/^Cloning into '[^']*'\.\.\.\s*/, '')
            .replace(/^fatal:\s*/, '');
          throw new Error(reason.charAt(0).toUpperCase() + reason.slice(1));
        }
        const data = (await response.json()) as { path?: unknown };
        if (typeof data.path !== 'string' || !data.path) {
          throw new Error('The clone finished, but the server didn’t say where. Add the folder from Folder on this server.');
        }
        addAndOpen(data.path);
      }),
    [addAndOpen, run],
  );

  /** Creates `location/name`, then optionally runs `git init` in it. */
  const createProject = React.useCallback(
    (location: string, name: string, initGit: boolean) =>
      run('create', async () => {
        const target = `${trimTrailingSeparators(location)}/${name.trim()}`;
        const created = await postJson('/api/fs/mkdir', { path: target }, { directory: location });
        if (!created.ok) throw new Error(await readError(created, 'Couldn’t create the folder.'));
        if (initGit) {
          const initialized = await runtimeFetch('/api/git/init', {
            method: 'POST',
            query: { directory: target },
          });
          if (!initialized.ok) {
            const reason = await readError(initialized, 'git init failed.');
            throw new Error(`The folder was created, but git init failed: ${reason}`);
          }
        }
        addAndOpen(target);
      }),
    [addAndOpen, run],
  );

  const clearError = React.useCallback(() => setError(null), []);

  return { pending, error, clearError, addFolder, cloneRepository, createProject };
}
