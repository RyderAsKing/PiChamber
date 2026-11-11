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

// Every section label shares one role: label size, semibold, muted. The
// weight sets it apart from row metadata at the same tone, and a plain heading
// (Recent, Today) and a shelf toggle (Snoozed) read as peers.
const sectionHeadingClassName = 'select-none px-3 pb-1 typography-ui-label font-medium text-muted-foreground';

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
    <span className="font-normal tabular-nums text-subtle-foreground">{count}</span>
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
      {/* A shelf heading is a row-sized control, set like a folder header:
          label and count on the left, the open/closed chevron on the right edge. */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="group/heading flex h-7 w-full select-none items-center gap-1.5 rounded-md px-3 text-left typography-ui-label font-medium text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        {label}
        {countLabel}
        <Icon
          name={expanded ? 'arrow-down-s' : 'arrow-right-s'}
          className="ml-auto size-4 shrink-0 text-muted-foreground group-hover/heading:text-foreground"
        />
      </button>
    </div>
  );
};
