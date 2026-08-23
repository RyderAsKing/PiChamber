import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useWorktreeStore } from '@/stores/useWorktreeStore';

const DISCOVERY_INTERVAL_MS = 15_000;
const DISCOVERY_CONCURRENCY = 2;

export const WorktreeDiscovery: React.FC = () => {
  const projects = useProjectsStore((state) => state.projects);
  const refreshProject = useWorktreeStore((state) => state.refreshProject);
  const { git } = useRuntimeAPIs();

  const projectPaths = React.useMemo(
    () => projects.map((project) => project.path).filter((path): path is string => Boolean(path)),
    [projects],
  );

  const refreshAll = React.useCallback(async () => {
    if (!git || projectPaths.length === 0) return;
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < projectPaths.length) {
        const path = projectPaths[nextIndex];
        nextIndex += 1;
        await refreshProject(path, git);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, projectPaths.length) }, () => worker()),
    );
  }, [git, projectPaths, refreshProject]);

  React.useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  React.useEffect(() => {
    const handleFocus = () => { void refreshAll(); };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshAll();
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshAll();
    }, DISCOVERY_INTERVAL_MS);
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.clearInterval(interval);
    };
  }, [refreshAll]);

  return null;
};
