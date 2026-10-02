import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionDaemon } from './session-daemon.js';
import { getPiSessionDirectory } from './session-jsonl.js';

const credential = 'turn-e2e-daemon-credential';

const TURN_EXTENSION = `
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';

export default function (pi) {
  const faux = fauxProvider({
    provider: 'turn-mock-provider',
    models: [{
      id: 'turn-mock-model',
      name: 'Turn Mock Model',
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16384,
      maxTokens: 2048,
    }],
    tokensPerSecond: 200,
  });

  faux.setResponses([
    // 1. Reply to "hello turn test"
    (context) => {
      const lastMsg = context.messages[context.messages.length - 1];
      const text = typeof lastMsg?.content === 'string'
        ? lastMsg.content
        : (Array.isArray(lastMsg?.content) ? lastMsg.content.map((c) => c.text || '').join('') : '');
      const reply = \`Reply: \${text}\`;
      const msg = fauxAssistantMessage(reply, {
        usage: { input: 12, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
      msg.usage = { input: 12, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      return msg;
    },
    // 2. Call echo_tool
    fauxAssistantMessage([fauxToolCall('echo_tool', { text: 'echo payload' }, { id: 'call-echo-1' })], { stopReason: 'toolUse' }),
    // 3. Complete echo turn
    fauxAssistantMessage('Echo turn completed', {
      usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }),
    // 4. Call nested_tool
    fauxAssistantMessage([fauxToolCall('nested_tool', { text: 'nested payload' }, { id: 'call-nested-1' })], { stopReason: 'toolUse' }),
    // 5. Complete nested turn
    fauxAssistantMessage('Nested turn completed', {
      usage: { input: 25, output: 12, cacheRead: 0, cacheWrite: 0, totalTokens: 37, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    }),
    // 6. Slow stream for queueing test
    async (context) => {
      await new Promise((r) => setTimeout(r, 750));
      return fauxAssistantMessage('Slow turn completed');
    },
    // 7 and 8. Replies to the queued steer and follow-up
    fauxAssistantMessage('First queued reply'),
    fauxAssistantMessage('Second queued reply'),
  ]);

  pi.registerProvider(faux.provider);

  pi.registerTool({
    name: 'echo_tool',
    description: 'Echoes input',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    execute: async (_toolCallId, args) => {
      return { content: [{ type: 'text', text: \`echo:\${args.text}\` }] };
    },
    renderCall: (args, theme) => {
      return {
        render: () => [theme.style(\`[calling echo \${args.text}]\`, { fg: 'accent', bold: true })],
      };
    },
    renderResult: (result, _options, theme) => {
      const resText = result?.content?.[0]?.text ?? result?.text ?? (typeof result === 'string' ? result : JSON.stringify(result));
      return {
        render: () => [theme.style(\`[echo result: \${resText}]\`, { fg: 'success' })],
      };
    },
  });

  pi.registerTool({
    name: 'nested_tool',
    description: 'Executes echo_tool nestedly',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    execute: async (_toolCallId, args, _signal, _onUpdate, ctx) => {
      const sub = await ctx.executeTool('echo_tool', { text: \`sub-\${args.text}\` });
      const subText = sub?.result?.content?.[0]?.text ?? sub?.content?.[0]?.text ?? sub?.text ?? (typeof sub === 'string' ? sub : JSON.stringify(sub));
      return { content: [{ type: 'text', text: \`nested-wrap:\${subText}\` }] };
    },
    renderCall: (args, theme) => {
      return {
        render: () => [theme.style(\`[calling nested \${args.text}]\`, { fg: 'warning' })],
      };
    },
    renderResult: (result, _options, theme) => {
      const resText = result?.content?.[0]?.text ?? result?.text ?? (typeof result === 'string' ? result : JSON.stringify(result));
      return {
        render: () => [theme.style(\`[nested result: \${resText}]\`, { fg: 'success' })],
      };
    },
  });
}
`;

