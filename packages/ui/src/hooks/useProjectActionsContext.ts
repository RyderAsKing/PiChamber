import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession } from '@/sync/sync-context';
import type { ProjectRef } from '@/lib/pichamberConfig';

export interface ProjectActionsContext {
  projectRef: ProjectRef;
  directory: string;
}

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

/**
 * Resolves the active project ref + working directory used by
 * {@link ProjectActionsButton}. Directory priority: session → draft → project path.
 */
export function useProjectActionsContext(): ProjectActionsContext | null {
  const activeProject = useProjectsStore((state) => {
    if (!state.activeProjectId) {
      return null;
    }
    return state.projects.find((project) => project.id === state.activeProjectId) ?? null;
  });

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSession = useSession(currentSessionId ?? null);

  const draftDirectory = useSessionUIStore((state) => {
    if (!state.newSessionDraft?.open) {
      return '';
    }
    return normalize(state.newSessionDraft.directoryOverride ?? '');
  });

  const sessionDirectory = React.useMemo(() => {
    const raw = typeof currentSession?.directory === 'string' ? currentSession.directory : '';
    return normalize(raw || '');
  }, [currentSession?.directory]);

  const openDirectory = sessionDirectory || draftDirectory;
  const actionDirectory = React.useMemo(
    () => normalize(openDirectory || activeProject?.path || ''),
    [activeProject?.path, openDirectory],
  );
  const activeProjectRef = React.useMemo<ProjectRef | null>(() => {
    if (!activeProject) {
      return null;
    }
    return {
      id: activeProject.id,
      path: normalize(activeProject.path),
    };
  }, [activeProject]);

  const stableContextRef = React.useRef<ProjectActionsContext | null>(null);

  if (activeProjectRef && actionDirectory) {
    stableContextRef.current = {
      projectRef: activeProjectRef,
      directory: actionDirectory,
    };
    return stableContextRef.current;
  }

  return stableContextRef.current;
}
