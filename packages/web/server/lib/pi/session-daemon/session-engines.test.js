import { describe, expect, it } from 'vitest';

import {
  ENGINE_HANDLER_COMMANDS,
  ENGINE_SESSION_COMMANDS,
  ENGINE_UNSUPPORTED_OPERATION,
  createSessionEngineRegistry,
  engineCommandsOf,
  isValidEngineId,
  isValidEngineLabel,
  logSessionEngineError,
} from './session-engines.js';

const host = { publish: () => {}, streamEpoch: 'epoch', agentDir: '/agent', dataDir: '/data' };

// Redaction is mandatory; tests that do not exercise it pass an identity.
const createRegistry = (options) => createSessionEngineRegistry({ redact: (value) => value, ...options });

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

const validRow = (id) => ({
  session: { id, directory: '/elsewhere', createdAt: 10, updatedAt: 20 },
  preview: 'hello',
  updatedAt: 20,
});

describe('session engine registry', () => {
  it('refuses to build without a redactor', async () => {
    await expect(createSessionEngineRegistry({ host, factories: [] })).rejects.toThrow(TypeError);
  });

  it('rejects the reserved pi id and invalid ids as programming errors', async () => {
    for (const badId of ['pi', 'Bad Id', '', 'UPPER', '0lead', 'a'.repeat(33), 42, undefined]) {
      await expect(createRegistry({
        host,
        factories: [() => makeEngine(badId)],
      })).rejects.toMatchObject({ code: 'INVALID_ENGINE' });
    }
    expect(isValidEngineId('example-engine')).toBe(true);
    expect(isValidEngineId('pi')).toBe(false);
    expect(isValidEngineId('Bad Id')).toBe(false);
  });

  it('rejects engines with an invalid shape', async () => {
    const broken = makeEngine('broken');
    delete broken.dispose;
    await expect(createRegistry({ host, factories: [() => broken] }))
      .rejects.toMatchObject({ code: 'INVALID_ENGINE' });

    const badProviders = makeEngine('bad-providers', { listProviders: 'nope' });
    await expect(createRegistry({ host, factories: [() => badProviders] }))
      .rejects.toMatchObject({ code: 'INVALID_ENGINE' });
  });

  it('rejects invalid handler maps and labels as programming errors', async () => {
    const missing = makeEngine('missing-handlers');
    delete missing.handlers;
    await expect(createRegistry({ host, factories: [() => missing] }))
      .rejects.toMatchObject({ code: 'INVALID_ENGINE' });

    await expect(createRegistry({
      host,
      factories: [() => makeEngine('unknown-command', { handlers: { 'sessions.list': async () => ({}) } })],
    })).rejects.toMatchObject({ code: 'INVALID_ENGINE' });

    await expect(createRegistry({
      host,
      factories: [() => makeEngine('non-function', { handlers: { 'sessions.open': 'nope' } })],
    })).rejects.toMatchObject({ code: 'INVALID_ENGINE' });

    for (const badLabel of ['', 'x'.repeat(65), 42]) {
      await expect(createRegistry({
        host,
        factories: [() => makeEngine('bad-label', { label: badLabel })],
      })).rejects.toMatchObject({ code: 'INVALID_ENGINE' });
    }
    expect(isValidEngineLabel('Friendly')).toBe(true);
    expect(isValidEngineLabel('')).toBe(false);
    expect(isValidEngineLabel('x'.repeat(65))).toBe(false);
  });

  it('describes engines with defaulted labels and sorted commands', async () => {
    const registry = await createRegistry({
      host,
      factories: [
        () => makeEngine('b-engine', {
          label: 'Bee',
          handlers: {
            'sessions.prompt': async () => ({}),
            'sessions.open': async () => ({}),
            'sessions.create': async () => ({}),
          },
        }),
        () => makeEngine('a-engine', { handlers: { 'sessions.tree': async () => ({}) } }),
      ],
    });
    expect(registry.describeEngines()).toEqual([
      { id: 'b-engine', label: 'Bee', commands: ['sessions.create', 'sessions.open', 'sessions.prompt'] },
      { id: 'a-engine', label: 'a-engine', commands: ['sessions.tree'] },
    ]);
    expect(engineCommandsOf(registry.get('b-engine'))).toEqual(['sessions.create', 'sessions.open', 'sessions.prompt']);
  });

  it('rejects duplicate ids and disposes already-created engines first', async () => {
    const disposed = [];
    const first = makeEngine('dup', { dispose: async () => { disposed.push('first'); } });
    await expect(createRegistry({
      host,
      factories: [() => first, () => makeEngine('dup')],
    })).rejects.toMatchObject({ code: 'INVALID_ENGINE' });
    expect(disposed).toEqual(['first']);
  });

  it('skips a factory that throws so the daemon still starts', async () => {
    const seen = [];
    const registry = await createRegistry({
      host,
      logger: (...args) => seen.push(args),
      factories: [
        () => { throw Object.assign(new Error('boom'), { code: 'FACTORY_BOOM' }); },
        () => makeEngine('healthy'),
      ],
    });
    expect(registry.size).toBe(1);
    expect(registry.get('healthy')?.id).toBe('healthy');
    expect(seen).toEqual([['unknown', 'factory-failed', 'FACTORY_BOOM']]);
  });

  it('resolves ownership in registration order', async () => {
    const registry = await createRegistry({
      host,
      factories: [
        () => makeEngine('first', {
          ownsSession: (sessionId) => sessionId === 'shared',
          ownsProvider: (providerId) => providerId === 'prov',
        }),
        () => makeEngine('second', {
          ownsSession: (sessionId) => sessionId === 'shared' || sessionId === 'only-second',
          ownsProvider: () => true,
        }),
      ],
    });
    expect(registry.ownerOfSession('shared')?.id).toBe('first');
    expect(registry.ownerOfSession('only-second')?.id).toBe('second');
    expect(registry.ownerOfSession('missing')).toBeUndefined();
    expect(registry.ownerOfSession('')).toBeUndefined();
    expect(registry.ownerOfProvider('prov')?.id).toBe('first');
    expect(registry.ownerOfProvider('other')?.id).toBe('second');
  });

  it('treats a throwing ownsSession as not owned and logs it', async () => {
    const seen = [];
    const registry = await createRegistry({
      host,
      logger: (...args) => seen.push(args),
      factories: [
        () => makeEngine('thrower', {
          ownsSession: () => { throw Object.assign(new Error('secret-index-failure'), { code: 'INDEX_BROKEN' }); },
        }),
        () => makeEngine('fallback', { ownsSession: () => true }),
      ],
    });
    expect(registry.ownerOfSession('anything')?.id).toBe('fallback');
    expect(seen).toEqual([['thrower', 'owns-failed', 'INDEX_BROKEN']]);
    expect(JSON.stringify(seen)).not.toContain('secret-index-failure');
  });

  it('isolates throwing, timed-out, and malformed listings while keeping healthy rows tagged', async () => {
    const seen = [];
    const registry = await createRegistry({
      host,
      logger: (...args) => seen.push(args),
      listTimeoutMs: 20,
      factories: [
        () => makeEngine('healthy', { listSessions: async () => [validRow('healthy-1')] }),
        () => makeEngine('thrower', {
          listSessions: async () => { throw Object.assign(new Error('super-secret-list-message'), { code: 'LIST_BROKEN' }); },
        }),
        () => makeEngine('slow', { listSessions: () => new Promise(() => {}) }),
        () => makeEngine('malformed', { listSessions: async () => [{ session: { id: '', createdAt: 1, updatedAt: 2 }, updatedAt: 2 }] }),
      ],
    });
    const { items, failed } = await registry.listSessions('/requested');
    expect(items).toEqual([{
      session: { id: 'healthy-1', directory: '/requested', createdAt: 10, updatedAt: 20, engine: 'healthy' },
      preview: 'hello',
      updatedAt: 20,
    }]);
    expect(failed.sort()).toEqual(['malformed', 'slow', 'thrower']);
    expect(JSON.stringify(seen)).not.toContain('super-secret-list-message');
    expect(seen.map((entry) => [entry[0], entry[1]]).sort()).toEqual([
      ['malformed', 'list-failed'],
      ['slow', 'list-failed'],
      ['thrower', 'list-failed'],
    ]);
  });

  it('aborts the listing signal when the per-engine timeout fires', async () => {
    const seen = [];
    const registry = await createRegistry({
      host,
      listTimeoutMs: 20,
      factories: [
        () => makeEngine('slow', {
          listSessions: (_directory, { signal } = {}) => new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error('should have timed out first')), 200);
            signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              seen.push(signal.aborted);
            });
          }),
        }),
      ],
    });
    const { items, failed } = await registry.listSessions('/requested');
    expect(items).toEqual([]);
    expect(failed).toEqual(['slow']);
    expect(seen).toEqual([true]);
  });

  it('shares one in-flight sessions listing per directory across concurrent callers', async () => {
    let calls = 0;
    const registry = await createRegistry({
      host,
      factories: [
        () => makeEngine('shared', {
          listSessions: async () => {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return [validRow('shared-1')];
          },
        }),
      ],
    });
    const [first, second] = await Promise.all([
      registry.listSessions('/shared'),
      registry.listSessions('/shared'),
    ]);
    expect(calls).toBe(1);
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    await registry.listSessions('/shared');
    expect(calls).toBe(2);
  });

  it('shares one in-flight providers listing across concurrent callers', async () => {
    let calls = 0;
    const good = { id: 'prov', label: 'Prov', authenticated: true, models: [] };
    const registry = await createRegistry({
      host,
      factories: [
        () => makeEngine('shared', {
          listProviders: async () => {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { providers: [good] };
          },
        }),
      ],
    });
    const [first, second] = await Promise.all([registry.listProviders(), registry.listProviders()]);
    expect(calls).toBe(1);
    expect(first.providers).toHaveLength(1);
    expect(second.providers).toHaveLength(1);
  });

  it('redacts engine list and provider rows through the injected redactor', async () => {
    const path = '/tmp/pi-clipboard-7f7ec702-256a-4783-855c-df34e3ecedab.pdf';
    const redact = (value) => {
      if (typeof value === 'string') return value.split(path).join('[attachment]');
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
      }
      return value;
    };
    const registry = await createRegistry({
      host,
      redact,
      factories: [
        () => makeEngine('redacted', {
          listSessions: async () => [{
            session: { id: 's1', directory: '/elsewhere', title: `Opened ${path}`, createdAt: 10, updatedAt: 20 },
            preview: `preview ${path}`,
            updatedAt: 20,
          }],
          listProviders: async () => ({
            providers: [{ id: 'prov', label: `label ${path}`, authenticated: true, models: [] }],
          }),
        }),
      ],
    });
    const sessions = await registry.listSessions('/requested');
    expect(JSON.stringify(sessions.items)).not.toContain('pi-clipboard-');
    expect(sessions.items[0].preview).toContain('[attachment]');
    const providers = await registry.listProviders();
    expect(JSON.stringify(providers.providers)).not.toContain('pi-clipboard-');
  });

  it('drops every row of an engine with one malformed row', async () => {
    const registry = await createRegistry({
      host,
      factories: [() => makeEngine('mixed', {
        listSessions: async () => [validRow('good'), { session: { id: 'bad' }, updatedAt: 1 }],
      })],
    });
    const { items, failed } = await registry.listSessions('/requested');
    expect(items).toEqual([]);
    expect(failed).toEqual(['mixed']);
  });

  it('isolates provider failures and validates provider shape', async () => {
    const good = { id: 'prov', label: 'Prov', authenticated: true, models: [] };
    const registry = await createRegistry({
      host,
      listTimeoutMs: 20,
      factories: [
        () => makeEngine('with-providers', { listProviders: async () => ({ providers: [good] }) }),
        () => makeEngine('array-shape', { listProviders: async () => [good] }),
        () => makeEngine('none'),
        () => makeEngine('bad-shape', { listProviders: async () => ({ providers: [{ id: 'x' }] }) }),
        () => makeEngine('rejects', { listProviders: async () => { throw new Error('nope'); } }),
      ],
    });
    const { providers, failed } = await registry.listProviders();
    expect(providers).toEqual([
      { ...good, engine: 'with-providers' },
      { ...good, engine: 'array-shape' },
    ]);
    expect(failed.sort()).toEqual(['bad-shape', 'rejects']);
  });

  it('disposes every engine even when one throws, then rejects with an AggregateError', async () => {
    const disposed = [];
    const registry = await createRegistry({
      host,
      factories: [
        () => makeEngine('first', { dispose: async () => { disposed.push('first'); } }),
        () => makeEngine('failing', {
          dispose: async () => {
            disposed.push('failing');
            throw Object.assign(new Error('cannot stop'), { code: 'DISPOSE_BROKEN' });
          },
        }),
        () => makeEngine('last', { dispose: async () => { disposed.push('last'); } }),
      ],
    });
    await expect(registry.disposeAll()).rejects.toBeInstanceOf(AggregateError);
    expect(disposed).toEqual(['first', 'failing', 'last']);
  });

  it('never logs error messages, only id, event, and code', () => {
    const seen = [];
    const secret = 'sk-live-super-secret-token-12345';
    logSessionEngineError((...args) => seen.push(args), 'fake', 'list-failed', new Error(secret));
    logSessionEngineError((...args) => seen.push(args), 'fake', 'list-failed', { code: 'EVIL\nINJECTION', message: secret });
    expect(seen).toEqual([['fake', 'list-failed', 'UNKNOWN'], ['fake', 'list-failed', 'UNKNOWN']]);
    expect(JSON.stringify(seen)).not.toContain(secret);
  });

  it('exposes the routed session command set without pi-only commands', () => {
    expect(ENGINE_SESSION_COMMANDS.has('sessions.prompt')).toBe(true);
    expect(ENGINE_SESSION_COMMANDS.has('sessions.open')).toBe(true);
    expect(ENGINE_SESSION_COMMANDS.has('sessions.compact')).toBe(true);
    expect(ENGINE_SESSION_COMMANDS.has('sessions.list')).toBe(false);
    expect(ENGINE_SESSION_COMMANDS.has('sessions.create')).toBe(false);
    expect(ENGINE_SESSION_COMMANDS.has('sessions.sendReceipt')).toBe(false);
    expect(ENGINE_SESSION_COMMANDS.has('extensions.draft')).toBe(false);
    expect(ENGINE_HANDLER_COMMANDS.has('sessions.create')).toBe(true);
    expect(ENGINE_HANDLER_COMMANDS.has('sessions.prompt')).toBe(true);
    expect(ENGINE_HANDLER_COMMANDS.has('sessions.list')).toBe(false);
    expect(ENGINE_UNSUPPORTED_OPERATION).toBe('ENGINE_UNSUPPORTED_OPERATION');
  });
});
