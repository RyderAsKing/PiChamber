import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionDirectory } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

/**
 * Hook that resolves the effective working directory for tabs (Git, Diff, Files, Terminal).
 *
 * Priority order:
 * 1. Session directory (for active sessions)
 * 2. Draft session directoryOverride (when creating a new session)
 * 3. Fallback directory from DirectoryStore
 */
export const useEffectiveDirectory = (): string | undefined => {
    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const newSessionDraft = useSessionUIStore((s) => s.newSessionDraft);
    const currentSessionDirectory = useSessionDirectory(currentSessionId);
    const fallbackDirectory = useDirectoryStore((s) => s.currentDirectory);

    // If we have an active session, use its directory
    if (currentSessionId && currentSessionDirectory) {
        return currentSessionDirectory;
    }

    // If a draft session is open, use its directoryOverride
    if (newSessionDraft?.open && newSessionDraft.directoryOverride) {
        return newSessionDraft.directoryOverride;
    }

    // Fall back to the global directory
    return fallbackDirectory ?? undefined;
};
