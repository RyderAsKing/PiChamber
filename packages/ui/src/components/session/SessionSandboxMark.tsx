import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useSessionSandboxLabel } from '@/sync/sync-context';

interface SessionSandboxMarkProps {
  sessionId: string;
  className?: string;
}

/**
 * A lock after a session's title when its agent runs in a project sandbox
 * (#242): closed while sandboxed, open while it waits to change after a turn.
 * The meaning is in the tooltip and the accessible name. Renders nothing for
 * an unsandboxed session.
 */
export const SessionSandboxMark: React.FC<SessionSandboxMarkProps> = ({ sessionId, className }) => {
  const label = useSessionSandboxLabel(sessionId);
  if (!label) return null;
  return (
    <span role="img" aria-label={label.text} title={label.text} className={cn('inline-flex shrink-0 items-center', className)}>
      <Icon name={label.icon} className="size-3.5 text-subtle-foreground" />
    </span>
  );
};
