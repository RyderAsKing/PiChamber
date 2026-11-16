import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSessionDaemon } from './session-daemon.js';

// Real SDK: the bundled plugins load through `plugins.configure`, which
// recreates the runtime. Visuals has no switch: `render_html` is declared and
// runs while the plugin is configured. Sub-agents follows its `on` state: a
// state-only change removes `subagent` from the declared tools without
// recreation, and a session's own value (its composer switch) applies to
// that session only.

const credential = 'plugins-e2e-daemon-credential';
const VISUALS_ENTRY = fileURLToPath(new URL('../../../../plugins/visuals/extension.js', import.meta.url));
const SUBAGENTS_ENTRY = fileURLToPath(new URL('../../../../plugins/subagents/extension.js', import.meta.url));

// Records, per model request, which plugin tools are declared to the model,
// and answers from a script.
const PROVIDER_EXTENSION = `
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';

export default function (pi) {
  const faux = fauxProvider({
    provider: 'plugins-mock-provider',
    models: [{ id: 'plugins-mock-model', name: 'Plugins Mock Model', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 2048 }],
    tokensPerSecond: 1000,
  });
  // System messages declare the tools: the first lists them, later ones add
  // (toolsAdded) or remove (toolsRemoved) declarations.
  const TOOLS = { visuals: /\\brender_html\\b/, subagents: /\\bsubagent\\b/ };
  const NAMES = { visuals: 'render_html', subagents: 'subagent' };
  const record = (context) => {
    const declared = { visuals: false, subagents: false };
    for (const message of context.messages) {
      if (message.role !== 'system') continue;
      for (const key of Object.keys(declared)) {
        if (TOOLS[key].test(String(message.sections?.tools ?? ''))) declared[key] = true;
        if ((message.toolsAdded ?? []).some((tool) => tool.name === NAMES[key])) declared[key] = true;
        if ((message.toolsRemoved ?? []).some((tool) => tool.name === NAMES[key])) declared[key] = false;
      }
    }
    (globalThis.__pluginsE2eDeclared ??= []).push(declared);
  };
  // Runtime recreation reloads this extension, so the script position lives
  // on globalThis instead of in this closure.
  const script = [
    () => fauxAssistantMessage('first'),
    () => fauxAssistantMessage([fauxToolCall('render_html', { title: 'Demo', html: '<p>hi</p>', height: 200 }, { id: 'call-visual-1' })], { stopReason: 'toolUse' }),
    () => fauxAssistantMessage('drawn'),
    () => fauxAssistantMessage('third'),
    () => fauxAssistantMessage('fourth'),
    () => fauxAssistantMessage('fifth'),
  ];
  const respond = (context) => {
    record(context);
    const step = globalThis.__pluginsE2eStep ?? 0;
    globalThis.__pluginsE2eStep = step + 1;
    return script[step]();
  };
  faux.setResponses(script.map(() => respond));
  pi.registerProvider(faux.provider);
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
      const response = await next((message) => (message.kind === 'response' || message.kind === 'error') && message.requestId === requestId);
      if (response.kind === 'error') throw new Error(`Daemon error: ${response.code}`);
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

describe('session daemon plugins end-to-end with real SDK', () => {
  let daemon;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    delete globalThis.__pluginsE2eDeclared;
    delete globalThis.__pluginsE2eStep;
  });

  it('loads plugins only when configured; Sub-agents follows its `on` state live', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-plugins-e2e-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(join(agentDir, 'extensions', 'plugins-provider.ts'), PROVIDER_EXTENSION);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'plugins-mock-provider', defaultModel: 'plugins-mock-model' }));
    await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ 'plugins-mock-provider': { type: 'api_key', key: 'faux-test-key' } }));
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\pichamber-plugins-e2e-${Date.now()}` : join(root, 'daemon.sock');

    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();

    const health = await client.request('runtime.health');
    expect(health.capabilities).toContain('plugins.configure');

    const created = await client.request('sessions.create', { cwd: projectDir });
    const sessionId = created.session.id;
    const prompt = async (text) => {
      const sequence = client.lastSequence();
      const idle = client.next((message) => message.sequence > sequence && message.event === 'session.lifecycle' && message.payload?.state === 'idle');
      await client.request('sessions.prompt', { sessionId, text });
      await idle;
      return sequence;
    };

    const none = { visuals: false, subagents: false };
    const both = { visuals: true, subagents: true };
    const visualsOnly = { visuals: true, subagents: false };

    // Never configured: no plugin reaches the model.
    await prompt('one');
    expect(globalThis.__pluginsE2eDeclared).toEqual([none]);

    // Sub-agents' `on` comes from the manifest default (on) unless state sets it.
    const plugins = (subagentsGlobal = {}, sessions = {}) => ({
      plugins: [
        { id: 'visuals', entry: VISUALS_ENTRY, state: { global: { allowNetwork: false }, projects: {}, sessions: {} } },
        { id: 'subagents', entry: SUBAGENTS_ENTRY, state: { global: subagentsGlobal, projects: {}, sessions } },
      ],
    });
    await expect(client.request('plugins.configure', plugins())).resolves.toEqual({
      plugins: [{ id: 'visuals', loaded: true }, { id: 'subagents', loaded: true }],
      enabledChanged: true,
      deferred: false,
    });

    const listed = await client.request('extensions.list', { directory: projectDir });
    const names = listed.extensions.map((extension) => extension.name);
    expect(names).toContain('pichamber:visuals');
    expect(names).toContain('pichamber:subagents');

    const before = await prompt('draw');
    const toolEnd = await client.next((message) => message.sequence > before && message.event === 'session.tool.end' && message.payload?.toolCallId === 'call-visual-1');
    expect(toolEnd.payload).toMatchObject({
      toolName: 'render_html',
      state: 'completed',
      output: 'Rendered "Demo".',
      metadata: { title: 'Demo', html: '<p>hi</p>', height: 200 },
    });
    expect(globalThis.__pluginsE2eDeclared).toEqual([none, both, both]);

    // State-only change: no recreation, `subagent` leaves the declared set and
    // Visuals, which has no switch, stays.
    await expect(client.request('plugins.configure', plugins({ on: false }))).resolves.toMatchObject({ enabledChanged: false, deferred: false });
    await prompt('three');
    expect(globalThis.__pluginsE2eDeclared.at(-1)).toEqual(visualsOnly);

    // Another session's value changes nothing here; this session's own value
    // wins over the global one.
    await client.request('plugins.configure', plugins({ on: false }, { 'some-other-session': { on: true } }));
    await prompt('four');
    expect(globalThis.__pluginsE2eDeclared.at(-1)).toEqual(visualsOnly);
    await client.request('plugins.configure', plugins({ on: false }, { [sessionId]: { on: true } }));
    await prompt('five');
    expect(globalThis.__pluginsE2eDeclared.at(-1)).toEqual(both);

    await client.close();
  }, 60_000);
});
