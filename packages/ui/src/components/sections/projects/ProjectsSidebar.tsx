import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SettingsSidebarItem } from '@/components/sections/shared/SettingsSidebarItem';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { sessionEvents } from '@/lib/sessionEvents';
import { SETTINGS_PANEL_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import { useDeviceInfo } from '@/lib/device';

export const ProjectsSidebar: React.FC<{ onItemSelect?: () => void }> = ({ onItemSelect }) => {
  const { isMobile } = useDeviceInfo();
  const projects = useProjectsStore((state) => state.projects);
  const selectedId = useUIStore((state) => state.settingsProjectsSelectedId);
  const setSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);

  const handleAddProject = React.useCallback(() => {
    sessionEvents.requestDirectoryDialog();
  }, []);

  React.useEffect(() => {
    if (projects.length === 0) {
      if (selectedId !== null) {
        setSelectedId(null);
      }
      return;
    }
    if (selectedId && projects.some((p) => p.id === selectedId)) {
      return;
    }
    setSelectedId(projects[0].id);
  }, [projects, selectedId, setSelectedId]);

  return (
    <SettingsSidebarLayout
      variant="background"
      header={
        <div className={cn('border-b px-3', 'pt-4 pb-3')}>
          {/* The mobile header already shows the page title. */}
          {!isMobile && <h2 className={`${SETTINGS_PANEL_TITLE_CLASS} mb-3`}>{"Projects"}</h2>}
          <div className="flex items-center justify-between gap-2">
            <span className="typography-meta text-muted-foreground">{`Total ${projects.length}`}</span>
            {(
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 -my-1 text-muted-foreground"
                onClick={handleAddProject}
                aria-label={"Add project"}
              >
                <Icon name="add" className="size-4" />
              </Button>
            )}
          </div>
        </div>
      }
    >
      {projects.map((project) => {
        const selected = project.id === selectedId;
        const icon = (
          <Icon name="folder" className={cn('h-4 w-4', selected ? 'text-foreground' : 'text-muted-foreground/70')} />
        );

        return (
          <SettingsSidebarItem
            key={project.id}
            title={project.label || project.path}
            metadata={project.label ? project.path : undefined}
            icon={icon}
            selected={selected}
            onSelect={() => {
              setSelectedId(project.id);
              onItemSelect?.();
            }}
          />
        );
      })}
    </SettingsSidebarLayout>
  );
};
