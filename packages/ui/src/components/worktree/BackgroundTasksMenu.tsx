import React from 'react';

import { AgentThinkingLoader } from '@/components/chat/AgentThinkingLoader';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useWorktreeCreationStore, type WorktreeCreationEntry } from '@/stores/useWorktreeCreationStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { DESKTOP_HEADER_ICON_BUTTON_CLASS } from '@/components/layout/header/HeaderIconActionButton';

export const BackgroundTasksMenu: React.FC<{ variant?: 'desktop' | 'mobile' }> = ({
  variant = 'desktop',
}) => {
  const entriesMap = useWorktreeCreationStore((state) => state.entries);
  const [open, setOpen] = React.useState(false);
  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const entries = React.useMemo(
    () => [...entriesMap.values()].sort((left, right) => right.startedAt - left.startedAt),
    [entriesMap],
  );
  const activeCount = entries.filter((entry) => entry.state && entry.state.phase !== 'failed').length;

  const cancelClose = React.useCallback(() => {
    if (!closeTimerRef.current) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);
  const scheduleClose = React.useCallback(() => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => setOpen(false), 150);
  }, [cancelClose]);

  React.useEffect(() => () => cancelClose(), [cancelClose]);

  if (entries.length === 0) return null;

  const openWorktree = (entry: WorktreeCreationEntry): void => {
    const receipt = entry.receipt;
    if (!receipt) return;
    const sessionState = useSessionUIStore.getState();
    if (sessionState.newSessionDraft.open) {
      sessionState.setNewSessionDraftTarget({
        directoryOverride: receipt.path,
        worktreeIntent: null,
      });
    } else {
      sessionState.openNewSessionDraft({ directoryOverride: receipt.path });
    }
    useWorktreeCreationStore.getState().clearEntry(entry.key);
    useUIStore.getState().setActiveMainTab('chat');
    setOpen(false);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            variant === 'desktop'
              ? DESKTOP_HEADER_ICON_BUTTON_CLASS
              : 'pointer-events-auto inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-border bg-sidebar px-3 typography-ui-label font-medium text-foreground shadow-lg hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            variant === 'desktop' && 'relative w-auto px-2.5',
          )}
          aria-label="Background tasks"
          onPointerEnter={(event) => {
            if (event.pointerType !== 'mouse') return;
            cancelClose();
            setOpen(true);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === 'mouse') scheduleClose();
          }}
        >
          {activeCount > 0 ? (
            <AgentThinkingLoader variant="inline" text={null} animationType="spinner" />
          ) : (
            <Icon name="task" className="size-[18px]" />
          )}
          <span>Background tasks</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side={variant === 'mobile' ? 'top' : 'bottom'}
        className="w-[min(26rem,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto p-0"
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
      >
        <div className="border-b border-border px-3 py-2.5">
          <p className="typography-ui-label font-medium text-foreground">Background tasks</p>
          <p className="typography-micro text-muted-foreground">
            {activeCount === 1 ? '1 worktree is being created' : `${activeCount} worktrees are being created`}
          </p>
        </div>
        <div className="divide-y divide-border">
          {entries.map((entry) => (
            <BackgroundTaskRow key={entry.key} entry={entry} onOpen={() => openWorktree(entry)} />
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const BackgroundTaskRow: React.FC<{
  entry: WorktreeCreationEntry;
  onOpen: () => void;
}> = ({ entry, onOpen }) => {
  const failed = entry.state?.phase === 'failed';
  const active = Boolean(entry.state && !failed);
  const completed = Boolean(entry.receipt && !entry.state);
  const title = failed
    ? entry.state?.label ?? 'Worktree creation failed'
    : active
      ? entry.state?.label ?? 'Creating worktree...'
      : `Worktree ready: ${entry.branch ?? entry.receipt?.branch ?? 'new worktree'}`;

  return (
    <div className="flex items-start gap-3 px-3 py-3">
      <div className="mt-0.5 shrink-0">
        {active ? (
          <AgentThinkingLoader variant="inline" text={null} animationType="spinner" />
        ) : failed ? (
          <Icon name="alert" className="size-4 text-[var(--status-error)]" />
        ) : (
          <Icon name="git-branch" className="size-4 text-[var(--status-success)]" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate typography-ui-label text-foreground">{title}</p>
        <p className="mt-0.5 truncate typography-micro text-muted-foreground">
          {failed ? entry.state?.error : entry.path ?? entry.intent.sourceDirectory}
        </p>
      </div>
      {failed ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => useWorktreeCreationStore.getState().dismissFailed(entry.key)}
        >
          Dismiss
        </Button>
      ) : null}
      {completed ? (
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" size="xs" onClick={onOpen}>Open</Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => useWorktreeCreationStore.getState().clearEntry(entry.key)}
            aria-label="Dismiss completed task"
          >
            <Icon name="close" className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
};
