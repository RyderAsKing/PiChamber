import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSessionDaemon } from './session-daemon.js';

// Real SDK: a draft session is started for a new-session draft so its
// extensions can declare composer controls before anything is sent. It stays
// out of listings, its events are marked `draft`, sending adopts it with what
// its controls did, and closing the draft discards it. No model is called.

const credential = 'drafts-e2e-daemon-credential';
const VISUALS_ENTRY = fileURLToPath(new URL('../../../../plugins/visuals/extension.js', import.meta.url));

// Two free models, so a mode can switch model and thinking as a real mode
// extension does. Nothing is ever sent to them.
const PROVIDER_EXTENSION = `
import { fauxProvider } from '@earendil-works/pi-ai';

export default function (pi) {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const faux = fauxProvider({
    provider: 'drafts-mock-provider',
    models: [
      { id: 'drafts-cheap', name: 'Drafts Cheap', reasoning: true, cost, contextWindow: 16384, maxTokens: 2048 },
      { id: 'drafts-smart', name: 'Drafts Smart', reasoning: true, cost, contextWindow: 16384, maxTokens: 2048 },
    ],
  });
  pi.registerProvider(faux.provider);
}
`;

const MODES_EXTENSION = `
export default function (pi) {
  let mode = 'economy';
  const declare = () => pi.events.emit('pichamber.composer', {
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
      handler: async (_args, ctx) => {
        mode = name;
        const model = ctx.modelRegistry.find('drafts-mock-provider', name === 'balance' ? 'drafts-smart' : 'drafts-cheap');
        if (model) await pi.setModel(model);
        pi.setThinkingLevel(name === 'balance' ? 'high' : 'low');
        declare();
      },
    });
  }
  pi.on('session_start', () => declare());
}
`;

