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

describe('session engine router pending input', () => {
  const makeIndex = () => {
    const applied = [];
    const forgotten = [];
    const summaries = new Map();
    return {
      applied,
      forgotten,
      pendingInput: {
        applyEngineSummary: (sessionId, directory, summary) => {
          applied.push({ sessionId, directory, summary });
          summaries.set(sessionId, summary);
        },
        summaryFor: (sessionId) => summaries.get(sessionId) ?? null,
        forgetSession: (sessionId) => {
          forgotten.push(sessionId);
          summaries.delete(sessionId);
        },
      },
    };
  };

  it('folds engine session.input into the index instead of publishing it directly', () => {
    const { pendingInput, applied } = makeIndex();
    const { router, published } = makeRouter({ pendingInput, getSequence: () => 42 });
    router.publish('session.input', { pending: { count: 2, kind: 'exotic', since: 77, extra: true } }, 's1', '/work');
    expect(applied).toEqual([{ sessionId: 's1', directory: '/work', summary: { count: 2, kind: 'input', since: 77 } }]);
    expect(published).toEqual([]);
  });

  it('rejects malformed engine session.input without publishing anything', () => {
    const { pendingInput, applied } = makeIndex();
    const { router, published } = makeRouter({ pendingInput });
    expect(() => router.publish('session.input', { pending: { count: 'many' } }, 's1', '/work')).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => router.publish('session.input', {}, 's1', '/work')).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(applied).toEqual([]);
    expect(published).toEqual([]);
  });

  it('forgets index state before publishing engine session.deleted', () => {
    const { pendingInput, forgotten } = makeIndex();
    const { router, published } = makeRouter({ pendingInput });
    router.publish('session.deleted', {}, 's1', '/work');
    expect(forgotten).toEqual(['s1']);
    expect(published).toEqual([{ event: 'session.deleted', payload: {}, sessionId: 's1', directory: '/work' }]);
  });

  it('stamps engine list rows from the engine value or the index fallback', async () => {
    const { pendingInput } = makeIndex();
    pendingInput.summaryFor = (sessionId) => (sessionId === 'fallback-1' ? { count: 1, kind: 'approval', since: 9 } : null);
    const registry = makeRegistry([]);
    registry.size = 1;
    registry.listSessions = async () => ({
      items: [
        { session: { id: 'engine-1', engine: 'fake' }, inputState: { pending: { count: 3, kind: 'approval', since: 50 } } },
        { session: { id: 'fallback-1', engine: 'fake' } },
        { session: { id: 'broken-1', engine: 'fake' }, inputState: { pending: { count: 'many' } } },
      ],
      failed: [],
    });
    const { router } = makeRouter({ getRegistry: () => registry, pendingInput, getSequence: () => 7 });
    const merged = await router.mergeSessionList([], '/work');
    expect(merged.sessions).toEqual([
      {
        session: { id: 'engine-1', engine: 'fake' },
        inputState: { pending: { count: 3, kind: 'approval', since: 50 }, sequence: 7 },
      },
      {
        session: { id: 'fallback-1', engine: 'fake' },
        inputState: { pending: { count: 1, kind: 'approval', since: 9 }, sequence: 7 },
      },
      {
        session: { id: 'broken-1', engine: 'fake' },
        inputState: { pending: null, sequence: 7 },
      },
    ]);
  });

  it('stamps engine snapshots with daemon-owned inputState after safe fields', async () => {
    const { pendingInput } = makeIndex();
    const engine = makeEngine('fake', {
      ownsSession: () => true,
      snapshot: () => ({ directory: '/work', inputState: { pending: { count: 'many' } }, injected: true }),
    });
    const { router } = makeRouter({
      getRegistry: () => makeRegistry([engine]),
      pendingInput,
      getSequence: () => 7,
    });
    const snapshot = router.snapshotEvent('s1', {});
    expect(snapshot.payload.inputState).toEqual({ pending: null });
    expect(snapshot.payload.injected).toBe(true);

    const valued = makeEngine('valued', {
      ownsSession: () => true,
      snapshot: () => ({ directory: '/work', inputState: { pending: { count: 2, kind: 'approval', since: 11 } } }),
    });
    const { router: valuedRouter } = makeRouter({
      getRegistry: () => makeRegistry([valued]),
      pendingInput,
      getSequence: () => 7,
    });
    expect(valuedRouter.snapshotEvent('s1', {}).payload.inputState).toEqual({
      pending: { count: 2, kind: 'approval', since: 11 },
    });
  });

  it('stamps engine details with the index summary unless the engine supplied a valid one', async () => {
    const { pendingInput } = makeIndex();
    pendingInput.summaryFor = () => ({ count: 1, kind: 'input', since: 5 });
    const engine = makeEngine('fake', {
      ownsSession: (id) => id === 'engine-1',
      handlers: {
        'sessions.open': async () => ({ session: { id: 'engine-1' }, messages: [] }),
        'sessions.messages': async () => ({
          session: { id: 'engine-1' },
          messages: [],
          inputState: { pending: { count: 2, kind: 'approval', since: 9 } },
        }),
      },
    });
    const { router, details } = makeRouter({ getRegistry: () => makeRegistry([engine]), pendingInput });
    await router.dispatch({}, { command: 'sessions.open', requestId: 'r1', payload: { sessionId: 'engine-1' } });
    expect(details[0].detail.inputState).toEqual({ pending: { count: 1, kind: 'input', since: 5 } });
    await router.dispatch({}, { command: 'sessions.messages', requestId: 'r2', payload: { sessionId: 'engine-1' } });
    expect(details[1].detail.inputState).toEqual({ pending: { count: 2, kind: 'approval', since: 9 } });
  });
});

