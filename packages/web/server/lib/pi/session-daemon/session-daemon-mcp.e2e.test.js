import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionDaemon } from './session-daemon.js';

const credential = 'mcp-e2e-daemon-credential';

const FIXTURE_SERVER_SCRIPT = `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const pidFile = process.env.MCP_PID_FILE;
if (pidFile) {
  try {
    writeFileSync(pidFile, String(process.pid));
  } catch {}
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }
  if (!('id' in message)) continue;
  let result;
  if (message.method === 'initialize') {
    result = {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture-server', version: '1.0.0' },
    };
  } else if (message.method === 'tools/list') {
    result = {
      tools: [
        {
          name: 'echo',
          description: 'Echoes input with a fixture prefix',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' }, delayMs: { type: 'number' } },
            required: ['text'],
          },
        },
      ],
    };
  } else if (message.method === 'tools/call') {
    const text = message.params?.arguments?.text ?? '';
    const delayMs = Number(message.params?.arguments?.delayMs) || 0;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = {
      content: [{ type: 'text', text: \`fixture-echo:\${text}\` }],
    };
  } else if (message.method === 'resources/list') {
    result = { resources: [] };
  } else if (message.method === 'prompts/list') {
    result = { prompts: [] };
  } else if (message.method === 'ping') {
    result = {};
  } else {
    process.stdout.write(\`\${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })}\\n\`);
    continue;
  }
  process.stdout.write(\`\${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\\n\`);
}
`;

function createFauxExtension(responsesCode, provider = 'mcp-mock-provider', model = 'mcp-mock-model') {
  return `
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';

export default function (pi) {
  const faux = fauxProvider({
    provider: '${provider}',
    models: [{
      id: '${model}',
      name: '${model}',
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16384,
      maxTokens: 2048,
    }],
    tokensPerSecond: 200,
  });

  faux.setResponses(${responsesCode});

  pi.registerProvider(faux.provider);
}
`;
}

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
    close() {
      socket.destroy();
    },
  };
}

async function waitForProcessExit(pid, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch (error) {
      if (error?.code === 'ESRCH') return true;
      throw error;
    }
  }
  return false;
}

