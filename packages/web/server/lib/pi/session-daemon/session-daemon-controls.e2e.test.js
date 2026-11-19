import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionDaemon } from './session-daemon.js';

// Real SDK: a plain Pi extension declares a composer control on `pi.events`;
// the daemon keeps it in the session snapshot, and `extensions.control` runs
// the extension's own command for the value asked for. The extension then
// reports the new value itself. No model is called.

const credential = 'controls-e2e-daemon-credential';

const MODES_EXTENSION = `
export default function (pi) {
  let mode = 'economy';
  const declare = () => pi.events.emit('pichamber:composer', {
    id: 'mode',
    kind: 'cycle',
    label: 'Mode',
    value: mode,
    options: [
      { value: 'economy', label: 'Economy', command: 'economy' },
      { value: 'balance', label: 'Balance', command: 'balance' },
    ],
  });
  for (const name of ['economy', 'balance']) {
    pi.registerCommand(name, {
      description: 'Switch to ' + name + ' mode',
      handler: async (args) => {
        mode = name;
        globalThis.__controlsE2eArgs = args;
        globalThis.__controlsE2eRuns = (globalThis.__controlsE2eRuns ?? 0) + 1;
        declare();
      },
    });
  }
  pi.on('session_start', () => {
    declare();
    // A control whose command nobody registered never runs.
    pi.events.emit('pichamber:composer', { id: 'ghost', kind: 'action', label: 'Ghost', command: 'not-registered' });
  });
}
`;

function connectClient(endpoint) {
  const socket = createConnection({ path: endpoint });
  let buffer = '';
  const messages = [];
  const waiters = [];
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      messages.push(message);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (waiters[index].predicate(message)) waiters.splice(index, 1)[0].resolve(message);
      }
    }
  });
  const next = (predicate, timeoutMs = 20_000) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for a daemon message.')), timeoutMs);
      waiters.push({ predicate, resolve: (message) => { clearTimeout(timer); resolve(message); } });
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
    async request(command, payload = {}) {
      const requestId = `request-${Math.random()}`;
      socket.write(`${JSON.stringify({ protocolVersion: 1, kind: 'request', requestId, command, payload })}\n`);
      // The daemon answers a failed request with an error frame without a
      // request id and closes the socket (one request per connection).
      const response = await next((message) => (message.kind === 'response' && message.requestId === requestId) || message.kind === 'error');
      if (response.kind === 'error') throw new Error(`Daemon error: ${response.error?.code}`);
      return response.result;
    },
    next,
    lastSequence: () => Math.max(0, ...messages.map((message) => message.sequence ?? 0)),
    async close() {
      socket.end();
      await new Promise((resolve) => socket.once('close', resolve));
    },
  };
}

