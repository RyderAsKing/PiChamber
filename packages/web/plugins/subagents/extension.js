// Sub-agents: the agent half. Registers `subagent`, which hands tasks to
// child `pi --mode json -p --no-session` processes, each with its own
// context. PiChamber draws the runs from the result's compact `details`.
//
// Adapted from the subagent example in @earendil-works/pi-coding-agent
// (examples/extensions/subagent), MIT License, Copyright (c) Mario Zechner.
// See ./LICENSE.
//
// `pichamber` is PiChamber's handle ({ id, state(directory, sessionId),
// onStateChange }).
// The Pi CLI passes none, so the manifest defaults apply (tool on).

import { spawn as nodeSpawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from '@earendil-works/pi-coding-agent';

export const TOOL_NAME = 'subagent';
export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const OUTPUT_CAP = 50 * 1024;
export const ERROR_CAP = 2_000;
export const ACTIVITY_LIMIT = 40;
export const ACTIVITY_TEXT_CAP = 400;
export const UPDATE_INTERVAL_MS = 250;
const KILL_DELAY_MS = 5_000;
const BUNDLED_AGENTS_DIR = fileURLToPath(new URL('./agents/', import.meta.url));
const DEFAULT_STATE = Object.freeze({ on: true });

// The id PiChamber keys a session's own plugin values by.
const sessionIdOf = (ctx) => {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
};

const PARAMETERS = {
  type: 'object',
  properties: {
    agent: { type: 'string', description: 'Agent name (single mode)' },
    task: { type: 'string', description: 'Task (single mode)' },
    tasks: {
      type: 'array',
      description: 'Parallel mode: [{agent, task}]',
      items: {
        type: 'object',
        properties: { agent: { type: 'string' }, task: { type: 'string' }, cwd: { type: 'string' } },
        required: ['agent', 'task'],
      },
    },
    chain: {
      type: 'array',
      description: 'Chain mode: [{agent, task}] run in order; {previous} is the prior output',
      items: {
        type: 'object',
        properties: { agent: { type: 'string' }, task: { type: 'string' }, cwd: { type: 'string' } },
        required: ['agent', 'task'],
      },
    },
    agentScope: { type: 'string', enum: ['user', 'project', 'both'], description: 'Default "user". "both" adds project agents.' },
    confirmProjectAgents: { type: 'boolean', description: 'Ask before running project agents. Default true.' },
    cwd: { type: 'string', description: 'Working directory (single mode)' },
  },
};

// ---------------------------------------------------------------- agents

const parseToolList = (value) => {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const tools = raw.filter((t) => typeof t === 'string').map((t) => t.trim()).filter(Boolean);
  return tools.length > 0 ? tools : undefined;
};

/** Read `*.md` agent files from a folder. A bad file is skipped, never fatal. */
export const loadAgentsFromDir = (dir, source) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const agents = [];
  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = path.join(dir, entry.name);
    let parsed;
    try {
      parsed = parseFrontmatter(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      continue;
    }
    const { frontmatter, body } = parsed;
    if (typeof frontmatter?.name !== 'string' || typeof frontmatter.description !== 'string') continue;
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: parseToolList(frontmatter.tools),
      model: typeof frontmatter.model === 'string' ? frontmatter.model : undefined,
      systemPrompt: body ?? '',
      source,
      filePath,
    });
  }
  return agents;
};

