import React from 'react';
import { getProjectDisplayLabel } from '@/lib/projectDisplayLabel';

import { Icon } from '@/components/icon/Icon';
import { MiddleTruncate } from '@/components/ui/MiddleTruncate';
import { ProjectIcon } from '@/components/ui/ProjectIcon';
import { cn, formatPathForDisplay } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import type { ProjectEntry } from '@/lib/api/types';
import type { PiProjectSandboxState } from '@/lib/pi/protocol';

interface ProjectCardProps {
  project: ProjectEntry;
  /** The project's sandbox state, when loaded. */
  sandbox?: PiProjectSandboxState;
  onSelect: (projectId: string) => void;
}

/** Grid card for project browse. Mirrors Provider/Skill/Snippet cards. */
export const ProjectCard: React.FC<ProjectCardProps> = ({ project, sandbox, onSelect }) => {
  const label = getProjectDisplayLabel(project);
  const hasCustomLabel = Boolean(project.label?.trim());
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  // Home-relative, so the card spends its width on the part that differs.
  const displayPath = formatPathForDisplay(project.path, homeDirectory);
  const sandboxText = !sandbox || sandbox.mode === 'off'
    ? null
    : sandbox.availability.state === 'unavailable'
      ? 'Sandbox unavailable'
      : 'Sandboxed';
  const sandboxUnavailable = sandbox?.mode !== 'off' && sandbox?.availability.state === 'unavailable';

  return (
    <button
      type="button"
      onClick={() => onSelect(project.id)}
      aria-label={`${label} project, ${project.path}${sandboxText ? `, ${sandboxText.toLowerCase()}` : ''}`}
      className={cn(
        'group flex min-h-[118px] flex-col gap-3 rounded-xl border bg-[var(--surface-elevated)] p-4 text-left',
        'border-border/60 hover:bg-interactive-hover hover:border-border',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
        'transition-colors duration-150',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <ProjectIcon directory={project.path} label={label} className="size-8" />
        {sandboxText ? (
          // A lock for a sandboxed project; when nono cannot run, the lock
          // turns to the error colour and says so, since its sessions refuse
          // to start. The card's accessible name carries the same state.
          <span
            title={sandboxText}
            className={cn(
              'inline-flex items-center gap-1 typography-micro whitespace-nowrap',
              sandboxUnavailable ? 'text-[var(--status-error)]' : 'text-subtle-foreground',
            )}
          >
            <Icon name="lock" className="size-3.5" />
            {sandboxUnavailable ? 'Unavailable' : null}
          </span>
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate typography-ui-label font-medium text-foreground">{label}</div>
        {/* Elide the middle: a path's useful part is its end. */}
        <MiddleTruncate
          value={displayPath}
          className={cn('flex typography-meta text-muted-foreground', hasCustomLabel && 'font-mono')}
        />
      </div>
    </button>
  );
};

interface ProjectCardSkeletonProps {
  count?: number;
}

export const ProjectCardSkeleton: React.FC<ProjectCardSkeletonProps> = ({ count = 6 }) => (
  <>
    {Array.from({ length: count }).map((_, index) => (
      <div
        key={index}
        className="flex min-h-[118px] flex-col gap-3 rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-4"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="size-8 shrink-0 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="space-y-1.5">
          <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-3 w-full animate-pulse rounded bg-muted" />
        </div>
      </div>
    ))}
  </>
);
