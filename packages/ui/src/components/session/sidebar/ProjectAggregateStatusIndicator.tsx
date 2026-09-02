import React from 'react';

import { AgentThinkingLoader } from '@/components/chat/AgentThinkingLoader';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { normalizePath } from './utils';

export interface ProjectAggregateStatusIndicatorProps {
  directories: Array<string | null>;
}

// Aggregated activity/attention dot for a collapsed project header. Only
// mounted while the project is collapsed, so the per-status-event scans stay
// rare and bounded by the project's directory count.
export const ProjectAggregateStatusIndicator: React.FC<ProjectAggregateStatusIndicatorProps> = ({
  directories,
}) => {
  const directorySet = React.useMemo(() => {
    const set = new Set<string>();
    directories.forEach((directory) => {
      const normalized = normalizePath(directory)?.toLowerCase();
      if (normalized) set.add(normalized);
    });
    return set;
  }, [directories]);

  const hasBusySession = usePiSessionSnapshot((state) => {
    for (const record of state.catalog.byId.values()) {
      if (record.lifecycle !== 'busy' && record.lifecycle !== 'retry') continue;
      const directory = normalizePath(record.directory)?.toLowerCase();
      if (directory && directorySet.has(directory)) return true;
    }
    return false;
  }, undefined, 'catalog');

  if (hasBusySession) {
    return (
      <span
        className="inline-flex items-center"
        aria-label={'Session active'}
        title={'Session active'}
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
  return null;
};
