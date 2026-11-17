import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import defaultExtension, {
  ACTIVITY_LIMIT,
  createSubagentsExtension,
  discoverAgents,
  summarizeToolCall,
  TOOL_NAME,
} from './extension.js';

const assistant = (text, extra = {}) => ({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: { total: 0.01 }, totalTokens: 18 },
    model: 'test/model',
    stopReason: 'stop',
    ...extra,
  },
});
const toolCall = (name, args) => ({
  type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'toolCall', name, arguments: args }] },
});

/** A fake child process driven by a script: events to print, then an exit code. */
const fakeSpawn = (scriptFor) => {
  const calls = [];
  const spawn = vi.fn((command, args, options) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.exitCode = null;
    proc.signalCode = null;
    proc.kills = [];
    const close = (code) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.exitCode = code;
      proc.emit('close', code);
    };
    proc.kill = (sig) => {
      proc.kills.push(sig);
      if (script.ignoreTerm && sig === 'SIGTERM') return true;
      proc.signalCode = sig;
      proc.emit('close', null);
      return true;
    };
    const task = args[args.length - 1];
    const promptIndex = args.indexOf('--append-system-prompt');
    const call = { command, args, options, proc, promptPath: promptIndex >= 0 ? args[promptIndex + 1] : null };
    call.promptExisted = call.promptPath ? existsSync(call.promptPath) : false;
    calls.push(call);
    const script = scriptFor(task, calls.length - 1);
    setTimeout(() => {
      for (const event of script.events ?? []) proc.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`));
      if (script.stderr) proc.stderr.emit('data', Buffer.from(script.stderr));
      if (!script.hang) close(script.code ?? 0);
    }, script.delay ?? 0);
    return proc;
  });
  return { spawn, calls };
};

const agentsDirs = async () => {
  const root = await mkdtemp(join(tmpdir(), 'pichamber-subagents-'));
  const bundled = join(root, 'bundled');
  const user = join(root, 'user');
  const project = join(root, 'project');
  const tmp = join(root, 'tmp');
  await Promise.all([bundled, user, join(project, '.pi', 'agents'), tmp].map((d) => mkdir(d, { recursive: true })));
  const agent = (dir, name, body, extra = '') => writeFile(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${name} agent\n${extra}---\n\n${body}\n`);
  await agent(bundled, 'scout', 'Bundled scout prompt', 'tools: read, grep\n');
  await agent(bundled, 'worker', 'Bundled worker prompt');
  await agent(user, 'worker', 'User worker prompt', 'model: user/model\n');
  await agent(join(project, '.pi', 'agents'), 'local', 'Project prompt');
  return { bundled, user, project, tmp };
};

const fakePi = (activeTools = ['read', 'bash']) => {
  const handlers = new Map();
  const pi = {
    tools: [],
    active: [...activeTools],
    registerTool: (tool) => pi.tools.push(tool),
    on: (event, handler) => handlers.set(event, handler),
    getActiveTools: () => [...pi.active],
    setActiveTools: (names) => { pi.active = [...names]; },
    start: (cwd) => handlers.get('session_start')?.({ type: 'session_start', reason: 'startup' }, { cwd }),
  };
  return pi;
};

const fakePichamber = (initial) => {
  let values = { ...initial };
  const listeners = new Set();
  return {
    id: 'subagents',
    state: () => ({ ...values }),
    onStateChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    set: (next) => { values = { ...values, ...next }; listeners.forEach((listener) => listener()); },
  };
};

const setup = async (scriptFor, options = {}) => {
  const dirs = await agentsDirs();
  const { spawn, calls } = fakeSpawn(scriptFor);
  const extension = createSubagentsExtension({
    spawn,
    invocation: (args) => ({ command: 'pi', args }),
    bundledAgentsDir: dirs.bundled,
    userAgentsDir: dirs.user,
    tmpRoot: dirs.tmp,
    updateIntervalMs: options.updateIntervalMs ?? 0,
    killDelayMs: options.killDelayMs ?? 20,
  });
  const pi = fakePi();
  extension(pi, options.pichamber);
  pi.start(dirs.project);
  const tool = pi.tools[0];
  const updates = [];
  const run = (params, { signal, ctx } = {}) => tool.execute('call-1', params, signal, (u) => updates.push(u), { cwd: dirs.project, ...ctx });
  return { dirs, pi, tool, run, updates, calls, spawn };
};

const keys = (obj) => Object.keys(obj).sort();
const RESULT_KEYS = ['activity', 'agent', 'agentSource', 'output', 'status', 'task', 'usage'];

afterEach(() => vi.useRealTimers());

describe('subagents extension', () => {
  it('runs a single agent with the compact details shape', async () => {
    const { run, calls } = await setup(() => ({ events: [toolCall('bash', { command: 'ls -la' }), assistant('All done')] }));
    const result = await run({ agent: 'scout', task: 'look around' });
    expect(result.content[0].text).toBe('All done');
    expect(result.isError).toBeUndefined();
    expect(keys(result.details)).toEqual(['agentScope', 'mode', 'results']);
    expect(result.details).toMatchObject({ mode: 'single', agentScope: 'user' });
    const [r] = result.details.results;
    expect(keys(r)).toEqual([...RESULT_KEYS, 'model'].sort());
    expect(r).toMatchObject({
      agent: 'scout', agentSource: 'bundled', task: 'look around', status: 'done', model: 'test/model', output: 'All done',
      usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.01, contextTokens: 18, turns: 2 },
      activity: [{ kind: 'tool', name: 'bash', text: '$ ls -la' }, { kind: 'text', text: 'All done' }],
    });
    expect(calls[0].args.slice(0, 4)).toEqual(['--mode', 'json', '-p', '--no-session']);
    expect(calls[0].args).toContain('--tools');
    expect(calls[0].args.at(-1)).toBe('Task: look around');
  });

  it('runs parallel tasks: queued placeholders, then running, then done', async () => {
    const { run, updates } = await setup((task) => ({ events: [assistant(`out ${task}`)], delay: 5 }));
    const result = await run({ tasks: [{ agent: 'scout', task: 'a' }, { agent: 'worker', task: 'b' }] });
    expect(result.details.mode).toBe('parallel');
    expect(result.details.results.map((r) => [r.agent, r.agentSource, r.status, r.step])).toEqual([
      ['scout', 'bundled', 'done', undefined],
      ['worker', 'user', 'done', undefined],
    ]);
    expect(updates[0].details.results.map((r) => r.status)).toEqual(['queued', 'queued']);
    expect(updates.some((u) => u.details.results.some((r) => r.status === 'running'))).toBe(true);
    expect(result.content[0].text).toMatch(/^Parallel: 2\/2 succeeded/);
    expect(result.content[0].text).toContain('### [worker] completed');
  });

  it('refuses more than 8 parallel tasks', async () => {
    const { run, spawn } = await setup(() => ({}));
    const result = await run({ tasks: Array.from({ length: 9 }, () => ({ agent: 'scout', task: 't' })) });
    expect(result.content[0].text).toMatch(/Max is 8/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('runs a chain, passing {previous}, with steps', async () => {
    const { run, calls } = await setup((task, i) => ({ events: [assistant(i === 0 ? 'found X' : `used ${task}`)] }));
    const result = await run({ chain: [{ agent: 'scout', task: 'find' }, { agent: 'worker', task: 'fix {previous}' }] });
    expect(calls[1].args.at(-1)).toBe('Task: fix found X');
    expect(result.details.results.map((r) => [r.step, r.status])).toEqual([[1, 'done'], [2, 'done']]);
    expect(result.content[0].text).toBe('used Task: fix found X');
  });

  it('stops a chain at a failed step and reports the error', async () => {
    const { run, spawn } = await setup(() => ({ code: 1, stderr: 'boom' }));
    const result = await run({ chain: [{ agent: 'scout', task: 'a' }, { agent: 'worker', task: 'b' }] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Chain stopped at step 1 (scout): boom');
    expect(result.details.results).toHaveLength(1);
    expect(result.details.results[0]).toMatchObject({ status: 'failed', error: 'boom' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reports an unknown agent without spawning', async () => {
    const { run, spawn } = await setup(() => ({}));
    const result = await run({ agent: 'nobody', task: 't' });
    expect(spawn).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.details.results[0]).toMatchObject({ agent: 'nobody', agentSource: 'unknown', status: 'failed' });
    expect(result.details.results[0].error).toMatch(/Unknown agent: "nobody"/);
  });

  it('marks runs aborted and escalates to SIGKILL', async () => {
    const { run, calls } = await setup(() => ({ hang: true, ignoreTerm: true }), { killDelayMs: 10 });
    const controller = new AbortController();
    const pending = run({ tasks: [{ agent: 'scout', task: 'a' }, { agent: 'worker', task: 'b' }] }, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const result = await pending;
    expect(result.details.results.map((r) => r.status)).toEqual(['aborted', 'aborted']);
    expect(calls[0].proc.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('throttles updates and still sends the final state', async () => {
    const events = Array.from({ length: 30 }, (_, i) => assistant(`step ${i}`));
    const { run, updates } = await setup(() => ({ events }), { updateIntervalMs: 1_000 });
    const result = await run({ agent: 'scout', task: 't' });
    expect(updates.length).toBeLessThanOrEqual(3);
    expect(updates.at(-1).details).toEqual(result.details);
    expect(result.details.results[0].activity).toHaveLength(30);
  });

  it('keeps only the last 40 activity items and clips text', async () => {
    const events = [...Array.from({ length: 45 }, (_, i) => assistant(`step ${i}`)), assistant('x'.repeat(1_000))];
    const { run } = await setup(() => ({ events }));
    const { activity } = (await run({ agent: 'scout', task: 't' })).details.results[0];
    expect(activity).toHaveLength(ACTIVITY_LIMIT);
    expect(activity.at(-1).text).toHaveLength(403);
  });

  it('writes the agent prompt to a private temp file and removes it', async () => {
    const { run, calls, dirs } = await setup(() => ({ events: [assistant('ok')] }));
    await run({ agent: 'scout', task: 't' });
    expect(calls[0].promptExisted).toBe(true);
    expect(calls[0].promptPath.startsWith(dirs.tmp)).toBe(true);
    expect(readdirSync(dirs.tmp)).toEqual([]);
  });

  it('lets user agents override bundled ones, and project agents only with a project scope', async () => {
    const dirs = await agentsDirs();
    const opts = { userAgentsDir: dirs.user, bundledAgentsDir: dirs.bundled };
    const byName = (scope) => Object.fromEntries(discoverAgents(dirs.project, scope, opts).agents.map((a) => [a.name, a.source]));
    expect(byName('user')).toEqual({ scout: 'bundled', worker: 'user' });
    expect(byName('both')).toEqual({ scout: 'bundled', worker: 'user', local: 'project' });
    expect(byName('project')).toEqual({ scout: 'bundled', worker: 'bundled', local: 'project' });
  });

  it('asks before running project agents and stops when declined', async () => {
    const { run, spawn } = await setup(() => ({}));
    const confirm = vi.fn(async () => false);
    const result = await run({ agent: 'local', task: 't', agentScope: 'both' }, { ctx: { hasUI: true, isProjectTrusted: () => false, ui: { confirm } } });
    expect(confirm).toHaveBeenCalledOnce();
    expect(result.content[0].text).toMatch(/not approved/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('adds and removes only its own tool from the active set as the state changes', async () => {
    const pichamber = fakePichamber({ on: false });
    const { pi, tool } = await setup(() => ({}), { pichamber });
    expect(pi.active).toEqual(['read', 'bash']);
    pichamber.set({ on: true });
    expect(pi.active).toEqual(['read', 'bash', TOOL_NAME]);
    pichamber.set({ on: false });
    expect(pi.active).toEqual(['read', 'bash']);
    await expect(tool.execute('c', { agent: 'scout', task: 't' }, undefined, undefined, {})).rejects.toThrow(/off/);
  });

  it('leaves a tool list the user changed alone until its switch flips or the session starts', async () => {
    const pichamber = fakePichamber({ on: true });
    const { pi, dirs } = await setup(() => ({}), { pichamber });
    expect(pi.active).toEqual(['read', 'bash', TOOL_NAME]);
    pi.active = ['read'];
    pichamber.set({ unrelated: 1 });
    expect(pi.active).toEqual(['read']);
    pichamber.set({ on: false });
    pichamber.set({ on: true });
    expect(pi.active).toEqual(['read', TOOL_NAME]);
    pi.active = ['read'];
    pi.start(dirs.project);
    expect(pi.active).toEqual(['read', TOOL_NAME]);
  });

  it('summarizes tool calls on one line', () => {
    expect(summarizeToolCall('read', { path: '/x/a.ts', offset: 10, limit: 5 })).toBe('read /x/a.ts:10-14');
    expect(summarizeToolCall('grep', { pattern: 'foo', path: 'src' })).toBe('grep /foo/ in src');
    expect(summarizeToolCall('custom', { value: 'v'.repeat(200) })).toMatch(/^custom \{"value":"v+\.\.\.$/);
  });

  it('ships the bundled agents with the default export', () => {
    const pi = fakePi();
    defaultExtension(pi);
    expect(pi.tools[0].description).toMatch(/scout, planner, reviewer, worker|planner, reviewer, scout, worker/);
  });
});
