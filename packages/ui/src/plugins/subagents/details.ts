/**
 * Reads `subagent` tool details into one display model.
 *
 * Two shapes are accepted:
 * - PiChamber's Sub-agents plugin: each result carries `status`, a short
 *   `activity` list, and the final `output` (kept small so live updates stay
 *   cheap).
 * - Pi's `subagent` example extension, which a user may run instead: each
 *   result carries the child's whole `messages` list and an `exitCode`.
 */

export type SubagentStatus = 'queued' | 'running' | 'done' | 'failed' | 'aborted';

export interface SubagentActivity {
  kind: 'tool' | 'text';
  /** Tool name for `tool` items. */
  name?: string;
  text: string;
}

export interface SubagentUsage {
  turns: number;
  input: number;
  output: number;
  cost: number;
  contextTokens: number;
}

export interface SubagentRun {
  agent: string;
  source: string;
  task: string;
  step?: number;
  status: SubagentStatus;
  model?: string;
  usage: SubagentUsage;
  activity: SubagentActivity[];
  output: string;
  error?: string;
}

export interface SubagentDetails {
  mode: 'single' | 'parallel' | 'chain';
  runs: SubagentRun[];
}

export const MODE_LABEL: Record<SubagentDetails['mode'], string> = {
  single: 'Sub-agent',
  parallel: 'Sub-agents in parallel',
  chain: 'Sub-agent chain',
};

/** Status of the `subagent` tool call itself, from the tool part. */
type SubagentCallStatus = 'running' | 'completed' | 'error' | 'cancelled' | string | undefined;

const MAX_ACTIVITY = 40;
const MAX_TEXT = 400;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const clip = (text: string, max = MAX_TEXT): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'done', 'failed', 'aborted']);

const readUsage = (value: unknown): SubagentUsage => {
  const usage = isRecord(value) ? value : {};
  return {
    turns: num(usage.turns),
    input: num(usage.input),
    output: num(usage.output),
    cost: num(usage.cost),
    contextTokens: num(usage.contextTokens),
  };
};

/** A one-line summary of a child's tool call, like Pi's own renderer. */
export const summarizeToolCall = (name: string, args: unknown): string => {
  const record = isRecord(args) ? args : {};
  const path = str(record.file_path) || str(record.path);
  switch (name) {
    case 'bash':
      return `$ ${clip(str(record.command) || '…', 120)}`;
    case 'read':
    case 'write':
    case 'edit':
    case 'ls':
      return path ? `${name} ${path}` : name;
    case 'grep':
      return `grep /${clip(str(record.pattern), 60)}/${path ? ` in ${path}` : ''}`;
    case 'find':
      return `find ${clip(str(record.pattern) || '*', 60)}${path ? ` in ${path}` : ''}`;
    default: {
      let preview = '';
      try {
        preview = JSON.stringify(args) ?? '';
      } catch {
        preview = '';
      }
      return preview && preview !== '{}' ? `${name} ${clip(preview, 80)}` : name;
    }
  }
};

const readActivity = (value: unknown): SubagentActivity[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): SubagentActivity[] => {
    if (!isRecord(item)) return [];
    const text = str(item.text);
    if (item.kind === 'tool') return [{ kind: 'tool', name: str(item.name) || 'tool', text: text || str(item.name) }];
    if (item.kind === 'text' && text) return [{ kind: 'text', text }];
    return [];
  }).slice(-MAX_ACTIVITY);
};

/** Activity and final text from Pi's message list (the example's shape). */
const fromMessages = (messages: unknown[]): { activity: SubagentActivity[]; output: string } => {
  const activity: SubagentActivity[] = [];
  let output = '';
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part)) continue;
      if (part.type === 'text' && str(part.text).trim()) {
        activity.push({ kind: 'text', text: clip(str(part.text).trim()) });
        output = str(part.text);
      } else if (part.type === 'toolCall') {
        const name = str(part.name) || 'tool';
        activity.push({ kind: 'tool', name, text: summarizeToolCall(name, part.arguments) });
      }
    }
  }
  return { activity: activity.slice(-MAX_ACTIVITY), output };
};

