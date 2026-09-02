import React from 'react';

import { AgentThinkingLoader } from '@/components/chat/AgentThinkingLoader';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DraftWorktreeCreationState } from '@/stores/useWorktreeCreationStore';

export interface DraftWorktreeCreationBannerProps {
  state: DraftWorktreeCreationState | null;
  onDismissFailed: () => void;
}

export const DraftWorktreeCreationBanner: React.FC<DraftWorktreeCreationBannerProps> = ({
  state,
  onDismissFailed,
}) => {
  if (!state) return null;

  return (
    <div
      className={cn(
        'mx-2 mb-2 flex min-h-16 items-center gap-3 rounded-xl px-3 py-2 typography-meta',
        state.phase === 'failed'
          ? 'bg-[var(--status-error-background)] text-[var(--status-error-foreground)]'
          : 'bg-[var(--surface-muted)] text-muted-foreground',
      )}
      role={state.phase === 'failed' ? 'alert' : 'status'}
    >
      {state.phase !== 'failed' ? (
        <AgentThinkingLoader variant="inline" text={null} animationType="spinner" />
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="typography-ui-label">{state.label}</p>
        {state.phase !== 'failed' ? (
          <p className="mt-0.5 text-xs opacity-70">Running in background — you can navigate away</p>
        ) : null}
        {state.error ? <p className="mt-0.5 break-words">{state.error}</p> : null}
      </div>
      {state.phase === 'failed' ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onDismissFailed}
          aria-label="Dismiss error"
        >
          Dismiss
        </Button>
      ) : null}
    </div>
  );
};
