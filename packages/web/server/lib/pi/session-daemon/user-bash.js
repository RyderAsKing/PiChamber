import { randomUUID } from 'node:crypto';

/**
 * User shell commands (`!cmd` / `!!cmd`), hosted the way Pi's interactive and
 * RPC modes host them: `user_bash` lets extensions intercept, then Pi's
 * `AgentSession.executeBash` runs the command and records a `bashExecution`
 * message (deferred until the turn ends while the agent is streaming).
 *
 * Pi records the result without emitting an event, so this module observes
 * `sessionManager.appendMessage` for `bashExecution` messages and publishes the
 * persisted entry id. Live output is coalesced: every daemon publish lands in
 * the bounded replay log, so a chatty command must not flood it.
 */

export const USER_BASH_CUSTOM_TYPE = 'pichamber.bash';
const USER_BASH_MAX_COMMAND_CHARS = 100_000;
/** Minimum spacing between live output events for one command. */
const USER_BASH_OUTPUT_FLUSH_MS = 100;
/** Largest single output event; a larger backlog is replaced by its tail. */
export const USER_BASH_OUTPUT_FLUSH_MAX_CHARS = 16 * 1024;
/** Live output tail kept for snapshots and late-joining clients. */
export const USER_BASH_LIVE_OUTPUT_MAX_CHARS = 64 * 1024;
/** Output carried by a recorded transcript item (Pi keeps a 50KB tail). */
const USER_BASH_RECORDED_OUTPUT_MAX_CHARS = 64 * 1024;

const APPEND_OBSERVER = Symbol('pichamber.userBashAppendObserver');

const tail = (text, max) => (text.length > max ? text.slice(text.length - max) : text);

export class UserBashError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const validateUserBashRequest = (payload) => {
  const command = typeof payload?.command === 'string' ? payload.command.trim() : '';
  if (!command || command.length > USER_BASH_MAX_COMMAND_CHARS) {
    throw new UserBashError('INVALID_ARGUMENT', 'The shell command is invalid.');
  }
  if (payload.excludeFromContext !== undefined && typeof payload.excludeFromContext !== 'boolean') {
    throw new UserBashError('INVALID_ARGUMENT', 'The shell command is invalid.');
  }
  return { command, excludeFromContext: payload.excludeFromContext === true };
};

/** Transcript details for a persisted or just-recorded `bashExecution` message. */
const bashDetails = (message, redact) => ({
  command: redact(String(message.command ?? '')),
  output: redact(tail(typeof message.output === 'string' ? message.output : '', USER_BASH_RECORDED_OUTPUT_MAX_CHARS)),
  ...(Number.isSafeInteger(message.exitCode) ? { exitCode: message.exitCode } : {}),
  ...(message.cancelled === true ? { cancelled: true } : {}),
  ...(message.truncated === true ? { truncated: true } : {}),
  ...(message.excludeFromContext === true ? { excludeFromContext: true } : {}),
  ...(typeof message.fullOutputPath === 'string' && message.fullOutputPath.length > 0
    ? { fullOutputPath: message.fullOutputPath }
    : {}),
});

/**
 * Projects a persisted `bashExecution` session entry as an extension-role
 * transcript item with the reserved `pichamber.bash` custom type. Returns
 * undefined for any other entry.
 */
export const projectBashExecutionEntry = (entry, { sessionId, directory, redact = (value) => value }) => {
  if (entry?.type !== 'message' || entry.message?.role !== 'bashExecution' || typeof entry.id !== 'string') return undefined;
  const timestamp = Date.parse(entry.timestamp);
  return {
    message: {
      id: entry.id,
      sessionId,
      directory,
      role: 'extension',
      customType: USER_BASH_CUSTOM_TYPE,
      createdAt: Number.isFinite(timestamp) ? timestamp : 0,
      details: bashDetails(entry.message, redact),
    },
    parts: [],
  };
};

