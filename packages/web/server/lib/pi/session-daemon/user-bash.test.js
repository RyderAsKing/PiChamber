import { describe, expect, it, vi } from 'vitest';

import {
  createUserBash,
  projectBashExecutionEntry,
  USER_BASH_CUSTOM_TYPE,
  USER_BASH_LIVE_OUTPUT_MAX_CHARS,
  USER_BASH_OUTPUT_FLUSH_MAX_CHARS,
  validateUserBashRequest,
} from './user-bash.js';

/**
 * Mirrors the Pi 1.4 `AgentSession` bash contract: `executeBash` streams
 * chunks, then `recordBashResult` appends a `bashExecution` message through
 * `sessionManager.appendMessage`, deferring it while the agent streams.
 */
const createFakeSession = () => {
  const entries = [];
  let running;
  const session = {
    isStreaming: false,
    pendingBash: [],
    userBashEvents: [],
    executeCalls: [],
    sessionManager: {
      getCwd: () => '/work',
      appendMessage(message) {
        const id = `entry-${entries.length + 1}`;
        entries.push({ type: 'message', id, timestamp: '2026-11-06T10:00:00.000Z', message });
        return id;
      },
      getEntry: (id) => entries.find((entry) => entry.id === id),
    },
    extensionRunner: {
      emitUserBash: async (event) => {
        session.userBashEvents.push(event);
        return session.userBashResult?.(event);
      },
    },
    get isBashRunning() {
      return running !== undefined;
    },
    recordBashResult(command, result, options) {
      const message = {
        role: 'bashExecution',
        command,
        output: result.output,
        exitCode: result.exitCode,
        cancelled: result.cancelled,
        truncated: result.truncated,
        fullOutputPath: result.fullOutputPath,
        timestamp: 1,
        excludeFromContext: options?.excludeFromContext,
      };
      if (session.isStreaming) session.pendingBash.push(message);
      else session.sessionManager.appendMessage(message);
    },
    flushPendingBash() {
      for (const message of session.pendingBash) session.sessionManager.appendMessage(message);
      session.pendingBash = [];
    },
    executeBash(command, onChunk, options) {
      session.executeCalls.push({ command, options });
      return new Promise((resolve, reject) => {
        running = {
          onChunk,
          finish: (result) => {
            running = undefined;
            session.recordBashResult(command, result, options);
            resolve(result);
          },
          fail: (error) => {
            running = undefined;
            reject(error);
          },
        };
      });
    },
    abortBash() {
      running?.finish({ output: 'partial', exitCode: undefined, cancelled: true, truncated: false });
    },
    get running() {
      return running;
    },
    entries,
  };
  return session;
};

