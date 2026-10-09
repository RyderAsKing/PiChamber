import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';

import {
  projectEventFrame,
  projectExtensionList,
  projectMessageRender,
  projectToolRender,
  registerPiRuntimeRoutes,
} from './routes.js';

const frame = (event, payload, sequence = 1) => ({
  protocolVersion: 1,
  kind: 'event',
  event,
  sequence,
  payload: { sessionId: 'sess-1', directory: '/work', ...payload },
});

describe('extension public projections', () => {
  it('whitelists extension list fields and rejects path-shaped identities', () => {
    expect(projectExtensionList({
      directory: '/work',
      extensions: [{ id: '0123456789abcdef', name: 'economy', path: '/secret/economy.ts' }],
      commands: [{ name: 'balance', description: 'Switch mode', source: 'daemon-value', scope: 'global', path: '/secret' }],
    })).toEqual({
      directory: '/work',
      extensions: [{ id: '0123456789abcdef', name: 'economy' }],
      commands: [{ name: 'balance', description: 'Switch mode', source: 'extension', scope: 'global' }],
    });

    expect(() => projectExtensionList({
      directory: '/work',
      extensions: [{ id: '/secret/extension.ts', name: 'extension' }],
      commands: [],
    })).toThrow();
    expect(() => projectExtensionList({
      directory: '/work',
      extensions: [{ id: '0123456789abcdef', name: '../extension' }],
      commands: [],
    })).toThrow();
  });
  it('projects extension.ui panels with caps and removals', () => {
    const projected = projectEventFrame(frame('extension.ui', {
      id: 'subagents',
      title: 'Sub-agents',
      component: 'table',
      props: { columns: ['Agent'], rows: [['research']] },
      actions: [{ label: 'Clear', command: 'agents-clear' }],
    }));
    expect(projected).toMatchObject({
      name: 'extension.ui',
      payload: { id: 'subagents', title: 'Sub-agents', component: 'table' },
    });

    // Missing component and title is treated as an unregister.
    expect(projectEventFrame(frame('extension.ui', { id: 'gone' }))).toMatchObject({
      payload: { id: 'gone', removed: true },
    });

    // Invalid ids are dropped entirely.
    expect(projectEventFrame(frame('extension.ui', { id: '' }))).toBeNull();
    expect(projectEventFrame(frame('extension.ui', { id: `${'x'.repeat(200)}` }))).toBeNull();
  });

  it('projects extension.app payloads and rejects oversized html', () => {
    const projected = projectEventFrame(frame('extension.app', {
      appId: 'board',
      title: 'Board',
      html: '<button data-pichamber-command="run">Run</button>',
    }));
    expect(projected?.payload).toMatchObject({ appId: 'board', title: 'Board' });
    expect(projected?.payload.html).toContain('data-pichamber-command');

    expect(projectEventFrame(frame('extension.app', {
      appId: 'big',
      html: `${'<a>'.repeat(70_000)}`,
    }))).toBeNull();

    expect(projectEventFrame(frame('extension.app', { appId: 'gone', removed: true }))?.payload).toMatchObject({
      appId: 'gone',
      removed: true,
    });
  });

  it('projects bounded editor/title/catalog and tree invalidation events', () => {
    expect(projectEventFrame(frame('extension.editor', { text: 'draft' }))).toMatchObject({
      name: 'extension.editor', payload: { text: 'draft', mode: 'set' },
    });
    expect(projectEventFrame(frame('extension.editor', { text: 'inserted', mode: 'paste' }))).toMatchObject({
      name: 'extension.editor', payload: { text: 'inserted', mode: 'paste' },
    });
    expect(projectEventFrame(frame('extension.editor', { text: 'replacement', mode: 'set' }))).toMatchObject({
      name: 'extension.editor', payload: { text: 'replacement', mode: 'set' },
    });
    expect(projectEventFrame(frame('extension.editor', { text: 'x'.repeat(100_001) }))).toBeNull();
    expect(projectEventFrame(frame('extension.title', { title: 'Mode\u0000 Picker' }))).toMatchObject({
      payload: { title: 'Mode  Picker' },
    });
    expect(projectEventFrame(frame('extension.title', {}))).toMatchObject({ payload: {} });
    expect(projectEventFrame(frame('extension.catalog', { providers: true, resources: true }))).toMatchObject({
      payload: { providers: true, resources: true },
    });
    expect(projectEventFrame(frame('extension.catalog', {}))).toBeNull();
    expect(projectEventFrame(frame('session.tree.updated', {}))).toMatchObject({ payload: {} });
  });

  it('projects form dialogs with sanitized fields', () => {
    const projected = projectEventFrame(frame('extension.dialog', {
      requestId: 'form-1',
      method: 'form',
      title: 'Spawn agent',
      fields: [
        { id: 'name', label: 'Name', type: 'text', required: true },
        { id: 'level', label: 'Level', type: 'select', options: ['low', 'high'], initial: 'high' },
        { id: 'bad' },
        null,
      ],
    }));
    expect(projected?.payload.method).toBe('form');
    expect(projected?.payload.fields).toHaveLength(2);
    expect(projected?.payload.fields[0]).toMatchObject({ id: 'name', type: 'text', required: true });
    expect(projected?.payload.fields[1]).toMatchObject({ id: 'level', initial: 'high', options: ['low', 'high'] });

    expect(projectEventFrame(frame('extension.dialog.dismiss', {
      requestId: 'form-1',
      reason: 'timeout',
    }))?.payload).toEqual({ requestId: 'form-1', reason: 'timeout' });
    expect(projectEventFrame(frame('extension.dialog.dismiss', {
      requestId: 'form-1',
      reason: 'invented',
    }))).toBeNull();

    // Unknown dialog methods fail closed: the frame is dropped.
    expect(projectEventFrame(frame('extension.dialog', {
      requestId: 'r1',
      method: 'hologram',
      title: '?',
    }))).toBeNull();
  });

  it('projects extension.working events and sanitizes/bounds payloads', () => {
    expect(projectEventFrame(frame('extension.working', { message: 'Thinking\u0000 deeply', visible: true }))).toMatchObject({
      name: 'extension.working',
      payload: { message: 'Thinking  deeply', visible: true },
    });
    expect(projectEventFrame(frame('extension.working', { visible: false }))).toMatchObject({
      name: 'extension.working',
      payload: { visible: false },
    });
    expect(projectEventFrame(frame('extension.working', { message: 'x'.repeat(250) }))?.payload.message).toHaveLength(200);
    expect(projectEventFrame(frame('extension.working', { message: 123, visible: 'yes' }))).toBeNull();
  });

  it('projects extension.editor.track events and ignores invalid frames', () => {
    expect(projectEventFrame(frame('extension.editor.track', { enabled: true }))).toMatchObject({
      name: 'extension.editor.track',
      payload: { enabled: true },
    });
    expect(projectEventFrame(frame('extension.editor.track', { enabled: false }))).toMatchObject({
      name: 'extension.editor.track',
      payload: { enabled: false },
    });
    expect(projectEventFrame(frame('extension.editor.track', { enabled: 'true' }))).toBeNull();
    expect(projectEventFrame(frame('extension.editor.track', {}))).toBeNull();
  });

  it('projects snapshot extensionPanels/extensionApps/extensionDraftTracked for reconnect', () => {
    const projected = projectEventFrame(frame('session.snapshot', {
      isStreaming: false,
      lifecycle: 'idle',
      queue: { steering: 0, followUp: 0 },
      lastSequence: 5,
      extensionStatuses: [{ key: 'mode', text: 'economy' }],
      extensionPanels: [{ id: 'panel-1', component: 'progress', props: { value: 50 } }],
      extensionApps: [{ appId: 'app-1', html: '<p>x</p>' }],
      extensionTitle: 'Build mode',
      extensionWorking: { message: 'Indexing...', visible: true },
      extensionDraftTracked: true,
      extensionDialogs: [{
        requestId: 'form-1',
        method: 'form',
        title: 'Form',
        fields: [{ id: 'a', label: 'A', type: 'text' }],
      }],
    }));
    const snapshot = projected?.payload.snapshot;
    expect(snapshot.extensionPanels).toHaveLength(1);
    expect(snapshot.extensionApps).toHaveLength(1);
    expect(snapshot.extensionDialogs[0].fields).toHaveLength(1);
    expect(snapshot.extensionTitle).toBe('Build mode');
    expect(snapshot.extensionWorking).toEqual({ message: 'Indexing...', visible: true });
    expect(snapshot.extensionDraftTracked).toBe(true);

    const projectedUntracked = projectEventFrame(frame('session.snapshot', {
      isStreaming: false,
      lifecycle: 'idle',
      queue: { steering: 0, followUp: 0 },
      lastSequence: 5,
      extensionDraftTracked: false,
    }));
    expect(projectedUntracked?.payload.snapshot.extensionDraftTracked).toBeUndefined();
  });

  it('projects session.input frames and drops malformed pending summaries', () => {
    expect(projectEventFrame(frame('session.input', { pending: { count: 2, kind: 'approval', since: 50 } })))
      .toMatchObject({
        name: 'session.input',
        sessionId: 'sess-1',
        directory: '/work',
        payload: { pending: { count: 2, kind: 'approval', since: 50 } },
      });
    expect(projectEventFrame(frame('session.input', { pending: null }))?.payload).toEqual({ pending: null });
    // Unknown kinds normalize; extra keys never cross the boundary.
    expect(projectEventFrame(frame('session.input', {
      pending: { count: 150, kind: 'question', since: 7, sessionId: 'sneaky' },
    }))?.payload).toEqual({ pending: { count: 99, kind: 'input', since: 7 } });
    expect(projectEventFrame(frame('session.input', { pending: { count: 'many' } }))).toBeNull();
    expect(projectEventFrame(frame('session.input', {}))).toBeNull();
    expect(projectEventFrame(frame('session.input', { pending: { count: 1, kind: 'input' } }))).toBeNull();
  });

  it('projects session.input serverNow when finite and omits it otherwise', () => {
    expect(projectEventFrame(frame('session.input', {
      pending: { count: 1, kind: 'input', since: 9 },
      serverNow: 12345,
    }))?.payload).toEqual({ pending: { count: 1, kind: 'input', since: 9 }, serverNow: 12345 });
    // Old payloads without serverNow project as before.
    expect(projectEventFrame(frame('session.input', {
      pending: { count: 1, kind: 'input', since: 9 },
    }))?.payload).toEqual({ pending: { count: 1, kind: 'input', since: 9 } });
    for (const serverNow of [undefined, Number.NaN, Number.POSITIVE_INFINITY, '123', null]) {
      expect(projectEventFrame(frame('session.input', {
        pending: { count: 1, kind: 'input', since: 9 },
        serverNow,
      }))?.payload).toEqual({ pending: { count: 1, kind: 'input', since: 9 } });
    }
  });

  it('projects snapshot inputState and omits malformed values', () => {
    const projected = projectEventFrame(frame('session.snapshot', {
      isStreaming: false,
      lifecycle: 'idle',
      queue: { steering: 0, followUp: 0 },
      lastSequence: 5,
      inputState: { pending: { count: 1, kind: 'input', since: 9 } },
    }));
    expect(projected?.payload.snapshot.inputState).toEqual({ pending: { count: 1, kind: 'input', since: 9 } });

    const cleared = projectEventFrame(frame('session.snapshot', {
      isStreaming: false,
      lifecycle: 'idle',
      queue: { steering: 0, followUp: 0 },
      lastSequence: 5,
      inputState: { pending: null },
    }));
    expect(cleared?.payload.snapshot.inputState).toEqual({ pending: null });

    const malformed = projectEventFrame(frame('session.snapshot', {
      isStreaming: false,
      lifecycle: 'idle',
      queue: { steering: 0, followUp: 0 },
      lastSequence: 5,
      inputState: { pending: { count: 1 } },
    }));
    expect(malformed?.payload.snapshot.inputState).toBeUndefined();

    const unknown = projectEventFrame(frame('session.snapshot', {
      isStreaming: false,
      lifecycle: 'idle',
      queue: { steering: 0, followUp: 0 },
      lastSequence: 5,
    }));
    expect(unknown?.payload.snapshot.inputState).toBeUndefined();
  });

  it('projects live-only extension.notify frames', () => {
    expect(projectEventFrame(frame('extension.notify', {
      message: 'Indexed 12 files',
      level: 'warning',
    }))?.payload).toEqual({
      message: 'Indexed 12 files',
      level: 'warning',
    });

    // Unknown levels still default to info; overlong messages stay capped.
    expect(projectEventFrame(frame('extension.notify', {
      message: 'x'.repeat(2500),
      level: 'urgent',
    }))?.payload).toEqual({
      message: 'x'.repeat(2000),
      level: 'info',
    });

    // Empty messages never project, as before.
    expect(projectEventFrame(frame('extension.notify', { message: '' }))).toBeNull();
  });

});