export function createUserBash({
  publish,
  redact = (value) => value,
  onSettled = () => {},
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  /** sessionId -> live executions in start order (running, awaiting record, latest failure). */
  const executionsBySession = new Map();

  const view = (execution) => ({
    id: execution.id,
    command: redact(execution.command),
    phase: execution.phase,
    startedAt: execution.startedAt,
    ...(execution.excludeFromContext ? { excludeFromContext: true } : {}),
    ...(execution.completedAt !== undefined ? { completedAt: execution.completedAt } : {}),
    ...(Number.isSafeInteger(execution.exitCode) ? { exitCode: execution.exitCode } : {}),
    ...(execution.truncated ? { truncated: true } : {}),
    ...(typeof execution.fullOutputPath === 'string' ? { fullOutputPath: execution.fullOutputPath } : {}),
    ...(execution.output ? { output: redact(execution.output) } : {}),
    ...(execution.error ? { error: execution.error } : {}),
  });

  const listFor = (sessionId) => executionsBySession.get(sessionId) ?? [];

  const remove = (execution) => {
    const list = executionsBySession.get(execution.sessionId);
    if (!list) return;
    const next = list.filter((candidate) => candidate !== execution);
    if (next.length > 0) executionsBySession.set(execution.sessionId, next);
    else executionsBySession.delete(execution.sessionId);
  };

  const cancelFlush = (execution) => {
    if (execution.flushTimer !== undefined) {
      clearTimer(execution.flushTimer);
      execution.flushTimer = undefined;
    }
  };

  const flushOutput = (execution) => {
    cancelFlush(execution);
    if (!execution.pendingDelta && !execution.pendingReset) return;
    const payload = execution.pendingReset
      ? { id: execution.id, output: redact(tail(execution.output, USER_BASH_OUTPUT_FLUSH_MAX_CHARS)), reset: true }
      : { id: execution.id, delta: redact(execution.pendingDelta) };
    execution.pendingDelta = '';
    execution.pendingReset = false;
    publish('session.bash.output', payload, execution.sessionId, execution.directory);
  };

  const appendOutput = (execution, chunk) => {
    if (typeof chunk !== 'string' || chunk.length === 0 || execution.phase !== 'running') return;
    execution.output = tail(execution.output + chunk, USER_BASH_LIVE_OUTPUT_MAX_CHARS);
    if (!execution.pendingReset) {
      execution.pendingDelta += chunk;
      if (execution.pendingDelta.length > USER_BASH_OUTPUT_FLUSH_MAX_CHARS) {
        execution.pendingDelta = '';
        execution.pendingReset = true;
      }
    }
    if (execution.flushTimer === undefined) {
      execution.flushTimer = setTimer(() => {
        execution.flushTimer = undefined;
        flushOutput(execution);
      }, USER_BASH_OUTPUT_FLUSH_MS);
    }
  };

  const publishState = (execution) => {
    publish('session.bash', { bash: view(execution) }, execution.sessionId, execution.directory);
  };

  const finish = (execution, result) => {
    flushOutput(execution);
    if (execution.recorded) return;
    execution.phase = result.cancelled === true ? 'cancelled' : 'completed';
    execution.completedAt = now();
    execution.exitCode = Number.isSafeInteger(result.exitCode) ? result.exitCode : undefined;
    execution.truncated = result.truncated === true;
    execution.fullOutputPath = typeof result.fullOutputPath === 'string' && result.fullOutputPath.length > 0
      ? result.fullOutputPath
      : undefined;
    execution.output = tail(typeof result.output === 'string' ? result.output : execution.output, USER_BASH_LIVE_OUTPUT_MAX_CHARS);
    // Recorded later, when Pi flushes messages it deferred during a turn.
    publishState(execution);
  };

  const fail = (execution, message) => {
    flushOutput(execution);
    if (execution.recorded) return;
    execution.phase = 'failed';
    execution.completedAt = now();
    execution.error = message;
    publishState(execution);
  };

  /**
   * Pi records `bashExecution` messages through `sessionManager.appendMessage`
   * (immediately, or after the turn when deferred) and emits nothing. Matching
   * is by start order: one command runs per session, so records arrive in the
   * order commands finished.
   */
  const installAppendObserver = (sessionId, directory, session) => {
    const manager = session?.sessionManager;
    if (!manager || typeof manager.appendMessage !== 'function') return;
    const existing = manager[APPEND_OBSERVER];
    if (existing) {
      existing.sessionId = sessionId;
      existing.directory = directory;
      return;
    }
    const state = { sessionId, directory };
    Object.defineProperty(manager, APPEND_OBSERVER, { value: state });
    const original = manager.appendMessage.bind(manager);
    manager.appendMessage = (message, ...rest) => {
      const entryId = original(message, ...rest);
      if (message?.role === 'bashExecution' && typeof entryId === 'string') {
        try {
          onRecorded(state.sessionId, state.directory, manager, message, entryId);
        } catch {
          // Publication never breaks Pi's transcript write.
        }
      }
      return entryId;
    };
  };

  const onRecorded = (sessionId, directory, manager, message, entryId) => {
    const execution = listFor(sessionId).find((candidate) => !candidate.recorded
      && candidate.phase !== 'failed'
      && candidate.command === message.command);
    if (execution) {
      flushOutput(execution);
      execution.recorded = true;
      remove(execution);
    }
    const entry = manager.getEntry?.(entryId);
    const projected = projectBashExecutionEntry(
      { type: 'message', id: entryId, timestamp: entry?.timestamp ?? new Date(now()).toISOString(), message },
      { sessionId, directory, redact },
    );
    publish('session.bash.recorded', {
      ...(execution ? { id: execution.id } : {}),
      message: {
        id: projected.message.id,
        createdAt: projected.message.createdAt,
        customType: USER_BASH_CUSTOM_TYPE,
        details: projected.message.details,
      },
    }, sessionId, directory);
  };

  const isActive = (sessionId) => listFor(sessionId).some((execution) => execution.phase === 'running');

  const start = ({ sessionId, directory, session, command, excludeFromContext }) => {
    if (!session || typeof session.executeBash !== 'function') {
      throw new UserBashError('INVALID_SESSION', 'Pi returned an invalid active session.');
    }
    if (isActive(sessionId) || session.isBashRunning === true) {
      throw new UserBashError('SESSION_BUSY', 'A shell command is already running in this session.');
    }
    installAppendObserver(sessionId, directory, session);
    // A new command replaces the previous failure notice.
    for (const stale of listFor(sessionId).filter((candidate) => candidate.phase === 'failed')) remove(stale);
    const execution = {
      id: randomUUID(),
      sessionId,
      directory,
      command,
      excludeFromContext,
      phase: 'running',
      startedAt: now(),
      output: '',
      pendingDelta: '',
      pendingReset: false,
      flushTimer: undefined,
      recorded: false,
    };
    executionsBySession.set(sessionId, [...listFor(sessionId), execution]);
    publishState(execution);

    const run = async () => {
      // Interactive-mode parity: an extension that throws in `user_bash` was
      // already reported by the runner; never fall back to local execution.
      let eventResult;
      try {
        eventResult = await session.extensionRunner?.emitUserBash?.({
          type: 'user_bash',
          command,
          excludeFromContext,
          cwd: session.sessionManager?.getCwd?.() ?? directory,
        });
      } catch {
        fail(execution, 'An extension failed while handling this command.');
        return;
      }
      if (eventResult?.result) {
        session.recordBashResult(command, eventResult.result, { excludeFromContext });
        finish(execution, eventResult.result);
        return;
      }
      const result = await session.executeBash(
        command,
        (chunk) => appendOutput(execution, chunk),
        { excludeFromContext, ...(eventResult?.operations ? { operations: eventResult.operations } : {}) },
      );
      finish(execution, result);
    };

    void run()
      .catch((error) => {
        fail(execution, redact(error instanceof Error && error.message ? error.message : 'The shell command failed.'));
      })
      .finally(() => {
        try {
          onSettled(sessionId);
        } catch {
          // Idle re-arm never throws into the command lifecycle.
        }
      });
    return { id: execution.id };
  };

  const abort = (session) => {
    if (typeof session?.abortBash === 'function') session.abortBash();
  };

  /** Live executions for snapshots/details. Undefined when there are none. */
  const snapshot = (sessionId) => {
    const list = listFor(sessionId);
    return list.length > 0 ? list.map(view) : undefined;
  };

  /** Drops live state for a disposed or deleted session runtime. */
  const clearSession = (sessionId) => {
    for (const execution of listFor(sessionId)) cancelFlush(execution);
    executionsBySession.delete(sessionId);
  };

  return { start, abort, isActive, snapshot, clearSession };
}
