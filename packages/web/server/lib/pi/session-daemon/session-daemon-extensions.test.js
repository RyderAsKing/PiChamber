import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { createSessionDaemon } from './session-daemon.js';

const credential = 'a-private-daemon-credential';

class ExtensibleFakeSession {
  constructor(sessionId = 'pi-session-ext') {
    this.sessionId = sessionId;
    this.isStreaming = false;
    this.listeners = new Set();
    this.entries = [];
    this.boundBindings = undefined;
    this.reloadCount = 0;
    this.providerMutations = [];
    this.labelChanges = [];
    this.modelRuntime = {
      registerProvider: (...args) => this.providerMutations.push(['registerProvider', ...args]),
      registerNativeProvider: (...args) => this.providerMutations.push(['registerNativeProvider', ...args]),
      unregisterProvider: (...args) => this.providerMutations.push(['unregisterProvider', ...args]),
    };
    this.sessionManager = {
      getSessionFile: () => undefined,
      getHeader: () => ({ timestamp: '2026-01-01T00:00:00.000Z' }),
      getEntries: () => this.entries,
      getBranch: () => this.entries,
      getLeafId: () => 'fake-entry',
      appendSessionInfo: () => {},
      getSessionName: () => undefined,
      appendLabelChange: (entryId, label) => this.labelChanges.push([entryId, label]),
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) listener(event);
  }

  async bindExtensions(bindings) {
    this.boundBindings = bindings;
  }

  async waitForIdle() {}

  async reload() {
    this.reloadCount += 1;
  }

  async prompt(text, options) {
    options?.preflightResult?.('started');
  }

  async navigateTree() {
    return { cancelled: false };
  }

  getSteeringMessages() {
    return [];
  }

  getFollowUpMessages() {
    return [];
  }
}

function connectClient(endpoint) {
  const socket = createConnection({ path: endpoint });
  const decoder = new StringDecoder('utf8');
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
    buffer += decoder.write(chunk);
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line) publish(JSON.parse(line));
    }
  });
  socket.on('close', () => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('Daemon connection closed'));
  });

  const next = (predicate) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error('Timed out waiting for daemon message'));
      }, 2_000);
      waiters.push({
        predicate,
        reject,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  };

  return {
    socket,
    events: messages,
    async authenticate(value = credential) {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(`${JSON.stringify({ kind: 'authenticate', credential: value })}\n`);
      await next((message) => message.kind === 'authenticated');
      return next((message) => message.kind === 'event' && message.event === 'session.snapshot');
    },
    request(command, payload = {}) {
      const requestId = `request-${Math.random()}`;
      socket.write(`${JSON.stringify({ protocolVersion: 1, kind: 'request', requestId, command, payload })}\n`);
      return next((message) => message.kind === 'response' && message.requestId === requestId);
    },
    next,
    async close() {
      socket.end();
      await new Promise((resolve) => socket.once('close', resolve));
    },
  };
}

