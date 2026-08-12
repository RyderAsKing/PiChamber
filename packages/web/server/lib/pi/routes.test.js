import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';

import { registerPiRuntimeRoutes } from './routes.js';

const listen = (app) => new Promise((resolve, reject) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
  const connections = new Set();
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  server.__testConnections = connections;
  server.once('error', reject);
});

const close = (server) => new Promise((resolve, reject) => {
  if (!server) return resolve();
  // SSE deliberately keeps a response open. Destroy its test-only sockets
  // before closing the listener so teardown cannot hang forever.
  for (const socket of server.__testConnections ?? []) socket.destroy();
  server.close((error) => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
});

describe('Pi runtime route', () => {
  let server;

  afterEach(async () => {
    await close(server);
    server = undefined;
  });

  it('returns only public daemon health fields and marks an unavailable daemon as a service failure', async () => {
    const runtime = {
      health: async () => ({
        state: 'ready',
        protocolVersion: 1,
        capabilities: ['sessions.prompt'],
        endpoint: '/private/socket',
        credential: 'never-expose-this',
        pid: 123,
      }),
    };
    const app = express();
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);

    const ready = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/runtime`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({
      state: 'ready',
      protocolVersion: 1,
      capabilities: ['sessions.prompt'],
    });

    runtime.health = async () => ({
      state: 'unavailable',
      protocolVersion: 1,
      error: { code: 'DAEMON_UNAVAILABLE' },
    });
    const unavailable = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/runtime`);
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({
      state: 'unavailable',
      protocolVersion: 1,
      error: { code: 'DAEMON_UNAVAILABLE' },
    });
  });

  it('lists and selects only daemon-owned projects', async () => {
    const calls = [];
    const runtime = {
      health: async () => ({ state: 'ready', protocolVersion: 1, capabilities: ['projects.list', 'projects.select'] }),
      request: async (command, payload) => {
        calls.push({ command, payload });
        if (command === 'projects.list') return { projects: [{ directory: '/workspace', selected: true, cwd: '/private' }] };
        return { directory: '/workspace', endpoint: '/private/socket' };
      },
    };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);

    const list = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/projects`);
    await expect(list.json()).resolves.toEqual({ projects: [{ directory: '/workspace', selected: true }] });
    const select = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/projects/select`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory: '/workspace' }),
    });
    await expect(select.json()).resolves.toEqual({ directory: '/workspace' });
    expect(calls).toEqual([
      { command: 'projects.list', payload: undefined },
      { command: 'projects.select', payload: { directory: '/workspace' } },
    ]);
  });

  it('projects Pi provider metadata without credentials or private model data', async () => {
    const runtime = {
      request: async (command) => {
        expect(command).toBe('providers.list');
        return { providers: [{ id: 'provider', label: 'Provider', authenticated: true, secret: 'never-public', models: [{ id: 'model', providerId: 'provider', label: 'Model', contextWindow: 100, supportsThinking: true, thinkingLevels: ['low', 'bad'] }] }] };
      },
    };
    const app = express();
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/providers`);
    await expect(response.json()).resolves.toEqual({ providers: [{ id: 'provider', label: 'Provider', authenticated: true, models: [{ id: 'model', providerId: 'provider', label: 'Model', contextWindow: 100, supportsThinking: true, thinkingLevels: ['low'] }] }] });
  });

  it('writes custom provider models through the daemon without projecting config credentials or headers', async () => {
    const calls = [];
    const runtime = {
      request: async (command, payload) => {
        calls.push({ command, payload });
        if (command === 'providers.config.get') return { config: null };
        if (command === 'providers.models.set') return { config: {
          providerId: 'custom', label: 'Custom', baseUrl: 'https://api.example.test/v1', api: 'openai-completions',
          apiKey: 'never-public', headers: { Authorization: 'never-public' },
          models: [{ id: 'model', providerId: 'custom', label: 'Model', contextWindow: 100, supportsThinking: true, private: true }],
        } };
        throw new Error(`Unexpected command ${command}`);
      },
    };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}/api/pi/providers/custom`;
    await expect((await fetch(`${base}/config`)).json()).resolves.toEqual({ config: null });
    const response = await fetch(`${base}/models`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Custom', baseUrl: 'https://api.example.test/v1', api: 'openai-completions', apiKeyReference: '{env:CUSTOM_KEY}', models: [{ id: 'model', providerId: 'custom', label: 'Model' }] }),
    });
    await expect(response.json()).resolves.toEqual({ config: {
      providerId: 'custom', label: 'Custom', baseUrl: 'https://api.example.test/v1', api: 'openai-completions',
      models: [{ id: 'model', providerId: 'custom', label: 'Model', contextWindow: 100, supportsThinking: true }],
    } });
    expect(calls).toEqual([
      { command: 'providers.config.get', payload: { providerId: 'custom' } },
      { command: 'providers.models.set', payload: { providerId: 'custom', label: 'Custom', baseUrl: 'https://api.example.test/v1', api: 'openai-completions', apiKeyReference: '{env:CUSTOM_KEY}', models: [{ id: 'model', providerId: 'custom', label: 'Model' }] } },
    ]);
  });

  it('forwards provider login without returning API keys and projects only interactive login state', async () => {
    const calls = [];
    const runtime = {
      request: async (command, payload) => {
        calls.push({ command, payload });
        if (command === 'providers.status') return { providerId: 'provider', authenticated: false, credential: 'never-public' };
        if (command === 'providers.login') return { login: {
          id: 'login-1', providerId: 'provider', state: 'pending',
          deviceCode: { userCode: 'ABCD', verificationUri: 'https://example.test/device', secret: 'never-public' },
        } };
        if (command === 'providers.login.respond') return { login: { id: 'login-1', providerId: 'provider', state: 'complete' } };
        if (command === 'providers.logout') return { providerId: 'provider', authenticated: false };
        throw new Error(`Unexpected command ${command}`);
      },
    };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}/api/pi/providers/provider`;

    await expect((await fetch(`${base}/status`)).json()).resolves.toEqual({ providerId: 'provider', authenticated: false });
    const login = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'api_key', apiKey: 'never-return-this' }) });
    expect(login.status).toBe(202);
    await expect(login.json()).resolves.toEqual({ login: { id: 'login-1', providerId: 'provider', state: 'pending', deviceCode: { userCode: 'ABCD', verificationUri: 'https://example.test/device' } } });
    await expect((await fetch(`${base}/login/login-1/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'manual-code' }) })).json()).resolves.toEqual({ login: { id: 'login-1', providerId: 'provider', state: 'complete' } });
    await expect((await fetch(`${base}/logout`, { method: 'POST' })).json()).resolves.toEqual({ providerId: 'provider', authenticated: false });
    expect(calls).toEqual([
      { command: 'providers.status', payload: { providerId: 'provider' } },
      { command: 'providers.login', payload: { providerId: 'provider', type: 'api_key', apiKey: 'never-return-this' } },
      { command: 'providers.login.respond', payload: { providerId: 'provider', loginId: 'login-1', value: 'manual-code' } },
      { command: 'providers.logout', payload: { providerId: 'provider' } },
    ]);
  });

  it('keeps Pi-owned settings and PiChamber defaults distinct', async () => {
    const settingsStore = {
      read: async () => ({ version: 1, defaultModel: { providerId: 'pichamber', modelId: 'default' } }),
      update: async (patch) => ({ version: 1, ...patch }),
    };
    const runtime = {
      request: async (command, payload) => {
        if (command === 'settings.get') return {
          global: { defaultProvider: 'pi', defaultModel: 'model', defaultThinking: 'medium' },
          project: { trusted: false },
        };
        expect(command).toBe('settings.set');
        expect(payload).toEqual({ scope: 'global', defaultThinking: 'high' });
        return { global: { defaultThinking: 'high' }, project: { trusted: false } };
      },
    };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime, settingsStore });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}/api/pi/settings`;
    await expect((await fetch(base)).json()).resolves.toEqual({
      pi: { global: { defaultProvider: 'pi', defaultModel: 'model', defaultThinking: 'medium' }, project: { trusted: false } },
      pichamber: { version: 1, defaultModel: { providerId: 'pichamber', modelId: 'default' } },
    });
    await expect((await fetch(`${base}/pi`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'global', defaultThinking: 'high' }) })).json()).resolves.toEqual({
      pi: { global: { defaultThinking: 'high' }, project: { trusted: false } },
    });
    await expect((await fetch(`${base}/defaults`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultThinking: 'low' }) })).json()).resolves.toEqual({ pichamber: { version: 1, defaultThinking: 'low' } });
  });

  it('uploads opaque attachments and resolves them only across the private prompt adapter', async () => {
    const calls = [];
    const attachmentStore = {
      create: async (input) => ({ id: 'attachment-1', name: input.filename, mime: input.mime, size: 3, path: '/never-public' }),
      resolve: async (ids) => {
        expect(ids).toEqual(['attachment-1']);
        return [{ id: 'attachment-1', name: 'note.txt', mime: 'text/plain', size: 3, path: '/private/upload' }];
      },
    };
    const runtime = {
      request: async (command, payload) => {
        calls.push({ command, payload });
        return command === 'sessions.prompt' ? { accepted: true, messageId: 'message-1' } : {};
      },
    };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime, attachmentStore });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}/api/pi`;

    const upload = await fetch(`${base}/attachments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'note.txt', mime: 'text/plain', base64: 'YWJj' }) });
    expect(upload.status).toBe(201);
    await expect(upload.json()).resolves.toEqual({ attachment: { id: 'attachment-1', name: 'note.txt', mime: 'text/plain', size: 3 } });
    const prompt = await fetch(`${base}/sessions/session-1/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'read this', attachments: [{ id: 'attachment-1' }] }) });
    expect(prompt.status).toBe(202);
    expect(calls).toEqual([{ command: 'sessions.prompt', payload: { sessionId: 'session-1', text: 'read this', attachments: [{ id: 'attachment-1', name: 'note.txt', mime: 'text/plain', size: 3, path: '/private/upload' }] } }]);
  });

  it('proxies a cwd-scoped session collection without exposing private daemon details', async () => {
    const runtime = {
      health: async () => ({ state: 'ready', protocolVersion: 1, capabilities: ['sessions.list'] }),
      request: async (command, payload) => {
        expect(command).toBe('sessions.list');
        expect(payload).toEqual({ directory: '/workspace' });
        return {
          sessions: [{
            session: {
              id: 'pi-session-1',
              directory: '/workspace',
              createdAt: 1,
              updatedAt: 2,
            },
            updatedAt: 2,
          }],
          endpoint: '/private/socket',
          credential: 'never-expose-this',
        };
      },
    };
    const app = express();
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/sessions?directory=%2Fworkspace`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      sessions: [{
        session: {
          id: 'pi-session-1',
          directory: '/workspace',
          createdAt: 1,
          updatedAt: 2,
        },
        updatedAt: 2,
      }],
    });
  });

  it('renames a session through the daemon without accepting a body session identity', async () => {
    const runtime = {
      health: async () => ({ state: 'ready', protocolVersion: 1, capabilities: ['sessions.rename'] }),
      request: async (command, payload) => {
        expect(command).toBe('sessions.rename');
        expect(payload).toEqual({ sessionId: 'pi-session-3', title: 'Renamed' });
        return {};
      },
    };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/sessions/pi-session-3`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'other-session', title: 'Renamed' }),
    });
    expect(response.status).toBe(204);
  });

  it('creates a session through the daemon and whitelists the fresh-session response', async () => {
    const runtime = {
      health: async () => ({ state: 'ready', protocolVersion: 1, capabilities: ['sessions.create'] }),
      request: async (command, payload) => {
        expect(command).toBe('sessions.create');
        expect(payload).toEqual({ cwd: '/workspace' });
        return {
          session: {
            id: 'pi-session-2',
            directory: '/workspace',
            createdAt: 1,
            updatedAt: 2,
            sessionFile: '/private/session.jsonl',
          },
          messages: [],
          lastSequence: 7,
          credential: 'never-expose-this',
        };
      },
    };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: '/workspace' }),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      session: {
        id: 'pi-session-2',
        directory: '/workspace',
        createdAt: 1,
        updatedAt: 2,
      },
      messages: [],
      lastSequence: 7,
    });
  });

  it('routes path-selected session operations and projects transcript fields only', async () => {
    const calls = [];
    const detail = {
      session: { id: 'pi-session-4', directory: '/workspace', createdAt: 1, updatedAt: 2, sessionFile: '/private/session.jsonl' },
      messages: [{
        message: { id: 'entry-1', sessionId: 'pi-session-4', directory: '/workspace', role: 'assistant', text: 'hello', thinking: '', createdAt: 2, secret: 'never-expose' },
        parts: [{ type: 'text', id: 'entry-1:0', index: 0, text: 'hello', privatePath: '/private' }],
      }],
      lastSequence: 9,
    };
    const runtime = {
      health: async () => ({ state: 'ready', protocolVersion: 1, capabilities: [] }),
      request: async (command, payload) => {
        calls.push({ command, payload });
        if (command === 'sessions.open' || command === 'sessions.navigate') return detail;
        if (command === 'sessions.prompt') return { accepted: true, messageId: 'entry-2', credential: 'never-expose' };
        return {};
      },
    };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime, archiveStore: { read: async () => ({}), set: async () => {} } });
    server = await listen(app);

    const detailResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/sessions/pi-session-4`);
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toEqual({
      session: { id: 'pi-session-4', directory: '/workspace', createdAt: 1, updatedAt: 2 },
      messages: [{
        message: { id: 'entry-1', sessionId: 'pi-session-4', directory: '/workspace', role: 'assistant', text: 'hello', thinking: '', createdAt: 2 },
        parts: [{ type: 'text', id: 'entry-1:0', index: 0, text: 'hello' }],
      }],
      lastSequence: 9,
    });
    const promptResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/sessions/pi-session-4/prompt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'other', text: 'hello' }),
    });
    expect(promptResponse.status).toBe(202);
    await expect(promptResponse.json()).resolves.toEqual({ accepted: true, messageId: 'entry-2' });
    expect(calls).toEqual([
      { command: 'sessions.open', payload: { sessionId: 'pi-session-4' } },
      { command: 'sessions.prompt', payload: { sessionId: 'pi-session-4', text: 'hello' } },
    ]);
  });

  it('adapts every path-selected session operation and archives without selecting a Pi runtime', async () => {
    const calls = [];
    const detail = { session: { id: 'pi-session-7', directory: '/workspace', createdAt: 1, updatedAt: 2 }, messages: [], lastSequence: 5 };
    const archiveStore = { read: async () => ({ 'pi-session-7': 9 }), set: async (...args) => calls.push({ command: 'archive.set', payload: args }) };
    const runtime = {
      health: async () => ({ state: 'ready', protocolVersion: 1, capabilities: [] }),
      request: async (command, payload) => {
        calls.push({ command, payload });
        if (command === 'sessions.open' || command === 'sessions.navigate' || command === 'sessions.fork' || command === 'sessions.clone') return detail;
        if (command === 'sessions.tree') return { rootId: 'pi-session-7', nodes: [{ entryId: 'entry-7', updatedAt: 2, children: [], privatePath: '/private' }] };
        if (command === 'sessions.list') return { sessions: [{ session: detail.session, updatedAt: 2 }] };
        if (['sessions.prompt', 'sessions.steer', 'sessions.followUp'].includes(command)) return { accepted: true, messageId: 'message-1' };
        return {};
      },
    };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime, archiveStore });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}/api/pi/sessions/pi-session-7`;

    await expect((await fetch(`${base}/snapshot`)).json()).resolves.toMatchObject({ session: { archived: true, timeArchived: 9 } });
    expect((await fetch(base, { method: 'DELETE' })).status).toBe(204);
    await expect((await fetch(`${base}/tree`)).json()).resolves.toEqual({ rootId: 'pi-session-7', nodes: [{ entryId: 'entry-7', updatedAt: 2, children: [] }] });
    expect((await fetch(`${base}/navigate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'other', messageId: 'entry-1' }) })).status).toBe(200);
    expect((await fetch(`${base}/fork`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'other', messageId: 'entry-1' }) })).status).toBe(201);
    expect((await fetch(`${base}/clone`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'other' }) })).status).toBe(201);
    for (const suffix of ['prompt', 'steer', 'follow-up']) {
      expect((await fetch(`${base}/${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'other', text: 'hello' }) })).status).toBe(202);
    }
    for (const [suffix, body] of [['abort', {}], ['model', { model: { providerId: 'test', modelId: 'model' } }], ['thinking', { thinking: 'high' }], ['compact', { thinking: 'low' }]]) {
      expect((await fetch(`${base}/${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'other', ...body }) })).status).toBe(204);
    }
    const callsBeforeArchive = calls.length;
    expect((await fetch(`${base}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: false }) })).status).toBe(204);
    expect(calls).toContainEqual({ command: 'archive.set', payload: ['pi-session-7', false] });
    expect(calls.slice(callsBeforeArchive)).toContainEqual({ command: 'sessions.list', payload: undefined });
    expect(calls.slice(callsBeforeArchive)).not.toContainEqual({ command: 'sessions.open', payload: { sessionId: 'pi-session-7' } });
    for (const call of calls.filter((call) => call.command?.startsWith('sessions.') && call.command !== 'sessions.list')) {
      expect(call.payload.sessionId).toBe('pi-session-7');
    }
  });

  it('rejects unauthenticated requests before the Pi adapters run', async () => {
    let invoked = false;
    const app = express();
    app.use('/api', (_req, res) => res.status(401).json({ error: { code: 'UNAUTHORIZED' } }));
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => { invoked = true; return undefined; } });
    server = await listen(app);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/sessions`);
    expect(response.status).toBe(401);
    expect(invoked).toBe(false);
  });

  it('streams sequenced projected snapshots without exposing private transport fields', async () => {
    const runtime = {
      health: async () => ({ state: 'ready', protocolVersion: 1, capabilities: [] }),
      subscribe: async ({ onEvent }) => {
        onEvent({ protocolVersion: 1, kind: 'event', event: 'session.snapshot', sequence: 4, payload: { sessionId: 'pi-session-5', directory: '/workspace', isStreaming: false, lifecycle: 'idle', queue: { steering: 0, followUp: 0 }, lastSequence: 4, endpoint: '/private/socket' } });
        return () => {};
      },
    };
    const app = express();
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/events?sessionId=pi-session-5&fromSequence=3`);
    const reader = response.body.getReader();
    const first = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain('"name":"session.snapshot"');
    expect(text).toContain('"lastSequence":4');
    expect(text).not.toContain('/private/socket');
  });

  it('returns an explicit failure when the daemon session collection is unavailable or malformed', async () => {
    const runtime = {
      health: async () => ({ state: 'ready', protocolVersion: 1, capabilities: ['sessions.list'] }),
      request: async () => {
        const error = new Error('unavailable');
        error.code = 'MALFORMED_SESSION_JSONL';
        throw error;
      },
    };
    const app = express();
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);

    const unavailable = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/sessions`);
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({ error: { code: 'MALFORMED_SESSION_JSONL' } });

    runtime.request = async () => ({ sessions: null });
    const malformed = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/sessions`);
    expect(malformed.status).toBe(503);
    await expect(malformed.json()).resolves.toEqual({ error: { code: 'DAEMON_PROTOCOL_MISMATCH' } });
  });
});