describe('POST /api/pi/sessions/:sessionId/editor-draft', () => {
  let server;

  const listen = (app) => new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });

  const close = (s) => new Promise((resolve, reject) => {
    if (!s) return resolve();
    s.close((err) => (err && err.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(err) : resolve()));
  });

  afterEach(async () => {
    await close(server);
    server = undefined;
  });

  it('validates payload and forwards valid drafts to daemon runtime returning 204', async () => {
    const calls = [];
    const runtime = {
      request: async (command, payload) => {
        calls.push({ command, payload });
        return { accepted: true };
      },
    };

    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}/api/pi/sessions/sess-123/editor-draft`;

    // 1. Valid request
    const validRes = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'draft content', revision: 5, directory: '/work' }),
    });
    expect(validRes.status).toBe(204);
    expect(calls).toEqual([
      { command: 'extensions.draft', payload: { sessionId: 'sess-123', text: 'draft content', revision: 5, directory: '/work' } },
    ]);

    // 2. Text not a string
    const badTextRes = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 123, revision: 1 }),
    });
    expect(badTextRes.status).toBe(400);
    await expect(badTextRes.json()).resolves.toEqual({ error: { code: 'INVALID_ARGUMENT' } });

    // 3. Text exceeds 100,000 chars
    const oversizedRes = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'a'.repeat(100_001), revision: 1 }),
    });
    expect(oversizedRes.status).toBe(400);
    await expect(oversizedRes.json()).resolves.toEqual({ error: { code: 'INVALID_ARGUMENT' } });

    // 4. Invalid revision (negative, float, string, missing)
    const badRevisions = [-1, 1.5, '5', null, undefined, NaN, Number.MAX_SAFE_INTEGER + 1];
    for (const rev of badRevisions) {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello', revision: rev }),
      });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: { code: 'INVALID_ARGUMENT' } });
    }

    // 5. Invalid directory (non-string)
    const badDirRes = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', revision: 1, directory: 123 }),
    });
    expect(badDirRes.status).toBe(400);
    await expect(badDirRes.json()).resolves.toEqual({ error: { code: 'INVALID_ARGUMENT' } });
  });
});

describe('projectToolRender and tool render route passthrough', () => {
  it('sanitizes tool render shapes and bounds lines', () => {
    expect(projectToolRender(null)).toBeUndefined();
    expect(projectToolRender('not-an-object')).toBeUndefined();
    expect(projectToolRender([])).toBeUndefined();
    expect(projectToolRender({})).toBeUndefined();
    expect(projectToolRender({ call: [] })).toBeUndefined();

    const longLine = 'a'.repeat(2500);
    const manyLines = Array.from({ length: 250 }, (_, i) => `line-${i}`);
    const sanitized = projectToolRender({
      call: [longLine, 123, null, 'valid'],
      result: manyLines,
      resultExpanded: ['expanded'],
    });

    expect(sanitized.call).toHaveLength(2);
    expect(sanitized.call[0]).toHaveLength(2000);
    expect(sanitized.call[1]).toBe('valid');
    expect(sanitized.result).toHaveLength(200);
    expect(sanitized.resultExpanded).toEqual(['expanded']);
  });

  it('projects session.tool.start, update, and end frames with sanitized render', () => {
    const start = projectEventFrame(frame('session.tool.start', {
      toolCallId: 't1',
      partId: 'm1:tool:t1',
      messageId: 'm1',
      name: 'subagent',
      state: 'running',
      render: {
        call: ['running subagent'],
      },
    }));
    expect(start?.payload.render).toEqual({
      call: ['running subagent'],
    });

    const update = projectEventFrame(frame('session.tool.update', {
      toolCallId: 't1',
      partId: 'm1:tool:t1',
      messageId: 'm1',
      name: 'subagent',
      state: 'running',
      render: {
        call: ['running subagent'],
        result: ['partial progress'],
      },
    }));
    expect(update?.payload.render).toEqual({
      call: ['running subagent'],
      result: ['partial progress'],
    });

    const end = projectEventFrame(frame('session.tool.end', {
      toolCallId: 't1',
      partId: 'm1:tool:t1',
      messageId: 'm1',
      name: 'subagent',
      state: 'completed',
      render: {
        call: ['running subagent'],
        result: ['collapsed result'],
        resultExpanded: ['expanded result full details'],
      },
    }));
    expect(end?.payload.render).toEqual({
      call: ['running subagent'],
      result: ['collapsed result'],
      resultExpanded: ['expanded result full details'],
    });
  });

  it('passes sanitized render on session detail tool parts', async () => {
    const runtime = {
      request: async (command) => {
        if (command === 'sessions.open') {
          return {
            session: { id: 'sess-tool', directory: '/work', createdAt: 1000, updatedAt: 1000 },
            messages: [{
              message: { id: 'm1', sessionId: 'sess-tool', directory: '/work', role: 'assistant', createdAt: 1000 },
              parts: [{
                type: 'tool',
                id: 'm1:tool:t1',
                index: 0,
                toolCallId: 't1',
                name: 'custom_tool',
                state: 'completed',
                render: {
                  call: ['call output'],
                  result: ['result output'],
                  resultExpanded: ['result expanded'],
                },
              }],
            }],
            lastSequence: 1,
            isStreaming: false,
            lifecycle: 'idle',
          };
        }
        throw new Error(`Unexpected command ${command}`);
      },
    };

    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    const server = await new Promise((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/sessions/sess-tool?directory=%2Fwork`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.messages[0].parts[0].render).toEqual({
        call: ['call output'],
        result: ['result output'],
        resultExpanded: ['result expanded'],
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('projectMessageRender and message render route passthrough', () => {
  it('sanitizes message render shapes and bounds lines', () => {
    expect(projectMessageRender(null)).toBeUndefined();
    expect(projectMessageRender('not-an-object')).toBeUndefined();
    expect(projectMessageRender([])).toBeUndefined();
    expect(projectMessageRender({})).toBeUndefined();
    expect(projectMessageRender({ message: [] })).toBeUndefined();
    // An expanded slot without a collapsed slot is dropped.
    expect(projectMessageRender({ messageExpanded: ['only expanded'] })).toBeUndefined();
    expect(projectMessageRender({ message: 'not-an-array', messageExpanded: ['expanded'] })).toBeUndefined();

    expect(projectMessageRender({ message: ['collapsed'] })).toEqual({ message: ['collapsed'] });
    expect(projectMessageRender({ message: ['collapsed'], messageExpanded: ['expanded'] })).toEqual({
      message: ['collapsed'],
      messageExpanded: ['expanded'],
    });

    const longLine = 'a'.repeat(2500);
    const manyLines = Array.from({ length: 250 }, (_, i) => `line-${i}`);
    const sanitized = projectMessageRender({ message: [longLine, 123, null, 'valid'], messageExpanded: manyLines });
    expect(sanitized.message).toHaveLength(2);
    expect(sanitized.message[0]).toHaveLength(2000);
    expect(sanitized.message[1]).toBe('valid');
    expect(sanitized.messageExpanded).toHaveLength(200);
    // Tool render keys never leak into message renders.
    expect(projectMessageRender({ message: ['ok'], call: ['tool'] })).toEqual({ message: ['ok'] });
  });

  it('leaves projectToolRender behavior unchanged', () => {
    expect(projectToolRender({ call: ['c'], result: ['r'], resultExpanded: ['e'] })).toEqual({
      call: ['c'],
      result: ['r'],
      resultExpanded: ['e'],
    });
    // Message render keys never leak into tool renders.
    expect(projectToolRender({ call: ['c'], message: ['m'] })).toEqual({ call: ['c'] });
  });

  it('projects extension.message frames with sanitized render and drops malformed shapes', () => {
    const rendered = projectEventFrame(frame('extension.message', {
      id: 'm1',
      customType: 'my-extension',
      text: 'hi',
      createdAt: 1000,
      render: { message: ['collapsed'], messageExpanded: ['expanded'] },
    }));
    expect(rendered?.payload.render).toEqual({ message: ['collapsed'], messageExpanded: ['expanded'] });

    const manyLines = Array.from({ length: 250 }, (_, i) => `line-${i}`);
    const capped = projectEventFrame(frame('extension.message', {
      id: 'm1',
      customType: 'my-extension',
      text: 'hi',
      createdAt: 1000,
      render: { message: manyLines },
    }));
    expect(capped?.payload.render.message).toHaveLength(200);

    // Invalid render shapes are dropped, not protocol errors.
    for (const render of [{ message: 'not-an-array' }, { messageExpanded: ['orphan'] }, 'nope', 42]) {
      const dropped = projectEventFrame(frame('extension.message', {
        id: 'm1',
        customType: 'my-extension',
        text: 'hi',
        createdAt: 1000,
        render,
      }));
      expect(dropped).not.toBeNull();
      expect('render' in dropped.payload).toBe(false);
    }

    const plain = projectEventFrame(frame('extension.message', {
      id: 'm1',
      customType: 'my-extension',
      text: 'hi',
      createdAt: 1000,
    }));
    expect(plain).not.toBeNull();
    expect('render' in plain.payload).toBe(false);
  });

  it('passes sanitized render on session detail extension messages and drops malformed shapes', async () => {
    const runtime = {
      request: async (command) => {
        if (command === 'sessions.open') {
          return {
            session: { id: 'sess-ext', directory: '/work', createdAt: 1000, updatedAt: 1000 },
            messages: [
              {
                message: {
                  id: 'm1', sessionId: 'sess-ext', directory: '/work', role: 'extension',
                  customType: 'my-extension', text: 'hi', createdAt: 1000,
                  render: { message: ['collapsed'], messageExpanded: ['expanded'] },
                },
                parts: [],
              },
              {
                message: {
                  id: 'm2', sessionId: 'sess-ext', directory: '/work', role: 'extension',
                  customType: 'my-extension', text: 'hi', createdAt: 1000,
                  render: { messageExpanded: ['orphan'] },
                },
                parts: [],
              },
            ],
            lastSequence: 1,
            isStreaming: false,
            lifecycle: 'idle',
          };
        }
        throw new Error(`Unexpected command ${command}`);
      },
    };

    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    const server = await new Promise((resolve, reject) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });

    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/sessions/sess-ext?directory=%2Fwork`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.messages[0].message.render).toEqual({ message: ['collapsed'], messageExpanded: ['expanded'] });
      expect('render' in data.messages[1].message).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

