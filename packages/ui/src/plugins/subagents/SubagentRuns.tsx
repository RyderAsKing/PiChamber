import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { cn } from '@/lib/utils';
import { runFooterMeta, type SubagentRun, type SubagentStatus } from './details';
import { splitRunModel } from './model';

const STATUS_ICON: Record<SubagentStatus, IconName> = {
  queued: 'time',
  running: 'loader-4',
  done: 'check',
  failed: 'close-circle',
  aborted: 'forbid',
};

const STATUS_LABEL: Record<SubagentStatus, string> = {
  queued: 'Waiting',
  running: 'Working',
  done: 'Done',
  failed: 'Failed',
  aborted: 'Stopped',
};

const STATUS_CLASS: Record<SubagentStatus, string> = {
  queued: 'text-muted-foreground',
  running: 'text-[var(--status-info)]',
  done: 'text-[var(--status-success)]',
  failed: 'text-[var(--status-error)]',
  aborted: 'text-muted-foreground',
};

/** Status icon and word, in the status colour. */
export function SubagentStatusLabel({ status, className }: { status: SubagentStatus; className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1 typography-micro font-medium', STATUS_CLASS[status], className)}>
      <Icon
        name={STATUS_ICON[status]}
        aria-hidden="true"
        className={cn('size-3.5 shrink-0', status === 'running' && 'animate-spin')}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * The run's model as a small tile: the provider's logo, or a robot mark when
 * the model or its logo is unknown.
 */
export function SubagentAvatar({ model, size = 'sm' }: { model?: string; size?: 'sm' | 'lg' }) {
  const providerId = splitRunModel(model)?.providerId ?? '';
  const { src, hasLogo, onError } = useProviderLogo(providerId);
  const showLogo = Boolean(providerId) && hasLogo && Boolean(src);
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background',
        size === 'lg' ? 'size-9' : 'size-7',
      )}
    >
      {showLogo ? (
        <img
          src={src ?? undefined}
          alt=""
          draggable={false}
          onError={onError}
          className={cn('object-contain dark:invert', size === 'lg' ? 'size-5' : 'size-4')}
        />
      ) : (
        <Icon name="robot-2" className={cn('text-muted-foreground', size === 'lg' ? 'size-5' : 'size-4')} />
      )}
    </span>
  );
}

/** One sub-agent run as a card. Opens the run on its own when pressed. */
export function SubagentRunCard({ run, onOpen }: { run: SubagentRun; onOpen?: () => void }) {
  const meta = runFooterMeta(run);
  const label = `${run.agent}${run.step !== undefined ? `, step ${run.step}` : ''}: ${STATUS_LABEL[run.status]}`;
  const body = (
    <>
      <span className="flex min-w-0 items-start gap-2.5 px-3 pb-2.5 pt-3">
        <SubagentAvatar model={run.model} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            {run.step !== undefined ? (
              <span className="shrink-0 typography-micro tabular-nums text-subtle-foreground">{run.step}</span>
            ) : null}
            <span className="truncate typography-ui-label font-medium text-foreground">{run.agent}</span>
          </span>
          <span className="mt-0.5 line-clamp-2 break-words text-pretty typography-meta text-muted-foreground">
            {run.task || 'No task given'}
          </span>
        </span>
      </span>
      <span className="mt-auto flex min-w-0 items-center gap-2 border-t border-border/60 px-3 py-2">
        <SubagentStatusLabel status={run.status} />
        {meta ? (
          <span
            className={cn(
              'ml-auto min-w-0 truncate typography-micro text-subtle-foreground',
              run.status === 'running' && 'font-mono',
            )}
          >
            {meta}
          </span>
        ) : null}
      </span>
    </>
  );
  const cardClass = 'flex min-w-0 flex-col rounded-xl border border-border/60 bg-[var(--surface-elevated)] text-left';
  if (!onOpen) return <div role="group" className={cardClass} aria-label={label}>{body}</div>;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className={cn(
        cardClass,
        'transition-colors hover:border-border hover:bg-interactive-hover',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
      )}
    >
      {body}
    </button>
  );
}

/**
 * A finished run on one line: how it ended, who ran it, what it was asked,
 * and when. Opens the run on its own when pressed.
 */
export function SubagentRunRow({ run, time, onOpen }: { run: SubagentRun; time?: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${run.agent}${run.step !== undefined ? `, step ${run.step}` : ''}: ${STATUS_LABEL[run.status]}`}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-interactive-hover',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
      )}
    >
      <Icon name={STATUS_ICON[run.status]} aria-hidden="true" className={cn('size-3.5 shrink-0', STATUS_CLASS[run.status])} />
      <span className="max-w-[40%] shrink-0 truncate typography-ui-label font-medium text-foreground">{run.agent}</span>
      <span className="min-w-0 flex-1 truncate typography-meta text-muted-foreground">{run.task || 'No task given'}</span>
      {time ? <span className="shrink-0 typography-micro tabular-nums text-subtle-foreground">{time}</span> : null}
    </button>
  );
}

/** Cards side by side as space allows. */
export function SubagentRunGrid({ runs, onOpen }: { runs: SubagentRun[]; onOpen?: (index: number) => void }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
      {runs.map((run, index) => (
        <SubagentRunCard key={index} run={run} onOpen={onOpen ? () => onOpen(index) : undefined} />
      ))}
    </div>
  );
}
