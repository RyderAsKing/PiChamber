import React from 'react';
import { RiCheckLine, RiFolder6Line } from '@remixicon/react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { PROJECT_COLORS, PROJECT_COLOR_MAP, PROJECT_ICONS, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';

import { MobileFullscreenSurface } from './MobileFullscreenSurface';

type MobileEditableProject = {
  id: string;
  label: string;
  path: string;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
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
  
  const { currentTheme } = useThemeSystem();
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const discoverProjectIcon = useProjectsStore((state) => state.discoverProjectIcon);
  const removeProjectIcon = useProjectsStore((state) => state.removeProjectIcon);
  // Read the live icon image from the store so discover/remove reflect instantly.
  const currentIconImage = useProjectsStore((state) =>
    project ? state.projects.find((entry) => entry.id === project.id)?.iconImage ?? null : null,
  );

  const [name, setName] = React.useState('');
  const [icon, setIcon] = React.useState<string | null>(null);
  const [color, setColor] = React.useState<string | null>(null);
  const [isDiscovering, setIsDiscovering] = React.useState(false);

  const projectId = project?.id ?? null;

  React.useEffect(() => {
    if (!open || !project) return;
    setName(project.label);
    setIcon(project.icon ?? null);
    setColor(project.color ?? null);
  }, [open, project, projectId]);

  const handleSave = () => {
    if (!project) return;
    const trimmed = name.trim();
    updateProjectMeta(project.id, {
      label: trimmed || project.label,
      icon,
      color,
    });
    onClose();
  };

  const handleDiscoverIcon = () => {
    if (!project || isDiscovering) return;
    setIsDiscovering(true);
    void discoverProjectIcon(project.id)
      .then((result) => {
        if (!result.ok) {
          toast.error(result.error || "Failed to discover project icon");
          return;
        }
        if (result.skipped) {
          toast.success("Custom icon already set for this project");
          return;
        }
        toast.success("Project icon discovered");
      })
      .finally(() => setIsDiscovering(false));
  };

  const handleRemoveDiscoveredIcon = () => {
    if (!project) return;
    void removeProjectIcon(project.id).then((result) => {
      if (!result.ok) {
        toast.error(result.error || "Failed to remove project icon");
        return;
      }
      toast.success("Project icon removed");
    });
  };

  const currentColorVar = color ? PROJECT_COLOR_MAP[color] ?? null : null;
  const previewIconName = icon ? PROJECT_ICON_MAP[icon] : null;
  const hasImageIcon = Boolean(currentIconImage);

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
          {/* Icon preview */}
          <div className="flex justify-center pt-2">
            <span
              className="flex size-16 items-center justify-center overflow-hidden rounded-2xl bg-[var(--surface-muted)] text-muted-foreground"
              style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
            >
              {hasImageIcon ? (
                <ProjectIconImage
                  project={{ id: project.id, iconImage: currentIconImage }}
                  options={{
                    themeVariant: currentTheme.metadata.variant,
                    iconColor: currentTheme.colors.surface.foreground,
                  }}
                  className="size-full object-contain"
                  fallback={<RiFolder6Line className="size-7" />}
                />
              ) : previewIconName ? (
                <Icon name={previewIconName} className="size-7" style={currentColorVar ? { color: currentColorVar } : undefined} />
              ) : (
                <RiFolder6Line className="size-7" style={currentColorVar ? { color: currentColorVar } : undefined} />
              )}
            </span>
          </div>

          {/* Name */}
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

          {/* Color */}
          <div className="flex flex-col gap-2">
            <label className="typography-ui-label font-medium text-foreground">
              {"Color"}
            </label>
            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                onClick={() => setColor(null)}
                aria-label={"None"}
                className={cn(
                  'flex size-9 items-center justify-center rounded-xl border-2 transition-all',
                  color === null ? 'border-foreground' : 'border-border/70 hover:border-border/70',
                )}
                style={{ touchAction: 'manipulation' }}
              >
                <span className="h-0.5 w-4 rotate-45 rounded-full bg-muted-foreground/40" />
              </button>
              {PROJECT_COLORS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => setColor(c.key)}
                  aria-label={c.label}
                  title={c.label}
                  className={cn(
                    'size-9 rounded-xl border-2 transition-all',
                    color === c.key ? 'border-foreground' : 'border-transparent hover:border-border/70',
                  )}
                  style={{ backgroundColor: c.cssVar, touchAction: 'manipulation' }}
                />
              ))}
            </div>
          </div>

          {/* Icon */}
          <div className="flex flex-col gap-2">
            <label className="typography-ui-label font-medium text-foreground">
              {"Icon"}
            </label>
            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                onClick={() => setIcon(null)}
                aria-label={"None"}
                className={cn(
                  'flex size-9 items-center justify-center rounded-xl border-2 transition-all',
                  icon === null ? 'border-foreground bg-[var(--surface-elevated)]' : 'border-border/70 hover:border-border/70',
                )}
                style={{ touchAction: 'manipulation' }}
              >
                <span className="h-0.5 w-4 rotate-45 rounded-full bg-muted-foreground/40" />
              </button>
              {PROJECT_ICONS.map((i) => (
                <button
                  key={i.key}
                  type="button"
                  onClick={() => setIcon(i.key)}
                  aria-label={i.label}
                  title={i.label}
                  className={cn(
                    'flex size-9 items-center justify-center rounded-xl border-2 transition-all',
                    icon === i.key ? 'border-foreground bg-[var(--surface-elevated)]' : 'border-border/70 hover:border-border/70',
                  )}
                  style={{ touchAction: 'manipulation' }}
                >
                  <Icon name={i.Icon} className="size-4" style={currentColorVar ? { color: currentColorVar } : undefined} />
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={handleDiscoverIcon} disabled={isDiscovering}>
                {isDiscovering
                  ? "Discovering..."
                  : "Discover Favicon"}
              </Button>
              {hasImageIcon ? (
                <Button size="sm" variant="outline" onClick={handleRemoveDiscoveredIcon}>
                  {"Remove Project Icon"}
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </MobileFullscreenSurface>
  );
};
