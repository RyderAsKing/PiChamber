import React from 'react';
import { RiCheckLine } from '@remixicon/react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useProjectsStore } from '@/stores/useProjectsStore';

import { MobileFullscreenSurface } from './MobileFullscreenSurface';

type MobileEditableProject = {
  id: string;
  label: string;
  path: string;
  isGitRepo: boolean;
};

type MobileProjectEditSurfaceProps = {
  open: boolean;
  project: MobileEditableProject | null;
  onClose: () => void;
};

export const MobileProjectEditSurface: React.FC<MobileProjectEditSurfaceProps> = ({
  open,
  project,
  onClose,
}) => {
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const [name, setName] = React.useState('');
  const projectId = project?.id ?? null;

  React.useEffect(() => {
    if (!open || !project) return;
    setName(project.label);
  }, [open, project, projectId]);

  const handleSave = () => {
    if (!project) return;
    const trimmed = name.trim();
    updateProjectMeta(project.id, {
      label: trimmed || project.label,
    });
    onClose();
  };

  return (
    <MobileFullscreenSurface
      open={open}
      onClose={onClose}
      title={"Edit project"}
      ariaLabel={"Edit project"}
      noHeaderBorder
      trailing={
        <Button
          type="button"
          variant="default"
          size="sm"
          aria-label={"Save"}
          onClick={handleSave}
          disabled={!name.trim()}
          style={{ touchAction: 'manipulation' }}
        >
          <RiCheckLine className="size-4" />
          {"Save"}
        </Button>
      }
    >
      {project ? (
        <div className="h-full space-y-6 overflow-y-auto px-4 pb-8 pt-2">
          <div className="flex justify-center pt-2">
            <span className="flex size-16 items-center justify-center overflow-hidden rounded-2xl bg-[var(--surface-muted)] text-muted-foreground">
              <Icon name="folder" className="size-7" />
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="typography-ui-label font-medium text-foreground">
              {"Name"}
            </label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={"Project name"}
              className="h-11"
            />
            <p className="truncate typography-meta text-muted-foreground" title={project.path}>
              {project.path}
            </p>
          </div>
        </div>
      ) : null}
    </MobileFullscreenSurface>
  );
};