// Only for the tests that need them: a control whose command waits on a
// dialog, and one whose command starts an agent turn.
const EXTRAS_EXTENSION = `
export default function (pi) {
  const declare = () => pi.events.emit('pichamber.composer', {
    id: 'extra',
    kind: 'cycle',
    label: 'Extra',
    value: 'idle',
    options: [
      { value: 'idle', label: 'Idle', command: 'extraidle' },
      { value: 'ask', label: 'Ask', command: 'extraask' },
      { value: 'chat', label: 'Chat', command: 'extrachat' },
    ],
  });
  pi.registerCommand('extraidle', { description: 'Nothing', handler: async () => {} });
  pi.registerCommand('extraask', {
    description: 'Ask something',
    handler: async (_args, ctx) => { await ctx.ui.confirm('Draft question', 'Answer me?'); },
  });
  pi.registerCommand('extrachat', {
    description: 'Start a turn',
    handler: async () => { pi.sendUserMessage('hello from a control'); },
  });
  pi.on('session_start', () => declare());
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
    events: () => messages.filter((message) => message.kind === 'event'),
    lastSequence: () => Math.max(0, ...messages.map((message) => message.sequence ?? 0)),
    async close() {
      socket.end();
      await new Promise((resolve) => socket.once('close', resolve));
    },
  };
}

const listedIds = async (client, directory) => (await client.request('sessions.list', { directory })).sessions.map((item) => item.session.id);

describe('session daemon draft sessions end-to-end with real SDK', () => {
  let daemon;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
  });

  const startDaemon = async ({ extras = false, idleTimeoutMs } = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-drafts-e2e-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(agentDir, 'extensions'), { recursive: true });
    await writeFile(join(agentDir, 'extensions', 'modes.ts'), MODES_EXTENSION);
    await writeFile(join(agentDir, 'extensions', 'provider.ts'), PROVIDER_EXTENSION);
    if (extras) await writeFile(join(agentDir, 'extensions', 'extras.ts'), EXTRAS_EXTENSION);
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'drafts-mock-provider', defaultModel: 'drafts-cheap', defaultThinkingLevel: 'low' }));
    await writeFile(join(agentDir, 'auth.json'), JSON.stringify({ 'drafts-mock-provider': { type: 'api_key', key: 'faux-test-key' } }));
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\pichamber-drafts-e2e-${Date.now()}` : join(root, 'daemon.sock');
    // A lease owner, as the server gives one: an expired draft is only
    // reported deleted after its lease is released.
    daemon = createSessionDaemon({
      endpoint, credential, cwd: projectDir, agentDir,
      profileKey: 'drafts-e2e', serverInstanceId: 'drafts-e2e-server', daemonId: 'drafts-e2e-daemon',
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    });
    await daemon.start();
    const client = connectClient(endpoint);
    await client.authenticate();
    return { client, endpoint, projectDir, agentDir };
  };

  it('keeps a draft hidden and marked, then adopts it on send with its control state', async () => {
    const { client, projectDir } = await startDaemon();
    expect((await client.request('runtime.health')).capabilities).toContain('sessions.discardDraft');

    const draft = await client.request('sessions.create', { cwd: projectDir, draft: true });
    const draftId = draft.session.id;
    expect(draft.extensionControls).toEqual([expect.objectContaining({ id: 'mode', value: 'economy' })]);
    expect(await listedIds(client, projectDir)).not.toContain(draftId);

    // A click in the draft runs the extension's command; what it publishes is marked.
    let sequence = client.lastSequence();
    const marked = client.next((message) => message.sequence > sequence && message.event === 'extension.control'
      && message.payload?.sessionId === draftId && message.payload.control?.value === 'balance');
    await expect(client.request('extensions.control', { sessionId: draftId, id: 'mode', value: 'balance' })).resolves.toEqual({ ran: true });
    expect((await marked).draft).toBe(true);
    // The mode switched model and thinking: both are published, marked, so
    // the draft's composer can follow.
    const modelEvent = await client.next((message) => message.sequence > sequence && message.event === 'session.model'
      && message.payload?.sessionId === draftId);
    expect(modelEvent.draft).toBe(true);
    expect(modelEvent.payload.model).toEqual({ providerId: 'drafts-mock-provider', modelId: 'drafts-smart' });
    const thinkingEvent = await client.next((message) => message.sequence > sequence && message.event === 'session.thinking'
      && message.payload?.sessionId === draftId);
    expect(thinkingEvent.draft).toBe(true);
    expect(thinkingEvent.payload.thinking).toBe('high');
    expect(await listedIds(client, projectDir)).not.toContain(draftId);

    // Everything it published, from `session_start` on, was marked.
    const draftEvents = client.events().filter((message) => message.payload?.sessionId === draftId);
    expect(draftEvents.length).toBeGreaterThan(1);
    expect(draftEvents.every((message) => message.draft === true)).toBe(true);

    // Sending adopts it: same id, the mode picked in the draft, listed, no longer marked.
    const adopted = await client.request('sessions.create', {
      cwd: projectDir, draftSessionId: draftId, title: 'Adopted',
      model: { providerId: 'drafts-mock-provider', modelId: 'drafts-smart' }, thinking: 'high',
    });
    expect(adopted.session.id).toBe(draftId);
    expect(adopted.extensionControls).toEqual([expect.objectContaining({ id: 'mode', value: 'balance' })]);
    expect(adopted.session.model).toEqual({ providerId: 'drafts-mock-provider', modelId: 'drafts-smart' });
    expect(adopted.session.thinking).toBe('high');
    // The title event comes first, so a client holding it does not treat the
    // reply (and its controls) as older than what it has.
    const titled = await client.next((message) => message.event === 'session.updated'
      && message.payload?.sessionId === draftId && message.payload.title === 'Adopted');
    expect(titled.draft).toBeUndefined();
    expect(adopted.lastSequence).toBeGreaterThanOrEqual(titled.sequence);
    expect(await listedIds(client, projectDir)).toContain(draftId);
    sequence = client.lastSequence();
    const unmarked = client.next((message) => message.sequence > sequence && message.event === 'extension.control'
      && message.payload?.sessionId === draftId && message.payload.control?.value === 'economy');
    await client.request('extensions.control', { sessionId: draftId, id: 'mode', value: 'economy' });
    expect((await unmarked).draft).toBeUndefined();

    // A draft that is gone falls back to an ordinary create.
    const fallback = await client.request('sessions.create', { cwd: projectDir, draftSessionId: 'gone-draft' });
    expect(fallback.session.id).not.toBe('gone-draft');
    expect(await listedIds(client, projectDir)).toContain(fallback.session.id);
    await client.close();
  }, 60_000);

  it('discards a closed draft without writing anything, and only drafts', async () => {
    const { client, projectDir, agentDir } = await startDaemon();
    const draft = await client.request('sessions.create', { cwd: projectDir, draft: true });
    const draftId = draft.session.id;
    const sequence = client.lastSequence();
    const deleted = client.next((message) => message.sequence > sequence && message.event === 'session.deleted'
      && message.payload?.sessionId === draftId);
    await expect(client.request('sessions.discardDraft', { sessionId: draftId })).resolves.toEqual({ discarded: true });
    expect((await deleted).draft).toBe(true);
    await expect(client.request('sessions.discardDraft', { sessionId: draftId })).resolves.toEqual({ discarded: false });

    const ordinary = await client.request('sessions.create', { cwd: projectDir });
    await expect(client.request('sessions.discardDraft', { sessionId: ordinary.session.id })).resolves.toEqual({ discarded: false });
    expect(await listedIds(client, projectDir)).toEqual([ordinary.session.id]);

    // Nothing was written for any of them.
    const sessionsDir = join(agentDir, 'sessions');
    const files = await readdir(sessionsDir, { recursive: true }).catch(() => []);
    expect(files.filter((name) => String(name).endsWith('.jsonl'))).toEqual([]);
    await client.close();
  }, 60_000);

  it('rejects a draft with a title or a parent', async () => {
    const { endpoint, projectDir, client } = await startDaemon();
    await client.close();
    for (const payload of [{ draft: true, title: 'Named' }, { draft: true, parentId: 'some-parent' }, { draft: 'yes' }]) {
      const fresh = connectClient(endpoint);
      await fresh.authenticate();
      await expect(fresh.request('sessions.create', { cwd: projectDir, ...payload })).rejects.toThrow('INVALID_ARGUMENT');
    }
  }, 60_000);

  it('publishes one session.thinking per change in a draft, with the effective level', async () => {
    const { client, projectDir } = await startDaemon();
    const draft = await client.request('sessions.create', { cwd: projectDir, draft: true });
    const draftId = draft.session.id;
    const thinkingAfter = (sequence) => client.events().filter((message) => message.sequence > sequence
      && message.event === 'session.thinking' && message.payload?.sessionId === draftId);
    let sequence = client.lastSequence();
    await client.request('sessions.setThinking', { sessionId: draftId, thinking: 'high' });
    await client.request('runtime.health');
    expect(thinkingAfter(sequence).map((message) => [message.payload.thinking, message.draft])).toEqual([['high', true]]);
    // An unchanged level still answers once.
    sequence = client.lastSequence();
    await client.request('sessions.setThinking', { sessionId: draftId, thinking: 'high' });
    await client.request('runtime.health');
    expect(thinkingAfter(sequence).map((message) => message.payload.thinking)).toEqual(['high']);
    await client.close();
  }, 60_000);

  it('announces drafts as deleted, still marked, when runtimes are recreated', async () => {
    const { client, projectDir } = await startDaemon();
    const draft = await client.request('sessions.create', { cwd: projectDir, draft: true });
    const draftId = draft.session.id;
    const sequence = client.lastSequence();
    const deleted = client.next((message) => message.sequence > sequence && message.event === 'session.deleted'
      && message.payload?.sessionId === draftId);
    // A changed plugin set recreates every runtime, the draft's too.
    await expect(client.request('plugins.configure', {
      plugins: [{ id: 'visuals', entry: VISUALS_ENTRY, state: { global: {}, projects: {}, sessions: {} } }],
    })).resolves.toMatchObject({ enabledChanged: true });
    expect((await deleted).draft).toBe(true);
    // The id is no draft any more: discarding it finds nothing.
    await expect(client.request('sessions.discardDraft', { sessionId: draftId })).resolves.toEqual({ discarded: false });
    await client.close();
  }, 60_000);

  it('never attributes an Open request to a draft', async () => {
    const { client, projectDir } = await startDaemon();
    const draft = await client.request('sessions.create', { cwd: projectDir, draft: true });
    const draftId = draft.session.id;
    const named = await client.request('openUrl.publish', { url: 'http://127.0.0.1:4777/', sessionId: draftId });
    expect(named.sessionId).not.toBe(draftId);
    const ordinary = await client.request('sessions.create', { cwd: projectDir });
    await client.request('extensions.control', { sessionId: draftId, id: 'mode', value: 'balance' });
    const attributed = await client.request('openUrl.publish', { url: 'http://127.0.0.1:4777/' });
    expect(attributed).toMatchObject({ published: true, sessionId: ordinary.session.id });
    await client.close();
  }, 60_000);

  it('discards a draft whose control waits on a dialog', async () => {
    const { client, projectDir, endpoint } = await startDaemon({ extras: true });
    const draft = await client.request('sessions.create', { cwd: projectDir, draft: true });
    const draftId = draft.session.id;
    const sequence = client.lastSequence();
    const dialog = client.next((message) => message.sequence > sequence && message.event === 'extension.dialog'
      && message.payload?.sessionId === draftId);
    const asker = connectClient(endpoint);
    await asker.authenticate();
    const control = asker.request('extensions.control', { sessionId: draftId, id: 'extra', value: 'ask' }).catch((error) => error);
    expect((await dialog).draft).toBe(true);
    await expect(client.request('sessions.discardDraft', { sessionId: draftId })).resolves.toEqual({ discarded: true });
    // The command's dialog was cancelled, so the control call settles.
    await control;
    await asker.close().catch(() => {});
    await client.close();
  }, 60_000);

  it('idle-disposes a draft whose control waits on a dialog', async () => {
    const { client, projectDir, endpoint } = await startDaemon({ extras: true, idleTimeoutMs: 300 });
    const draft = await client.request('sessions.create', { cwd: projectDir, draft: true });
    const draftId = draft.session.id;
    const asker = connectClient(endpoint);
    await asker.authenticate();
    const control = asker.request('extensions.control', { sessionId: draftId, id: 'extra', value: 'ask' }).catch((error) => error);
    await client.next((message) => message.event === 'extension.dialog' && message.payload?.sessionId === draftId);
    const deleted = await client.next((message) => message.event === 'session.deleted' && message.payload?.sessionId === draftId);
    expect(deleted.draft).toBe(true);
    await control;
    await asker.close().catch(() => {});
    await client.close();
  }, 60_000);

  it('makes a draft an ordinary session when a control starts a model turn in it', async () => {
    const { client, projectDir } = await startDaemon({ extras: true });
    const draft = await client.request('sessions.create', { cwd: projectDir, draft: true });
    const draftId = draft.session.id;
    expect(await listedIds(client, projectDir)).not.toContain(draftId);
    const sequence = client.lastSequence();
    await expect(client.request('extensions.control', { sessionId: draftId, id: 'extra', value: 'chat' })).resolves.toEqual({ ran: true });
    const settled = await client.next((message) => message.sequence > sequence && message.event === 'session.lifecycle'
      && message.payload?.sessionId === draftId && message.payload.state === 'idle');
    // The turn ran to its end as any session's would, unmarked.
    expect(settled.draft).toBeUndefined();
    // The drafting client hears one marked busy state (no command: a turn),
    // then the same state goes out unmarked for every client.
    const turnStarts = client.events().filter((message) => message.sequence > sequence && message.event === 'session.lifecycle'
      && message.payload?.sessionId === draftId && message.payload.state === 'busy' && message.payload.command === undefined);
    expect(turnStarts.map((message) => message.draft === true)).toEqual([true, false]);
    // The turn reached the provider and was not stopped: the mock provider
    // has no reply queued, and its own error goes out unmarked.
    const errors = client.events().filter((message) => message.sequence > sequence && message.event === 'session.error'
      && message.payload?.sessionId === draftId);
    expect(errors.map((message) => [message.draft, /abort/i.test(message.payload.message)])).toEqual([[undefined, false]]);
    // The message the command sent goes out unmarked, after the turn's
    // start: clients title the new row from it, as the list does.
    const userStarts = client.events().filter((message) => message.sequence > sequence && message.event === 'assistant.message.start'
      && message.payload?.sessionId === draftId && message.payload.role === 'user');
    expect(userStarts.map((message) => [message.draft, message.payload.text, message.sequence > turnStarts[1].sequence]))
      .toEqual([[undefined, 'hello from a control', true]]);
    // It is a session now: listed, and no longer a draft to discard or adopt.
    expect(await listedIds(client, projectDir)).toContain(draftId);
    const listed = (await client.request('sessions.list', { directory: projectDir })).sessions.find((item) => item.session.id === draftId);
    expect(listed.session.title).toBe('hello from a control');
    await expect(client.request('sessions.discardDraft', { sessionId: draftId })).resolves.toEqual({ discarded: false });
    const sent = await client.request('sessions.create', { cwd: projectDir, draftSessionId: draftId });
    expect(sent.session.id).not.toBe(draftId);
    await client.close();
  }, 60_000);

  it('keeps a draft on its idle lifetime when adoption fails', async () => {
    const { client, projectDir, endpoint } = await startDaemon({ idleTimeoutMs: 400 });
    const draft = await client.request('sessions.create', { cwd: projectDir, draft: true });
    const draftId = draft.session.id;
    const fresh = connectClient(endpoint);
    await fresh.authenticate();
    await expect(fresh.request('sessions.create', {
      cwd: projectDir, draftSessionId: draftId, model: { providerId: 'drafts-mock-provider', modelId: 'no-such-model' },
    })).rejects.toThrow('Daemon error');
    // Still a draft (hidden) and still expires.
    expect(await listedIds(client, projectDir)).not.toContain(draftId);
    const deleted = await client.next((message) => message.event === 'session.deleted' && message.payload?.sessionId === draftId);
    expect(deleted.draft).toBe(true);
    await client.close();
  }, 60_000);
});
