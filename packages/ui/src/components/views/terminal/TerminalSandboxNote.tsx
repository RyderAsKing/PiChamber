import React from 'react';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useProjectSandboxStore } from '@/stores/useProjectSandboxStore';
import { buildAvailableWorktreesByProject, useWorktreeStore } from '@/stores/useWorktreeStore';

/**
 * The built-in terminal always opens the user's normal shell (#242). In a
 * sandboxed project it says so, so nobody mistakes it for the agent's
 * confined environment.
 */
export const TerminalSandboxNote: React.FC<{ directory: string }> = ({ directory }) => {
  const projects = useProjectsStore((state) => state.projects);
  const worktreeProjects = useWorktreeStore((state) => state.projects);
  const sandboxes = useProjectSandboxStore((state) => state.projects);
  const sandboxesStatus = useProjectSandboxStore((state) => state.projectsStatus);
  const loadSandboxes = useProjectSandboxStore((state) => state.loadProjects);

  React.useEffect(() => {
    if (sandboxesStatus === 'idle') void loadSandboxes();
  }, [loadSandboxes, sandboxesStatus]);

  const project = React.useMemo(
    () => resolveProjectForSessionDirectory(
      projects,
      buildAvailableWorktreesByProject(projects, { projects: worktreeProjects }),
      directory,
    ),
    [directory, projects, worktreeProjects],
  );

  const sandbox = project ? sandboxes[project.id] : undefined;
  if (!sandbox || sandbox.mode === 'off') return null;

  return (
    <p className="px-4 pt-2 typography-micro text-muted-foreground">
      This project is sandboxed, but this terminal runs outside the sandbox with your normal access.
    </p>
  );
};
