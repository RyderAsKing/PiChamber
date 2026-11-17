import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import type { PiReducerMessagePart } from '@/lib/pi/reducers/reducerTypes';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { parseSubagentDetails, runsFromInput, type SubagentDetails, type SubagentRun } from './details';
import { SubagentRunDetail } from './RunDetail';
import { useSubagentSelection } from './selection';
import { SUBAGENT_TOOL } from './sessionCalls';
import { SubagentRunCard, SubagentRunRow } from './SubagentRuns';

const sameParts = (a: PiReducerMessagePart[], b: PiReducerMessagePart[]) => (
  a.length === b.length && a.every((part, index) => part === b[index])
);

const callStatus = (state: string | undefined) => (
  state === 'running' || state === 'pending' ? 'running' : state === 'error' ? 'error' : state === 'cancelled' ? 'cancelled' : 'completed'
);

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Time of day for calls from today, date and time otherwise. */
const formatCallTime = (startedAt: number): string => {
  const date = new Date(startedAt);
  return date.toDateString() === new Date().toDateString() ? TIME_FORMAT.format(date) : DATE_TIME_FORMAT.format(date);
};

interface AgentCall {
  id: string;
  startedAt: number;
  details: SubagentDetails;
}

/** One run of one call, as the list shows it. */
interface ListedRun {
  key: string;
  callId: string;
  index: number;
  startedAt: number;
  run: SubagentRun;
}

function ListHeading({ title, count }: { title: string; count: number }) {
  return (
    <header className="flex items-baseline gap-2 px-0.5">
      <h3 className="typography-meta font-medium text-foreground">{title}</h3>
      <span className="typography-micro tabular-nums text-subtle-foreground">{count}</span>
    </header>
  );
}

/**
 * The Agents panel: the session's sub-agents that are working or waiting now
 * as live cards on top, and every finished one below as a row, newest call
 * first. Either opens that run on its own (task, steps, answer). Desktop
 * rail surface of the Sub-agents plugin; phones open a run from the chat in
 * a sheet instead.
 */
export function AgentsSurface({ sessionId }: { sessionId: string | null | undefined }) {
  // The reducer keeps parts copy-on-write, so identity tells whether a call
  // changed. Selecting only `subagent` parts keeps other activity cheap.
  const parts = usePiSessionSnapshot(
    (state) => {
      if (!sessionId) return [] as PiReducerMessagePart[];
      const session = state.reducer.bySession.get(sessionId);
      if (!session) return [] as PiReducerMessagePart[];
      const found: PiReducerMessagePart[] = [];
      for (const part of session.parts.values()) {
        if (part.type === 'tool' && part.tool?.name === SUBAGENT_TOOL) found.push(part);
      }
      return found;
    },
    sameParts,
    sessionId ? `session:${sessionId}` : 'chrome',
  );

  const calls = React.useMemo<AgentCall[]>(() => parts.flatMap((part) => {
    const status = callStatus(part.tool?.state);
    const details = parseSubagentDetails(part.tool?.metadata, status)
      ?? (status === 'running' ? runsFromInput(part.tool?.input) : null);
    if (!details || details.runs.length === 0) return [];
    return [{ id: part.id, startedAt: part.tool?.startedAt ?? 0, details }];
  }).sort((a, b) => b.startedAt - a.startedAt), [parts]);

  // Calls are newest first; a call's own runs keep their order.
  const { active, finished } = React.useMemo(() => {
    const active: ListedRun[] = [];
    const finished: ListedRun[] = [];
    for (const call of calls) {
      call.details.runs.forEach((run, index) => {
        const item = { key: `${call.id}:${index}`, callId: call.id, index, startedAt: call.startedAt, run };
        (run.status === 'running' || run.status === 'queued' ? active : finished).push(item);
      });
    }
    return { active, finished };
  }, [calls]);

  const selected = useSubagentSelection((state) => state.selected);
  const select = useSubagentSelection((state) => state.select);
  const selectedCall = selected ? calls.find((call) => call.id === selected.callId) : undefined;
  const selectedRun = selected && selectedCall ? selectedCall.details.runs[selected.index] : undefined;

  if (selectedRun && selectedCall) {
    const { runs } = selectedCall.details;
    const index = selected?.index ?? 0;
    return (
      <div className="@container flex h-full min-h-0 flex-col" data-testid="agents-surface">
        <nav className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-1.5" aria-label="Sub-agent">
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => select(null)}>
            <Icon name="arrow-left-s" className="size-4" />
            {'All agents'}
          </Button>
          {runs.length > 1 ? (
            <div className="ml-auto flex items-center gap-0.5">
              <span className="mr-1 typography-micro tabular-nums text-subtle-foreground">{`${index + 1} of ${runs.length}`}</span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Previous sub-agent"
                disabled={index === 0}
                onClick={() => select({ callId: selectedCall.id, index: index - 1 })}
              >
                <Icon name="arrow-up-s" className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Next sub-agent"
                disabled={index === runs.length - 1}
                onClick={() => select({ callId: selectedCall.id, index: index + 1 })}
              >
                <Icon name="arrow-down-s" className="size-4" />
              </Button>
            </div>
          ) : null}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <SubagentRunDetail run={selectedRun} />
        </div>
      </div>
    );
  }

  if (calls.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 p-6 text-center">
        <Icon name="robot-2" aria-hidden="true" className="size-6 text-subtle-foreground" />
        <p className="typography-ui-label font-medium text-foreground">{'No sub-agents in this session'}</p>
        <p className="max-w-64 text-balance typography-micro text-muted-foreground">
          {'When the agent hands work to sub-agents, each one shows up here with its steps and answer.'}
        </p>
      </div>
    );
  }

  return (
    <div className="@container flex h-full min-h-0 flex-col gap-5 overflow-y-auto p-3" data-testid="agents-surface">
      {active.length > 0 ? (
        <section className="space-y-2" aria-label="Working">
          <ListHeading title="Working" count={active.length} />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-2">
            {active.map((item) => (
              <SubagentRunCard
                key={item.key}
                run={item.run}
                onOpen={() => select({ callId: item.callId, index: item.index })}
              />
            ))}
          </div>
        </section>
      ) : null}
      {finished.length > 0 ? (
        <section className="space-y-1" aria-label="Finished">
          <ListHeading title="Finished" count={finished.length} />
          <ul className="-mx-1.5">
            {finished.map((item) => (
              <li key={item.key}>
                <SubagentRunRow
                  run={item.run}
                  time={item.startedAt > 0 ? formatCallTime(item.startedAt) : undefined}
                  onOpen={() => select({ callId: item.callId, index: item.index })}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
