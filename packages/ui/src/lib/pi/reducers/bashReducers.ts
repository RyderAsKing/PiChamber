import {
  PI_BASH_CUSTOM_TYPE,
  PI_BASH_OUTPUT_MAX_CHARS,
  type PiBashExecution,
  type PiSessionBashOutputEvent,
  type PiSessionBashRecordedEvent,
} from '../protocol';
import type { PiReducerMessage, PiReducerSessionState } from './reducerTypes';
import { markMutation } from './reducerHelpers';
import type { PiSessionId } from '../types';

/**
 * User shell commands (`!cmd`). A command lives in `session.bashExecutions`
 * from start until Pi records it, then becomes an ordinary `pichamber.bash`
 * extension message keyed by its session entry id. The list is small (one
 * running command per session plus recordings Pi defers until the agent turn
 * ends), so linear scans are fine; output deltas arrive at most every 100 ms.
 */

const BASH_PHASES = new Set<PiBashExecution['phase']>(['running', 'completed', 'cancelled', 'failed']);

const tail = (text: string): string => (text.length > PI_BASH_OUTPUT_MAX_CHARS
  ? text.slice(-PI_BASH_OUTPUT_MAX_CHARS)
  : text);

const isBashExecution = (value: unknown): value is PiBashExecution => {
  const candidate = value as Partial<PiBashExecution> | null;
  return Boolean(candidate)
    && typeof candidate!.id === 'string'
    && candidate!.id.length > 0
    && typeof candidate!.command === 'string'
    && BASH_PHASES.has(candidate!.phase as PiBashExecution['phase'])
    && typeof candidate!.startedAt === 'number';
};

/** Normalizes an authoritative snapshot/detail list. `undefined` means the
 *  server did not report one (older server), which keeps the current list. */
const normalizeBashExecutions = (value: unknown): PiBashExecution[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isBashExecution).map((execution) => (
    typeof execution.output === 'string' && execution.output.length > PI_BASH_OUTPUT_MAX_CHARS
      ? { ...execution, output: tail(execution.output) }
      : execution
  ));
};

/** Replaces the live list from an authoritative snapshot. */
export const applyBashSnapshot = (session: PiReducerSessionState, value: unknown): void => {
  const executions = normalizeBashExecutions(value);
  if (!executions) return;
  if (executions.length === 0) {
    if (session.bashExecutions?.length) delete session.bashExecutions;
    return;
  }
  session.bashExecutions = executions;
};

/** `session.bash`: upsert the full current view. Output already received
 *  live is kept when the phase update carries none (running updates). */
export const reduceBash = (session: PiReducerSessionState, bash: PiBashExecution): void => {
  if (!isBashExecution(bash)) return;
  const current = session.bashExecutions ?? [];
  const index = current.findIndex((execution) => execution.id === bash.id);
  const previous = index >= 0 ? current[index] : undefined;
  const output = typeof bash.output === 'string' ? tail(bash.output) : previous?.output;
  const next: PiBashExecution = { ...bash, ...(output ? { output } : {}) };
  if (!output) delete next.output;
  const list = [...current];
  if (index >= 0) list[index] = next;
  else list.push(next);
  session.bashExecutions = list;
};

/** `session.bash.output`: append a coalesced delta or replace on reset. */
export const reduceBashOutput = (
  session: PiReducerSessionState,
  payload: PiSessionBashOutputEvent['payload'],
): void => {
  const current = session.bashExecutions;
  if (!current) return;
  const index = current.findIndex((execution) => execution.id === payload.id);
  if (index < 0) return;
  const execution = current[index]!;
  const output = payload.reset === true
    ? tail(payload.output)
    : tail(`${execution.output ?? ''}${payload.delta}`);
  if (output === (execution.output ?? '')) return;
  const list = [...current];
  list[index] = { ...execution, output };
  session.bashExecutions = list;
};

/** `session.bash.recorded`: settle the live execution and insert the
 *  authoritative transcript row. */
export const reduceBashRecorded = (
  session: PiReducerSessionState,
  directory: string,
  sessionId: PiSessionId,
  payload: PiSessionBashRecordedEvent['payload'],
): void => {
  if (payload.id && session.bashExecutions?.some((execution) => execution.id === payload.id)) {
    const remaining = session.bashExecutions.filter((execution) => execution.id !== payload.id);
    if (remaining.length > 0) session.bashExecutions = remaining;
    else delete session.bashExecutions;
  }
  const { message } = payload;
  if (!message || typeof message.id !== 'string' || message.customType !== PI_BASH_CUSTOM_TYPE) return;
  const recorded: PiReducerMessage = {
    id: message.id,
    sessionId,
    directory,
    role: 'extension',
    customType: PI_BASH_CUSTOM_TYPE,
    details: message.details,
    createdAt: message.createdAt,
    text: '',
    thinking: '',
    streaming: false,
  };
  session.messages = new Map(session.messages);
  session.messages.set(recorded.id, recorded);
  markMutation(session, recorded.id, 'structure');
};
