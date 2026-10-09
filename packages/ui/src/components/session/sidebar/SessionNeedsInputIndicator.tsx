import React from 'react';
import { cn } from '@/lib/utils';

/**
 * "Needs input" dot for sessions the daemon reports as waiting on the user.
 * Sibling of `SessionUnreadDot`; uses the status-warning token so the
 * pending state reads apart from the neutral unread dot.
 */
export function SessionNeedsInputIndicator({
  label,
  className,
}: {
  label: string;
  className?: string;
}): React.ReactNode {
  return (
    <span
      className={cn('size-1.5 shrink-0 rounded-full bg-status-warning', className)}
      aria-label={label}
      title={label}
    />
  );
}
