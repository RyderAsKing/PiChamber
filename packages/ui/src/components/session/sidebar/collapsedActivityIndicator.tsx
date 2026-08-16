import React from 'react';
import { cn } from '@/lib/utils';
import type { CollapsedActivityState } from './collapsedActivityState';
import { AgentThinkingLoader } from '@/components/chat/AgentThinkingLoader';

export function CollapsedActivityIndicator({
  state,
  activeLabel,
  unreadLabel,
  className,
}: {
  state: Exclude<CollapsedActivityState, null>;
  activeLabel: string;
  unreadLabel?: string;
  className?: string;
}): React.ReactNode {
  if (state === 'unread') {
    return (
      <span
        className={cn('inline-flex items-center', className)}
        aria-label={unreadLabel ?? activeLabel}
        title={unreadLabel ?? activeLabel}
      >
        <span className="size-1.5 shrink-0 rounded-full bg-foreground" />
      </span>
    );
  }
  return (
    <span
      className={cn('inline-flex items-center', className)}
      aria-label={activeLabel}
      title={activeLabel}
    >
      <AgentThinkingLoader
        variant="inline"
        text={null}
        animationType="spinner"
        speedMs={80}
        className="text-primary text-xs shrink-0"
      />
    </span>
  );
}