describe('session engine router recent notices', () => {
  const makeNotices = (lists = new Map()) => {
    const recorded = [];
    const forgotten = [];
    return {
      recorded,
      forgotten,
      recentNotices: {
        record: (sessionId, notice) => {
          recorded.push({ sessionId, notice });
          const current = lists.get(sessionId) ?? [];
          current.push(notice);
          lists.set(sessionId, current);
          return notice;
        },
        listFor: (sessionId) => [...(lists.get(sessionId) ?? [])],
        forgetSession: (sessionId) => {
          forgotten.push(sessionId);
          lists.delete(sessionId);
        },
      },
    };
  };

  it('normalizes engine notifications, records them, and publishes the redacted payload', () => {
    const { recentNotices, recorded } = makeNotices();
    const seen = [];
    const { router, published } = makeRouter({
      recentNotices,
      redact: (value) => {
        seen.push(value);
        return value;
      },
    });
    router.publish('extension.notify', {
      id: 'n1', message: 'hello', level: 'warning', createdAt: 42, sessionId: 'sneaky', directory: '/nope',
    }, 's1', '/work');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      sessionId: 's1',
      notice: { id: 'n1', message: 'hello', level: 'warning', createdAt: 42 },
    });
    expect(published).toEqual([
      {
        event: 'extension.notify',
        payload: { id: 'n1', message: 'hello', level: 'warning', createdAt: 42 },
        sessionId: 's1',
        directory: '/work',
      },
    ]);
    // The normalized payload still travels through the redactor.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ id: 'n1', message: 'hello', level: 'warning', createdAt: 42 });
  });

  it('fills id/createdAt, defaults the level, and caps the message', () => {
    const { recentNotices, recorded } = makeNotices();
    const { router, published } = makeRouter({ recentNotices });
    router.publish('extension.notify', { message: 'x'.repeat(2500), level: 'urgent' }, 's1', '/work');
    expect(recorded[0].notice.message).toHaveLength(2000);
    expect(recorded[0].notice.level).toBe('info');
    expect(typeof recorded[0].notice.id).toBe('string');
    expect(recorded[0].notice.id.length).toBeGreaterThan(0);
    expect(Number.isFinite(recorded[0].notice.createdAt)).toBe(true);
    expect(published[0].payload).toEqual(recorded[0].notice);
  });

  it('rejects empty engine notifications without recording or publishing', () => {
    const { recentNotices, recorded } = makeNotices();
    const { router, published } = makeRouter({ recentNotices });
    expect(() => router.publish('extension.notify', { message: '' }, 's1', '/work')).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(() => router.publish('extension.notify', {}, 's1', '/work')).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(recorded).toEqual([]);
    expect(published).toEqual([]);
  });

  it('stamps engine snapshots and details with daemon-owned notices after engine fields', () => {
    const lists = new Map([['engine-1', [{ id: 'n1', level: 'info', message: 'kept', createdAt: 7 }]]]);
    const { recentNotices } = makeNotices(lists);
    const engine = makeEngine('fake', {
      ownsSession: (id) => id === 'engine-1',
      snapshot: () => ({ directory: '/work', extensionNotices: [{ id: 'spoofed' }] }),
      handlers: {
        'sessions.open': async () => ({
          session: { id: 'engine-1' },
          messages: [],
          extensionNotices: [{ id: 'spoofed' }],
        }),
      },
    });
    const { router } = makeRouter({
      getRegistry: () => makeRegistry([engine]),
      recentNotices,
      getSequence: () => 7,
    });
    const snapshot = router.snapshotEvent('engine-1', {});
    expect(snapshot.payload.extensionNotices).toEqual([
      { id: 'n1', level: 'info', message: 'kept', createdAt: 7 },
    ]);
  });

  it('includes an empty notice list on engine details without stored notices', async () => {
    const { recentNotices } = makeNotices();
    const engine = makeEngine('fake', {
      ownsSession: (id) => id === 'engine-1',
      handlers: {
        'sessions.open': async () => ({ session: { id: 'engine-1' }, messages: [] }),
      },
    });
    const { router, details } = makeRouter({
      getRegistry: () => makeRegistry([engine]),
      recentNotices,
    });
    await router.dispatch({}, { command: 'sessions.open', requestId: 'r1', payload: { sessionId: 'engine-1' } });
    expect(details[0].detail.extensionNotices).toEqual([]);
  });

  it('forgets notices before publishing engine session.deleted', () => {
    const lists = new Map([['s1', [{ id: 'n1', level: 'info', message: 'kept', createdAt: 7 }]]]);
    const { recentNotices, forgotten } = makeNotices(lists);
    const { router, published } = makeRouter({ recentNotices });
    router.publish('session.deleted', {}, 's1', '/work');
    expect(forgotten).toEqual(['s1']);
    expect(published).toEqual([{ event: 'session.deleted', payload: {}, sessionId: 's1', directory: '/work' }]);
  });
});
