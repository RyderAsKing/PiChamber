import React from 'react';

import { toast } from '@/components/ui/toast';
import { useWorktreeCreationStore } from '@/stores/useWorktreeCreationStore';

export const WorktreeCreationToasts: React.FC = () => {
  const entries = useWorktreeCreationStore((state) => state.entries);

  React.useEffect(() => {
    for (const entry of entries.values()) {
      if (!entry.receipt || entry.notificationSent) continue;
      useWorktreeCreationStore.getState().markNotificationSent(entry.key);
      toast.success('Worktree ready', {
        id: `worktree-ready:${entry.key}`,
        description: entry.receipt.branch || entry.receipt.path,
      });
    }
  }, [entries]);

  return null;
};
