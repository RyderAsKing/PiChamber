import React from 'react';
import { cn } from '@/lib/utils';

export function SessionUnreadDot({
  label,
  className,
}: {
  label: string;
  className?: string;
}): React.ReactNode {
  return (
    <span
      className={cn('size-1.5 shrink-0 rounded-full bg-foreground', className)}
      aria-label={label}
      title={label}
    />
  );
}
