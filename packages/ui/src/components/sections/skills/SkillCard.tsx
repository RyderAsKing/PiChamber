import React from 'react';

import { cn } from '@/lib/utils';
import type { DiscoveredSkill } from '@/stores/useSkillsStore';

interface SkillCardProps {
  skill: DiscoveredSkill;
  onSelect: (skillName: string) => void;
  /** Hide the Project/Global pill — used when the grid is already filtered by location. */
  showLocationPill?: boolean;
}

/** Grid card for skill browse. Shows name, description, and optional location pill. */
export const SkillCard: React.FC<SkillCardProps> = ({ skill, onSelect, showLocationPill = true }) => {
  const locationLabel = skill.location === 'project' ? 'Project' : skill.location === 'global' ? 'Global' : skill.location;
  const description = skill.description?.trim() || 'No description';

  return (
    <button
      type="button"
      onClick={() => onSelect(skill.name)}
      aria-label={`${skill.name} skill, ${locationLabel}`}
      className={cn(
        'group flex min-h-[118px] flex-col gap-3 rounded-xl border bg-[var(--surface-elevated)] p-4 text-left',
        'border-border/60 hover:bg-interactive-hover hover:border-border',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
        'transition-colors duration-150',
      )}
    >
      {showLocationPill ? (
        <div className="flex justify-end">
          <span
            className={cn(
              'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 typography-micro font-medium capitalize',
              skill.location === 'project'
                ? 'bg-[var(--primary-base)]/10 text-[var(--primary-base)]'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {locationLabel}
          </span>
        </div>
      ) : null}

      <div className="min-w-0 flex-1">
        <div className="truncate typography-ui-label font-medium text-foreground">{skill.name}</div>
        <div className="mt-1 line-clamp-2 typography-micro text-muted-foreground">{description}</div>
      </div>
    </button>
  );
};

interface SkillCardSkeletonProps {
  count?: number;
}

export const SkillCardSkeleton: React.FC<SkillCardSkeletonProps> = ({ count = 6 }) => (
  <>
    {Array.from({ length: count }).map((_, index) => (
      <div
        key={index}
        className="flex min-h-[118px] flex-col gap-3 rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-4"
      >
        <div className="flex justify-end">
          <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
        </div>
        <div className="space-y-1.5">
          <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-3 w-full animate-pulse rounded bg-muted" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      </div>
    ))}
  </>
);
