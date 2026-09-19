import React from 'react';

import { toast } from '@/components/ui/toast';
import { shouldNotifyWorktreeReady } from '@/components/chat/composer/submit/worktreeFailedSend';
import { useWorktreeCreationStore } from '@/stores/useWorktreeCreationStore';

export const WorktreeCreationToasts: React.FC = () => {
  const entries = useWorktreeCreationStore((state) => state.entries);

  React.useEffect(() => {
    for (const entry of entries.values()) {
      // Prompt-dispatch-pending entries (`receipt && failedSend && !state`)
      // must stay silent until dispatch settles; only completed tasks
      // announce Worktree ready. Post-receipt failed entries surface through
      // the prompt-failure toast with Restore draft available.
      if (!shouldNotifyWorktreeReady(entry) || !entry.receipt) continue;
      useWorktreeCreationStore.getState().markNotificationSent(entry.key);
      toast.success('Worktree ready', {
        id: `worktree-ready:${entry.key}`,
        description: entry.receipt.branch || entry.receipt.path,
      });
    }
  }, [entries]);

  return null;
};