const createHarness = () => {
  const events = [];
  const timers = [];
  const settled = [];
  const userBash = createUserBash({
    publish: (event, payload, sessionId, directory) => events.push({ event, payload, sessionId, directory }),
    onSettled: (sessionId) => settled.push(sessionId),
    now: () => 5_000,
    setTimer: (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
  });
  const runTimers = () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback();
  };
  return { userBash, events, timers, settled, runTimers };
};

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('validateUserBashRequest', () => {
  it('trims the command and rejects empty, oversized, or mistyped input', () => {
    expect(validateUserBashRequest({ command: '  ls -la  ' })).toEqual({ command: 'ls -la', excludeFromContext: false });
    expect(validateUserBashRequest({ command: 'ls', excludeFromContext: true })).toEqual({ command: 'ls', excludeFromContext: true });
    expect(() => validateUserBashRequest({ command: '   ' })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => validateUserBashRequest({ command: 'x'.repeat(100_001) })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => validateUserBashRequest({ command: 'ls', excludeFromContext: 'yes' })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});

describe('createUserBash', () => {
  it('runs through user_bash and executeBash, coalesces output, and publishes the recorded entry', async () => {
    const { userBash, events, timers, settled, runTimers } = createHarness();
    const session = createFakeSession();

    const { id } = userBash.start({ sessionId: 's1', directory: '/work', session, command: 'ls', excludeFromContext: false });
    expect(events[0]).toMatchObject({ event: 'session.bash', payload: { bash: { id, command: 'ls', phase: 'running', startedAt: 5_000 } }, sessionId: 's1', directory: '/work' });
    expect(userBash.isActive('s1')).toBe(true);
    await flushMicrotasks();
    expect(session.userBashEvents).toEqual([{ type: 'user_bash', command: 'ls', excludeFromContext: false, cwd: '/work' }]);

    session.running.onChunk('a\n');
    session.running.onChunk('b\n');
    session.running.onChunk('c\n');
    // One timer per flush window, however many chunks arrive.
    expect(timers).toHaveLength(1);
    expect(events.filter((entry) => entry.event === 'session.bash.output')).toHaveLength(0);
    runTimers();
    expect(events.filter((entry) => entry.event === 'session.bash.output')).toEqual([
      expect.objectContaining({ payload: { id, delta: 'a\nb\nc\n' } }),
    ]);
    expect(userBash.snapshot('s1')).toEqual([expect.objectContaining({ id, phase: 'running', output: 'a\nb\nc\n' })]);

    session.running.finish({ output: 'a\nb\nc\n', exitCode: 0, cancelled: false, truncated: false });
    await flushMicrotasks();

    const recorded = events.filter((entry) => entry.event === 'session.bash.recorded');
    expect(recorded).toEqual([expect.objectContaining({
      directory: '/work',
      payload: {
        id,
        message: {
          id: 'entry-1',
          createdAt: Date.parse('2026-11-06T10:00:00.000Z'),
          customType: USER_BASH_CUSTOM_TYPE,
          details: { command: 'ls', output: 'a\nb\nc\n', exitCode: 0 },
        },
      },
    })]);
    // Recorded synchronously by Pi, so no separate completed state is published.
    expect(events.filter((entry) => entry.event === 'session.bash').map((entry) => entry.payload.bash.phase)).toEqual(['running']);
    expect(userBash.snapshot('s1')).toBeUndefined();
    expect(userBash.isActive('s1')).toBe(false);
    expect(settled).toEqual(['s1']);
  });

  it('keeps a completed command live while Pi defers its record until the turn ends', async () => {
    const { userBash, events } = createHarness();
    const session = createFakeSession();
    session.isStreaming = true;

    const { id } = userBash.start({ sessionId: 's1', directory: '/work', session, command: 'git status', excludeFromContext: true });
    await flushMicrotasks();
    session.running.finish({ output: 'clean', exitCode: 0, cancelled: false, truncated: false });
    await flushMicrotasks();

    expect(events.filter((entry) => entry.event === 'session.bash').at(-1).payload.bash).toMatchObject({
      id, phase: 'completed', exitCode: 0, output: 'clean', excludeFromContext: true, completedAt: 5_000,
    });
    expect(userBash.snapshot('s1')).toEqual([expect.objectContaining({ id, phase: 'completed' })]);
    expect(userBash.isActive('s1')).toBe(false);
    expect(events.some((entry) => entry.event === 'session.bash.recorded')).toBe(false);

    session.isStreaming = false;
    session.flushPendingBash();
    expect(events.at(-1)).toMatchObject({
      event: 'session.bash.recorded',
      payload: { id, message: { id: 'entry-1', details: { command: 'git status', output: 'clean', exitCode: 0, excludeFromContext: true } } },
    });
    expect(userBash.snapshot('s1')).toBeUndefined();
  });

  it('records an extension-provided result without executing locally', async () => {
    const { userBash, events } = createHarness();
    const session = createFakeSession();
    session.userBashResult = () => ({ result: { output: 'remote output', exitCode: 3, cancelled: false, truncated: false } });

    const { id } = userBash.start({ sessionId: 's1', directory: '/work', session, command: 'uptime', excludeFromContext: false });
    await flushMicrotasks();

    expect(session.executeCalls).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      event: 'session.bash.recorded',
      payload: { id, message: { details: { command: 'uptime', output: 'remote output', exitCode: 3 } } },
    });
  });

  it('passes extension operations to executeBash', async () => {
    const { userBash } = createHarness();
    const session = createFakeSession();
    const operations = { exec: vi.fn() };
    session.userBashResult = () => ({ operations });

    userBash.start({ sessionId: 's1', directory: '/work', session, command: 'hostname', excludeFromContext: true });
    await flushMicrotasks();

    expect(session.executeCalls).toEqual([{ command: 'hostname', options: { excludeFromContext: true, operations } }]);
  });

  it('fails without local fallback when a user_bash handler throws', async () => {
    const { userBash, events, settled } = createHarness();
    const session = createFakeSession();
    session.userBashResult = () => { throw new Error('extension exploded'); };

    const { id } = userBash.start({ sessionId: 's1', directory: '/work', session, command: 'ls', excludeFromContext: false });
    await flushMicrotasks();

    expect(session.executeCalls).toEqual([]);
    expect(events.at(-1).payload.bash).toMatchObject({ id, phase: 'failed', error: 'An extension failed while handling this command.' });
    expect(userBash.snapshot('s1')).toEqual([expect.objectContaining({ id, phase: 'failed' })]);
    expect(settled).toEqual(['s1']);

    // The next command replaces the previous failure.
    userBash.start({ sessionId: 's1', directory: '/work', session, command: 'pwd', excludeFromContext: false });
    expect(userBash.snapshot('s1')).toEqual([expect.objectContaining({ command: 'pwd', phase: 'running' })]);
  });

  it('reports an executeBash rejection as a failed command', async () => {
    const { userBash, events } = createHarness();
    const session = createFakeSession();

    userBash.start({ sessionId: 's1', directory: '/work', session, command: 'ls', excludeFromContext: false });
    await flushMicrotasks();
    session.running.fail(new Error('spawn bash ENOENT'));
    await flushMicrotasks();

    expect(events.at(-1).payload.bash).toMatchObject({ phase: 'failed', error: 'spawn bash ENOENT' });
  });

  it('runs one command per session at a time', async () => {
    const { userBash } = createHarness();
    const session = createFakeSession();
    const other = createFakeSession();

    userBash.start({ sessionId: 's1', directory: '/work', session, command: 'sleep 10', excludeFromContext: false });
    expect(() => userBash.start({ sessionId: 's1', directory: '/work', session, command: 'ls', excludeFromContext: false }))
      .toThrow(expect.objectContaining({ code: 'SESSION_BUSY' }));
    expect(() => userBash.start({ sessionId: 's2', directory: '/work', session: other, command: 'ls', excludeFromContext: false }))
      .not.toThrow();
  });

  it('records cancellation after abort', async () => {
    const { userBash, events } = createHarness();
    const session = createFakeSession();

    const { id } = userBash.start({ sessionId: 's1', directory: '/work', session, command: 'sleep 10', excludeFromContext: false });
    await flushMicrotasks();
    userBash.abort(session);
    await flushMicrotasks();

    expect(events.at(-1)).toMatchObject({
      event: 'session.bash.recorded',
      payload: { id, message: { details: { command: 'sleep 10', output: 'partial', cancelled: true } } },
    });
  });

  it('bounds live output and replaces an oversized backlog with its tail', async () => {
    const { userBash, events, runTimers } = createHarness();
    const session = createFakeSession();

    const { id } = userBash.start({ sessionId: 's1', directory: '/work', session, command: 'yes', excludeFromContext: false });
    await flushMicrotasks();
    for (let index = 0; index < 50; index += 1) session.running.onChunk(`${String(index).padStart(4, '0')}${'y'.repeat(4_000)}\n`);
    runTimers();

    const outputs = events.filter((entry) => entry.event === 'session.bash.output');
    expect(outputs).toHaveLength(1);
    expect(outputs[0].payload).toMatchObject({ id, reset: true });
    expect(outputs[0].payload.output.length).toBe(USER_BASH_OUTPUT_FLUSH_MAX_CHARS);
    expect(outputs[0].payload.output.endsWith(`${'y'.repeat(4_000)}\n`)).toBe(true);
    expect(userBash.snapshot('s1')[0].output.length).toBe(USER_BASH_LIVE_OUTPUT_MAX_CHARS);

    session.running.onChunk('tail\n');
    runTimers();
    expect(events.at(-1).payload).toEqual({ id, delta: 'tail\n' });
  });

  it('flushes pending output before the final state and clears timers with the session', async () => {
    const { userBash, events, timers } = createHarness();
    const session = createFakeSession();
    session.isStreaming = true;

    userBash.start({ sessionId: 's1', directory: '/work', session, command: 'make', excludeFromContext: false });
    await flushMicrotasks();
    session.running.onChunk('building\n');
    session.running.finish({ output: 'building\n', exitCode: 2, cancelled: false, truncated: false });
    await flushMicrotasks();

    const names = events.map((entry) => entry.event);
    expect(names.slice(-2)).toEqual(['session.bash.output', 'session.bash']);
    expect(timers.every((timer) => timer.cleared)).toBe(true);

    userBash.start({ sessionId: 's2', directory: '/work', session: createFakeSession(), command: 'ls', excludeFromContext: false });
    userBash.clearSession('s1');
    userBash.clearSession('s2');
    expect(userBash.snapshot('s1')).toBeUndefined();
    expect(userBash.isActive('s2')).toBe(false);
  });

  it('rejects a session without bash support', () => {
    const { userBash } = createHarness();
    expect(() => userBash.start({ sessionId: 's1', directory: '/work', session: {}, command: 'ls', excludeFromContext: false }))
      .toThrow(expect.objectContaining({ code: 'INVALID_SESSION' }));
  });
});

describe('projectBashExecutionEntry', () => {
  it('projects persisted bashExecution entries and ignores everything else', () => {
    const entry = {
      type: 'message',
      id: 'entry-9',
      timestamp: '2026-11-06T10:00:00.000Z',
      message: {
        role: 'bashExecution',
        command: 'npm test',
        output: 'x'.repeat(70_000),
        exitCode: 1,
        cancelled: false,
        truncated: true,
        fullOutputPath: '/tmp/pi-bash-1.log',
        excludeFromContext: false,
        timestamp: 1,
      },
    };
    const projected = projectBashExecutionEntry(entry, { sessionId: 's1', directory: '/work' });
    expect(projected).toEqual({
      message: {
        id: 'entry-9',
        sessionId: 's1',
        directory: '/work',
        role: 'extension',
        customType: USER_BASH_CUSTOM_TYPE,
        createdAt: Date.parse('2026-11-06T10:00:00.000Z'),
        details: {
          command: 'npm test',
          output: 'x'.repeat(64 * 1024),
          exitCode: 1,
          truncated: true,
          fullOutputPath: '/tmp/pi-bash-1.log',
        },
      },
      parts: [],
    });
    expect(projectBashExecutionEntry({ type: 'message', id: 'u', message: { role: 'user', content: 'hi' } }, { sessionId: 's1', directory: '/work' })).toBeUndefined();
    expect(projectBashExecutionEntry({ type: 'custom', id: 'c' }, { sessionId: 's1', directory: '/work' })).toBeUndefined();
  });
});
