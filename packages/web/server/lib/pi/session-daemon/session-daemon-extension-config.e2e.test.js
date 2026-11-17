import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSessionDaemon } from './session-daemon.js';

// Real SDK, temp agent and project dirs, no model provider and no prompt:
// a seeded user extension leaves the live runtime when it is turned off in
// global scope (`extensions.config.set`) and comes back when turned on.

const credential = 'extension-config-e2e-daemon-credential';

const DEMO_EXTENSION = `
export default function (pi) {
  pi.registerCommand('e2e-demo', { description: 'Demo', handler: async () => {} });
}
`;

const VISUALS_ENTRY = fileURLToPath(new URL('../../../../plugins/visuals/extension.js', import.meta.url));

// Shares a tool with the bundled Visuals plugin and a command with Pi's
// built-in MCP extension; both are replaceable, so Pi leaves them out.
const TAKER_EXTENSION = `
export default function (pi) {
  pi.registerTool({ name: 'render_html', label: 'Mine', description: 'Mine', parameters: { type: 'object', properties: {} }, async execute() { return { content: [] }; } });
  pi.registerCommand('mcp', { description: 'Mine', handler: async () => {} });
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
      const response = await next((message) => (message.kind === 'response' && message.requestId === requestId) || message.kind === 'error');
      if (response.kind === 'error') throw Object.assign(new Error(`Daemon error: ${response.error?.code}`), { code: response.error?.code });
      return response.result;
    },
    async close() {
      socket.end();
      await new Promise((resolve) => socket.once('close', resolve));
    },
  };
}

describe('session daemon extension config end-to-end with real SDK', () => {
  let daemon;
  let root;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('turns a user extension off and on in global scope and the runtime follows', async () => {
    root = await mkdtemp(join(tmpdir(), 'pichamber-extension-config-e2e-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(join(agentDir, 'extensions', 'e2e-demo.ts'), DEMO_EXTENSION);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({}));
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\pichamber-extension-config-e2e-${Date.now()}` : join(root, 'daemon.sock');

    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();

    const health = await client.request('runtime.health');
    expect(health.capabilities).toEqual(expect.arrayContaining(['extensions.config.list', 'extensions.config.set', 'extensions.packages.remove']));

    const loadedNames = async () => (await client.request('extensions.list', { directory: projectDir })).extensions.map((entry) => entry.name);
    expect(await loadedNames()).toContain('e2e-demo');

    const listed = await client.request('extensions.config.list', {});
    const demo = listed.extensions.find((entry) => entry.name === 'e2e-demo.ts');
    expect(demo).toMatchObject({ group: 'auto', scope: 'user', global: true });
    expect(JSON.stringify(listed)).not.toContain(root);

    const off = await client.request('extensions.config.set', { id: demo.id, scope: 'global', enabled: false });
    expect(off.extensions.find((entry) => entry.id === demo.id).global).toBe(false);
    expect(off.deferred).toBeUndefined();
    expect(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')).extensions).toEqual(['-extensions/e2e-demo.ts']);
    expect(await loadedNames()).not.toContain('e2e-demo');

    await client.request('extensions.config.set', { id: demo.id, scope: 'global', enabled: true });
    expect(await loadedNames()).toContain('e2e-demo');

    // A project with no saved decision and nothing that needs trust is
    // trusted, as Pi treats it: the override lands in its own settings file.
    const fresh = await client.request('extensions.config.list', { directory: projectDir });
    expect(fresh.project).toEqual({ available: true, trusted: true });
    expect(fresh.extensions.find((entry) => entry.id === demo.id).project).toEqual({ state: 'inherit', inherited: true, enabled: true });
    const overridden = await client.request('extensions.config.set', { id: demo.id, scope: 'project', state: 'unload', directory: projectDir });
    expect(overridden.extensions.find((entry) => entry.id === demo.id)).toMatchObject({
      global: true,
      project: { state: 'unload', inherited: true, enabled: false },
    });
    expect(JSON.parse(await readFile(join(projectDir, '.pi', 'settings.json'), 'utf8')).extensions).toContain(`-${join(agentDir, 'extensions', 'e2e-demo.ts')}`);
    // The answer echoes the caller's directory and nothing else of the server's paths.
    expect(JSON.stringify({ ...overridden, directory: undefined })).not.toContain(root);
    // The project now has settings of its own; it stays trusted on the next read.
    expect((await client.request('extensions.config.list', { directory: projectDir })).project.trusted).toBe(true);

    // A project the user denied is read-only: the global list, no override.
    await client.request('settings.set', { scope: 'project', directory: projectDir, trust: false });
    const denied = await client.request('extensions.config.list', { directory: projectDir });
    expect(denied.project).toEqual({ available: true, trusted: false });
    expect(denied.extensions.every((entry) => entry.project === undefined)).toBe(true);
    await expect(client.request('extensions.config.set', { id: demo.id, scope: 'project', state: 'inherit', directory: projectDir }))
      .rejects.toMatchObject({ code: 'PROJECT_UNTRUSTED' });
  }, 60_000);

  it('reports the plugins and built-ins a live runtime left out, and what took their place', async () => {
    root = await mkdtemp(join(tmpdir(), 'pichamber-extension-config-e2e-'));
    const projectDir = join(root, 'project');
    const otherDir = join(root, 'other');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(otherDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(join(agentDir, 'extensions', 'taker.ts'), TAKER_EXTENSION);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({}));
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\pichamber-extension-config-e2e-${Date.now()}` : join(root, 'daemon.sock');

    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();

    // No runtime is resident in this folder: unknown, and nothing is started.
    const unknown = await client.request('extensions.config.list', { directory: otherDir });
    expect(unknown.replaced).toBeUndefined();

    await client.request('plugins.configure', {
      plugins: [{ id: 'visuals', entry: VISUALS_ENTRY, replaceable: true, state: { global: {} } }],
    });
    // Start the project's runtime, then ask.
    await client.request('extensions.list', { directory: projectDir });
    const listed = await client.request('extensions.config.list', { directory: projectDir });
    const taker = listed.extensions.find((entry) => entry.name === 'taker.ts');
    const mcp = listed.extensions.find((entry) => entry.group === 'builtin' && entry.name === 'mcp');
    expect(taker).toBeDefined();
    expect(mcp).toBeDefined();
    expect(listed.replaced).toEqual(expect.arrayContaining([
      { kind: 'plugin', id: 'visuals', registers: { kind: 'tool', name: 'render_html' }, by: { id: taker.id, name: 'taker.ts' } },
      { kind: 'builtin', id: mcp.id, registers: { kind: 'command', name: 'mcp' }, by: { id: taker.id, name: 'taker.ts' } },
    ]));
    expect(JSON.stringify({ ...listed, directory: undefined })).not.toContain(root);

    // Turning the taker off lets both load again: the field stays, now empty.
    const off = await client.request('extensions.config.set', { id: taker.id, scope: 'global', enabled: false });
    expect(off.replaced).toEqual([]);
    expect(JSON.stringify({ ...off, directory: undefined })).not.toContain(root);
  }, 60_000);
});
