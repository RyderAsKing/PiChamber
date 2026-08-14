import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions } from '@/sync/sync-context';
import type { Session } from '@/lib/chat/types';

export const useChatSearchDirectory = (): string | undefined => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessions = useSessions();
  const newSessionDraft = useSessionUIStore((state) => state.newSessionDraft);

  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const projects = useProjectsStore((state) => state.projects);

  const fallbackDirectory = useDirectoryStore((state) => state.currentDirectory);

  if (currentSessionId) {
    type SessionWithDirectory = Session & { directory?: string };
    const currentSession = sessions.find((session) => session.id === currentSessionId) as SessionWithDirectory | undefined;
    if (currentSession?.directory) {
      return currentSession.directory;
    }
  }

  if (newSessionDraft?.open && newSessionDraft.directoryOverride) {
    return newSessionDraft.directoryOverride ?? undefined;
  }

  if (activeProjectId) {
    const activeProject = projects.find((project) => project.id === activeProjectId);
    if (activeProject?.path) {
      return activeProject.path;
    }
  }

  return fallbackDirectory ?? undefined;
};