describe('session daemon composer controls end-to-end with real SDK', () => {
  let daemon;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    delete globalThis.__controlsE2eRuns;
    delete globalThis.__controlsE2eArgs;
  });

  it('keeps a declared control and runs its command for a click', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-controls-e2e-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(join(agentDir, 'extensions', 'modes.ts'), MODES_EXTENSION);
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\pichamber-controls-e2e-${Date.now()}` : join(root, 'daemon.sock');

    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();

    const health = await client.request('runtime.health');
    expect(health.capabilities).toContain('extensions.control');

    const created = await client.request('sessions.create', { cwd: projectDir });
    const sessionId = created.session.id;
    const opened = await client.request('sessions.open', { sessionId });
    expect(opened.extensionControls).toEqual([
      expect.objectContaining({ id: 'mode', kind: 'cycle', value: 'economy' }),
      expect.objectContaining({ id: 'ghost', kind: 'action', command: 'not-registered' }),
    ]);

    // The listener is PiChamber's own, not one of the user's extensions.
    const listed = await client.request('extensions.list', { directory: projectDir });
    expect(listed.extensions.map((extension) => extension.name).join(' ')).not.toContain('composer-controls');

    const sequence = client.lastSequence();
    const updated = client.next((message) => message.sequence > sequence && message.event === 'extension.control'
      && message.payload?.control?.id === 'mode' && message.payload.control.value === 'balance');
    await expect(client.request('extensions.control', { sessionId, id: 'mode', value: 'balance' })).resolves.toEqual({ ran: true });
    await updated;
    expect(globalThis.__controlsE2eRuns).toBe(1);
    expect((await client.request('sessions.open', { sessionId })).extensionControls[0]).toMatchObject({ value: 'balance' });

    // Asking for the value it already has runs nothing.
    await expect(client.request('extensions.control', { sessionId, id: 'mode', value: 'balance' })).resolves.toEqual({ ran: false });
    await expect(client.request('extensions.control', { sessionId, id: 'gone', value: 'balance' })).resolves.toEqual({ ran: false });
    expect(globalThis.__controlsE2eRuns).toBe(1);

    // Nothing reached the transcript.
    expect((await client.request('sessions.open', { sessionId })).messages ?? []).toEqual([]);
    await client.close();

    const failing = async (payload, code) => {
      const fresh = connectClient(endpoint);
      await fresh.authenticate();
      await expect(fresh.request('extensions.control', payload)).rejects.toThrow(code);
    };
    await failing({ sessionId, id: 'mode', value: 'turbo' }, 'INVALID_ARGUMENT');
    await failing({ sessionId, id: 'ghost' }, 'CONTROL_UNAVAILABLE');
    expect(globalThis.__controlsE2eRuns).toBe(1);
  }, 60_000);

  it('runs a card action\'s command by the same rule, and refuses one nobody registered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-controls-e2e-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(join(agentDir, 'extensions', 'modes.ts'), MODES_EXTENSION);
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\pichamber-command-e2e-${Date.now()}` : join(root, 'daemon.sock');

    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();
    expect((await client.request('runtime.health')).capabilities).toContain('extensions.command');

    const created = await client.request('sessions.create', { cwd: projectDir });
    const sessionId = created.session.id;
    await client.request('sessions.open', { sessionId });

    // A leading `/` is allowed, as in a composer control; args arrive as one line.
    await expect(client.request('extensions.command', { sessionId, command: '/balance', args: ' fast\nplease ' }))
      .resolves.toEqual({ ran: true });
    expect(globalThis.__controlsE2eRuns).toBe(1);
    expect(globalThis.__controlsE2eArgs).toBe('fast please');
    // Nothing reached the transcript.
    expect((await client.request('sessions.open', { sessionId })).messages ?? []).toEqual([]);
    await client.close();

    const failing = async (payload, code) => {
      const fresh = connectClient(endpoint);
      await fresh.authenticate();
      await expect(fresh.request('extensions.command', payload)).rejects.toThrow(code);
    };
    // Never sent to the model as a prompt.
    await failing({ sessionId, command: 'not-registered' }, 'COMMAND_UNAVAILABLE');
    await failing({ sessionId, command: 'a/b' }, 'INVALID_ARGUMENT');
    await failing({ sessionId, command: 'balance', args: 3 }, 'INVALID_ARGUMENT');
    expect(globalThis.__controlsE2eRuns).toBe(1);
    const check = connectClient(endpoint);
    await check.authenticate();
    expect((await check.request('sessions.open', { sessionId })).messages ?? []).toEqual([]);
    await check.close();
  }, 60_000);

  it('holds a settings change until a running shell command ends, then drops the control', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-controls-e2e-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(join(agentDir, 'extensions', 'modes.ts'), MODES_EXTENSION);
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\pichamber-controls-e2e-${Date.now()}` : join(root, 'daemon.sock');

    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();

    const created = await client.request('sessions.create', { cwd: projectDir });
    const sessionId = created.session.id;
    await client.request('sessions.open', { sessionId });
    const modes = (await client.request('extensions.config.list', {})).extensions.find((entry) => entry.name === 'modes.ts');

    const sequence = client.lastSequence();
    const started = await client.request('sessions.bash', { sessionId, command: 'sleep 1 && echo held' });
    // Turning the extension off recreates every runtime, which would end the command.
    const off = await client.request('extensions.config.set', { id: modes.id, scope: 'global', enabled: false });
    expect(off.deferred).toBe(true);
    const recorded = await client.next((message) => message.sequence > sequence
      && message.event === 'session.bash.recorded' && message.payload?.id === started.id);
    expect(recorded.payload.message.details).toMatchObject({ output: 'held\n', exitCode: 0 });

    // The change applies once the command has ended.
    const loaded = (await client.request('extensions.list', { directory: projectDir })).extensions.map((entry) => entry.name);
    expect(loaded).not.toContain('modes.ts');
    await client.close();

    // The control went with its extension: a late click runs nothing.
    const late = connectClient(endpoint);
    await late.authenticate();
    await late.request('extensions.control', { sessionId, id: 'mode', value: 'balance' }).catch(() => {});
    expect(globalThis.__controlsE2eRuns).toBeUndefined();
  }, 60_000);
});
