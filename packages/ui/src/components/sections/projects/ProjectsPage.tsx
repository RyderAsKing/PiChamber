import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { ProjectSettingsPanel } from '@/components/sections/projects/ProjectSettingsPanel';
import type { ProjectIdentitySaveData } from '@/components/sections/projects/useProjectIdentityForm';
import { useDeviceInfo } from '@/lib/device';

export const ProjectsPage: React.FC = () => {
  
  const { isMobile } = useDeviceInfo();
  const projects = useProjectsStore((state) => state.projects);
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const selectedId = useUIStore((state) => state.settingsProjectsSelectedId);
  const setSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);

  const selectedProject = React.useMemo(() => {
    if (!selectedId) return null;
    return projects.find((p) => p.id === selectedId) ?? null;
  }, [projects, selectedId]);

  React.useEffect(() => {
    if (projects.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId && projects.some((p) => p.id === selectedId)) {
      return;
    }
    setSelectedId(projects[0].id);
  }, [projects, selectedId, setSelectedId]);

  const handleIdentitySave = React.useCallback(async (data: ProjectIdentitySaveData) => {
    if (!selectedProject) return;
    updateProjectMeta(selectedProject.id, {
      label: data.label,
      defaultModel: data.defaultModel ?? null,
    });
  }, [selectedProject, updateProjectMeta]);

  if (!selectedProject) {
    return (
      <SettingsPageLayout title={isMobile ? undefined : "Projects"}>
        <p className="typography-meta text-muted-foreground">{"No projects available."}</p>
      </SettingsPageLayout>
    );
  }

  const headerLabel = selectedProject.label ?? "Project Settings";

  return (
    <SettingsPageLayout
      title={headerLabel}
      description={selectedProject.path}
      outerClassName="bg-background"
    >
      <ProjectSettingsPanel project={selectedProject} onIdentitySave={handleIdentitySave} />
    </SettingsPageLayout>
  );
};