describe('Pi session daemon extension bridging', () => {
  let daemon;
  let sessions = [];

  const startWithExtensibleSession = async ({ entries } = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-ext-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const endpoint = join(root, 'daemon.sock');
    const session = new ExtensibleFakeSession();
    const runtimeState = { disposeCount: 0 };
    if (entries) session.entries = entries;
    sessions.push(session);

    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: projectDir,
      agentDir,
      createRuntime: async (_options, hooks) => {
        // Mirror the default factory contract: bind extensions when the daemon
        // supplies bindings hooks.
        if (hooks?.createExtensionBindings && typeof session.bindExtensions === 'function') {
          await session.bindExtensions(hooks.createExtensionBindings(session));
        }
        return { session, cwd: projectDir, async dispose() { runtimeState.disposeCount += 1; } };
      },
    });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    await client.request('sessions.create', { cwd: projectDir });
    return { client, session, endpoint, runtimeState };
  };

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    sessions = [];
  });

  it('binds extensions into every created runtime and resolves blocking dialogs via extensions.respond', async () => {
    const { client, session } = await startWithExtensibleSession();
    expect(session.boundBindings).toBeTruthy();
    expect(session.boundBindings.mode).toBe('rpc');

    const confirmPromise = session.boundBindings.uiContext.confirm('Dangerous?', 'Allow rm -rf?');
    const dialogRequest = await client.next((message) => message.kind === 'event' && message.event === 'extension.dialog');
    expect(dialogRequest.payload).toMatchObject({
      sessionId: 'pi-session-ext',
      method: 'confirm',
      title: 'Dangerous?',
      message: 'Allow rm -rf?',
    });

    await client.request('extensions.respond', { requestId: dialogRequest.payload.requestId, confirmed: true });
    await expect(confirmPromise).resolves.toBe(true);
    const confirmDismiss = await client.next((message) => message.event === 'extension.dialog.dismiss' && message.payload?.requestId === dialogRequest.payload.requestId);
    expect(confirmDismiss.payload.reason).toBe('answered');

    const selectPromise = session.boundBindings.uiContext.select('Pick one:', ['A', 'B']);
    const selectRequest = await client.next((message) => message.event === 'extension.dialog' && message.payload?.method === 'select');
    expect(selectRequest.payload.options).toEqual(['A', 'B']);
    await client.request('extensions.respond', { requestId: selectRequest.payload.requestId, value: 'B' });
    await expect(selectPromise).resolves.toBe('B');

    const cancelPromise = session.boundBindings.uiContext.input('Name?', 'placeholder');
    const inputRequest = await client.next((message) => message.event === 'extension.dialog' && message.payload?.method === 'input');
    expect(inputRequest.payload.placeholder).toBe('placeholder');
    await client.request('extensions.respond', { requestId: inputRequest.payload.requestId, cancelled: true });
    await expect(cancelPromise).resolves.toBeUndefined();
    const cancelDismiss = await client.next((message) => message.event === 'extension.dialog.dismiss' && message.payload?.requestId === inputRequest.payload.requestId);
    expect(cancelDismiss.payload.reason).toBe('cancelled');
  });

  it('bridges standard RPC editor/title calls and extension-owned catalog mutations', async () => {
    const { client, session } = await startWithExtensibleSession();

    const editor = client.next((message) => message.event === 'extension.editor');
    session.boundBindings.uiContext.setEditorText('replace the draft');
    await expect(editor).resolves.toMatchObject({ payload: { text: 'replace the draft' } });

    const pasted = client.next((message) => message.event === 'extension.editor' && message.payload?.text === 'pasted text');
    session.boundBindings.uiContext.pasteToEditor('pasted text');
    await expect(pasted).resolves.toMatchObject({ payload: { text: 'pasted text' } });

    const title = client.next((message) => message.event === 'extension.title' && message.payload?.title === 'Mode picker');
    session.boundBindings.uiContext.setTitle('Mode picker');
    await expect(title).resolves.toMatchObject({ payload: { title: 'Mode picker' } });

    const providerChange = client.next((message) => message.event === 'extension.catalog' && message.payload?.providers === true);
    session.modelRuntime.registerProvider('local', { models: [] });
    await expect(providerChange).resolves.toMatchObject({ payload: { providers: true } });
    expect(session.providerMutations).toEqual([['registerProvider', 'local', { models: [] }]]);

    const treeChange = client.next((message) => message.event === 'session.tree.updated');
    session.sessionManager.appendLabelChange('entry-1', 'checkpoint');
    await expect(treeChange).resolves.toMatchObject({ payload: { sessionId: session.sessionId } });
    expect(session.labelChanges).toEqual([['entry-1', 'checkpoint']]);
    await client.close();
  });

  it('reloads extension resources and disposes only the requesting idle runtime on shutdown', async () => {
    const { client, session, runtimeState } = await startWithExtensibleSession();

    const reloaded = client.next((message) => message.event === 'extension.catalog'
      && message.payload?.providers === true
      && message.payload?.resources === true
      && message.payload?.commands === true);
    await session.boundBindings.commandContextActions.reload();
    expect(session.reloadCount).toBe(1);
    await expect(reloaded).resolves.toBeTruthy();

    session.boundBindings.shutdownHandler();
    session.emit({ type: 'agent_settled' });
    await expect.poll(() => runtimeState.disposeCount).toBe(1);
    await client.close();
  });

  it('reports unknown dialog requests as not pending and honors dialog timeouts', async () => {
    const { client } = await startWithExtensibleSession();
    const unknown = await client.request('extensions.respond', { requestId: 'does-not-exist' });
    expect(unknown.result).toEqual({ resolved: false });

    const timedPromise = sessions[0].boundBindings.uiContext.confirm('Fast?', 'Decide quickly', { timeout: 20 });
    const timedDialog = await client.next((message) => message.event === 'extension.dialog');
    await expect(timedPromise).resolves.toBe(false);
    const dismissal = await client.next((message) => message.event === 'extension.dialog.dismiss' && message.payload?.requestId === timedDialog.payload.requestId);
    expect(dismissal.payload.reason).toBe('timeout');
  });

  it('publishes fire-and-forget extension UI events and extension errors', async () => {
    const { client, session } = await startWithExtensibleSession();
    const ui = session.boundBindings.uiContext;

    ui.notify('Indexed 12 files', 'info');
    ui.notify('Disk almost full', 'warning');
    const notify = await client.next((message) => message.event === 'extension.notify');
    expect(notify.payload).toMatchObject({ sessionId: 'pi-session-ext', message: 'Indexed 12 files', level: 'info' });
    const warning = await client.next((message) => message.event === 'extension.notify' && message.payload?.level === 'warning');
    expect(warning.payload.message).toBe('Disk almost full');

    ui.setStatus('my-ext', 'Processing…');
    const status = await client.next((message) => message.event === 'extension.status');
    expect(status.payload).toMatchObject({ key: 'my-ext', text: 'Processing…' });
    const opened = await client.request('sessions.open', { sessionId: session.sessionId });
    expect(opened.result.extensionStatuses).toEqual([{ key: 'my-ext', text: 'Processing…' }]);
    ui.setStatus('my-ext', undefined);
    const cleared = await client.next((message) => message.event === 'extension.status' && !message.payload?.text);
    expect(cleared.payload.key).toBe('my-ext');

    ui.setWidget('todo', ['[x] one', '[ ] two']);
    const widget = await client.next((message) => message.event === 'extension.widget');
    expect(widget.payload).toMatchObject({ key: 'todo', lines: ['[x] one', '[ ] two'] });

    session.boundBindings.onError({ extensionPath: '/tmp/ext.ts', event: 'tool_call', error: 'boom' });
    const errorEvent = await client.next((message) => message.event === 'extension.error');
    expect(errorEvent.payload).toMatchObject({
      source: 'ext',
      event: 'tool_call',
      message: 'boom',
    });
    expect(errorEvent.payload.source).not.toContain('/tmp');
    const { directory: _dir, ...errorPayload } = errorEvent.payload;
    expect(JSON.stringify(errorPayload)).not.toContain('/tmp');
  });

  it('projects appended custom entries and custom messages as extension events', async () => {
    const { client, session } = await startWithExtensibleSession();

    session.emit({
      type: 'entry_appended',
      entry: { type: 'custom', id: 'state-1', customType: 'plannotator', data: { phase: 'idle' }, timestamp: '2026-01-01T00:00:00.000Z' },
    });
    session.emit({
      type: 'entry_appended',
      entry: { type: 'custom', id: 'entry-1', customType: 'pichamber.ui', data: { component: 'progress', props: { value: 40 } }, timestamp: '2026-01-01T00:00:01.000Z' },
    });
    const entryEvent = await client.next((message) => message.event === 'extension.entry');
    // Private extension state (non-`pichamber.*` appendEntry) is never published.
    expect(client.events.some((message) => message.event === 'extension.entry' && message.payload?.customType === 'plannotator')).toBe(false);
    expect(entryEvent.payload).toMatchObject({
      id: 'entry-1',
      customType: 'pichamber.ui',
      data: { component: 'progress', props: { value: 40 } },
    });

    session.emit({
      type: 'message_end',
      message: { role: 'custom', customType: 'my-extension', content: 'Status update', display: true, details: { count: 3 }, timestamp: Date.now() },
    });
    const messageEvent = await client.next((message) => message.event === 'extension.message');
    expect(messageEvent.payload).toMatchObject({
      customType: 'my-extension',
      text: 'Status update',
      details: { count: 3 },
    });

    session.emit({
      type: 'message_end',
      message: { role: 'custom', customType: 'silent', content: 'context only', display: false, timestamp: Date.now() },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(client.events.some((message) => message.event === 'extension.message' && message.payload?.customType === 'silent')).toBe(false);
  });

  it('includes extension entries and messages in the projected session snapshot in branch order', async () => {
    const baseTimestamp = '2026-01-01T00:00:00.000Z';
    const { client, session } = await startWithExtensibleSession({
      entries: [
        { type: 'message', id: 'm-user', timestamp: baseTimestamp, message: { role: 'user', content: 'hello', timestamp: Date.parse(baseTimestamp) } },
        { type: 'custom', id: 'e-state', customType: 'plannotator', data: { phase: 'idle' }, timestamp: baseTimestamp },
        { type: 'custom', id: 'e-1', customType: 'pichamber.ui', data: { component: 'kv', props: { rows: [] } }, timestamp: baseTimestamp },
        {
          type: 'custom_message',
          id: 'cm-1',
          customType: 'my-extension',
          content: [{ type: 'text', text: 'inline note' }],
          display: true,
          details: { answer: 42 },
          timestamp: baseTimestamp,
        },
        {
          type: 'custom_message',
          id: 'cm-hidden',
          customType: 'hidden-extension',
          content: 'invisible',
          display: false,
          timestamp: baseTimestamp,
        },
      ],
    });

    const opened = await client.request('sessions.open', { sessionId: session.sessionId });
    const roles = opened.result.messages.map((item) => item.message.role);
    expect(roles).toEqual(['user', 'extension', 'extension']);
    const items = opened.result.messages.filter((item) => item.message.role === 'extension');
    expect(items[0].message).toMatchObject({ id: 'e-1', customType: 'pichamber.ui', data: { component: 'kv' } });
    expect(items[1].message).toMatchObject({ id: 'cm-1', customType: 'my-extension', text: 'inline note', details: { answer: 42 } });
  });

  it('cancels pending dialogs when the owning runtime is disposed at idle timeout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-ext-idle-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const endpoint = join(root, 'daemon.sock');
    const session = new ExtensibleFakeSession();

    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: projectDir,
      agentDir,
      idleTimeoutMs: 30,
      createRuntime: async (_options, hooks) => {
        if (hooks?.createExtensionBindings) {
          await session.bindExtensions(hooks.createExtensionBindings(session));
        }
        return { session, cwd: projectDir, async dispose() {} };
      },
    });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    await client.request('sessions.create', { cwd: projectDir });
    // Idle disposal is scheduled by Pi's settled lifecycle event.
    session.emit({ type: 'agent_settled' });
    const settled = { value: 'pending' };
    const dialogPromise = session.boundBindings.uiContext.confirm('Waiting…', 'Idle disposal will cancel this');
    dialogPromise.then(() => {
      settled.value = 'settled';
    });
    await client.next((message) => message.event === 'extension.dialog');

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(settled.value).toBe('settled');
    await expect(dialogPromise).resolves.toBe(false);
    await client.close();
  });

  it('clears extension state and cancels pending dialogs when an active session is deleted', async () => {
    const { client, session } = await startWithExtensibleSession();
    const ui = session.boundBindings.uiContext;

    ui.setStatus('del-status', 'pending');
    ui.setWidget('del-widget', ['w1']);
    ui.setWorkingMessage('busy deleting');
    ui.getEditorText(); // tracks draft

    const dialogPromise = ui.confirm('Delete now?', 'Proceed with deletion');
    const dialogMsg = await client.next((message) => message.event === 'extension.dialog');
    expect(dialogMsg.payload.title).toBe('Delete now?');

    const deleteRes = await client.request('sessions.delete', { sessionId: session.sessionId });
    expect(deleteRes.result).toBeTruthy();

    await expect(dialogPromise).resolves.toBe(false);
    const dismissEvent = await client.next((message) => message.event === 'extension.dialog.dismiss'
      && message.payload?.requestId === dialogMsg.payload.requestId);
    expect(dismissEvent.payload.reason).toBe('session-closed');

    // Draft updates are rejected because session extension state was cleared
    const draftRes = await client.request('extensions.draft', {
      sessionId: session.sessionId,
      text: 'late text',
      revision: 1,
    });
    expect(draftRes.result).toEqual({ accepted: false });
    await client.close();
  });
});

