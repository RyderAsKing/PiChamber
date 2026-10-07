import { describe, expect, it, vi } from 'vitest';

import { ENGINE_UNSUPPORTED_OPERATION } from './session-engines.js';
import { createSessionEngineRouter } from './session-engine-router.js';

const protocolVersion = 1;

const makeRouter = (overrides = {}) => {
  const frames = [];
  const details = [];
  const published = [];
  return {
    frames,
    details,
    published,
    router: createSessionEngineRouter({
      getRegistry: () => undefined,
      resolveDirectory: async (dir) => dir,
      sessionInput: async (payload) => ({ accepted: true, messageId: 'm1' }),
      redact: (value) => value,
      createError: (code, message) => Object.assign(new Error(message), { code }),
      logEngineError: () => {},
      writeFrame: (socket, frame) => { frames.push(frame); },
      writeDetail: (socket, requestId, detail) => { details.push({ requestId, detail }); },
      publish: (event, payload, sessionId, directory) => { published.push({ event, payload, sessionId, directory }); },
      getStreamEpoch: () => 'epoch',
      allocateSequence: (() => { let next = 100; return () => ++next; })(),
      protocolVersion,
      ...overrides,
    }),
  };
};

const makeEngine = (id, overrides = {}) => ({
  id,
  ownsSession: () => false,
  ownsProvider: () => false,
  listSessions: async () => [],
  handlers: {},
  snapshot: () => undefined,
  dispose: async () => {},
  ...overrides,
});

const makeRegistry = (enginesArray) => {
  const byId = new Map(enginesArray.map((engine) => [engine.id, engine]));
  return {
    size: enginesArray.length,
    get: (id) => byId.get(id),
    ownerOfSession: (sessionId, directory) => enginesArray.find((engine) => {
      try {
        return engine.ownsSession(sessionId, directory);
      } catch {
        return false;
      }
    }),
    ownerOfProvider: (providerId) => enginesArray.find((engine) => {
      try {
        return engine.ownsProvider(providerId);
      } catch {
        return false;
      }
    }),
    listSessions: async () => ({ items: [], failed: [] }),
    listProviders: async () => ({ providers: [], failed: [] }),
    describeEngines: () => enginesArray.map((engine) => ({
      id: engine.id,
      label: engine.label ?? engine.id,
      commands: Object.keys(engine.handlers ?? {}).sort(),
    })),
  };
};

