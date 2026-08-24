import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionDaemon } from './session-daemon.js';

// End-to-end smoke validation against the pinned Pi SDK: a real extension
// file is loaded from the agent directory through the default runtime
// factory, its command triggers a blocking dialog over the public stream,
// and its GUI payload projects back out.
const credential = 'a-private-daemon-credential';

const DEMO_EXTENSION = `
const answer = Symbol.for('pichamber-demo-answer');

export default function (pi) {
  pi.registerCommand("demo-state", {
    description: "Mutate extension-owned runtime state",
    handler: async (_args, ctx) => {
      pi.setSessionName("Extension-owned title");
      const leafId = ctx.sessionManager.getLeafId();
      if (leafId) pi.setLabel(leafId, "extension-checkpoint");
      ctx.ui.setEditorText("draft from extension");
      ctx.ui.setTitle("Extension window title");
      pi.unregisterProvider("not-registered");
    },
  });
  pi.registerCommand("demo-reload", {
    description: "Reload extension resources",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });
  pi.registerCommand("demo-shutdown", {
    description: "Dispose this session runtime",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });
  pi.registerCommand("demo-dialog", {
    description: "Ask a question",
    handler: async (_args, ctx) => {
      const ok = await ctx.ui.confirm("Fire the missile?", "This cannot be undone");
      pi.appendEntry("pichamber.ui", {
        title: "Demo",
        component: "badges",
        props: { items: [{ label: ok ? "confirmed" : "declined", tone: ok ? "success" : "warning" }] },
      });
      pi.sendMessage({
        customType: "demo-note",
        content: "Dialog answered",
        display: true,
        details: { ok },
      });
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
  const next = (predicate) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for daemon message')), 20_000);
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
      return next((message) => message.kind === 'response' && message.requestId === requestId);
    },
    next,
    events: messages,
    async close() {
      socket.end();
      await new Promise((resolve) => socket.once('close', resolve));
    },
  };
}

describe('pi extensions end-to-end through the real SDK', () => {
  let daemon;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
  });

  it('loads a global extension, answers its dialog, and projects its GUI payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-ext-e2e-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(join(agentDir, 'extensions', 'pichamber-demo.ts'), DEMO_EXTENSION);

    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\pichamber-pi-ext-e2e-${Date.now()}`
      : join(root, 'daemon.sock');

    daemon = createSessionDaemon({ endpoint, credential, cwd: projectDir, agentDir });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    const created = await client.request('sessions.create', { cwd: projectDir });
    expect(created.result.session.id).toBeTruthy();

    // The extension loaded and registered its command.
    const list = await client.request('extensions.list', {});
    expect(list.result.extensions.map((extension) => extension.name)).toContain('pichamber-demo');
    expect(list.result.commands.map((command) => command.name)).toContain('demo-dialog');

    // Invoke the extension command: it blocks on a dialog over the stream.
    await client.request('sessions.prompt', {
      sessionId: created.result.session.id,
      text: '/demo-dialog',
    });

    const dialog = await client.next((message) => message.kind === 'event' && message.event === 'extension.dialog');
    expect(dialog.payload).toMatchObject({ method: 'confirm', title: 'Fire the missile?' });

    const settled = client.next((message) => message.kind === 'event'
      && message.event === 'session.lifecycle'
      && message.payload.state === 'idle');
    await client.request('extensions.respond', {
      requestId: dialog.payload.requestId,
      confirmed: true,
    });

    // Extension saw the answer and emitted its GUI card + custom message.
    const card = await client.next((message) => message.kind === 'event' && message.event === 'extension.entry');
    expect(card.payload.customType).toBe('pichamber.ui');
    expect(card.payload.data.component).toBe('badges');

    const note = await client.next((message) => message.kind === 'event' && message.event === 'extension.message');
    expect(note.payload).toMatchObject({ customType: 'demo-note', text: 'Dialog answered' });
    await expect(settled).resolves.toMatchObject({
      payload: { sessionId: created.result.session.id, state: 'idle' },
    });

    // A fresh projection includes both items for reconnect/hydration.
    const opened = await client.request('sessions.open', { sessionId: created.result.session.id });
    const extensionItems = opened.result.messages.filter((item) => item.message.role === 'extension');
    expect(extensionItems.map((item) => item.message.customType).sort()).toEqual(['demo-note', 'pichamber.ui']);

    const sessionUpdated = client.next((message) => message.event === 'session.updated' && message.payload?.title === 'Extension-owned title');
    const treeUpdated = client.next((message) => message.event === 'session.tree.updated');
    const editorUpdated = client.next((message) => message.event === 'extension.editor' && message.payload?.text === 'draft from extension');
    const titleUpdated = client.next((message) => message.event === 'extension.title' && message.payload?.title === 'Extension window title');
    const providerUpdated = client.next((message) => message.event === 'extension.catalog' && message.payload?.providers === true);
    await client.request('sessions.prompt', { sessionId: created.result.session.id, text: '/demo-state' });
    await Promise.all([sessionUpdated, treeUpdated, editorUpdated, titleUpdated, providerUpdated]);

    const tree = await client.request('sessions.tree', { sessionId: created.result.session.id });
    const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
    expect(flatten(tree.result.nodes)).toContainEqual(expect.objectContaining({ label: 'extension-checkpoint' }));

    const reloadCatalog = client.next((message) => message.event === 'extension.catalog'
      && message.payload?.providers === true
      && message.payload?.resources === true
      && message.payload?.commands === true);
    const clearedTitle = client.next((message) => message.event === 'extension.title' && message.payload?.title === undefined);
    await client.request('sessions.prompt', { sessionId: created.result.session.id, text: '/demo-reload' });
    await Promise.all([reloadCatalog, clearedTitle]);

    const beforeShutdownSequence = Math.max(...client.events.map((message) => message.sequence ?? 0));
    const shutdownSettled = client.next((message) => message.event === 'session.lifecycle'
      && message.sequence > beforeShutdownSequence
      && message.payload?.state === 'idle');
    await client.request('sessions.prompt', { sessionId: created.result.session.id, text: '/demo-shutdown' });
    await shutdownSettled;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(client.request('runtime.health')).resolves.toMatchObject({ result: { state: 'ready' } });

    await client.close();
  }, 120_000);
});
