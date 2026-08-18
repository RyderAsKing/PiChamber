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
}): React.ReactNode => (
  <button type="button" onClick={onClick} className={cn(mobileVariant ? sidebarSessionRowClassNameMobile : sidebarSessionRowClassName, className)}>
    <Icon name={icon} className={cn(sidebarRowIconClass(mobileVariant), 'text-muted-foreground')} />
    <span className={cn(sidebarRowLabelClass(mobileVariant), 'flex-1 text-muted-foreground')}>{children}</span>
  </button>
);
