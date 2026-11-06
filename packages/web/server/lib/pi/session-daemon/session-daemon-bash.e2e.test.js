import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionDaemon } from './session-daemon.js';
import { getPiSessionDirectory } from './session-jsonl.js';

const credential = 'bash-e2e-daemon-credential';

// The faux model reports which shell markers reached its context, so the test
// observes Pi's own context rules for `!cmd` (sent) and `!!cmd` (excluded).
const BASH_EXTENSION = `
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';

const contextText = (context) => context.messages.map((message) => (
  typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content) ? message.content.map((part) => part.text || '').join('') : ''
)).join('\\n');

export default function (pi) {
  const faux = fauxProvider({
    provider: 'bash-mock-provider',
    models: [{
      id: 'bash-mock-model',
      name: 'Bash Mock Model',
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16384,
      maxTokens: 2048,
    }],
    tokensPerSecond: 200,
  });
  const report = (context) => {
    const text = contextText(context);
    return fauxAssistantMessage(\`visible=\${text.includes('visible-marker')} hidden=\${text.includes('hidden-marker')}\`);
  };
  faux.setResponses([
    report,
    async (context) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return report(context);
    },
  ]);
  pi.registerProvider(faux.provider);

  pi.on('user_bash', (event) => {
    if (event.command === 'ext-handled') {
      return { result: { output: 'handled by extension\\n', exitCode: 0, cancelled: false, truncated: false } };
    }
    return undefined;
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
        reject(new Error(`Timed out waiting for daemon message. Received:\n${messages.map((m) => JSON.stringify(m)).join('\n')}`));
      }, timeoutMs);
      waiters.push({ predicate, reject, resolve: (message) => { clearTimeout(timer); resolve(message); } });
    });
  };
  return {
    async authenticate() {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(`${JSON.stringify({ kind: 'authenticate', credential })}\n`);
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

describe('session daemon user shell commands with the real SDK', () => {
  let daemon;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
  });

  it('runs, records, defers, excludes, delegates to extensions, and aborts shell commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-bash-e2e-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(join(agentDir, 'extensions', 'bash-extension.ts'), BASH_EXTENSION);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      defaultProvider: 'bash-mock-provider',
      defaultModel: 'bash-mock-model',
    }));
    await writeFile(join(agentDir, 'auth.json'), JSON.stringify({
      'bash-mock-provider': { type: 'api_key', key: 'faux-test-key' },
    }));
    const endpoint = join(root, 'daemon.sock');
    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();

    const created = await client.request('sessions.create', { cwd: projectDir });
    const sessionId = created.result.session.id;

    const runBash = async (command, extra = {}) => {
      const seq = client.lastSequence();
      const response = await client.request('sessions.bash', { sessionId, command, ...extra });
      expect(response.result).toMatchObject({ accepted: true, id: expect.any(String) });
      const recorded = await client.next((m) => m.sequence > seq && m.event === 'session.bash.recorded' && m.payload.id === response.result.id);
      return { id: response.result.id, seq, recorded };
    };

    // 1. A plain command streams output and is recorded with Pi's entry id.
    const plain = await runBash("printf 'visible-marker\\n'");
    expect(client.events.some((m) => m.sequence > plain.seq && m.event === 'session.bash' && m.payload.bash.phase === 'running')).toBe(true);
    expect(client.events.some((m) => m.sequence > plain.seq && m.event === 'session.bash.output' && m.payload.delta?.includes('visible-marker'))).toBe(true);
    expect(plain.recorded.payload.message).toMatchObject({
      customType: 'pichamber.bash',
      details: { command: "printf 'visible-marker\\n'", output: 'visible-marker\n', exitCode: 0 },
    });

    // 2. `!!` is recorded but flagged as excluded.
    const hidden = await runBash("printf 'hidden-marker\\n'", { excludeFromContext: true });
    expect(hidden.recorded.payload.message.details).toMatchObject({ excludeFromContext: true });

    // 3. An extension `user_bash` result replaces local execution.
    const handled = await runBash('ext-handled');
    expect(handled.recorded.payload.message.details).toMatchObject({ output: 'handled by extension\n', exitCode: 0 });

    // 4. Pi's context rules: `!cmd` reaches the model, `!!cmd` does not.
    const seqPrompt = client.lastSequence();
    const reply = client.next((m) => m.sequence > seqPrompt && m.event === 'assistant.message.end');
    await client.request('sessions.prompt', { sessionId, text: 'what ran?' });
    expect((await reply).payload.text).toBe('visible=true hidden=false');
    await client.next((m) => m.sequence > seqPrompt && m.event === 'session.lifecycle' && m.payload?.state === 'idle');

    // 5. A command that finishes during a turn waits for the turn to end.
    const seqSlow = client.lastSequence();
    const slowIdle = client.next((m) => m.sequence > seqSlow && m.event === 'session.lifecycle' && m.payload?.state === 'idle');
    await client.request('sessions.prompt', { sessionId, text: 'slow turn' });
    await client.next((m) => m.sequence > seqSlow && m.event === 'assistant.message.start' && m.payload?.role === 'assistant');
    const deferred = await client.request('sessions.bash', { sessionId, command: 'echo deferred' });
    const completed = await client.next((m) => m.sequence > seqSlow && m.event === 'session.bash' && m.payload.bash.id === deferred.result.id && m.payload.bash.phase === 'completed');
    const deferredRecorded = await client.next((m) => m.sequence > seqSlow && m.event === 'session.bash.recorded' && m.payload.id === deferred.result.id);
    const slowEnd = await client.next((m) => m.sequence > seqSlow && m.event === 'assistant.message.end');
    expect(completed.sequence).toBeLessThan(slowEnd.sequence);
    expect(deferredRecorded.sequence).toBeGreaterThan(slowEnd.sequence);
    await slowIdle;

    // 6. Abort cancels a running command.
    const seqAbort = client.lastSequence();
    const sleeper = await client.request('sessions.bash', { sessionId, command: 'sleep 10' });
    await client.next((m) => m.sequence > seqAbort && m.event === 'session.bash' && m.payload.bash.id === sleeper.result.id && m.payload.bash.phase === 'running');
    await client.request('sessions.abortBash', { sessionId });
    const cancelled = await client.next((m) => m.sequence > seqAbort && m.event === 'session.bash.recorded' && m.payload.id === sleeper.result.id);
    expect(cancelled.payload.message.details).toMatchObject({ cancelled: true });

    // 7. The transcript and the session file hold the authoritative entries.
    const opened = await client.request('sessions.open', { sessionId });
    const shellRows = opened.result.messages
      .filter((entry) => entry.message.customType === 'pichamber.bash')
      .map((entry) => entry.message.details.command);
    expect(shellRows).toEqual([
      "printf 'visible-marker\\n'",
      "printf 'hidden-marker\\n'",
      'ext-handled',
      'echo deferred',
      'sleep 10',
    ]);
    expect(opened.result.bashExecutions).toEqual([]);
    const sessionDir = getPiSessionDirectory({ cwd: projectDir, agentDir });
    const [file] = (await readdir(sessionDir)).filter((name) => name.endsWith('.jsonl'));
    const lines = (await readFile(join(sessionDir, file), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.filter((line) => line.type === 'message' && line.message?.role === 'bashExecution')).toHaveLength(5);

    await client.close();
  }, 60_000);
});