function connectClient(endpoint) {
  const socket = createConnection({ path: endpoint });
  let buffer = '';
  const messages = [];
  const waiters = [];
  const publish = (message) => {
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter.predicate(message)) {
        waiters.splice(index, 1);
        waiter.resolve(message);
      }
    }
  };
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line) publish(JSON.parse(line));
    }
  });
  const next = (predicate, timeoutMs = 20_000) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const eventsSummary = messages.map((m) => JSON.stringify(m)).join('\n');
        reject(new Error(`Timed out waiting for daemon message. Received:\n${eventsSummary}`));
      }, timeoutMs);
      waiters.push({ predicate, reject, resolve: (message) => { clearTimeout(timer); resolve(message); } });
    });
  };
  return {
    async authenticate(value = credential) {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(`${JSON.stringify({ kind: 'authenticate', credential: value })}\n`);
      await next((message) => message.kind === 'authenticated');
    },
    request(command, payload = {}) {
      const requestId = `request-${Math.random()}`;
      socket.write(`${JSON.stringify({ protocolVersion: 1, kind: 'request', requestId, command, payload })}\n`);
      return next((message) => (message.kind === 'response' || message.kind === 'error') && message.requestId === requestId).then((res) => {
        if (res.kind === 'error') throw new Error(`Daemon error: ${res.code} - ${res.message}`);
        return res;
      });
    },
    next,
    events: messages,
    lastSequence() {
      return Math.max(0, ...messages.map((m) => m.sequence ?? 0));
    },
    async close() {
      socket.end();
      await new Promise((resolve) => socket.once('close', resolve));
    },
  };
}