describe('Pi session daemon extension panels, apps, and forms', () => {
  let daemon;
  let sessions = [];

  const startWithExtensibleSession = async ({ entries } = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-daemon-panel-'));
    const projectDir = join(root, 'project');
    const agentDir = join(root, 'agent');
    await mkdir(projectDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const endpoint = join(root, 'daemon.sock');
    const session = new ExtensibleFakeSession();
    if (entries) session.entries = entries;
    sessions.push(session);

    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: projectDir,
      agentDir,
      createRuntime: async (_options, hooks) => {
        if (hooks?.createExtensionBindings && typeof session.bindExtensions === 'function') {
          await session.bindExtensions(hooks.createExtensionBindings(session));
        }
        return { session, cwd: projectDir, async dispose() {} };
      },
    });
    await daemon.start();

    const client = connectClient(endpoint);
    await client.authenticate();
    await client.request('sessions.create', { cwd: projectDir });
    return { client, session, endpoint };
  };

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    sessions = [];
  });

  it('mirrors pichamber.ui entries into extension.ui panels that update in place and appear in snapshots', async () => {
    const { client, session, endpoint } = await startWithExtensibleSession();

    session.emit({
      type: 'entry_appended',
      entry: { type: 'custom', id: 'entry-1', customType: 'pichamber.ui', data: { protocol: 'pichamber-extension-ui', version: 1, id: 'subagents', title: 'Sub-agents', component: 'progress', props: { value: 10 } }, timestamp: '2026-01-01T00:00:01.000Z' },
    });
    const first = await client.next((message) => message.event === 'extension.ui');
    expect(first.payload).toMatchObject({ id: 'subagents', title: 'Sub-agents', component: 'progress' });

    // Latest wins per id: an update replaces the panel instead of stacking.
    session.emit({
      type: 'entry_appended',
      entry: { type: 'custom', id: 'entry-2', customType: 'pichamber.ui', data: { id: 'subagents', component: 'progress', props: { value: 90 } }, timestamp: '2026-01-01T00:00:02.000Z' },
    });
    await client.next((message) => message.event === 'extension.ui' && message.payload?.props?.value === 90);

    // A freshly authenticating client receives the normalized panels in its
    // authoritative snapshot.
    const reconnect = connectClient(endpoint);
    const snapshot = await reconnect.authenticate();
    expect(snapshot.payload.extensionPanels).toHaveLength(1);
    expect(snapshot.payload.extensionPanels[0]).toMatchObject({ id: 'subagents', props: { value: 90 } });
    reconnect.close();
  });

  it('mirrors pichamber.app entries into extension.app events and unregisters on removal', async () => {
    const { client, session } = await startWithExtensibleSession();

    session.emit({
      type: 'entry_appended',
      entry: { type: 'custom', id: 'app-entry-1', customType: 'pichamber.app', data: { appId: 'board', title: 'Board', html: '<button data-pichamber-command="board-run">Run</button>' }, timestamp: '2026-01-01T00:00:03.000Z' },
    });
    const appEvent = await client.next((message) => message.event === 'extension.app');
    expect(appEvent.payload).toMatchObject({ appId: 'board', title: 'Board' });
    expect(appEvent.payload.html).toContain('data-pichamber-command');

    session.emit({
      type: 'entry_appended',
      entry: { type: 'custom', id: 'app-entry-2', customType: 'pichamber.app', data: { appId: 'board', removed: true }, timestamp: '2026-01-01T00:00:04.000Z' },
    });
    const removal = await client.next((message) => message.event === 'extension.app' && message.payload?.removed === true);
    expect(removal.payload.appId).toBe('board');
  });

  it('bridges ctx.ui.form to a form dialog and resolves with a values object', async () => {
    const { client, session, endpoint } = await startWithExtensibleSession();
    const ui = session.boundBindings.uiContext;

    const pending = ui.form('Spawn agent', [
      { id: 'name', label: 'Name', type: 'text', required: true },
      { id: 'level', label: 'Level', type: 'select', options: ['low', 'high'], initial: 'high' },
      { id: 'workers', label: 'Workers', type: 'number', min: 1, max: 4 },
    ]);

    const dialogRequest = await client.next((message) => message.kind === 'event' && message.event === 'extension.dialog');
    expect(dialogRequest.payload).toMatchObject({ method: 'form', title: 'Spawn agent' });
    expect(dialogRequest.payload.fields).toHaveLength(3);

    await expect(client.request('extensions.respond', {
      requestId: dialogRequest.payload.requestId,
      values: { level: 'high' },
    })).rejects.toThrow('Daemon connection closed');

    const invalidClient = connectClient(endpoint);
    await invalidClient.authenticate();
    await expect(invalidClient.request('extensions.respond', {
      requestId: dialogRequest.payload.requestId,
      values: { name: 'research', level: 'invalid-option', workers: '8' },
    })).rejects.toThrow('Daemon connection closed');

    const validClient = connectClient(endpoint);
    await validClient.authenticate();
    await validClient.request('extensions.respond', {
      requestId: dialogRequest.payload.requestId,
      values: { name: 'research', level: 'high', workers: '4' },
    });
    validClient.close();
    expect(await pending).toEqual({ name: 'research', level: 'high', workers: '4' });
  });

  it('lists extensions with opaque ids and never leaks server paths', async () => {
    const { client, session } = await startWithExtensibleSession();
    session.extensionRunner = {
      getExtensionPaths: () => ['/home/someone/secret/extensions/modes.ts'],
      getRegisteredCommands: () => [{ invocationName: 'economy', description: 'Switch to economy mode' }],
    };

    const result = (await client.request('extensions.list', {})).result;
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0].name).toBe('modes');
    expect(JSON.stringify(result)).not.toContain('/home/someone');
    expect(result.extensions[0].id).not.toContain('/');
  });

  it('lists directory-based extensions with directory names and opaque ids', async () => {
    const { client, session } = await startWithExtensibleSession();
    session.extensionRunner = {
      getExtensionPaths: () => [
        '/home/someone/secret/extensions/browser/index.ts',
        '/home/someone/secret/extensions/web-search/index.js',
        '/home/someone/secret/extensions/modes.ts',
      ],
      getRegisteredCommands: () => [],
    };

    const result = (await client.request('extensions.list', {})).result;
    expect(result.extensions.map((e) => e.name)).toEqual(['browser', 'web-search', 'modes']);
    const ids = new Set(result.extensions.map((e) => e.id));
    expect(ids.size).toBe(3);
    expect(JSON.stringify(result)).not.toContain('/home/someone');
  });

  it('emits extension.editor with mode paste for pasteToEditor and mode set for setEditorText', async () => {
    const { client, session } = await startWithExtensibleSession();
    const ui = session.boundBindings.uiContext;

    ui.pasteToEditor('hello paste');
    const pasteEvent = await client.next((message) => message.event === 'extension.editor' && message.payload?.text === 'hello paste');
    expect(pasteEvent.payload).toMatchObject({ text: 'hello paste', mode: 'paste' });

    ui.setEditorText('hello set');
    const setEvent = await client.next((message) => message.event === 'extension.editor' && message.payload?.text === 'hello set');
    expect(setEvent.payload).toMatchObject({ text: 'hello set', mode: 'set' });
  });

  it('excludes idd pichamber.ui entries from sessions.open messages while rebuilding them into live panel snapshots on open and handling removed: true', async () => {
    const { client, session } = await startWithExtensibleSession({
      entries: [
        {
          type: 'custom',
          id: 'entry-1',
          customType: 'pichamber.ui',
          data: { id: 'status-panel', title: 'Status', component: 'badges', props: { status: 'running' } },
          timestamp: '2026-01-01T00:00:01.000Z',
        },
        {
          type: 'custom',
          id: 'entry-2',
          customType: 'pichamber.ui',
          data: { id: 'status-panel', title: 'Status', component: 'badges', props: { status: 'completed' } },
          timestamp: '2026-01-01T00:00:02.000Z',
        },
        {
          type: 'custom',
          id: 'entry-3',
          customType: 'pichamber.ui',
          data: { id: 'temp-panel', title: 'Temp', component: 'progress' },
          timestamp: '2026-01-01T00:00:03.000Z',
        },
        {
          type: 'custom',
          id: 'entry-4',
          customType: 'pichamber.ui',
          data: { id: 'temp-panel', removed: true },
          timestamp: '2026-01-01T00:00:04.000Z',
        },
        {
          type: 'custom',
          id: 'card-1',
          customType: 'pichamber.ui',
          data: { component: 'one-off-card', title: 'Card' },
          timestamp: '2026-01-01T00:00:05.000Z',
        },
      ],
    });

    const openRes = await client.request('sessions.open', { sessionId: session.sessionId });
    expect(openRes.result.extensionPanels).toHaveLength(1);
    expect(openRes.result.extensionPanels[0]).toMatchObject({
      id: 'status-panel',
      title: 'Status',
      component: 'badges',
      props: { status: 'completed' },
    });
    // Id'd entries entry-1, entry-2, entry-3, entry-4 must NOT appear in messages.
    // The un-id'd card-1 entry DOES appear in messages.
    const extensionMessages = openRes.result.messages.filter((m) => m.message.role === 'extension');
    expect(extensionMessages).toHaveLength(1);
    expect(extensionMessages[0].message.id).toBe('card-1');
  });

  it('renders component factory widgets and coalesces requestRender updates', async () => {
    const { client, session } = await startWithExtensibleSession();
    const ui = session.boundBindings.uiContext;

    let renderCount = 0;
    let widgetLines = ['initial line'];
    let disposed = false;
    let capturedTui = null;
    let capturedTheme = null;

    ui.setWidget('dynamic-widget', (tui, theme) => {
      capturedTui = tui;
      capturedTheme = theme;
      return {
        render: (width) => {
          renderCount += 1;
          expect(width).toBe(100);
          return widgetLines;
        },
        dispose: () => {
          disposed = true;
        },
      };
    });

    const initialWidget = await client.next((message) => message.event === 'extension.widget' && message.payload?.key === 'dynamic-widget');
    expect(initialWidget.payload.lines).toEqual(['initial line']);
    expect(renderCount).toBe(1);
    expect(capturedTui.terminal.columns).toBe(100);
    expect(capturedTheme.name).toBe('pichamber');

    // Trigger requestRender with updated lines
    widgetLines = ['updated line'];
    capturedTui.requestRender();

    const updatedWidget = await client.next((message) => message.event === 'extension.widget' && message.payload?.lines?.[0] === 'updated line');
    expect(updatedWidget.payload.lines).toEqual(['updated line']);

    // Replacing the widget disposes the previous component
    ui.setWidget('dynamic-widget', ['replaced with string']);
    const stringWidget = await client.next((message) => message.event === 'extension.widget' && message.payload?.lines?.[0] === 'replaced with string');
    expect(stringWidget.payload.lines).toEqual(['replaced with string']);
    expect(disposed).toBe(true);

    // Clearing the widget
    ui.setWidget('dynamic-widget', undefined);
    const cleared = await client.next((message) => message.event === 'extension.widget' && message.payload?.key === 'dynamic-widget' && !message.payload?.lines);
    expect(cleared.payload.key).toBe('dynamic-widget');
  });

  it('handles component factory errors gracefully without crashing the daemon', async () => {
    const { client, session } = await startWithExtensibleSession();
    const ui = session.boundBindings.uiContext;

    // Throwing factory
    ui.setWidget('faulty-factory', () => {
      throw new Error('Factory explosion');
    });

    const errorEvent = await client.next((message) => message.event === 'extension.error' && message.payload?.source === 'extension.widget');
    expect(errorEvent.payload.message).toContain('Factory explosion');

    // Throwing render
    let renderDisposed = false;
    let capturedTui = null;
    let shouldThrow = false;

    ui.setWidget('faulty-render', (tui) => {
      capturedTui = tui;
      return {
        render: () => {
          if (shouldThrow) throw new Error('Render crash');
          return ['safe line'];
        },
        dispose: () => {
          renderDisposed = true;
        },
      };
    });

    await client.next((message) => message.event === 'extension.widget' && message.payload?.key === 'faulty-render' && message.payload?.lines);

    shouldThrow = true;
    capturedTui.requestRender();

    const renderError = await client.next((message) => message.event === 'extension.error' && message.payload?.source === 'extension.widget' && message.payload?.event === 'render');
    expect(renderError.payload.message).toContain('Render crash');
    expect(renderDisposed).toBe(true);
  });

  it('publishes extension.working events and includes working state in snapshots', async () => {
    const { client, session } = await startWithExtensibleSession();
    const ui = session.boundBindings.uiContext;

    ui.setWorkingMessage('Analyzing repository...');
    const workingEvent1 = await client.next((message) => message.event === 'extension.working');
    expect(workingEvent1.payload).toMatchObject({ message: 'Analyzing repository...' });

    ui.setWorkingVisible(false);
    const workingEvent2 = await client.next((message) => message.event === 'extension.working' && message.payload?.visible === false);
    expect(workingEvent2.payload).toMatchObject({ message: 'Analyzing repository...', visible: false });

    const openRes = await client.request('sessions.open', { sessionId: session.sessionId });
    expect(openRes.result.extensionWorking).toEqual({
      message: 'Analyzing repository...',
      visible: false,
    });

    ui.setWorkingMessage(undefined);
    const workingEvent3 = await client.next((message) => message.event === 'extension.working' && message.payload?.message === undefined);
    expect(workingEvent3.payload).toMatchObject({ visible: false });
  });

  it('supports ctx.ui.getEditorText lazy draft mirror end-to-end', async () => {
    const { client, session } = await startWithExtensibleSession();
    const ui = session.boundBindings.uiContext;

    // 1. First getEditorText() call returns '' and publishes extension.editor.track exactly once
    const firstText = ui.getEditorText();
    expect(firstText).toBe('');
    const trackEvent = await client.next((message) => message.event === 'extension.editor.track');
    expect(trackEvent.payload).toMatchObject({
      sessionId: session.sessionId,
      enabled: true,
    });

    // Subsequent calls return current mirror and do not publish tracking again
    expect(ui.getEditorText()).toBe('');

    // Snapshot reflects extensionDraftTracked: true
    const snapshotRes1 = await client.request('sessions.open', { sessionId: session.sessionId });
    expect(snapshotRes1.result.extensionDraftTracked).toBe(true);

    // 2. extensions.draft with revision 1 updates the mirror
    const draftRes1 = await client.request('extensions.draft', {
      sessionId: session.sessionId,
      text: 'Draft content from composer',
      revision: 1,
    });
    expect(draftRes1.result).toEqual({ accepted: true });
    expect(ui.getEditorText()).toBe('Draft content from composer');

    // 3. Stale revision is rejected/ignored
    const staleRes = await client.request('extensions.draft', {
      sessionId: session.sessionId,
      text: 'Stale draft',
      revision: 1,
    });
    expect(staleRes.result).toEqual({ accepted: false });
    expect(ui.getEditorText()).toBe('Draft content from composer');

    // 4. Untracked session draft update is rejected
    const untrackedRes = await client.request('extensions.draft', {
      sessionId: 'untracked-session-xyz',
      text: 'Some text',
      revision: 10,
    });
    expect(untrackedRes.result).toEqual({ accepted: false });

    // 5. setEditorText and pasteToEditor update the mirror
    ui.setEditorText('Replaced by extension');
    expect(ui.getEditorText()).toBe('Replaced by extension');
    ui.pasteToEditor(' - appended');
    expect(ui.getEditorText()).toBe('Replaced by extension - appended');

    // 6. Next newer revision updates the mirror
    const draftRes2 = await client.request('extensions.draft', {
      sessionId: session.sessionId,
      text: 'Fresh user typing',
      revision: 2,
    });
    expect(draftRes2.result).toEqual({ accepted: true });
    expect(ui.getEditorText()).toBe('Fresh user typing');

    // 7. Prompt submission resets the mirror text (keeps tracking)
    await client.request('sessions.prompt', {
      sessionId: session.sessionId,
      text: 'User prompt',
    });
    expect(ui.getEditorText()).toBe('');

    // Can still send new draft after prompt
    const draftRes3 = await client.request('extensions.draft', {
      sessionId: session.sessionId,
      text: 'Typing next turn',
      revision: 3,
    });
    expect(draftRes3.result).toEqual({ accepted: true });
    expect(ui.getEditorText()).toBe('Typing next turn');
  });
});
