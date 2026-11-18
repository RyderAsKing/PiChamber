import React from 'react';
import { useProjectSandboxStore } from '@/stores/useProjectSandboxStore';
import { usePiSessionStore } from '@/sync/pi-session-context';

/**
 * Read a session again when the sandbox state this client knows changes
 * (Check again, or a saved sandbox setting), while the session is held back
 * by its sandbox: shown read-only, or not loaded at all. A sandbox that
 * works now makes the session live without the user asking twice.
 */
export const useReloadWhenSandboxChanges = (sessionId: string | null | undefined, blocked: boolean): void => {
  const store = usePiSessionStore();
  const launchers = useProjectSandboxStore((state) => state.launchers);
  const projects = useProjectSandboxStore((state) => state.projects);
  const seen = React.useRef({ launchers, projects });
  React.useEffect(() => {
    const changed = seen.current.launchers !== launchers || seen.current.projects !== projects;
    seen.current = { launchers, projects };
    if (!changed || !blocked || !sessionId) return;
    void store.reloadSession(sessionId);
  }, [blocked, launchers, projects, sessionId, store]);
};
