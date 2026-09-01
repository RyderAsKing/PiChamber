import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { sessionEvents } from '@/lib/sessionEvents';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { ProjectCard } from '@/components/sections/projects/ProjectCard';
import { ProjectSettingsPanel } from '@/components/sections/projects/ProjectSettingsPanel';
import { useDeviceInfo } from '@/lib/device';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import type { ProjectIdentitySaveData } from '@/components/sections/projects/useProjectIdentityForm';

/** Projects settings — browse grid + detail, like Providers/Skills/Snippets. */
export const ProjectsPage: React.FC = () => {
  const { isMobile } = useDeviceInfo();
  const projects = useProjectsStore((state) => state.projects);
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const selectedId = useUIStore((state) => state.settingsProjectsSelectedId);
  const setSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);

  const [projectQuery, setProjectQuery] = React.useState('');

  const handleAddProject = React.useCallback(() => {
    sessionEvents.requestDirectoryDialog();
  }, []);

  const selectedProject = React.useMemo(() => {
    if (!selectedId) return null;
    return projects.find((p) => p.id === selectedId) ?? null;
  }, [projects, selectedId]);

  // Clear stale selection (e.g. project removed) — don't auto-select first;
  // browse grid is the default empty state like Providers/Skills.
  React.useEffect(() => {
    if (selectedId && !projects.some((p) => p.id === selectedId)) {
      setSelectedId(null);
    }
  }, [projects, selectedId, setSelectedId]);

  const handleIdentitySave = React.useCallback(
    async (data: ProjectIdentitySaveData) => {
      if (!selectedProject) return;
      updateProjectMeta(selectedProject.id, {
        label: data.label,
        defaultModel: data.defaultModel ?? null,
      });
    },
    [selectedProject, updateProjectMeta],
  );

  const sortedProjects = React.useMemo(() => {
    return [...projects].sort((a, b) => {
      const aLabel = (a.label?.trim() || a.path).toLowerCase();
      const bLabel = (b.label?.trim() || b.path).toLowerCase();
      return aLabel.localeCompare(bLabel, undefined, { sensitivity: 'base' });
    });
  }, [projects]);

  const filteredProjects = React.useMemo(() => {
    const q = projectQuery.trim().toLowerCase();
    if (!q) return sortedProjects;
    return sortedProjects.filter((p) => {
      const label = (p.label ?? '').toLowerCase();
      const path = p.path.toLowerCase();
      return label.includes(q) || path.includes(q);
    });
  }, [sortedProjects, projectQuery]);

  // ── Detail view ──────────────────────────────────────────────────────────
  if (selectedProject) {
    const label = selectedProject.label?.trim() || selectedProject.path.split('/').pop()?.trim() || selectedProject.path;

    return (
      <SettingsPageLayout
        title={
          <span className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setSelectedId(null)}
              aria-label="Back to projects"
              className="-ml-1 h-7 w-7 p-0"
            >
              <Icon name="arrow-left-s" className="size-4" />
            </Button>
            <Icon name="folder" className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{label}</span>
          </span>
        }
        description={<span className="font-mono typography-settings-description text-muted-foreground">{selectedProject.path}</span>}
      >
        <ProjectSettingsPanel project={selectedProject} onIdentitySave={handleIdentitySave} />
      </SettingsPageLayout>
    );
  }

  // ── Browse grid ──────────────────────────────────────────────────────────
  // Empty state — no projects at all
  if (projects.length === 0) {
    return (
      <SettingsPageLayout
        title={isMobile ? undefined : 'Projects'}
        description={isMobile ? undefined : 'Manage your projects and worktrees. Add a project to configure its defaults and actions.'}
        headerEnd={
          <Button variant="outline" size="sm" onClick={handleAddProject}>
            <Icon name="add" className="size-4" />
            Add project
          </Button>
        }
      >
        <SettingsSection title="Projects" divider={false} settingsItem="projects.browse">
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <Icon name="folders" className="size-8 text-muted-foreground/60" aria-hidden />
            <p className="typography-meta text-muted-foreground">No projects yet</p>
            <p className="typography-micro max-w-sm text-muted-foreground">Add a local directory to start saving per-project defaults, session history, and header actions.</p>
            <Button variant="outline" size="sm" onClick={handleAddProject}>
              <Icon name="add" className="size-4" />
              Add project
            </Button>
          </div>
        </SettingsSection>
      </SettingsPageLayout>
    );
  }

  return (
    <SettingsPageLayout
      title={isMobile ? undefined : 'Projects'}
      description={isMobile ? undefined : 'Manage your projects and worktrees. Click a card to configure its defaults and actions.'}
      headerEnd={
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Icon
              name="search"
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={projectQuery}
              onChange={(event) => setProjectQuery(event.target.value)}
              placeholder="Search projects"
              aria-label="Search projects"
              className="h-9 w-[18rem] max-w-[24rem] pl-8"
            />
            {projectQuery ? (
              <button
                type="button"
                onClick={() => setProjectQuery('')}
                aria-label="Clear search"
                className="absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
              >
                <Icon name="close" className="size-4" />
              </button>
            ) : null}
          </div>
          <Button variant="outline" size="sm" onClick={handleAddProject}>
            <Icon name="add" className="size-4" />
            Add project
          </Button>
        </div>
      }
    >
      <SettingsSection title="Projects" divider={false} settingsItem="projects.browse">
        {filteredProjects.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
            <p className="typography-meta text-muted-foreground">No projects match “{projectQuery}”.</p>
            <Button variant="ghost" size="xs" onClick={() => setProjectQuery('')}>
              Clear search
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3">
            {filteredProjects.map((project) => (
              <ProjectCard key={project.id} project={project} onSelect={setSelectedId} />
            ))}
            <button
              type="button"
              onClick={handleAddProject}
              aria-label="Add project"
              className={cn(
                'group flex min-h-[118px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-4',
                'border-border/60 bg-transparent text-muted-foreground',
                'hover:border-border hover:bg-interactive-hover hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
                'transition-colors duration-150',
              )}
            >
              <span className="inline-flex size-9 items-center justify-center rounded-full bg-muted">
                <Icon name="add" className="size-5" />
              </span>
              <span className="typography-ui-label font-medium">Add project</span>
              <span className="typography-micro text-muted-foreground">Local directory</span>
            </button>
          </div>
        )}
      </SettingsSection>
    </SettingsPageLayout>
  );
};