describe('session daemon MCP and built-in extensions end-to-end with real SDK', () => {
  let daemon;
  let client;
  let originalAgentDirEnv;

  afterEach(async () => {
    if (originalAgentDirEnv !== undefined) {
      process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
      originalAgentDirEnv = undefined;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    client?.close();
    client = undefined;
    await daemon?.stop();
    daemon = undefined;
  });

  it('loads direct MCP server, executes tool with renderCall/renderResult, and stops process on shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-mcp-direct-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    const pidFile = join(root, 'fixture.pid');
    const fixtureServerPath = join(root, 'fixture-server.mjs');

    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    await mkdir(projectDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(fixtureServerPath, FIXTURE_SERVER_SCRIPT);

    const responsesCode = `[
      fauxAssistantMessage([fauxToolCall('mcp__fixture__echo', { text: 'direct-payload' }, { id: 'call-direct-1' })], { stopReason: 'toolUse' }),
      (context) => {
        const lastMsg = context.messages[context.messages.length - 1];
        const resText = lastMsg?.content?.[0]?.text ?? '';
        return fauxAssistantMessage('Direct completed: ' + resText);
      },
    ]`;
    await writeFile(join(agentDir, 'extensions', 'mcp-direct-provider.ts'), createFauxExtension(responsesCode, 'mcp-direct-provider', 'mcp-direct-model'));

    await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        fixture: {
          command: 'node',
          args: [fixtureServerPath],
          env: {
            MCP_PID_FILE: pidFile,
          },
          exposure: 'direct',
        },
      },
    }));

    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      defaultProvider: 'mcp-direct-provider',
      defaultModel: 'mcp-direct-model',
    }));

    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\pichamber-mcp-direct-${Date.now()}`
      : join(root, 'daemon.sock');

    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();

    client = connectClient(endpoint);
    await client.authenticate();

    // 1. extensions.list includes builtin:mcp, builtin:codemode, builtin:tool-search and mcp command
    const extList = await client.request('extensions.list', {});
    const extNames = extList.result.extensions.map((e) => e.name);
    expect(extNames).toContain('builtin:mcp');
    expect(extNames).toContain('builtin:codemode');
    expect(extNames).toContain('builtin:tool-search');
    expect(extList.result.commands.map((c) => c.name)).toContain('mcp');

    // 2. Create session and run direct tool turn
    const created = await client.request('sessions.create', {
      cwd: projectDir,
      model: { providerId: 'mcp-direct-provider', modelId: 'mcp-direct-model' },
    });
    const sessionId = created.result.session.id;

    const seq0 = client.lastSequence();
    const toolStartPromise = client.next((m) => m.sequence > seq0 && m.event === 'session.tool.start');
    const toolEndPromise = client.next((m) => m.sequence > seq0 && m.event === 'session.tool.end');
    const assistantEndPromise = client.next((m) => m.sequence > seq0 && m.event === 'assistant.message.end' && Boolean(m.payload?.text));
    const settledPromise = client.next((m) => m.sequence > seq0 && m.event === 'session.lifecycle' && m.payload?.state === 'idle');

    await client.request('sessions.prompt', {
      sessionId,
      text: 'call direct tool',
    });

    const toolStart = await toolStartPromise;
    expect(toolStart.payload.toolCallId).toBe('call-direct-1');
    expect(toolStart.payload.render?.call).toBeDefined();

    const toolEnd = await toolEndPromise;
    expect(toolEnd.payload.toolCallId).toBe('call-direct-1');
    expect(toolEnd.payload.state).toBe('completed');
    expect(toolEnd.payload.render?.result).toBeDefined();
    const resultRenderText = toolEnd.payload.render.result.join('\n');
    expect(resultRenderText).toContain('fixture-echo:direct-payload');

    const assistantEnd = await assistantEndPromise;
    expect(assistantEnd.payload.text).toBe('Direct completed: fixture-echo:direct-payload');
    await settledPromise;

    // Assert exactly one tool start and one tool end
    const toolStarts = client.events.filter((m) => m.event === 'session.tool.start');
    const toolEnds = client.events.filter((m) => m.event === 'session.tool.end');
    expect(toolStarts).toHaveLength(1);
    expect(toolEnds).toHaveLength(1);

    // No session error
    const errors = client.events.filter((m) => m.event === 'session.error');
    expect(errors).toHaveLength(0);

    // `/mcp` takes its non-TUI path and reports server status as a notification.
    const seq1 = client.lastSequence();
    const statusPromise = client.next((m) => m.sequence > seq1 && m.event === 'extension.notify');
    await client.request('sessions.prompt', { sessionId, text: '/mcp' });
    const status = await statusPromise;
    expect(status.payload.message).toContain('fixture: connected, 1 tools (direct)');
    expect(client.events.filter((m) => m.event === 'session.error')).toHaveLength(0);

    // Stop daemon and verify child process pid has exited
    client.close();
    client = undefined;
    await daemon.stop();
    daemon = undefined;

    const pidText = await readFile(pidFile, 'utf8');
    const pid = parseInt(pidText.trim(), 10);
    expect(Number.isInteger(pid)).toBe(true);
    const exited = await waitForProcessExit(pid);
    expect(exited).toBe(true);
  }, 25_000);

  it('runs codemode exposure tool call with nested calls listed in parent row and no nested rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-mcp-codemode-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    const fixtureServerPath = join(root, 'fixture-server.mjs');

    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    await mkdir(projectDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(fixtureServerPath, FIXTURE_SERVER_SCRIPT);

    const responsesCode = `[
      fauxAssistantMessage([fauxToolCall('codemode', {
        code: "const res = await tools.mcp__fixture__echo({ text: 'nested-codemode-payload', delayMs: 700 }); return 'script-result:' + res.content[0].text;"
      }, { id: 'call-codemode-1' })], { stopReason: 'toolUse' }),
      (context) => {
        const lastMsg = context.messages[context.messages.length - 1];
        const resText = Array.isArray(lastMsg?.content) ? lastMsg.content.map((c) => c.text || '').join(' ') : (lastMsg?.content || '');
        return fauxAssistantMessage('Codemode turn finished: ' + resText);
      },
    ]`;
    await writeFile(join(agentDir, 'extensions', 'mcp-codemode-provider.ts'), createFauxExtension(responsesCode, 'mcp-codemode-provider', 'mcp-codemode-model'));

    await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        fixture: {
          command: 'node',
          args: [fixtureServerPath],
          exposure: 'codemode',
        },
      },
    }));

    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      defaultProvider: 'mcp-codemode-provider',
      defaultModel: 'mcp-codemode-model',
    }));

    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\pichamber-mcp-codemode-${Date.now()}`
      : join(root, 'daemon.sock');

    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();

    client = connectClient(endpoint);
    await client.authenticate();

    await client.request('extensions.list', {});

    const created = await client.request('sessions.create', {
      cwd: projectDir,
      model: { providerId: 'mcp-codemode-provider', modelId: 'mcp-codemode-model' },
    });
    const sessionId = created.result.session.id;

    const seq0 = client.lastSequence();
    const toolStartPromise = client.next((m) => m.sequence > seq0 && m.event === 'session.tool.start');
    const toolEndPromise = client.next((m) => m.sequence > seq0 && m.event === 'session.tool.end');
    const assistantEndPromise = client.next((m) => m.sequence > seq0 && m.event === 'assistant.message.end' && Boolean(m.payload?.text));
    const settledPromise = client.next((m) => m.sequence > seq0 && m.event === 'session.lifecycle' && m.payload?.state === 'idle');

    await client.request('sessions.prompt', {
      sessionId,
      text: 'run codemode script',
    });

    const toolStart = await toolStartPromise;
    expect(toolStart.payload.toolCallId).toBe('call-codemode-1');
    expect(toolStart.payload.render?.call).toBeDefined();

    const toolEnd = await toolEndPromise;
    expect(toolEnd.payload.toolCallId).toBe('call-codemode-1');
    expect(toolEnd.payload.state).toBe('completed');
    expect(toolEnd.payload.render?.result).toBeDefined();

    // Rendered result lists the nested call and script output
    const resultText = toolEnd.payload.render.result.join('\n');
    expect(resultText).toContain('mcp__fixture__echo');
    expect(resultText).toContain('script-result:fixture-echo:nested-codemode-payload');

    const assistantEnd = await assistantEndPromise;
    expect(assistantEnd.payload.text).toContain('script-result:fixture-echo:nested-codemode-payload');
    await settledPromise;

    // While the script runs, the codemode row itself shows the nested call as
    // in progress. The nested call takes longer than the render throttle.
    const liveRenders = client.events
      .filter((m) => m.event === 'session.tool.update' && m.payload?.toolCallId === 'call-codemode-1' && m.payload?.render?.result)
      .map((m) => m.payload.render.result.join('\n'));
    expect(liveRenders.some((text) => text.includes('mcp__fixture__echo') && text.includes('…'))).toBe(true);
    expect(liveRenders.every((text) => !text.includes('script-result:'))).toBe(true);

    // Exactly one tool start and end for the entire turn (nested calls skipped as separate rows)
    const toolStarts = client.events.filter((m) => m.event === 'session.tool.start');
    const toolEnds = client.events.filter((m) => m.event === 'session.tool.end');
    expect(toolStarts).toHaveLength(1);
    expect(toolEnds).toHaveLength(1);

    const errors = client.events.filter((m) => m.event === 'session.error');
    expect(errors).toHaveLength(0);
  }, 25_000);

  it('runs tool_search with deferred MCP server and calls discovered tool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-mcp-deferred-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    const fixtureServerPath = join(root, 'fixture-server.mjs');

    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    await mkdir(projectDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(fixtureServerPath, FIXTURE_SERVER_SCRIPT);

    const responsesCode = `[
      fauxAssistantMessage([fauxToolCall('tool_search', { query: 'echo' }, { id: 'call-search-1' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('mcp__fixture__echo', { text: 'search-payload' }, { id: 'call-echo-after-search-1' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Search and call turn complete'),
    ]`;
    await writeFile(join(agentDir, 'extensions', 'mcp-deferred-provider.ts'), createFauxExtension(responsesCode, 'mcp-deferred-provider', 'mcp-deferred-model'));

    await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        fixture: {
          command: 'node',
          args: [fixtureServerPath],
          exposure: 'deferred',
        },
      },
    }));

    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      defaultProvider: 'mcp-deferred-provider',
      defaultModel: 'mcp-deferred-model',
    }));

    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\pichamber-mcp-deferred-${Date.now()}`
      : join(root, 'daemon.sock');

    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();

    client = connectClient(endpoint);
    await client.authenticate();

    await client.request('extensions.list', {});

    const created = await client.request('sessions.create', {
      cwd: projectDir,
      model: { providerId: 'mcp-deferred-provider', modelId: 'mcp-deferred-model' },
    });
    const sessionId = created.result.session.id;

    const seq0 = client.lastSequence();
    const searchStartPromise = client.next((m) => m.sequence > seq0 && m.event === 'session.tool.start' && m.payload?.toolCallId === 'call-search-1');
    const searchEndPromise = client.next((m) => m.sequence > seq0 && m.event === 'session.tool.end' && m.payload?.toolCallId === 'call-search-1');
    const echoStartPromise = client.next((m) => m.sequence > seq0 && m.event === 'session.tool.start' && m.payload?.toolCallId === 'call-echo-after-search-1');
    const echoEndPromise = client.next((m) => m.sequence > seq0 && m.event === 'session.tool.end' && m.payload?.toolCallId === 'call-echo-after-search-1');
    const settledPromise = client.next((m) => m.sequence > seq0 && m.event === 'session.lifecycle' && m.payload?.state === 'idle');

    await client.request('sessions.prompt', {
      sessionId,
      text: 'search and run tool',
    });

    await searchStartPromise;
    const searchEnd = await searchEndPromise;
    expect(searchEnd.payload.state).toBe('completed');

    await echoStartPromise;
    const echoEnd = await echoEndPromise;
    expect(echoEnd.payload.state).toBe('completed');
    const echoRenderText = echoEnd.payload.render?.result?.join('\n') ?? '';
    expect(echoRenderText).toContain('fixture-echo:search-payload');

    await settledPromise;

    const errors = client.events.filter((m) => m.event === 'session.error');
    expect(errors).toHaveLength(0);
  }, 25_000);

  it('disables builtin:mcp when configured in settings.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-mcp-disabled-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');

    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });

    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      extensions: ['-builtin:mcp'],
    }));

    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\pichamber-mcp-disabled-${Date.now()}`
      : join(root, 'daemon.sock');

    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();

    client = connectClient(endpoint);
    await client.authenticate();

    const extList = await client.request('extensions.list', {});
    const extNames = extList.result.extensions.map((e) => e.name);
    expect(extNames).not.toContain('builtin:mcp');
    expect(extNames).toContain('builtin:codemode');
    expect(extNames).toContain('builtin:tool-search');
    expect(extList.result.commands.map((c) => c.name)).not.toContain('mcp');
  }, 25_000);

  it('lets an installed extension that registers /mcp replace the built-in MCP extension', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-mcp-replaced-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');

    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    await mkdir(projectDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(join(agentDir, 'extensions', 'other-mcp.ts'), `
export default function (pi) {
  pi.registerCommand('mcp', {
    description: 'Third-party MCP command',
    handler: async (_args, ctx) => { ctx.ui.notify('third-party mcp', 'info'); },
  });
}
`);

    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\pichamber-mcp-replaced-${Date.now()}`
      : join(root, 'daemon.sock');

    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();

    client = connectClient(endpoint);
    await client.authenticate();

    const extList = await client.request('extensions.list', {});
    const extNames = extList.result.extensions.map((e) => e.name);
    expect(extNames).toContain('other-mcp');
    expect(extNames).not.toContain('builtin:mcp');
    expect(extNames).toContain('builtin:codemode');
    expect(extNames).toContain('builtin:tool-search');
    const mcpCommands = extList.result.commands.filter((c) => c.name === 'mcp');
    expect(mcpCommands).toHaveLength(1);
    expect(mcpCommands[0].description).toBe('Third-party MCP command');
  }, 25_000);

  it('handles broken MCP server command without breaking normal prompt turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-mcp-broken-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');

    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    await mkdir(projectDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });

    const responsesCode = `[
      fauxAssistantMessage('Normal reply from broken server environment'),
    ]`;
    await writeFile(join(agentDir, 'extensions', 'mcp-broken-provider.ts'), createFauxExtension(responsesCode, 'mcp-broken-provider', 'mcp-broken-model'));

    await writeFile(join(agentDir, 'mcp.json'), JSON.stringify({
      mcpServers: {
        broken: {
          command: 'nonexistent-command-xyz-12345',
        },
      },
    }));

    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      defaultProvider: 'mcp-broken-provider',
      defaultModel: 'mcp-broken-model',
    }));

    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\pichamber-mcp-broken-${Date.now()}`
      : join(root, 'daemon.sock');

    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();

    client = connectClient(endpoint);
    await client.authenticate();

    await client.request('extensions.list', {});

    const created = await client.request('sessions.create', {
      cwd: projectDir,
      model: { providerId: 'mcp-broken-provider', modelId: 'mcp-broken-model' },
    });
    const sessionId = created.result.session.id;

    const seq0 = client.lastSequence();
    const assistantEndPromise = client.next((m) => m.sequence > seq0 && m.event === 'assistant.message.end');
    const settledPromise = client.next((m) => m.sequence > seq0 && m.event === 'session.lifecycle' && m.payload?.state === 'idle');

    await client.request('sessions.prompt', {
      sessionId,
      text: 'hello broken test',
    });

    const assistantEnd = await assistantEndPromise;
    expect(assistantEnd.payload.text).toBe('Normal reply from broken server environment');
    await settledPromise;
  }, 25_000);
});
