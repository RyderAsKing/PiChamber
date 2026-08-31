import React from 'react';

import { useWorktreeCreationStore, getWorktreeCreationKey, type WorktreeCreationEntry } from '@/stores/useWorktreeCreationStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { AgentThinkingLoader } from '@/components/chat/AgentThinkingLoader';
import { cn } from '@/lib/utils';

/**
 * Global persistent banner for worktree creation that survives navigation.
 * Mounted at the app root so progress remains visible when the user switches
 * sessions, tabs, or views while a worktree is being bootstrapped in the
 * background.
 *
 * Behavior:
 * - Visible whenever any entry has a non-null, non-failed `state` (active creation)
 *   and the current draft intent does NOT match that entry (otherwise the inline
 *   composer banner already shows it).
 * - Also visible for `failed` entries until dismissed, and for recently completed
 *   entries that have a receipt but are no longer tied to the open draft (orphaned
 *   worktree) — offers an "Open" action.
 * - Positioned fixed bottom-center, above the composer but not overlapping mobile
 *   drawers. Uses the same spinner visual as the inline banner.
 */
export const GlobalWorktreeCreationBanner: React.FC = () => {
  const entries = useWorktreeCreationStore((state) => state.entries);
  const isMobile = useUIStore((state) => state.isMobile);
  const activeMainTab = useUIStore((state) => state.activeMainTab);
  const draft = useSessionUIStore((state) => state.newSessionDraft);
  const openDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const setDraftTarget = useSessionUIStore((state) => state.setNewSessionDraftTarget);

  const isChatVisible = activeMainTab === 'chat';

  const visibleEntries = React.useMemo(() => {
    const draftKey = getWorktreeCreationKey(draft?.worktreeIntent);
    const draftOpen = Boolean(draft?.open);

    const result: WorktreeCreationEntry[] = [];
    for (const entry of entries.values()) {
      const isCurrentDraft = draftOpen && entry.key === draftKey;
      const inlineVisible = isCurrentDraft && isChatVisible;
      if (entry.state) {
        if (!inlineVisible) result.push(entry);
        continue;
      }
      if (entry.receipt && !isCurrentDraft) result.push(entry);
    }
    return result;
  }, [entries, draft?.worktreeIntent, draft?.open, isChatVisible]);

  if (visibleEntries.length === 0) return null;

  return (
    <div
      className={cn(
        'pointer-events-none fixed inset-x-0 z-40 flex justify-center px-3',
        isMobile ? 'bottom-[calc(var(--oc-safe-area-bottom,0px)+5.5rem)]' : 'bottom-4',
      )}
      aria-live="polite"
    >
      <div className="pointer-events-auto flex w-full max-w-[640px] flex-col gap-2">
        {visibleEntries.map((entry) => (
          <BannerRow
            key={entry.key}
            entry={entry}
            onDismissFailed={() => useWorktreeCreationStore.getState().dismissFailed(entry.key)}
            onDismissCompleted={() => useWorktreeCreationStore.getState().clearEntry(entry.key)}
            onOpenWorktree={() => {
              const receipt = entry.receipt;
              if (!receipt) return;
              if (draft?.open) {
                setDraftTarget({
                  directoryOverride: receipt.path,
                  worktreeIntent: null,
                });
              } else {
                openDraft({ directoryOverride: receipt.path });
              }
              useWorktreeCreationStore.getState().clearEntry(entry.key);
              useUIStore.getState().setActiveMainTab('chat');
            }}
          />
        ))}
      </div>
    </div>
  );
};

const BannerRow: React.FC<{
  entry: WorktreeCreationEntry;
  onDismissFailed: () => void;
  onDismissCompleted: () => void;
  onOpenWorktree: () => void;
}> = ({ entry, onDismissFailed, onDismissCompleted, onOpenWorktree }) => {
  const isFailed = entry.state?.phase === 'failed';
  const isActive = Boolean(entry.state && !isFailed);
  const isCompleted = !entry.state && Boolean(entry.receipt);

  const label = isFailed
    ? entry.state?.label ?? 'Worktree creation failed'
    : isActive
      ? entry.state?.label ?? 'Creating worktree...'
      : entry.receipt
        ? `Worktree ready: ${entry.receipt.branch ?? entry.path ?? 'new worktree'}`
        : '';

  const detail = isFailed ? entry.state?.error : isCompleted ? entry.receipt?.path : null;

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border px-3 py-2.5 shadow-lg backdrop-blur',
        isFailed
          ? 'border-[var(--status-error-border)] bg-[var(--status-error-background)] text-[var(--status-error-foreground)]'
          : isCompleted
            ? 'border-[var(--border)] bg-[var(--surface-elevated)] text-foreground'
            : 'border-[var(--border)] bg-[var(--surface-muted)] text-muted-foreground',
      )}
      role={isFailed ? 'alert' : 'status'}
    >
      {isActive ? (
        <AgentThinkingLoader variant="inline" text={null} animationType="spinner" />
      ) : isCompleted ? (
        <Icon name="git-branch" className="h-4 w-4 shrink-0 text-[var(--status-success)]" />
      ) : (
        <Icon name="alert" className="h-4 w-4 shrink-0" />
      )}

      <div className="min-w-0 flex-1">
        <p className="typography-ui-label truncate">{label}</p>
        {detail ? <p className="mt-0.5 break-words text-xs opacity-80 line-clamp-2">{detail}</p> : null}
        {isActive && entry.branch ? (
          <p className="mt-0.5 truncate text-xs opacity-60">{entry.branch}</p>
        ) : null}
      </div>

      {isFailed ? (
        <Button type="button" variant="ghost" size="xs" onClick={onDismissFailed} aria-label="Dismiss error">
          Dismiss
        </Button>
      ) : null}

      {isCompleted ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" size="xs" onClick={onOpenWorktree}>
            Open
          </Button>
          <Button type="button" variant="ghost" size="icon" className="size-6" onClick={onDismissCompleted} aria-label="Dismiss">
            <Icon name="close" className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : null}

      {isActive ? (
        <span className="hidden shrink-0 text-xs opacity-60 sm:inline">In background</span>
      ) : null}
    </div>
  );
};
