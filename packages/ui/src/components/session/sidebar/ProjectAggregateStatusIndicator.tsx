import React from 'react';

import { AgentThinkingLoader } from '@/components/chat/AgentThinkingLoader';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { formatSessionsNeedingInputLabel, hasPendingInput } from './sessionAttention';
import { normalizePath } from './utils';

export interface ProjectAggregateStatusIndicatorProps {
  directories: Array<string | null>;
}

// Aggregated activity/attention dot for a collapsed project header. Only
// mounted while the project is collapsed, so the per-status-event scans stay
// rare and bounded by the project's directory count. A session needing input
// takes precedence over the busy spinner.
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

  const status = usePiSessionSnapshot((state) => {
    let inputCount = 0;
    let hasBusySession = false;
    for (const record of state.catalog.byId.values()) {
      const directory = normalizePath(record.directory)?.toLowerCase();
      if (!directory || !directorySet.has(directory)) continue;
      if (hasPendingInput(record.pendingInput)) {
        inputCount += 1;
      } else if (record.lifecycle === 'busy' || record.lifecycle === 'retry') {
        hasBusySession = true;
      }
    }
    return { inputCount, hasBusySession };
  }, (left, right) => left.inputCount === right.inputCount && left.hasBusySession === right.hasBusySession, 'catalog');

  if (status.inputCount > 0) {
    const label = formatSessionsNeedingInputLabel(status.inputCount);
    return (
      <span
        className="inline-flex items-center"
        aria-label={label}
        title={label}
      >
        <span className="size-1.5 shrink-0 rounded-full bg-status-warning" />
      </span>
    );
  }

  if (status.hasBusySession) {
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
