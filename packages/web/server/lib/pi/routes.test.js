import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';

import { projectEventFrame, registerPiRuntimeRoutes } from './routes.js';

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

  it('projects prompt-time files on a live user message start', () => {
    expect(projectEventFrame({
      protocolVersion: 1,
      kind: 'event',
      event: 'assistant.message.start',
      sequence: 4,
      payload: {
        sessionId: 'pi-session-files',
        directory: '/workspace',
        messageId: 'user-1',
        role: 'user',
        text: 'look',
        startedAt: 2,
        files: [
          { type: 'file', id: 'user-1:file:0', index: 0, mime: 'image/png', filename: 'image.png' },
          { type: 'file', id: 'bad', index: 1, mime: `x/${'y'.repeat(300)}`, filename: 'bad.png', url: 'file:///private/path' },
        ],
      },
    })).toMatchObject({
      name: 'assistant.message.start',
      payload: {
        messageId: 'user-1',
        files: [
          { type: 'file', id: 'user-1:file:0', index: 0, mime: 'image/png', filename: 'image.png' },
          { type: 'file', id: 'bad', index: 1, filename: 'bad.png' },
        ],
      },
    });
  });

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

  it('serves PiChamber UI settings, session folders, custom themes, and update metadata without removed routes', async () => {
    let settings = { themeMode: 'dark' };
    let sessionFolders = { exists: false };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, {
      getPiSessionDaemonRuntime: () => null,
      uiSettingsStore: {
        read: async () => settings,
        write: async (changes) => (settings = { ...settings, ...changes }),
      },
      sessionFoldersStore: {
        read: async () => sessionFolders,
        write: async (snapshot) => (sessionFolders = { exists: true, ...snapshot }),
      },
      listCustomThemes: async () => [{ metadata: { id: 'custom' } }],
      updateChecker: async () => ({ available: false, currentVersion: '1.0.0' }),
      resolveUpdatePackageManager: () => 'npm',
      updateLauncher: () => ({ success: true }),
    });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}`;

    await expect((await fetch(`${base}/api/pi/ui-settings`)).json()).resolves.toEqual({ themeMode: 'dark' });
    await expect((await fetch(`${base}/api/pi/ui-settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: 'en' }),
    })).json()).resolves.toEqual({ themeMode: 'dark', language: 'en' });
    await expect((await fetch(`${base}/api/pi/session-folders`)).json()).resolves.toEqual({ exists: false });
    await expect((await fetch(`${base}/api/pi/session-folders`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, foldersMap: {}, collapsedFolderIds: [], updatedAt: 1 }),
    })).json()).resolves.toEqual({ exists: true, version: 1, foldersMap: {}, collapsedFolderIds: [], updatedAt: 1 });
    await expect((await fetch(`${base}/api/pi/themes`)).json()).resolves.toEqual({ themes: [{ metadata: { id: 'custom' } }] });
    await expect((await fetch(`${base}/api/pi/update-check`)).json()).resolves.toEqual({ available: false, currentVersion: '1.0.0' });
    const installResponse = await fetch(`${base}/api/pi/update-install`, { method: 'POST' });
    expect(installResponse.status).toBe(200);
    await expect(installResponse.json()).resolves.toEqual({ success: true, autoRestart: true });
  });

  it('rejects web updates when the current install is not owned by a trusted package manager', async () => {
    const app = express();
    registerPiRuntimeRoutes(app, {
      getPiSessionDaemonRuntime: () => null,
      resolveUpdatePackageManager: () => null,
      updateLauncher: () => { throw new Error('must not run'); },
    });
    server = await listen(app);

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/update-install`, { method: 'POST' });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'This PiChamber copy is not a supported global package-manager install. Run: pichamber update',
    });
  });

  it('generates a task name with the configured small model without exposing model details', async () => {
    const calls = [];
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, {
      getPiSessionDaemonRuntime: () => null,
      settingsStore: {
        read: async () => ({ smallModel: { providerId: 'provider', modelId: 'small' } }),
      },
      smallModelGenerator: async (input) => {
        calls.push(input);
        return { text: 'fix-auth-timeout' };
      },
    });
    server = await listen(app);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/small-model/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: '/repo', prompt: 'Fix the authentication timeout' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ text: 'fix-auth-timeout' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      directory: '/repo',
      model: { providerId: 'provider', modelId: 'small' },
    });
    expect(calls[0].prompt).toContain('Fix the authentication timeout');
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
        return { providers: [{ id: 'provider', label: 'Provider', authenticated: true, secret: 'never-public', models: [{ id: 'model', providerId: 'provider', label: 'Model', contextWindow: 100, supportsThinking: true, thinkingLevels: ['low', 'minimal', 'bad', 'max'] }] }] };
      },
    };
    const app = express();
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/providers`);
    await expect(response.json()).resolves.toEqual({ providers: [{ id: 'provider', label: 'Provider', authenticated: true, models: [{ id: 'model', providerId: 'provider', label: 'Model', contextWindow: 100, supportsThinking: true, thinkingLevels: ['low', 'minimal', 'max'] }] }] });
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
    registerPiRuntimeRoutes(app, {
      getPiSessionDaemonRuntime: () => runtime,
      settingsStore,
      uiSettingsStore: { read: async () => ({}), write: async () => ({}) },
    });
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

  it('projects native resources without exposing daemon filesystem paths', async () => {
    const calls = [];
    const runtime = {
      request: async (command, payload) => {
        calls.push({ command, payload });
        return {
          skills: [{ id: 'skill-1', kind: 'skill', name: 'review', description: 'Review', location: 'global', filePath: '/private/skill/SKILL.md' }],
          prompts: [{ id: 'prompt-1', kind: 'prompt', name: 'review', location: 'project', content: 'Review it', editable: true, filePath: '/private/.pi/prompts/review.md' }],
          agents: [{ id: 'agents-1', kind: 'agents', name: 'AGENTS.md', location: 'global', content: 'Rules', editable: true, filePath: '/private/AGENTS.md' }],
        };
      },
    };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}/api/pi/resources`;
    const listed = await fetch(base);
    await expect(listed.json()).resolves.toEqual({
      skills: [{ id: 'skill-1', kind: 'skill', name: 'review', description: 'Review', location: 'global' }],
      prompts: [{ id: 'prompt-1', kind: 'prompt', name: 'review', location: 'project', content: 'Review it', editable: true }],
      agents: [{ id: 'agents-1', kind: 'agents', name: 'AGENTS.md', location: 'global', content: 'Rules', editable: true }],
    });
    const updated = await fetch(`${base}/agents-1`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'Updated rules' }) });
    expect(updated.status).toBe(200);
    expect(calls).toEqual([{ command: 'resources.list', payload: undefined }, { command: 'resources.update', payload: { resourceId: 'agents-1', content: 'Updated rules' } }]);
  });

  it('uploads opaque attachments and resolves them only across the private prompt adapter', async () => {
    const calls = [];
    const attachmentStore = {
      create: async (input) => ({ id: 'attachment-1', name: input.filename, mime: input.mime, size: 3, expiresAt: 3_600_000, path: '/never-public' }),
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
    await expect(upload.json()).resolves.toEqual({ attachment: { id: 'attachment-1', name: 'note.txt', mime: 'text/plain', size: 3, expiresAt: 3_600_000 } });
    const prompt = await fetch(`${base}/sessions/session-1/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'read this', attachments: [{ id: 'attachment-1' }] }) });
    expect(prompt.status).toBe(202);
    expect(calls).toEqual([{ command: 'sessions.prompt', payload: { sessionId: 'session-1', text: 'read this', attachments: [{ id: 'attachment-1', name: 'note.txt', mime: 'text/plain', size: 3, path: '/private/upload' }] } }]);
  });

  it('streams binary attachments with bounded metadata and deletes unused uploads', async () => {
    const calls = [];
    const attachmentStore = {
      createFromStream: async ({ filename, mime, stream }) => {
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        calls.push({ filename, mime, body: Buffer.concat(chunks).toString('utf8') });
        return { id: 'binary-1', name: filename, mime, size: 5, expiresAt: 4_000 };
      },
      remove: async (id) => calls.push({ removed: id }),
    };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => null, attachmentStore });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}/api/pi/attachments`;

    const upload = await fetch(base, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-PiChamber-Filename': encodeURIComponent('notes ü.txt'),
        'X-PiChamber-Mime': 'text/plain',
      },
      body: 'hello',
    });
    expect(upload.status).toBe(201);
    await expect(upload.json()).resolves.toEqual({
      attachment: { id: 'binary-1', name: 'notes ü.txt', mime: 'text/plain', size: 5, expiresAt: 4_000 },
    });
    expect((await fetch(`${base}/binary-1`, { method: 'DELETE' })).status).toBe(204);
    expect(calls).toEqual([
      { filename: 'notes ü.txt', mime: 'text/plain', body: 'hello' },
      { removed: 'binary-1' },
    ]);
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
      isStreaming: false,
      lifecycle: 'idle',
    });
  });

  it('routes path-selected session operations and projects transcript fields only', async () => {
    const calls = [];
    const detail = {
      session: { id: 'pi-session-4', directory: '/workspace', createdAt: 1, updatedAt: 2, sessionFile: '/private/session.jsonl' },
      messages: [{
        message: { id: 'entry-1', sessionId: 'pi-session-4', directory: '/workspace', role: 'assistant', parentId: 'user-1', text: 'hello', thinking: '', createdAt: 2, error: { code: 'ASSISTANT_ERROR', message: 'provider request timed out' }, secret: 'never-expose' },
        parts: [{ type: 'text', id: 'entry-1:0', index: 0, text: 'hello', privatePath: '/private' }],
      }],
      lastSequence: 9,
      isStreaming: true,
      lifecycle: 'retry',
      retry: { attempt: 2, next: 5_000, message: 'provider request timed out' },
      extensionStatuses: [{ key: 'mode', text: 'mode:economy/xhigh' }],
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
        message: { id: 'entry-1', sessionId: 'pi-session-4', directory: '/workspace', role: 'assistant', parentId: 'user-1', text: 'hello', thinking: '', createdAt: 2, error: { code: 'ASSISTANT_ERROR', message: 'provider request timed out' } },
        parts: [{ type: 'text', id: 'entry-1:0', index: 0, text: 'hello' }],
      }],
      lastSequence: 9,
      isStreaming: true,
      lifecycle: 'retry',
      retry: { attempt: 2, next: 5_000, message: 'provider request timed out' },
      extensionStatuses: [{ key: 'mode', text: 'mode:economy/xhigh' }],
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
        if (command === 'sessions.compact') return { accepted: true };
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
    for (const [suffix, body] of [['abort', {}], ['model', { model: { providerId: 'test', modelId: 'model' } }], ['thinking', { thinking: 'high' }]]) {
      expect((await fetch(`${base}/${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'other', ...body }) })).status).toBe(204);
    }
    expect((await fetch(`${base}/compact`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'other', thinking: 'low' }) })).status).toBe(202);
    const callsBeforeArchive = calls.length;
    expect((await fetch(`${base}/archive`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: false }) })).status).toBe(204);
    expect(calls).toContainEqual({ command: 'archive.set', payload: ['pi-session-7', false] });
    expect(calls.slice(callsBeforeArchive)).toContainEqual({ command: 'sessions.list', payload: undefined });
    expect(calls.slice(callsBeforeArchive)).not.toContainEqual({ command: 'sessions.open', payload: { sessionId: 'pi-session-7' } });
    for (const call of calls.filter((call) => call.command?.startsWith('sessions.') && call.command !== 'sessions.list')) {
      expect(call.payload.sessionId).toBe('pi-session-7');
    }
  });

  it('verifies archive membership against the owning directory', async () => {
    const calls = [];
    const runtime = {
      health: async () => ({ state: 'ready', protocolVersion: 1, capabilities: [] }),
      request: async (command, payload) => {
        calls.push({ command, payload });
        if (command === 'sessions.list') {
          if (payload?.directory === '/other') {
            return { sessions: [{ session: { id: 'foreign-1', directory: '/other', createdAt: 1, updatedAt: 2 }, updatedAt: 2 }] };
          }
          return { sessions: [{ session: { id: 'focused-1', directory: '/focused', createdAt: 1, updatedAt: 2 }, updatedAt: 2 }] };
        }
        return {};
      },
    };
    const archiveSets = [];
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, {
      getPiSessionDaemonRuntime: () => runtime,
      archiveStore: { read: async () => ({}), set: async (...args) => archiveSets.push(args) },
    });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}/api/pi/sessions/foreign-1/archive`;

    // Owning directory succeeds and forwards that directory to the daemon list.
    expect((await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true, directory: '/other' }) })).status).toBe(204);
    expect(archiveSets).toEqual([['foreign-1', true]]);
    expect(calls).toContainEqual({ command: 'sessions.list', payload: { directory: '/other' } });

    // Wrong directory fails membership without writing the sidecar.
    calls.length = 0;
    archiveSets.length = 0;
    const wrong = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true, directory: '/focused' }) });
    expect(wrong.status).not.toBe(204);
    expect(archiveSets).toEqual([]);
    expect(calls).toContainEqual({ command: 'sessions.list', payload: { directory: '/focused' } });
  });

  it('projects daemon file parts for image and attachment history instead of failing the session open', async () => {
    const detail = {
      session: { id: 'pi-session-files', directory: '/workspace', createdAt: 1, updatedAt: 2 },
      messages: [{
        message: { id: 'entry-1', sessionId: 'pi-session-files', directory: '/workspace', role: 'user', text: 'look', createdAt: 2 },
        parts: [
          { type: 'file', id: 'entry-1:image:1', index: 1, mime: 'image/png', url: 'data:image/png;base64,AAA', filename: 'image.png' },
          { type: 'file', id: 'entry-1:attachment:0', index: 0, filename: 'notes.zip' },
          // Degraded, never fatal: oversized/non-data URLs and oversized mime are stripped.
          { type: 'file', id: 'entry-1:image:9', index: 9, mime: 'image/png', url: `data:image/png;base64,${'A'.repeat(9000000)}`, filename: 'huge.png' },
          { type: 'file', id: 'entry-1:image:10', index: 10, mime: 'image/png', url: 'https://example.test/image.png', filename: 'remote.png' },
          { type: 'file', id: 'entry-1:image:11', index: 11, mime: `x/${'y'.repeat(300)}`, filename: 'bad-mime.png' },
        ],
      }],
      lastSequence: 3,
      isStreaming: false,
      lifecycle: 'idle',
    };
    const runtime = {
      health: async () => ({ state: 'ready', protocolVersion: 1, capabilities: [] }),
      request: async (command) => {
        if (command === 'sessions.open') return detail;
        return {};
      },
    };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime, archiveStore: { read: async () => ({}) } });
    server = await listen(app);

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/sessions/pi-session-files`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      session: { id: 'pi-session-files', directory: '/workspace', createdAt: 1, updatedAt: 2 },
      messages: [{
        message: { id: 'entry-1', sessionId: 'pi-session-files', directory: '/workspace', role: 'user', text: 'look', createdAt: 2 },
        parts: [
          { type: 'file', id: 'entry-1:image:1', index: 1, mime: 'image/png', url: 'data:image/png;base64,AAA', filename: 'image.png' },
          { type: 'file', id: 'entry-1:attachment:0', index: 0, filename: 'notes.zip' },
          { type: 'file', id: 'entry-1:image:9', index: 9, mime: 'image/png', filename: 'huge.png' },
          { type: 'file', id: 'entry-1:image:10', index: 10, mime: 'image/png', filename: 'remote.png' },
          { type: 'file', id: 'entry-1:image:11', index: 11, filename: 'bad-mime.png' },
        ],
      }],
      lastSequence: 3,
      isStreaming: false,
      lifecycle: 'idle',
    });
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
        onEvent({ protocolVersion: 1, kind: 'event', event: 'session.snapshot', sequence: 4, payload: { sessionId: 'pi-session-5', directory: '/workspace', isStreaming: true, lifecycle: 'retry', retry: { attempt: 1, next: 4_000, message: 'provider request timed out' }, compaction: { phase: 'running', reason: 'overflow', startedAt: 3_000 }, queue: { steering: 0, followUp: 0 }, lastSequence: 4, endpoint: '/private/socket' } });
        onEvent({ protocolVersion: 1, kind: 'event', event: 'assistant.message.start', sequence: 5, payload: { sessionId: 'pi-session-5', directory: '/workspace', messageId: 'assistant-1', parentId: 'user-1', role: 'assistant', startedAt: 1 } });
        onEvent({ protocolVersion: 1, kind: 'event', event: 'assistant.message.end', sequence: 6, payload: { sessionId: 'pi-session-5', directory: '/workspace', messageId: 'assistant-1', durationMs: 42, continuing: true, error: { code: 'ASSISTANT_ERROR', message: 'provider request timed out' } } });
        onEvent({ protocolVersion: 1, kind: 'event', event: 'session.lifecycle', sequence: 7, payload: { sessionId: 'pi-session-5', directory: '/workspace', state: 'retry', attempt: 2, next: 8_000, message: 'provider request timed out' } });
        onEvent({ protocolVersion: 1, kind: 'event', event: 'session.error', sequence: 8, payload: { sessionId: 'pi-session-5', directory: '/workspace', code: 'ASSISTANT_ERROR', message: 'provider request timed out' } });
        onEvent({ protocolVersion: 1, kind: 'event', event: 'session.tool.start', sequence: 9, payload: { sessionId: 'pi-session-5', directory: '/workspace', toolCallId: 'skill-read', partId: 'assistant-1:tool:skill-read', messageId: 'assistant-1', name: 'read', state: 'running', metadata: { pichamber: { skill: { name: 'review' } } }, privatePath: '/private/skill/SKILL.md' } });
        onEvent({ protocolVersion: 1, kind: 'event', event: 'session.compaction', sequence: 10, payload: { sessionId: 'pi-session-5', directory: '/workspace', phase: 'completed', reason: 'overflow', startedAt: 3_000, completedAt: 9_000, tokensBefore: 120_000, estimatedTokensAfter: 24_000, willRetry: true, privateResult: 'hidden' } });
        return () => {};
      },
    };
    const app = express();
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/events?sessionId=pi-session-5&fromSequence=3`);
    const reader = response.body.getReader();
    const first = await reader.read();
    let text = new TextDecoder().decode(first.value);
    while (!text.includes('"phase":"completed"')) {
      const next = await reader.read();
      if (next.done) break;
      text += new TextDecoder().decode(next.value);
    }
    await reader.cancel();
    expect(text).toContain('"name":"session.snapshot"');
    expect(text).toContain('"lastSequence":4');
    expect(text).toContain('"retry":{"attempt":1,"next":4000,"message":"provider request timed out"}');
    expect(text).toContain('"compaction":{"phase":"running","reason":"overflow","startedAt":3000}');
    expect(text).toContain('"parentId":"user-1"');
    expect(text).toContain('"durationMs":42');
    expect(text).toContain('"continuing":true');
    expect(text).toContain('"state":"retry","attempt":2,"next":8000,"message":"provider request timed out"');
    expect(text).toContain('"message":"provider request timed out"');
    expect(text).toContain('"metadata":{"pichamber":{"skill":{"name":"review"}}}');
    expect(text).toContain('"phase":"completed","reason":"overflow","startedAt":3000,"completedAt":9000,"tokensBefore":120000,"estimatedTokensAfter":24000,"willRetry":true');
    expect(text).not.toContain('privatePath');
    expect(text).not.toContain('privateResult');
    expect(text).not.toContain('/private/socket');
  });

  it('sends named SSE heartbeats that native EventSource clients can observe', async () => {
    const runtime = {
      subscribe: async () => () => {},
    };
    const app = express();
    registerPiRuntimeRoutes(app, {
      getPiSessionDaemonRuntime: () => runtime,
      eventHeartbeatMs: 5,
    });
    server = await listen(app);

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/events`);
    const reader = response.body.getReader();
    let text = '';
    while (!text.includes('event: heartbeat')) {
      const next = await reader.read();
      if (next.done) break;
      text += new TextDecoder().decode(next.value);
    }
    await reader.cancel();

    expect(text).toContain('event: heartbeat\ndata: {}\n\n');
  });

  it('projects session.updated titles onto the public event stream', async () => {
    const runtime = {
      health: async () => ({ state: 'ready', protocolVersion: 1, capabilities: [] }),
      subscribe: async ({ onEvent }) => {
        onEvent({
          protocolVersion: 1,
          kind: 'event',
          event: 'session.updated',
          sequence: 8,
          payload: { sessionId: 'pi-session-5', directory: '/workspace', title: '  Fix the parser  ', endpoint: '/private/socket' },
        });
        return () => {};
      },
    };
    const app = express();
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/events?sessionId=pi-session-5&fromSequence=7`);
    const reader = response.body.getReader();
    const first = await reader.read();
    let text = new TextDecoder().decode(first.value);
    while (!text.includes('"session.updated"')) {
      const next = await reader.read();
      if (next.done) break;
      text += new TextDecoder().decode(next.value);
    }
    await reader.cancel();
    expect(text).toContain('"name":"session.updated"');
    expect(text).toContain('"title":"Fix the parser"');
    expect(text).not.toContain('/private/socket');
  });

  it('projects Pi usage through the public session and event envelopes', async () => {
    const sampleUsage = {
      input: 120, output: 80, cacheRead: 30, cacheWrite: 5, totalTokens: 235,
      cost: { input: 0.0012, output: 0.0024, cacheRead: 0.0003, cacheWrite: 0.0005, total: 0.0044 },
    };
    const runtime = {
      health: async () => ({ state: 'ready', protocolVersion: 1, capabilities: [] }),
      request: async (command) => {
        if (command === 'sessions.open') {
          return {
            session: { id: 'pi-session-usage', directory: '/workspace', createdAt: 0, updatedAt: 0 },
            lastSequence: 1,
            messages: [{
              message: {
                id: 'assistant-usage', sessionId: 'pi-session-usage', directory: '/workspace', role: 'assistant',
                createdAt: 1, text: 'ok', thinking: '',
                model: { providerId: 'test', modelId: 'model' },
                usage: sampleUsage,
              },
              parts: [],
            }],
          };
        }
        throw new Error(`unexpected command: ${command}`);
      },
      subscribe: async ({ onEvent }) => {
        onEvent({ protocolVersion: 1, kind: 'event', event: 'assistant.message.end', sequence: 1, payload: {
          sessionId: 'pi-session-usage', directory: '/workspace', messageId: 'assistant-usage',
          text: 'ok', durationMs: 100, usage: sampleUsage,
        } });
        return () => {};
      },
    };
    const app = express();
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);

    const detail = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/sessions/pi-session-usage`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.messages[0].message.usage).toEqual(sampleUsage);

    const events = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/events?sessionId=pi-session-usage&fromSequence=0`);
    const reader = events.body.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    await reader.cancel();
    expect(text).toContain('"usage"');
    expect(text).toContain('"totalTokens":235');
    expect(text).toContain('"cacheRead":30');
  });

  it('omits Pi usage when the message payload carries a malformed or missing usage record', async () => {
    const runtime = {
      health: async () => ({ state: 'ready', protocolVersion: 1, capabilities: [] }),
      request: async (command) => {
        if (command === 'sessions.open') {
          return {
            session: { id: 'pi-session-usage-malformed', directory: '/workspace', createdAt: 0, updatedAt: 0 },
            lastSequence: 1,
            messages: [{
              message: {
                id: 'assistant-no-usage', sessionId: 'pi-session-usage-malformed', directory: '/workspace', role: 'assistant',
                createdAt: 1, text: 'ok', thinking: '',
                model: { providerId: 'test', modelId: 'model' },
              },
              parts: [],
            }, {
              message: {
                id: 'assistant-bad-usage', sessionId: 'pi-session-usage-malformed', directory: '/workspace', role: 'assistant',
                createdAt: 2, text: 'partial', thinking: '',
                model: { providerId: 'test', modelId: 'model' },
                usage: { input: 'not-a-number', output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null },
              },
              parts: [],
            }],
          };
        }
        throw new Error(`unexpected command: ${command}`);
      },
      subscribe: async ({ onEvent }) => {
        onEvent({ protocolVersion: 1, kind: 'event', event: 'assistant.message.end', sequence: 1, payload: {
          sessionId: 'pi-session-usage-malformed', directory: '/workspace', messageId: 'assistant-no-usage',
          text: 'ok', durationMs: 100,
        } });
        onEvent({ protocolVersion: 1, kind: 'event', event: 'assistant.message.end', sequence: 2, payload: {
          sessionId: 'pi-session-usage-malformed', directory: '/workspace', messageId: 'assistant-bad-usage',
          text: 'partial', durationMs: 100,
          usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 'x', output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } });
        return () => {};
      },
    };
    const app = express();
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);

    const detail = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/sessions/pi-session-usage-malformed`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.messages[0].message.usage).toBeUndefined();
    expect(detailBody.messages[1].message.usage).toBeUndefined();

    const events = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/events?sessionId=pi-session-usage-malformed&fromSequence=0`);
    const reader = events.body.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    await reader.cancel();
    expect(text).not.toContain('"usage"');
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

  it('treats a daemon that never becomes ready as a service failure, not a bad request', async () => {
    const runtime = {
      request: async () => {
        const error = new Error('timeout');
        error.code = 'DAEMON_START_TIMEOUT';
        throw error;
      },
    };
    const app = express();
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/providers`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: { code: 'DAEMON_START_TIMEOUT' } });
  });

  it('treats a daemon lock failure as a service failure', async () => {
    const runtime = {
      request: async () => {
        const error = new Error('lock');
        error.code = 'DAEMON_LOCK_UNAVAILABLE';
        throw error;
      },
    };
    const app = express();
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/resources`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: { code: 'DAEMON_LOCK_UNAVAILABLE' } });
  });

  it('lists Pi prompt templates and extension commands as native slash commands', async () => {
    const calls = [];
    const runtime = {
      request: async (command, payload) => {
        calls.push({ command, payload });
        if (command === 'resources.list') {
          return {
            skills: [],
            prompts: [{ id: 'prompt-1', kind: 'prompt', name: 'review', description: 'Review', location: 'project', content: 'Review', filePath: '/private/review.md' }],
            agents: [],
          };
        }
        return {
          directory: '/workspace',
          extensions: [{ id: 'a1b2c3d4e5f60718', name: 'ext' }],
          commands: [{ name: 'hello', description: 'Say hello', source: 'extension' }],
        };
      },
    };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/commands?directory=/workspace`);
    expect(response.status).toBe(200);
    // Order mirrors Pi SDK getCommands(): extensions, prompts, skills.
    await expect(response.json()).resolves.toEqual({
      directory: '/workspace',
      commands: [
        { name: 'hello', description: 'Say hello', source: 'extension' },
        { name: 'review', description: 'Review', source: 'prompt', scope: 'project' },
      ],
    });
    expect(calls).toEqual([
      { command: 'resources.list', payload: { directory: '/workspace' } },
      { command: 'extensions.list', payload: { directory: '/workspace' } },
    ]);
  });

  it('exposes Pi skills as /skill:name commands (never bare /name)', async () => {
    const runtime = {
      request: async (command) => {
        if (command === 'resources.list') {
          return {
            skills: [{ id: 'skill-1', kind: 'skill', name: 'code-review', description: 'Review', location: 'global' }],
            prompts: [{ id: 'prompt-1', kind: 'prompt', name: 'review', description: 'Review', location: 'global' }],
            agents: [],
          };
        }
        return { directory: '/work', extensions: [], commands: [] };
      },
    };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pi/commands?directory=/work`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      directory: '/work',
      commands: [
        { name: 'review', description: 'Review', source: 'prompt', scope: 'global' },
        { name: 'skill:code-review', description: 'Review', source: 'skill', scope: 'global' },
      ],
    });
  });

  it('stores PiChamber snippets independently of Pi prompt templates', async () => {
    const snippets = [];
    const snippetsStore = {
      list: async (directory) => snippets.filter((snippet) => snippet.scope === 'global' || snippet.directory === directory),
      create: async (input) => {
        const snippet = { id: 'snippet-1', aliases: [], ...input };
        snippets.push(snippet);
        return snippets;
      },
      update: async (id, input) => {
        const snippet = snippets.find((entry) => entry.id === id);
        Object.assign(snippet, input);
        return snippets;
      },
      remove: async (id) => {
        const index = snippets.findIndex((entry) => entry.id === id);
        snippets.splice(index, 1);
        return snippets;
      },
    };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => ({}), snippetsStore });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}/api/pi/snippets`;
    await expect((await fetch(base)).json()).resolves.toEqual({ snippets: [] });
    const created = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'note', content: 'Content', scope: 'global' }),
    });
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toEqual({
      snippets: [{ id: 'snippet-1', aliases: [], name: 'note', content: 'Content', scope: 'global' }],
    });
    const invalid = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad name!', content: 'x', scope: 'global' }),
    });
    expect(invalid.status).toBe(400);
  });

  it('renames snippets and moves scopes by opaque id', async () => {
    const calls = [];
    const snippetsStore = {
      list: async () => [],
      create: async () => [],
      update: async (id, input, directory) => {
        calls.push({ id, input, directory });
        return [];
      },
      remove: async () => [],
    };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => ({}), snippetsStore });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}/api/pi/snippets/s1?directory=/work`;
    const renamed = await fetch(base, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed', scope: 'project', directory: '/work', aliases: ['r'] }),
    });
    expect(renamed.status).toBe(200);
    expect(calls[0]).toMatchObject({ id: 's1', directory: '/work' });
    expect(calls[0].input).toMatchObject({ name: 'renamed', scope: 'project' });
    const bad = await fetch(base, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bad name!' }),
    });
    expect(bad.status).toBe(400);
    const oversized = await fetch(base, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x'.repeat(200_001) }),
    });
    expect([400, 413]).toContain(oversized.status);
    const invalidAliases = await fetch(base, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aliases: ['valid', 'bad alias'] }),
    });
    expect(invalidAliases.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('carries explicit directories for prompt create, update, and delete', async () => {
    const calls = [];
    const runtime = {
      request: async (command, payload) => {
        calls.push({ command, payload });
        return { skills: [], prompts: [], agents: [] };
      },
    };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);
    const base = `http://127.0.0.1:${server.address().port}/api/pi/resources/prompts`;
    const created = await fetch(`${base}?directory=/work`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'review', description: 'Review', content: 'Do $1', location: 'global' }),
    });
    expect(created.status).toBe(201);
    const updated = await fetch(`${base}/prompt-1?directory=/work`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'review2', description: 'Updated' }),
    });
    expect(updated.status).toBe(200);
    const deleted = await fetch(`${base}/prompt-1?directory=/work`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(calls).toEqual([
      { command: 'resources.prompts.create', payload: { name: 'review', description: 'Review', content: 'Do $1', location: 'global', directory: '/work' } },
      { command: 'resources.prompts.update', payload: { resourceId: 'prompt-1', directory: '/work', name: 'review2', description: 'Updated' } },
      { command: 'resources.prompts.delete', payload: { resourceId: 'prompt-1', directory: '/work' } },
    ]);
  });

  it('refreshes /commands after prompt mutations without stale entries', async () => {
    let prompts = [{ id: 'prompt-1', kind: 'prompt', name: 'review', description: 'Review', location: 'global', content: 'Do $1', editable: true }];
    const runtime = {
      request: async (command, payload) => {
        if (command === 'resources.list') {
          return { skills: [], prompts: [...prompts], agents: [] };
        }
        if (command === 'resources.prompts.create') {
          prompts.push({ id: 'prompt-2', kind: 'prompt', name: payload.name, description: payload.description, location: payload.location, content: payload.content, editable: true });
          return { skills: [], prompts: [...prompts], agents: [] };
        }
        if (command === 'resources.prompts.update') {
          prompts = prompts.map((p) => p.id === payload.resourceId ? { ...p, ...(payload.name ? { name: payload.name } : {}) } : p);
          return { skills: [], prompts: [...prompts], agents: [] };
        }
        if (command === 'resources.prompts.delete') {
          prompts = prompts.filter((p) => p.id !== payload.resourceId);
          return { skills: [], prompts: [...prompts], agents: [] };
        }
        if (command === 'extensions.list') {
          return { directory: '/work', extensions: [], commands: [] };
        }
        return { skills: [], prompts: [...prompts], agents: [] };
      },
    };
    const app = express();
    app.use(express.json());
    registerPiRuntimeRoutes(app, { getPiSessionDaemonRuntime: () => runtime });
    server = await listen(app);
    const api = `http://127.0.0.1:${server.address().port}/api/pi`;
    const commandsBefore = await (await fetch(`${api}/commands?directory=/work`)).json();
    expect(commandsBefore.commands.map((c) => c.name)).toContain('review');
    await fetch(`${api}/resources/prompts?directory=/work`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'second', description: 'Second', content: 'Body', location: 'global' }),
    });
    const commandsAfterCreate = await (await fetch(`${api}/commands?directory=/work`)).json();
    expect(commandsAfterCreate.commands.map((c) => c.name).sort()).toEqual(['review', 'second']);
    await fetch(`${api}/resources/prompts/prompt-1?directory=/work`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    const commandsAfterRename = await (await fetch(`${api}/commands?directory=/work`)).json();
    expect(commandsAfterRename.commands.map((c) => c.name)).toContain('renamed');
    expect(commandsAfterRename.commands.map((c) => c.name)).not.toContain('review');
    await fetch(`${api}/resources/prompts/prompt-2?directory=/work`, { method: 'DELETE' });
    const commandsAfterDelete = await (await fetch(`${api}/commands?directory=/work`)).json();
    expect(commandsAfterDelete.commands.map((c) => c.name)).not.toContain('second');
  });
});
