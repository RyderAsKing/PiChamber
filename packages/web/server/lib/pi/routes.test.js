import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';

import { registerPiRuntimeRoutes } from './routes.js';

const listen = (app) => new Promise((resolve, reject) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
  server.once('error', reject);
});

const close = (server) => new Promise((resolve, reject) => {
  if (!server) return resolve();
  server.close((error) => error ? reject(error) : resolve());
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