describe('session engine router', () => {
  it('refuses to build without a redactor', () => {
    expect(() => createSessionEngineRouter({ getRegistry: () => undefined })).toThrow(TypeError);
  });

  it('returns false on every path when no registry exists', async () => {
    const { router } = makeRouter();
    expect(router.hasEngines()).toBe(false);
    expect(await router.dispatch({}, { command: 'sessions.open', payload: { sessionId: 's1' } })).toBe(false);
    expect(await router.create({}, { command: 'sessions.create', payload: { cwd: '/work' } })).toBe(false);
    expect(router.snapshotEvent('s1')).toBeUndefined();
    expect(router.describe()).toEqual({ engines: [] });
    const merged = await router.mergeSessionList([{ session: { id: 'pi-1' } }], '/work');
    expect(merged).toEqual({ sessions: [{ session: { id: 'pi-1' } }] });
  });

  it('dispatches owned session commands and rejects drafts without touching Pi', async () => {
    const engine = makeEngine('fake', {
      ownsSession: (id) => id === 'engine-1',
      handlers: { 'sessions.open': async () => ({ session: { id: 'engine-1' }, messages: [] }) },
    });
    const { router, details } = makeRouter({ getRegistry: () => makeRegistry([engine]) });
    const handled = await router.dispatch({}, {
      command: 'sessions.open',
      requestId: 'r1',
      payload: { sessionId: 'engine-1' },
    });
    expect(handled).toBe(true);
    expect(details[0].detail.session.engine).toBe('fake');
    await expect(router.dispatch({}, {
      command: 'extensions.draft',
      payload: { sessionId: 'engine-1' },
    })).rejects.toMatchObject({ code: ENGINE_UNSUPPORTED_OPERATION });
  });

  it('throws unsupported automatically when the handler is missing', async () => {
    const engine = makeEngine('fake', {
      ownsSession: () => true,
      handlers: {},
    });
    const { router } = makeRouter({ getRegistry: () => makeRegistry([engine]) });
    await expect(router.dispatch({}, {
      command: 'sessions.tree',
      requestId: 'r1',
      payload: { sessionId: 's1' },
    })).rejects.toMatchObject({ code: ENGINE_UNSUPPORTED_OPERATION });
  });

  it('redacts engine detail results and event payloads', async () => {
    const path = '/tmp/pi-clipboard-7f7ec702-256a-4783-855c-df34e3ecedab.pdf';
    const redact = (value) => {
      if (typeof value === 'string') return value.split(path).join('[attachment]');
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
      }
      return value;
    };
    const engine = makeEngine('fake', {
      ownsSession: () => true,
      handlers: {
        'sessions.open': async () => ({
          session: { id: 's1', title: `Opened ${path}` },
          messages: [],
        }),
      },
    });
    const { router, details, published } = makeRouter({
      getRegistry: () => makeRegistry([engine]),
      redact,
    });
    await router.dispatch({}, { command: 'sessions.open', requestId: 'r1', payload: { sessionId: 's1' } });
    expect(JSON.stringify(details[0].detail)).not.toContain('pi-clipboard-');
    router.publish('session.updated', { title: `t ${path}` }, 's1', '/work');
    expect(JSON.stringify(published[0].payload)).not.toContain('pi-clipboard-');
  });

  it('stamps create targets and rejects explicit engines without a create handler', async () => {
    const withCreate = makeEngine('with-create', {
      handlers: { 'sessions.create': async (payload) => ({ session: { id: 'new-1', directory: payload.cwd } }) },
    });
    const withoutCreate = makeEngine('no-create', { handlers: {} });
    const registry = makeRegistry([withCreate, withoutCreate]);
    const { router, details } = makeRouter({
      getRegistry: () => registry,
      resolveDirectory: async (dir) => dir,
    });
    const handled = await router.create({}, {
      command: 'sessions.create',
      requestId: 'r1',
      payload: { cwd: '/work', engine: 'with-create' },
    });
    expect(handled).toBe(true);
    expect(details[0].detail.session.engine).toBe('with-create');
    await expect(router.create({}, {
      command: 'sessions.create',
      requestId: 'r2',
      payload: { cwd: '/work', engine: 'no-create' },
    })).rejects.toMatchObject({ code: ENGINE_UNSUPPORTED_OPERATION });
  });

  it('skips provider routing for engines without a create handler and falls back to Pi', async () => {
    const engine = makeEngine('no-create', {
      ownsProvider: (id) => id === 'owned',
      handlers: {},
    });
    const { router } = makeRouter({ getRegistry: () => makeRegistry([engine]) });
    expect(await router.create({}, {
      command: 'sessions.create',
      requestId: 'r1',
      payload: { cwd: '/work', model: { providerId: 'owned' } },
    })).toBe(false);
  });

  it('rejects unknown explicit engines even with zero engines', async () => {
    const { router } = makeRouter({ getRegistry: () => makeRegistry([]) });
    await expect(router.create({}, {
      command: 'sessions.create',
      requestId: 'r1',
      payload: { cwd: '/work', engine: 'nope' },
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('merges session lists after Pi rows and marks collisions as incomplete', async () => {
    const registry = makeRegistry([]);
    registry.size = 1;
    registry.listSessions = async () => ({
      items: [
        { session: { id: 'engine-1', engine: 'fake' } },
        { session: { id: 'pi-1', engine: 'fake' } },
      ],
      failed: ['broken'],
    });
    const { router } = makeRouter({ getRegistry: () => registry });
    const merged = await router.mergeSessionList([{ session: { id: 'pi-1' } }], '/work');
    expect(merged.sessions.map((item) => item.session.id)).toEqual(['pi-1', 'engine-1']);
    expect(merged.incompleteEngines.sort()).toEqual(['broken', 'fake']);
  });

  it('merges providers after Pi rows and strips attribution', async () => {
    const registry = makeRegistry([]);
    registry.size = 1;
    registry.listProviders = async () => ({
      providers: [{ id: 'engine-prov', label: 'E', authenticated: true, models: [], engine: 'fake' }],
      failed: [],
    });
    const { router } = makeRouter({ getRegistry: () => registry });
    const merged = await router.mergeProviders({ providers: [{ id: 'pi-prov' }] });
    expect(merged.providers).toEqual([
      { id: 'pi-prov' },
      { id: 'engine-prov', label: 'E', authenticated: true, models: [] },
    ]);
  });

  it('builds snapshot payloads with redacted fields and daemon-owned framing', async () => {
    const path = '/tmp/pi-clipboard-7f7ec702-256a-4783-855c-df34e3ecedab.pdf';
    const redact = (value) => {
      if (typeof value === 'string') return value.split(path).join('[attachment]');
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
      }
      return value;
    };
    const engine = makeEngine('fake', {
      ownsSession: () => true,
      snapshot: () => ({ directory: '/work', note: `n ${path}` }),
    });
    const allocateSequence = vi.fn(() => 101);
    const { router } = makeRouter({
      getRegistry: () => makeRegistry([engine]),
      redact,
      allocateSequence,
    });
    const snapshot = router.snapshotEvent('s1', {});
    expect(snapshot.sequence).toBe(101);
    expect(snapshot.payload.sessionId).toBe('s1');
    expect(snapshot.payload.directory).toBe('/work');
    expect(JSON.stringify(snapshot.payload)).not.toContain('pi-clipboard-');
    expect(allocateSequence).toHaveBeenCalledTimes(1);
  });

  it('requires an absolute directory for engine event publication', () => {
    const publish = vi.fn();
    const allocateSequence = vi.fn(() => 101);
    const { router } = makeRouter({ publish, allocateSequence });
    expect(() => router.publish('session.updated', { title: 't' }, 's1')).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => router.publish('session.updated', { title: 't' }, 's1', '')).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => router.publish('session.updated', { title: 't' }, 's1', 'relative/path')).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(publish).not.toHaveBeenCalled();
    expect(allocateSequence).not.toHaveBeenCalled();
  });

  it('passes an absolute directory through to publish', () => {
    const { router, published } = makeRouter();
    router.publish('session.updated', { title: 't' }, 's1', '/work/dir');
    expect(published).toEqual([
      { event: 'session.updated', payload: { title: 't' }, sessionId: 's1', directory: '/work/dir' },
    ]);
  });

  it('returns undefined without consuming a sequence when the snapshot lacks an absolute directory', () => {
    const engine = makeEngine('fake', {
      ownsSession: () => true,
      snapshot: () => ({ note: 'no directory here' }),
    });
    const allocateSequence = vi.fn(() => 101);
    const { router } = makeRouter({
      getRegistry: () => makeRegistry([engine]),
      allocateSequence,
    });
    expect(router.snapshotEvent('s1', {})).toBeUndefined();
    expect(allocateSequence).not.toHaveBeenCalled();
  });

  it('returns undefined without consuming a sequence for relative snapshot directories', () => {
    const engine = makeEngine('fake', {
      ownsSession: () => true,
      snapshot: () => ({ directory: 'relative/path' }),
    });
    const allocateSequence = vi.fn(() => 101);
    const { router } = makeRouter({
      getRegistry: () => makeRegistry([engine]),
      allocateSequence,
    });
    expect(router.snapshotEvent('s1', {})).toBeUndefined();
    expect(allocateSequence).not.toHaveBeenCalled();
  });
});
