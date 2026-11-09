import React from 'react';

import { MiddleTruncate } from '@/components/ui/MiddleTruncate';
import { ProjectIcon } from '@/components/ui/ProjectIcon';
import { cn } from '@/lib/utils';
import type { ProjectEntry } from '@/lib/api/types';

interface ProjectCardProps {
  project: ProjectEntry;
  onSelect: (projectId: string) => void;
}

/** Grid card for project browse. Mirrors Provider/Skill/Snippet cards. */
export const ProjectCard: React.FC<ProjectCardProps> = ({ project, onSelect }) => {
  const label = project.label?.trim() || project.path.split('/').pop()?.trim() || project.path;
  const hasCustomLabel = Boolean(project.label?.trim());

  return (
    <button
      type="button"
      onClick={() => onSelect(project.id)}
      aria-label={`${label} project, ${project.path}`}
      className={cn(
        'group flex min-h-[118px] flex-col gap-3 rounded-xl border bg-[var(--surface-elevated)] p-4 text-left',
        'border-border/60 hover:bg-interactive-hover hover:border-border',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
        'transition-colors duration-150',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <ProjectIcon directory={project.path} label={label} className="size-8" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="truncate typography-ui-label font-medium text-foreground">{label}</div>
        {/* Elide the middle: a path's useful part is its end. */}
        <MiddleTruncate
          value={project.path}
          className={cn('flex typography-micro text-muted-foreground', hasCustomLabel && 'font-mono')}
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
