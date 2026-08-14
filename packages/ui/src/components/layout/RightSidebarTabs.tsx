import React from 'react';

import { ProjectNotesTodoPanel } from '@/components/session/ProjectNotesTodoPanel';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { formatDirectoryName } from '@/lib/utils';

export const ProjectContextPanel: React.FC<{
  onActionComplete?: () => void;
}> = ({ onActionComplete }) => {
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const projects = useProjectsStore((state) => state.projects);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);

  const activeProject = React.useMemo(() => {
    if (activeProjectId) {
      return projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null;
    }
    return projects[0] ?? null;
  }, [activeProjectId, projects]);

  const projectRef = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }
    return {
      id: activeProject.id,
      path: activeProject.path,
    };
  }, [activeProject]);

  const projectLabel = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }
    return activeProject.label?.trim()
      || formatDirectoryName(activeProject.path, homeDirectory)
      || activeProject.path;
  }, [activeProject, homeDirectory]);

  return (
    <div className="h-full min-h-0 overflow-auto bg-background">
      <ProjectNotesTodoPanel
        projectRef={projectRef}
        projectLabel={projectLabel}
        onActionComplete={onActionComplete}
      />
    </div>
  );
};
