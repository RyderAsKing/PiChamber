import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';

import {
  sidebarSessionRowClassName,
  sidebarSessionRowClassNameMobile,
  sidebarRowIconClass,
  sidebarRowLabelClass,
} from './utils';
import { SessionRowVariantContext, treeRowGapClassName, treeRowSpacingClassName } from './sessionRowVariant';

export const SidebarSessionLikeButton = ({
  icon,
  children,
  onClick,
  className,
  mobileVariant = false,
}: {
  icon: IconName;
  children: React.ReactNode;
  onClick: () => void;
  className?: string;
  mobileVariant?: boolean;
}): React.ReactNode => {
  const isTree = React.useContext(SessionRowVariantContext) === 'tree';
  return (
    <button
      type="button"
      onClick={onClick}
      data-sidebar-tree-row={isTree ? '' : undefined}
      className={cn(
        mobileVariant ? sidebarSessionRowClassNameMobile : sidebarSessionRowClassName,
        isTree && treeRowGapClassName,
        isTree && treeRowSpacingClassName,
        className,
      )}
    >
      <Icon name={icon} className={cn(sidebarRowIconClass(mobileVariant), 'text-muted-foreground')} />
      <span className={cn(sidebarRowLabelClass(mobileVariant), 'flex-1 text-muted-foreground')}>{children}</span>
    </button>
  );
};

const sectionHeadingClassName = 'select-none px-3 pb-1 text-xs leading-4 font-medium text-muted-foreground';

/**
 * Small heading above a run of session rows: Timeline's date buckets and the
 * Threads and By folder sections. With `onToggle` it collapses its section;
 * the count and chevron sit beside the label so the heading keeps its shape.
 */
export const SidebarSectionHeading = ({
  label,
  first = false,
  count,
  expanded,
  onToggle,
}: {
  label: string;
  /** The first heading in the list sits closer to the top. */
  first?: boolean;
  count?: number;
  expanded?: boolean;
  onToggle?: () => void;
}) => {
  const spacing = first ? 'pt-1' : 'pt-3';
  const countLabel = typeof count === 'number' ? (
    <span className="font-normal text-subtle-foreground tabular-nums">{count}</span>
  ) : null;
  if (!onToggle) {
    return (
      <div role="heading" aria-level={3} className={cn(sectionHeadingClassName, spacing, 'flex items-center gap-1.5')}>
        {label}
        {countLabel}
      </div>
    );
  }
  return (
    <div role="heading" aria-level={3} className={spacing}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cn(
          sectionHeadingClassName,
          'group/heading flex w-full items-center gap-1.5 rounded-md pt-0 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        )}
      >
        {label}
        {countLabel}
        <Icon
          name="arrow-right-s"
          className={cn('size-3.5 shrink-0 text-subtle-foreground transition-transform group-hover/heading:text-foreground', expanded && 'rotate-90')}
        />
      </button>
    </div>
  );
};