const readRun = (
  value: unknown,
  index: number,
  count: number,
  mode: SubagentDetails['mode'],
  callStatus: SubagentCallStatus,
): SubagentRun | null => {
  if (!isRecord(value)) return null;
  const agent = str(value.agent) || 'agent';
  const base = {
    agent,
    source: str(value.agentSource) || str(value.source) || 'unknown',
    task: str(value.task),
    ...(typeof value.step === 'number' ? { step: value.step } : {}),
    ...(str(value.model) ? { model: str(value.model) } : {}),
    usage: readUsage(value.usage),
  };

  if (STATUSES.has(str(value.status))) {
    let status = str(value.status) as SubagentStatus;
    // A run the call left behind (the call ended without updating it).
    if ((status === 'running' || status === 'queued') && callStatus !== 'running') status = 'aborted';
    return {
      ...base,
      status,
      activity: readActivity(value.activity),
      output: str(value.output),
      ...(str(value.error) ? { error: str(value.error) } : {}),
    };
  }

  // Pi example shape.
  const messages = Array.isArray(value.messages) ? value.messages : [];
  const { activity, output } = fromMessages(messages);
  const exitCode = typeof value.exitCode === 'number' ? value.exitCode : 0;
  const stopReason = str(value.stopReason);
  const running = callStatus === 'running';
  let status: SubagentStatus;
  if (exitCode === -1) {
    status = running ? (messages.length > 0 ? 'running' : 'queued') : 'aborted';
  } else if (running && mode !== 'parallel' && index === count - 1) {
    status = 'running';
  } else if (stopReason === 'aborted') {
    status = 'aborted';
  } else if (exitCode !== 0 || stopReason === 'error') {
    status = 'failed';
  } else {
    status = 'done';
  }
  const error = status === 'failed' ? (str(value.errorMessage) || clip(str(value.stderr).trim(), 2000)) : '';
  return { ...base, status, activity, output, ...(error ? { error } : {}) };
};

/** The tool's details as a display model, or `null` when it is not a sub-agent call. */
export const parseSubagentDetails = (metadata: unknown, callStatus: SubagentCallStatus): SubagentDetails | null => {
  if (!isRecord(metadata) || !Array.isArray(metadata.results)) return null;
  const mode = metadata.mode === 'parallel' || metadata.mode === 'chain' ? metadata.mode : 'single';
  const results = metadata.results;
  const runs = results.flatMap((result, index) => {
    const run = readRun(result, index, results.length, mode, callStatus);
    return run ? [run] : [];
  });
  return { mode, runs };
};

/** Runs from the call's input, before the first update arrives. */
export const runsFromInput = (input: unknown): SubagentDetails | null => {
  if (!isRecord(input)) return null;
  const queued = (agent: unknown, task: unknown, step?: number): SubagentRun => ({
    agent: str(agent) || 'agent',
    source: 'unknown',
    task: str(task),
    ...(step !== undefined ? { step } : {}),
    status: 'queued',
    usage: readUsage(null),
    activity: [],
    output: '',
  });
  if (Array.isArray(input.chain) && input.chain.length > 0) {
    return { mode: 'chain', runs: input.chain.filter(isRecord).map((item, index) => queued(item.agent, item.task, index + 1)) };
  }
  if (Array.isArray(input.tasks) && input.tasks.length > 0) {
    return { mode: 'parallel', runs: input.tasks.filter(isRecord).map((item) => queued(item.agent, item.task)) };
  }
  if (input.agent && input.task) return { mode: 'single', runs: [queued(input.agent, input.task)] };
  return null;
};

const formatTokenCount = (count: number): string => {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
};

/** "3 turns · 12k tokens" for a run that has usage. */
export const formatRunUsage = (usage: SubagentUsage): string => {
  const parts: string[] = [];
  if (usage.turns > 0) parts.push(usage.turns === 1 ? '1 turn' : `${usage.turns} turns`);
  const tokens = usage.input + usage.output;
  if (tokens > 0) parts.push(`${formatTokenCount(tokens)} tokens`);
  return parts.join(' · ');
};

/** "2 of 3 done" style progress for a call. */
export const summarizeRuns = (runs: SubagentRun[]): string => {
  const finished = runs.filter((run) => run.status === 'done').length;
  const failed = runs.filter((run) => run.status === 'failed').length;
  const stopped = runs.filter((run) => run.status === 'aborted').length;
  const parts = [`${finished} of ${runs.length} done`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (stopped > 0) parts.push(`${stopped} stopped`);
  return parts.join(', ');
};

/** What a card's footer shows on the right: the current step while working, usage after. */
export const runFooterMeta = (run: SubagentRun): string => {
  if (run.status === 'running') {
    const last = run.activity[run.activity.length - 1];
    return last?.kind === 'tool' ? last.text : 'Thinking';
  }
  if (run.status === 'done') return formatRunUsage(run.usage);
  return '';
};
