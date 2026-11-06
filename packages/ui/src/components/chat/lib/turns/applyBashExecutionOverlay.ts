import { PI_BASH_CUSTOM_TYPE, type PiBashExecution } from '@/lib/pi/protocol';

import type { ChatMessageEntry } from './types';

/**
 * Render-time overlay that appends user shell commands (`!cmd`) Pi has not
 * recorded yet. They render after the transcript, where Pi shows pending
 * shell output: a command that finishes while the agent is responding is
 * recorded only after that turn ends.
 *
 * Each execution becomes an `extension` entry with the reserved
 * `pichamber.bash` custom type and the live execution on `bashExecution`, so
 * `MessageRow` renders it with the same row as the recorded entry that
 * replaces it.
 *
 * Performance: with no executions the input array is returned by reference.
 * The reducer replaces an execution object on every change, so entries are
 * cached per object and unchanged rows keep their references.
 */

const entryCache = new WeakMap<PiBashExecution, { sessionId: string; entry: ChatMessageEntry }>();

const toBashEntry = (execution: PiBashExecution, sessionId: string): ChatMessageEntry => {
  const cached = entryCache.get(execution);
  if (cached && cached.sessionId === sessionId) return cached.entry;
  const entry: ChatMessageEntry = {
    info: {
      id: `bash:${execution.id}`,
      sessionID: sessionId,
      role: 'extension',
      customType: PI_BASH_CUSTOM_TYPE,
      bashExecution: execution,
      time: { created: execution.startedAt, ...(execution.completedAt ? { completed: execution.completedAt } : {}) },
    },
    parts: [],
  };
  entryCache.set(execution, { sessionId, entry });
  return entry;
};

export const applyBashExecutionOverlay = (
  messages: ChatMessageEntry[],
  executions: readonly PiBashExecution[],
  sessionId: string | null,
): ChatMessageEntry[] => {
  if (!sessionId || executions.length === 0) return messages;
  return [...messages, ...executions.map((execution) => toBashEntry(execution, sessionId))];
};