describe('session daemon agent turn end-to-end with real SDK', () => {
  let daemon;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
  });

  it('runs prompt turn, tool execution with render, nested tool filtering, persistence, and queueing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-turn-e2e-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(join(agentDir, 'extensions', 'turn-extension.ts'), TURN_EXTENSION);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      defaultProvider: 'turn-mock-provider',
      defaultModel: 'turn-mock-model',
    }));

    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\pichamber-turn-e2e-${Date.now()}`
      : join(root, 'daemon.sock');

    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();

    // 1. extensions.list contains the custom extension and no builtin: extensions
    const extList = await client.request('extensions.list', {});
    expect(extList.result.extensions.map((e) => e.name)).toContain('turn-extension');
    const builtinExts = extList.result.extensions.filter((e) => e.name.startsWith('builtin:'));
    expect(builtinExts).toHaveLength(0);
    // The Pi CLI's built-in extensions (mcp, codemode, tool-search) are not
    // loaded for SDK sessions, so their commands are absent too.
    expect(extList.result.commands.map((command) => command.name)).not.toContain('mcp');

    // 2. Create session
    const created = await client.request('sessions.create', { cwd: projectDir });
    const sessionId = created.result.session.id;
    expect(sessionId).toBeTruthy();

    // 3. Prompt acceptance: preflight disposition resolves immediately
    const seq0 = client.lastSequence();
    const userStartPromise = client.next((m) => m.sequence > seq0 && m.event === 'assistant.message.start' && m.payload?.role === 'user');
    const assistantStartPromise = client.next((m) => m.sequence > seq0 && m.event === 'assistant.message.start' && m.payload?.role === 'assistant');
    const deltaPromise = client.next((m) => m.sequence > seq0 && m.event === 'assistant.message.delta');
    const assistantEndPromise = client.next((m) => m.sequence > seq0 && m.event === 'assistant.message.end');
    const settledPromise0 = client.next((m) => m.sequence > seq0 && m.event === 'session.lifecycle' && m.payload?.state === 'idle');

    const promptResponse = await client.request('sessions.prompt', {
      sessionId,
      text: 'hello turn test',
    });
    expect(promptResponse.result).toMatchObject({ accepted: true });

    // 4. Turn streaming events and usage sanitation
    await userStartPromise;
    const assistantStart = await assistantStartPromise;
    expect(assistantStart.payload.role).toBe('assistant');
    const delta = await deltaPromise;
    expect(delta.payload.delta).toBeTruthy();
    const assistantEnd = await assistantEndPromise;
    expect(assistantEnd.payload.text).toBe('Reply: hello turn test');
    expect(assistantEnd.payload.usage).toMatchObject({
      input: expect.any(Number),
      output: expect.any(Number),
      totalTokens: expect.any(Number),
      cost: {
        input: expect.any(Number),
        output: expect.any(Number),
        total: expect.any(Number),
      },
    });
    await settledPromise0;

    // 5. Session file persistence: JSONL exists after first prompt
    const sessionDir = getPiSessionDirectory({ cwd: projectDir, agentDir });
    const sessionFiles = (await readdir(sessionDir)).filter((name) => name.endsWith('.jsonl'));
    expect(sessionFiles).toHaveLength(1);
    expect(sessionFiles[0]).toContain(sessionId);
    const opened = await client.request('sessions.open', { sessionId });
    expect(opened.result.session.id).toBe(sessionId);
    expect(opened.result.messages.length).toBeGreaterThanOrEqual(2);
    expect(opened.result.messages[0].message.role).toBe('user');
    expect(opened.result.messages[0].message.text).toBe('hello turn test');
    expect(opened.result.messages[1].message.role).toBe('assistant');
    expect(opened.result.messages[1].message.text).toBe('Reply: hello turn test');

    // 6. Tool execution with renderCall and renderResult
    const seq1 = client.lastSequence();
    const toolStartPromise = client.next((m) => m.sequence > seq1 && m.event === 'session.tool.start' && m.payload?.partId?.includes('call-echo-1'));
    const toolEndPromise = client.next((m) => m.sequence > seq1 && m.event === 'session.tool.end' && m.payload?.partId?.includes('call-echo-1'));
    const echoSettledPromise = client.next((m) => m.sequence > seq1 && m.event === 'session.lifecycle' && m.payload?.state === 'idle');

    await client.request('sessions.prompt', {
      sessionId,
      text: 'run echo tool',
    });

    const toolStart = await toolStartPromise;
    expect(toolStart.payload.render?.call).toBeDefined();
    expect(toolStart.payload.render.call[0]).toContain('[calling echo echo payload]');
    expect(toolStart.payload.render.call[0]).toContain('\x1b[38;2;1;1;');

    const toolEnd = await toolEndPromise;
    expect(toolEnd.payload.state).toBe('completed');
    expect(toolEnd.payload.render?.result).toBeDefined();
    expect(toolEnd.payload.render.result[0]).toContain('[echo result: echo:echo payload]');
    expect(toolEnd.payload.render.result[0]).toContain('\x1b[38;2;1;1;');
    await echoSettledPromise;

    // 7. Nested tool execution via ctx.executeTool() skips nested events
    const seq2 = client.lastSequence();
    const parentToolStartPromise = client.next((m) => m.sequence > seq2 && m.event === 'session.tool.start' && m.payload?.partId?.includes('call-nested-1'));
    const parentToolEndPromise = client.next((m) => m.sequence > seq2 && m.event === 'session.tool.end' && m.payload?.partId?.includes('call-nested-1'));
    const nestedSettledPromise = client.next((m) => m.sequence > seq2 && m.event === 'session.lifecycle' && m.payload?.state === 'idle');

    await client.request('sessions.prompt', {
      sessionId,
      text: 'run nested tool',
    });

    await parentToolStartPromise;
    const parentToolEnd = await parentToolEndPromise;
    expect(parentToolEnd.payload.state).toBe('completed');
    expect(parentToolEnd.payload.render?.result[0]).toContain('nested-wrap:echo:sub-nested payload');
    await nestedSettledPromise;
    // The nested echo_tool call ran (its output is in the parent result) but
    // every published tool event belongs to the model-issued parent call.
    const nestedTurnToolEvents = client.events.filter((m) => m.sequence > seq2 && typeof m.event === 'string' && m.event.startsWith('session.tool.'));
    expect(nestedTurnToolEvents.filter((m) => m.event === 'session.tool.start')).toHaveLength(1);
    expect(nestedTurnToolEvents.filter((m) => m.event === 'session.tool.end')).toHaveLength(1);
    for (const toolEvent of nestedTurnToolEvents) {
      expect(toolEvent.payload.partId.endsWith(':tool:call-nested-1')).toBe(true);
    }
    expect(client.events.some((m) => m.sequence > seq2 && m.event === 'session.error')).toBe(false);

    // 8. Steer and followUp queued while streaming
    const seq3 = client.lastSequence();
    const slowPrompt = client.request('sessions.prompt', {
      sessionId,
      text: 'slow prompt',
    });
    // Wait until streaming starts
    await client.next((m) => m.sequence > seq3 && m.event === 'session.lifecycle' && m.payload?.state === 'busy');

    // Send followUp and steer while streaming
    const followUpResponse = await client.request('sessions.followUp', {
      sessionId,
      text: 'queued follow-up',
    });
    expect(followUpResponse.result).toMatchObject({ accepted: true });
    const steerResponse = await client.request('sessions.steer', {
      sessionId,
      text: 'queued steer',
    });
    expect(steerResponse.result).toMatchObject({ accepted: true });

    await slowPrompt;
    // Both queued inputs are delivered after the slow reply and each gets a turn.
    await client.next((m) => m.sequence > seq3 && m.event === 'assistant.message.end' && m.payload?.text === 'First queued reply');
    await client.next((m) => m.sequence > seq3 && m.event === 'assistant.message.end' && m.payload?.text === 'Second queued reply');
    const lastReply = client.events.find((m) => m.sequence > seq3 && m.event === 'assistant.message.end' && m.payload?.text === 'Second queued reply');
    await client.next((m) => m.sequence > lastReply.sequence && m.event === 'session.lifecycle' && m.payload?.state === 'idle');
    const afterQueue = await client.request('sessions.open', { sessionId });
    const userTexts = afterQueue.result.messages.filter((item) => item.message.role === 'user').map((item) => item.message.text);
    expect(userTexts).toEqual(['hello turn test', 'run echo tool', 'run nested tool', 'slow prompt', 'queued steer', 'queued follow-up']);
    expect(client.events.some((m) => m.event === 'session.error')).toBe(false);

    await client.close();
  }, 120_000);

  it('rejects a first prompt with no usable model and persists nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-turn-e2e-reject-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\pichamber-turn-e2e-reject-${Date.now()}`
      : join(root, 'daemon.sock');

    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    const created = await client.request('sessions.create', { cwd: projectDir });
    const sessionId = created.result.session.id;

    // The SDK rejects before preflight: the callback never fires and the
    // prompt promise rejects. The daemon answers with an error frame and
    // closes that connection, so send on a dedicated one.
    const sender = connectClient(endpoint);
    await sender.authenticate();
    const outcome = sender.next((m) => m.kind === 'error' || m.kind === 'response');
    sender.request('sessions.prompt', { sessionId, text: 'hello without a model' }).catch(() => {});
    const frame = await outcome;
    expect(frame.kind).toBe('error');
    expect(frame.result).toBeUndefined();

    expect(client.events.some((m) => m.event === 'assistant.message.start')).toBe(false);
    const sessionDir = getPiSessionDirectory({ cwd: projectDir, agentDir });
    const sessionFiles = await readdir(sessionDir).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    expect(sessionFiles.filter((name) => name.endsWith('.jsonl'))).toHaveLength(0);

    await client.close();
  }, 60_000);

  it('opens a stored session with context_edit and usage entries as plain user and assistant rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-turn-e2e-entries-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    const sessionDir = getPiSessionDirectory({ cwd: projectDir, agentDir });
    await mkdir(sessionDir, { recursive: true });
    const timestamp = '2026-09-25T12:00:00.000Z';
    const sessionId = '5d0c1f0e-6a55-4f0e-9d0a-3b8b3d5a7c11';
    const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const entries = [
      { type: 'session', version: 3, id: sessionId, timestamp, cwd: projectDir },
      { type: 'message', id: '00000001', parentId: null, timestamp, message: { role: 'user', content: 'What is 2+2?', timestamp: Date.parse(timestamp) } },
      { type: 'message', id: '00000002', parentId: '00000001', timestamp, message: {
        role: 'assistant', content: [{ type: 'text', text: '4' }], provider: 'opencode', model: 'deepseek-v4-flash', api: 'openai-completions', stopReason: 'stop', timestamp: Date.parse(timestamp), usage,
      } },
      { type: 'context_edit', id: '00000003', parentId: '00000002', timestamp, targetId: '00000001', replacement: null },
      { type: 'usage', id: '00000004', parentId: '00000003', timestamp, kind: 'cache_warm', provider: 'opencode', model: 'deepseek-v4-flash', usage },
    ];
    await writeFile(join(sessionDir, `2026-09-25T12-00-00-000Z_${sessionId}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\pichamber-turn-e2e-entries-${Date.now()}`
      : join(root, 'daemon.sock');
    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    const opened = await client.request('sessions.open', { sessionId, cwd: projectDir });
    // The context edit changes what the model sees, not the stored history,
    // and neither entry type is a transcript row.
    expect(opened.result.messages.map((item) => [item.message.role, item.message.text])).toEqual([
      ['user', 'What is 2+2?'],
      ['assistant', '4'],
    ]);

    await client.close();
  }, 60_000);
});
