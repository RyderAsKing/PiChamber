import React from 'react';

import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatRunUsage, type SubagentRun } from './details';
import { splitRunModel, useRunModelName } from './model';
import { SubagentAvatar, SubagentStatusLabel } from './SubagentRuns';

const TASK_PREVIEW_CHARS = 480;

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="typography-micro font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function TaskText({ task }: { task: string }) {
  const [expanded, setExpanded] = React.useState(false);
  const long = task.length > TASK_PREVIEW_CHARS;
  const shown = long && !expanded ? `${task.slice(0, TASK_PREVIEW_CHARS).trimEnd()}…` : task;
  return (
    <div className="space-y-1">
      <p className="whitespace-pre-wrap break-words text-pretty typography-meta text-foreground">{shown}</p>
      {long ? (
        <Button variant="link" size="xs" className="h-auto px-0" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show less' : 'Show all'}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * One sub-agent run on its own: who ran it, on which model, what it was
 * asked, the steps it took, and its answer. Live while the run works.
 */
export function SubagentRunDetail({ run }: { run: SubagentRun }) {
  const model = splitRunModel(run.model);
  const modelName = useRunModelName(model);
  const usage = formatRunUsage(run.usage);
  const facts = [
    usage,
    run.usage.cost > 0 ? `$${run.usage.cost.toFixed(4)}` : '',
  ].filter(Boolean);

  return (
    <div className="space-y-5">
      <header className="flex min-w-0 items-start gap-3">
        <SubagentAvatar model={run.model} size="lg" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate typography-ui-header font-semibold text-foreground">
              {run.step !== undefined ? <span className="mr-1.5 font-normal tabular-nums text-subtle-foreground">{run.step}</span> : null}
              {run.agent}
            </h2>
            <SubagentStatusLabel status={run.status} />
          </div>
          <p className="truncate typography-micro text-muted-foreground">
            {[modelName || 'Session model', ...facts].join(' · ')}
          </p>
        </div>
      </header>

      <DetailSection title="Task">
        <TaskText task={run.task || 'No task given'} />
      </DetailSection>

      {run.activity.length > 0 ? (
        <DetailSection title="Steps">
          <ol className="space-y-1.5 border-l border-border/60 pl-3">
            {run.activity.map((item, index) => (
              <li
                key={index}
                className={cn(
                  'min-w-0 break-words',
                  item.kind === 'tool'
                    ? 'typography-code font-mono text-muted-foreground'
                    : 'text-pretty typography-meta text-foreground',
                )}
              >
                {item.text}
              </li>
            ))}
          </ol>
        </DetailSection>
      ) : null}

      {run.error ? (
        <DetailSection title="Error">
          <p className="whitespace-pre-wrap break-words typography-meta text-[var(--status-error)]">{run.error}</p>
        </DetailSection>
      ) : null}

      {run.output && run.status === 'done' ? (
        <DetailSection title="Answer">
          <SimpleMarkdownRenderer content={run.output} className="max-w-none" />
        </DetailSection>
      ) : null}
    </div>
  );
}