const isDirectory = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const findNearestProjectAgentsDir = (cwd) => {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  let current = cwd;
  while (true) {
    const candidate = path.join(current, CONFIG_DIR_NAME, 'agents');
    if (isDirectory(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

/**
 * Bundled agents are the base layer; user agents override them by name, and
 * project agents (scope project/both) override both.
 */
export const discoverAgents = (cwd, scope, { userAgentsDir, bundledAgentsDir = BUNDLED_AGENTS_DIR } = {}) => {
  const userDir = userAgentsDir ?? path.join(getAgentDir(), 'agents');
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  const map = new Map();
  for (const agent of loadAgentsFromDir(bundledAgentsDir, 'bundled')) map.set(agent.name, agent);
  if (scope !== 'project') for (const agent of loadAgentsFromDir(userDir, 'user')) map.set(agent.name, agent);
  if (scope !== 'user' && projectAgentsDir) {
    for (const agent of loadAgentsFromDir(projectAgentsDir, 'project')) map.set(agent.name, agent);
  }
  return { agents: [...map.values()], projectAgentsDir };
};

// ---------------------------------------------------------------- formatting

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}...` : text);

const clipBytes = (text, cap) => {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= cap) return { text, omitted: 0 };
  let cut = text.slice(0, cap);
  while (Buffer.byteLength(cut, 'utf8') > cap) cut = cut.slice(0, -1);
  return { text: cut, omitted: bytes - Buffer.byteLength(cut, 'utf8') };
};

const shortenPath = (p) => {
  const home = os.homedir();
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

const readRange = (offset, limit) => {
  if (typeof offset !== 'number' && typeof limit !== 'number') return '';
  const start = typeof offset === 'number' ? offset : 1;
  return typeof limit === 'number' ? `:${start}-${start + limit - 1}` : `:${start}`;
};

/** One-line summary of a child's tool call. */
export const summarizeToolCall = (name, args = {}) => {
  const a = args && typeof args === 'object' ? args : {};
  const str = (v, fallback) => (typeof v === 'string' && v.length > 0 ? v : fallback);
  switch (name) {
    case 'bash': return `$ ${clip(str(a.command, '...'), 60)}`;
    case 'read': return `read ${shortenPath(str(a.file_path ?? a.path, '...'))}${readRange(a.offset, a.limit)}`;
    case 'write': {
      const lines = str(a.content, '').split('\n').length;
      return `write ${shortenPath(str(a.file_path ?? a.path, '...'))}${lines > 1 ? ` (${lines} lines)` : ''}`;
    }
    case 'edit': return `edit ${shortenPath(str(a.file_path ?? a.path, '...'))}`;
    case 'ls': return `ls ${shortenPath(str(a.path, '.'))}`;
    case 'find': return `find ${str(a.pattern, '*')} in ${shortenPath(str(a.path, '.'))}`;
    case 'grep': return `grep /${str(a.pattern, '')}/ in ${shortenPath(str(a.path, '.'))}`;
    default: {
      let json;
      try {
        json = JSON.stringify(a) ?? '';
      } catch {
        json = '';
      }
      return `${name} ${clip(json, 80)}`;
    }
  }
};

// ---------------------------------------------------------------- runs

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });

/** A run keeps private process state beside the public, compact fields. */
const createRun = ({ agent, agentSource = 'unknown', task, step, status = 'queued', model }) => ({
  agent, agentSource, task, step, status, model,
  usage: emptyUsage(),
  activity: [],
  lastText: '',
  stderr: '',
  errorMessage: undefined,
  stopReason: undefined,
});

const isFailed = (run) => run.status === 'failed' || run.status === 'aborted';

const runError = (run) => clip(run.errorMessage || run.stderr.trim() || '', ERROR_CAP) || undefined;

/** The compact, public shape the UI parses. */
const publicRun = (run) => {
  const result = {
    agent: run.agent,
    agentSource: run.agentSource,
    task: run.task,
    ...(run.step !== undefined ? { step: run.step } : {}),
    status: run.status,
    ...(run.model ? { model: run.model } : {}),
    usage: { ...run.usage },
    activity: run.activity.slice(),
    output: clipBytes(run.lastText, OUTPUT_CAP).text,
  };
  if (isFailed(run)) {
    const error = runError(run);
    if (error) result.error = error;
  }
  return result;
};

/** What the model reads for one run (same order as the example). */
const runOutputForModel = (run) => {
  if (isFailed(run)) return run.errorMessage || run.stderr || run.lastText || '(no output)';
  return run.lastText || '(no output)';
};

const truncateForModel = (output) => {
  const { text, omitted } = clipBytes(output, OUTPUT_CAP);
  return omitted === 0 ? text : `${text}\n\n[Output truncated: ${omitted} bytes omitted.]`;
};

const pushActivity = (run, item) => {
  run.activity.push(item);
  if (run.activity.length > ACTIVITY_LIMIT) run.activity.splice(0, run.activity.length - ACTIVITY_LIMIT);
};

/** Apply one JSON-mode event line from the child. Exported for tests. */
export const applyChildEvent = (run, event) => {
  if (event?.type !== 'message_end' || !event.message) return false;
  const msg = event.message;
  if (msg.role !== 'assistant') return true;
  run.usage.turns++;
  const usage = msg.usage;
  if (usage) {
    run.usage.input += usage.input || 0;
    run.usage.output += usage.output || 0;
    run.usage.cacheRead += usage.cacheRead || 0;
    run.usage.cacheWrite += usage.cacheWrite || 0;
    run.usage.cost += usage.cost?.total || 0;
    run.usage.contextTokens = usage.totalTokens || 0;
  }
  if (!run.model && msg.model) run.model = msg.model;
  if (msg.stopReason) run.stopReason = msg.stopReason;
  if (msg.errorMessage) run.errorMessage = msg.errorMessage;
  let text = '';
  for (const part of Array.isArray(msg.content) ? msg.content : []) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      if (!text) text = part.text;
      pushActivity(run, { kind: 'text', text: clip(part.text, ACTIVITY_TEXT_CAP) });
    } else if (part?.type === 'toolCall') {
      const name = typeof part.name === 'string' ? part.name : 'tool';
      pushActivity(run, { kind: 'tool', name, text: summarizeToolCall(name, part.arguments) });
    }
  }
  if (text) run.lastText = text;
  return true;
};

/** Run the example's Pi invocation logic: reuse this process's Pi CLI. */
export const getPiInvocation = (args) => {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/');
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: 'pi', args };
};

const writePromptToTempFile = async (tmpRoot, agentName, prompt) => {
  const dir = await fs.promises.mkdtemp(path.join(tmpRoot, 'pi-subagent-'));
  const filePath = path.join(dir, `prompt-${agentName.replace(/[^\w.-]+/g, '_')}.md`);
  await fs.promises.writeFile(filePath, prompt, { encoding: 'utf-8', mode: 0o600 });
  return { dir, filePath };
};

/** Coalesce updates to one per interval; `flush` sends the latest at once. */
export const createThrottle = (send, intervalMs) => {
  let last = 0;
  let timer = null;
  let pending = null;
  const fire = () => {
    timer = null;
    if (!pending) return;
    const value = pending();
    pending = null;
    last = Date.now();
    send(value);
  };
  return {
    push(build) {
      pending = build;
      if (timer) return;
      const wait = intervalMs - (Date.now() - last);
      if (wait <= 0) fire();
      else timer = setTimeout(fire, wait);
    },
    flush(build) {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = build ?? pending;
      fire();
    },
  };
};

const mapWithConcurrencyLimit = async (items, concurrency, fn) => {
  const results = new Array(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: limit }, async () => {
    while (true) {
      const current = next++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  }));
  return results;
};

/**
 * Build the extension. Tests inject `spawn`, agent folders, the temp root,
 * and timings; the default export uses the real ones.
 */
export const createSubagentsExtension = ({
  spawn = nodeSpawn,
  invocation = getPiInvocation,
  bundledAgentsDir = BUNDLED_AGENTS_DIR,
  userAgentsDir,
  tmpRoot = os.tmpdir(),
  updateIntervalMs = UPDATE_INTERVAL_MS,
  killDelayMs = KILL_DELAY_MS,
} = {}) => {
  const runAgent = async ({ run, agent, defaultCwd, cwd, dispatch, signal, changed }) => {
    if (!agent) return run;
    const args = ['--mode', 'json', '-p', '--no-session'];
    const model = agent.model ?? dispatch.model;
    if (model) args.push('--model', model);
    if (!agent.model && dispatch.thinkingLevel) args.push('--thinking', dispatch.thinkingLevel);
    if (agent.tools?.length) args.push('--tools', agent.tools.join(','));
    run.model = model;

    let tmp = null;
    try {
      if (agent.systemPrompt.trim()) {
        tmp = await writePromptToTempFile(tmpRoot, agent.name, agent.systemPrompt);
        args.push('--append-system-prompt', tmp.filePath);
      }
      args.push(`Task: ${run.task}`);
      let aborted = false;
      const exitCode = await new Promise((resolveExit) => {
        if (signal?.aborted) {
          aborted = true;
          resolveExit(1);
          return;
        }
        const { command, args: fullArgs } = invocation(args);
        let proc;
        try {
          proc = spawn(command, fullArgs, { cwd: cwd ?? defaultCwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
          run.stderr += error instanceof Error ? error.message : String(error);
          resolveExit(1);
          return;
        }
        run.status = 'running';
        changed();
        let buffer = '';
        const processLine = (line) => {
          if (!line.trim()) return;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          if (applyChildEvent(run, event)) changed();
        };
        proc.stdout.on('data', (data) => {
          buffer += data.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) processLine(line);
        });
        proc.stderr.on('data', (data) => {
          // Keep a bounded tail; only the first ERROR_CAP chars are reported.
          if (run.stderr.length < ERROR_CAP * 4) run.stderr += data.toString();
        });
        let killTimer = null;
        const onAbort = () => {
          aborted = true;
          proc.kill('SIGTERM');
          killTimer = setTimeout(() => {
            if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
          }, killDelayMs);
          killTimer.unref?.();
        };
        const settle = (code) => {
          if (killTimer) clearTimeout(killTimer);
          signal?.removeEventListener?.('abort', onAbort);
          resolveExit(code);
        };
        proc.on('close', (code) => {
          if (buffer.trim()) processLine(buffer);
          settle(code ?? 0);
        });
        proc.on('error', (error) => {
          run.stderr += error?.message ?? '';
          settle(1);
        });
        signal?.addEventListener?.('abort', onAbort, { once: true });
      });
      if (aborted || run.stopReason === 'aborted') run.status = 'aborted';
      else if (exitCode !== 0 || run.stopReason === 'error') run.status = 'failed';
      else run.status = 'done';
      return run;
    } finally {
      if (tmp) await fs.promises.rm(tmp.dir, { recursive: true, force: true }).catch(() => {});
    }
  };

  return function subagents(pi, pichamber) {
    let sessionCwd;
    // A composer switch can turn a plugin off for one session only.
    let sessionId;
    const isOn = () => {
      const state = pichamber ? { ...DEFAULT_STATE, ...pichamber.state(sessionCwd, sessionId) } : DEFAULT_STATE;
      return state.on !== false;
    };

    // Keep the rest of the active tools as they are; only add or remove ours,
    // and only when the session starts or our switch flips, so a tool list the
    // user changed survives unrelated plugin changes.
    let appliedOn;
    const applyActive = ({ force = false } = {}) => {
      try {
        const on = isOn();
        if (!force && on === appliedOn) return;
        appliedOn = on;
        const active = pi.getActiveTools();
        const listed = active.includes(TOOL_NAME);
        if (on && !listed) pi.setActiveTools([...active, TOOL_NAME]);
        if (!on && listed) pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
      } catch {
        // A runtime that is shutting down has no tools to change.
      }
    };

    const bundledNames = loadAgentsFromDir(bundledAgentsDir, 'bundled').map((a) => a.name).sort();
    const description = [
      'Hand tasks to sub-agents that work in their own context.',
      'Modes: single (agent + task), parallel (tasks, max 8), chain (in order; {previous} is the prior output).',
      bundledNames.length ? `Agents: ${bundledNames.join(', ')}, plus any in ${shortenPath(userAgentsDir ?? path.join(getAgentDir(), 'agents'))}.` : '',
      `agentScope "both" adds project agents from ${CONFIG_DIR_NAME}/agents.`,
    ].filter(Boolean).join(' ');

    pi.registerTool({
      name: TOOL_NAME,
      label: 'Sub-agents',
      description,
      parameters: PARAMETERS,
      async execute(_toolCallId, params = {}, signal, onUpdate, ctx = {}) {
        if (!isOn()) throw new Error('Sub-agents are off.');
        const defaultCwd = ctx.cwd ?? sessionCwd ?? process.cwd();
        const agentScope = ['user', 'project', 'both'].includes(params.agentScope) ? params.agentScope : 'user';
        const dispatch = {
          model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
          thinkingLevel: ctx.thinkingLevel,
        };
        const { agents, projectAgentsDir } = discoverAgents(defaultCwd, agentScope, { userAgentsDir, bundledAgentsDir });
        const findAgent = (name) => agents.find((a) => a.name === name);
        const available = agents.map((a) => `${a.name} (${a.source})`).join(', ') || 'none';

        const hasChain = (params.chain?.length ?? 0) > 0;
        const hasTasks = (params.tasks?.length ?? 0) > 0;
        const hasSingle = Boolean(params.agent && params.task);
        const mode = hasChain ? 'chain' : hasTasks ? 'parallel' : 'single';
        const details = (runs) => ({ mode, agentScope, results: runs.map(publicRun) });

        if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
          return {
            content: [{ type: 'text', text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` }],
            details: { mode: 'single', agentScope, results: [] },
          };
        }

        const requested = hasChain ? params.chain : hasTasks ? params.tasks : [{ agent: params.agent, task: params.task, cwd: params.cwd }];

        if (agentScope !== 'user' && (params.confirmProjectAgents ?? true) && ctx.hasUI && !ctx.isProjectTrusted?.()) {
          const projectAgents = [...new Set(requested.map((r) => r.agent))]
            .map(findAgent)
            .filter((a) => a?.source === 'project');
          if (projectAgents.length > 0) {
            const ok = await ctx.ui.confirm(
              'Run project-local agents?',
              `Agents: ${projectAgents.map((a) => a.name).join(', ')}\nSource: ${projectAgentsDir ?? '(unknown)'}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
            );
            if (!ok) {
              return { content: [{ type: 'text', text: 'Canceled: project-local agents not approved.' }], details: details([]) };
            }
          }
        }

        if (hasTasks && params.tasks.length > MAX_PARALLEL_TASKS) {
          return {
            content: [{ type: 'text', text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
            details: details([]),
          };
        }

        const runs = [];
        const progressText = () => {
          if (mode === 'parallel') {
            const done = runs.filter((r) => r.status !== 'queued' && r.status !== 'running').length;
            const running = runs.filter((r) => r.status === 'running').length;
            return `Parallel: ${done}/${runs.length} done, ${running} running...`;
          }
          return runs[runs.length - 1]?.lastText || '(running...)';
        };
        const snapshot = () => ({ content: [{ type: 'text', text: progressText() }], details: details(runs) });
        const throttle = onUpdate ? createThrottle(onUpdate, updateIntervalMs) : null;
        const changed = () => throttle?.push(snapshot);

        const newRun = (item, step) => {
          const agent = findAgent(item.agent);
          const run = createRun({ agent: item.agent, agentSource: agent?.source ?? 'unknown', task: item.task, step });
          if (!agent) {
            run.status = 'failed';
            run.errorMessage = `Unknown agent: "${item.agent}". Available agents: ${agents.map((a) => `"${a.name}"`).join(', ') || 'none'}.`;
          }
          return { run, agent };
        };
        const start = ({ run, agent }, item) => runAgent({ run, agent, defaultCwd, cwd: item.cwd, dispatch, signal, changed });

        try {
          if (mode === 'chain') {
            let previous = '';
            for (let i = 0; i < params.chain.length; i++) {
              const step = params.chain[i];
              const entry = newRun({ ...step, task: step.task.replace(/\{previous\}/g, () => previous) }, i + 1);
              runs.push(entry.run);
              changed();
              await start(entry, step);
              if (isFailed(entry.run)) {
                return {
                  content: [{ type: 'text', text: `Chain stopped at step ${i + 1} (${step.agent}): ${runOutputForModel(entry.run)}` }],
                  details: details(runs),
                  isError: true,
                };
              }
              previous = entry.run.lastText;
            }
            return { content: [{ type: 'text', text: runs[runs.length - 1].lastText || '(no output)' }], details: details(runs) };
          }

          if (mode === 'parallel') {
            const entries = params.tasks.map((t) => newRun(t));
            runs.push(...entries.map((e) => e.run));
            changed();
            await mapWithConcurrencyLimit(entries, MAX_CONCURRENCY, async (entry, index) => {
              await start(entry, params.tasks[index]);
              changed();
            });
            const ok = runs.filter((r) => !isFailed(r)).length;
            const summaries = runs.map((r) => {
              const status = isFailed(r) ? `failed${r.stopReason && r.stopReason !== 'end' ? ` (${r.stopReason})` : ''}` : 'completed';
              return `### [${r.agent}] ${status}\n\n${truncateForModel(runOutputForModel(r))}`;
            });
            return {
              content: [{ type: 'text', text: `Parallel: ${ok}/${runs.length} succeeded\n\n${summaries.join('\n\n---\n\n')}` }],
              details: details(runs),
            };
          }

          const entry = newRun(requested[0]);
          runs.push(entry.run);
          await start(entry, requested[0]);
          if (isFailed(entry.run)) {
            const reason = entry.run.status === 'aborted' ? 'aborted' : entry.run.stopReason || 'failed';
            return {
              content: [{ type: 'text', text: `Agent ${reason}: ${runOutputForModel(entry.run)}` }],
              details: details(runs),
              isError: true,
            };
          }
          return { content: [{ type: 'text', text: entry.run.lastText || '(no output)' }], details: details(runs) };
        } finally {
          // Always send the final state, even if the last change was throttled.
          if (runs.length > 0) throttle?.flush(snapshot);
        }
      },
    });

    pi.on('session_start', (_event, ctx) => {
      sessionCwd = ctx?.cwd;
      sessionId = sessionIdOf(ctx);
      applyActive({ force: true });
    });
    pichamber?.onStateChange(() => applyActive());
  };
};

export default createSubagentsExtension();
