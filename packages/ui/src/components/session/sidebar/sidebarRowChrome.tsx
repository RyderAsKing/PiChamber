import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';

import {
  sidebarRowIconClassName,
  sidebarRowLabelClassName,
  sidebarSessionRowClassName,
} from './utils';

export const SidebarSessionLikeButton = ({
  icon,
  children,
  onClick,
  className,
}: {
  icon: IconName;
  children: React.ReactNode;
  onClick: () => void;
  className?: string;
}): React.ReactNode => (
  <button type="button" onClick={onClick} className={cn(sidebarSessionRowClassName, className)}>
    <Icon name={icon} className={cn(sidebarRowIconClassName, 'text-muted-foreground')} />
    <span className={cn(sidebarRowLabelClassName, 'flex-1 text-muted-foreground')}>{children}</span>
  </button>
);
