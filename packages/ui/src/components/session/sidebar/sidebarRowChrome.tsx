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
