import { EventEmitter } from 'events';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mintOutsideFileGrant, registerFsRoutes } from './routes.js';

const createRouteRegistry = () => {
  const routes = new Map();
  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;
  const headers = new Map();
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    type() {
      return this;
    },
    send(payload) {
      body = payload;
      return this;
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

// Fake child process: emits the configured stdout then closes with the given code.
const createSpawn = ({ stdoutByCommand = {}, exitCode = 0 } = {}) => {
  const calls = [];
  const spawn = vi.fn((_shell, args) => {
    const command = args[args.length - 1];
    calls.push(command);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      const out = stdoutByCommand[command];
      if (out) child.stdout.emit('data', Buffer.from(out));
      child.emit('close', exitCode, null);
    });
    return child;
  });
  return { spawn, calls };
};

const createDeferredSpawn = ({ stdoutByCommand = {}, exitCode = 0 } = {}) => {
  const calls = [];
  const pending = [];
  const spawn = vi.fn((_shell, args) => {
    const command = args[args.length - 1];
    calls.push(command);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    pending.push({ child, command });
    return child;
  });
  const closeNext = () => {
    const entry = pending.shift();
    if (!entry) return;
    const out = stdoutByCommand[entry.command];
    if (out) entry.child.stdout.emit('data', Buffer.from(out));
    entry.child.emit('close', exitCode, null);
  };
  return { spawn, calls, closeNext };
};

const registerExec = ({ spawn }) => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path,
    fsPromises: {
      realpath: async (targetPath) => targetPath,
      stat: async () => ({ isDirectory: () => true }),
    },
    spawn,
    crypto: { randomUUID: (() => { let n = 0; return () => `job-${n++}`; })() },
    normalizeDirectoryPath: (p) => p,
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    pichamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('POST', '/api/fs/exec');
};

const registerWrite = (fsPromises) => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: async (targetPath) => targetPath,
      ...fsPromises,
    },
    spawn: vi.fn(),
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (p) => p,
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    pichamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('POST', '/api/fs/write');
};

const registerRead = (fsPromises) => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: async (targetPath) => targetPath,
      ...fsPromises,
    },
    spawn: vi.fn(),
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (p) => p,
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    pichamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('GET', '/api/fs/read');
};

const registerRaw = (fsPromises) => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: async (targetPath) => targetPath,
      ...fsPromises,
    },
    spawn: vi.fn(),
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (p) => p,
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    pichamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('GET', '/api/fs/raw');
};

const registerMkdir = (fsPromises) => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: async (targetPath) => targetPath,
      ...fsPromises,
    },
    spawn: vi.fn(),
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (p) => p,
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    pichamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('POST', '/api/fs/mkdir');
};

const registerClone = ({ fsPromises, spawn }) => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: async (targetPath) => targetPath,
      ...fsPromises,
    },
    spawn,
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (p) => p,
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    pichamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('POST', '/api/fs/clone');
};

const registerFind = ({ fsPromises, spawn, resolveProjectDirectory = async () => ({ directory: '/repo' }) }) => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: async (targetPath) => targetPath,
      stat: async () => ({ isDirectory: () => true }),
      ...fsPromises,
    },
    spawn,
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (p) => p,
    resolveProjectDirectory,
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    pichamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('GET', '/api/fs/find');
};

const registerReveal = ({ fsPromises, spawn, platform = 'linux' }) => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: async (targetPath) => targetPath,
      ...fsPromises,
    },
    spawn,
    platform,
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (p) => p,
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    pichamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('POST', '/api/fs/reveal');
};

const callExec = async (handler, body) => {
  const res = createMockResponse();
  await handler({ body }, res);
  return res;
};

const callWrite = async (handler, body) => {
  const res = createMockResponse();
  await handler({ body }, res);
  return res;
};

const callRead = async (handler, query) => {
  const res = createMockResponse();
  await handler({ query }, res);
  return res;
};

const callRaw = async (handler, query) => {
  const res = createMockResponse();
  await handler({ query }, res);
  return res;
};

const callMkdir = async (handler, body) => {
  const res = createMockResponse();
  await handler({ body }, res);
  return res;
};

const callClone = async (handler, body) => {
  const res = createMockResponse();
  await handler({ body }, res);
  return res;
};

const callReveal = async (handler, body) => {
  const res = createMockResponse();
  await handler({ body }, res);
  return res;
};

describe('fs write', () => {
  it('does not rewrite a file when content is unchanged', async () => {
    const fsPromises = {
      stat: vi.fn(async () => ({ isFile: () => true, size: 4, mtimeMs: 1000 })),
      readFile: vi.fn(async () => 'same'),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
    };
    const handler = registerWrite(fsPromises);

    const res = await callWrite(handler, { path: '/repo/file.txt', content: 'same' });

    expect(res.body).toMatchObject({ success: true, path: '/repo/file.txt', noop: true });
    expect(typeof res.body.revision).toBe('string');
    expect(res.body.revision.startsWith('v1:')).toBe(true);
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });

  it('writes a file when content changed', async () => {
    const fsPromises = {
      stat: vi.fn(async () => ({ isFile: () => true, size: 3, mtimeMs: 1000 })),
      readFile: vi.fn(async () => 'old'),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    };
    const handler = registerWrite(fsPromises);

    const res = await callWrite(handler, { path: '/repo/file.txt', content: 'new' });

    expect(res.body).toMatchObject({ success: true, path: '/repo/file.txt' });
    expect(typeof res.body.revision).toBe('string');
    expect(fsPromises.mkdir).toHaveBeenCalledWith('/repo', { recursive: true });
    const tmp = fsPromises.writeFile.mock.calls[0][0];
    expect(tmp).toMatch(/^\/repo\/file\.txt\.tmp-/);
    expect(fsPromises.writeFile).toHaveBeenCalledWith(tmp, 'new', 'utf8');
    expect(fsPromises.rename).toHaveBeenCalledWith(tmp, '/repo/file.txt');
    expect(fsPromises.unlink).not.toHaveBeenCalled();
  });

  it('writes through existing symlinks without replacing the link', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => {
        if (targetPath === '/repo/link.txt') return '/repo/target.txt';
        return targetPath;
      }),
      stat: vi.fn(async () => ({ isFile: () => true, size: 3, mtimeMs: 1000 })),
      readFile: vi.fn(async () => 'old'),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    };
    const handler = registerWrite(fsPromises);

    const res = await callWrite(handler, { path: '/repo/link.txt', content: 'new' });

    expect(res.body).toMatchObject({ success: true, path: '/repo/link.txt' });
    expect(fsPromises.readFile).toHaveBeenCalledWith('/repo/target.txt', 'utf8');
    const tmp = fsPromises.writeFile.mock.calls[0][0];
    expect(tmp).toMatch(/^\/repo\/target\.txt\.tmp-/);
    expect(fsPromises.rename).toHaveBeenCalledWith(tmp, '/repo/target.txt');
    expect(fsPromises.rename).not.toHaveBeenCalledWith(expect.any(String), '/repo/link.txt');
  });

  it('rejects existing symlinks that resolve outside the workspace', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => {
        if (targetPath === '/repo/link.txt') return '/outside/target.txt';
        return targetPath;
      }),
      stat: vi.fn(async () => ({ isFile: () => true, size: 3, mtimeMs: 1000 })),
      readFile: vi.fn(async () => 'old'),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    };
    const handler = registerWrite(fsPromises);

    const res = await callWrite(handler, { path: '/repo/link.txt', content: 'new' });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Access denied' });
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
    expect(fsPromises.rename).not.toHaveBeenCalled();
  });
});

describe('fs file-save revisions (finding #8)', () => {
  const createMemoryFs = (initial = {}) => {
    const store = new Map(Object.entries(initial));
    let mtimeSeq = 1000;
    const calls = { chmod: [] };
    const enoent = () => Object.assign(new Error('not found'), { code: 'ENOENT' });
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async (targetPath) => {
        if (!store.has(targetPath)) throw enoent();
        const content = store.get(targetPath) ?? '';
        return {
          isFile: () => true,
          size: Buffer.byteLength(content, 'utf8'),
          mtimeMs: 1000 + (store.get(`${targetPath}:mtime`) ?? 0),
          mode: 0o100600,
        };
      }),
      readFile: vi.fn(async (targetPath, encoding) => {
        if (!store.has(targetPath)) throw enoent();
        const content = store.get(targetPath) ?? '';
        if (encoding === undefined || Buffer.isBuffer(content)) return Buffer.from(content, 'utf8');
        return content;
      }),
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (targetPath, content) => {
        store.set(targetPath, typeof content === 'string' ? content : String(content));
      }),
      chmod: vi.fn(async (targetPath, mode) => {
        calls.chmod.push([targetPath, mode]);
      }),
      rename: vi.fn(async (tmp, dest) => {
        if (!store.has(tmp)) throw enoent();
        store.set(dest, store.get(tmp));
        store.delete(tmp);
        store.set(`${dest}:mtime`, (store.get(`${dest}:mtime`) ?? 0) + 1);
        mtimeSeq += 1;
      }),
      unlink: vi.fn(async (targetPath) => {
        store.delete(targetPath);
      }),
      rm: vi.fn(async (targetPath) => {
        store.delete(targetPath);
        store.delete(`${targetPath}:mtime`);
      }),
    };
    const externalWrite = (targetPath, content) => {
      store.set(targetPath, content);
      store.set(`${targetPath}:mtime`, (store.get(`${targetPath}:mtime`) ?? 0) + 7);
    };
    const externalDelete = (targetPath) => {
      store.delete(targetPath);
      store.delete(`${targetPath}:mtime`);
    };
    return { store, fsPromises, calls, externalWrite, externalDelete };
  };

  const registerReadWrite = (fsPromises) => {
    const { app, getRoute } = createRouteRegistry();
    registerFsRoutes(app, {
      os: { homedir: () => '/home/user' },
      path: path.posix,
      fsPromises: { realpath: async (p) => p, ...fsPromises },
      spawn: vi.fn(),
      crypto: { randomUUID: () => 'job-0' },
      normalizeDirectoryPath: (p) => p,
      resolveProjectDirectory: async () => ({ directory: '/repo' }),
      buildAugmentedPath: () => '/usr/bin',
      resolveGitBinaryForSpawn: () => 'git',
      pichamberUserConfigRoot: '/home/user/.config',
    });
    return {
      read: getRoute('GET', '/api/fs/read'),
      write: getRoute('POST', '/api/fs/write'),
      stat: getRoute('GET', '/api/fs/stat'),
    };
  };

  it('two readers observe the same opaque revision', async () => {
    const mem = createMemoryFs({ '/repo/a.txt': 'hello' });
    const { read } = registerReadWrite(mem.fsPromises);
    const first = createMockResponse();
    await read({ query: { path: '/repo/a.txt' } }, first);
    const second = createMockResponse();
    await read({ query: { path: '/repo/a.txt' } }, second);
    expect(first.body).toBe('hello');
    expect(second.body).toBe('hello');
    const revA = first.getHeader('x-pichamber-file-revision');
    const revB = second.getHeader('x-pichamber-file-revision');
    expect(typeof revA).toBe('string');
    expect(revA).toBe(revB);
    expect(revA.startsWith('v1:')).toBe(true);
  });

  it('serializes simultaneous same-revision writes: first wins, second conflicts', async () => {
    const mem = createMemoryFs({ '/repo/a.txt': 'base' });
    const { read, write } = registerReadWrite(mem.fsPromises);
    const readRes = createMockResponse();
    await read({ query: { path: '/repo/a.txt' } }, readRes);
    const baseRev = readRes.getHeader('x-pichamber-file-revision');
    const [firstRes, secondRes] = await Promise.all([
      (async () => { const r = createMockResponse(); await write({ body: { path: '/repo/a.txt', content: 'writer-one', expectedRevision: baseRev } }, r); return r; })(),
      (async () => { const r = createMockResponse(); await write({ body: { path: '/repo/a.txt', content: 'writer-two', expectedRevision: baseRev } }, r); return r; })(),
    ]);
    const successes = [firstRes, secondRes].filter((r) => r.statusCode === 200);
    const conflicts = [firstRes, secondRes].filter((r) => r.statusCode === 409);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].body.reason).toBe('file-revision-conflict');
    expect(typeof conflicts[0].body.currentRevision).toBe('string');
    expect(conflicts[0].body.exists).toBe(true);
  });

  it('rejects stale revisions after an external change with the current revision', async () => {
    const mem = createMemoryFs({ '/repo/a.txt': 'v1' });
    const { read, write } = registerReadWrite(mem.fsPromises);
    const readRes = createMockResponse();
    await read({ query: { path: '/repo/a.txt' } }, readRes);
    const stale = readRes.getHeader('x-pichamber-file-revision');
    mem.externalWrite('/repo/a.txt', 'external');
    const writeRes = createMockResponse();
    await write({ body: { path: '/repo/a.txt', content: 'stale-write', expectedRevision: stale } }, writeRes);
    expect(writeRes.statusCode).toBe(409);
    expect(writeRes.body).toMatchObject({ reason: 'file-revision-conflict', exists: true });
    expect(typeof writeRes.body.currentRevision).toBe('string');
    expect(writeRes.body.currentRevision).not.toBe(stale);
  });

  it('conflicts with exists:false after external delete', async () => {
    const mem = createMemoryFs({ '/repo/a.txt': 'v1' });
    const { read, write } = registerReadWrite(mem.fsPromises);
    const readRes = createMockResponse();
    await read({ query: { path: '/repo/a.txt' } }, readRes);
    const stale = readRes.getHeader('x-pichamber-file-revision');
    mem.externalDelete('/repo/a.txt');
    const writeRes = createMockResponse();
    await write({ body: { path: '/repo/a.txt', content: 'resurrect', expectedRevision: stale } }, writeRes);
    expect(writeRes.statusCode).toBe(409);
    expect(writeRes.body).toMatchObject({ reason: 'file-revision-conflict', exists: false, currentRevision: null });
  });

  it('detects delete+recreate as a conflict for diverging writes', async () => {
    const mem = createMemoryFs({ '/repo/a.txt': 'v1' });
    const { read, write } = registerReadWrite(mem.fsPromises);
    const readRes = createMockResponse();
    await read({ query: { path: '/repo/a.txt' } }, readRes);
    const stale = readRes.getHeader('x-pichamber-file-revision');
    mem.externalDelete('/repo/a.txt');
    mem.externalWrite('/repo/a.txt', 'recreated');
    const writeRes = createMockResponse();
    await write({ body: { path: '/repo/a.txt', content: 'diverged', expectedRevision: stale } }, writeRes);
    expect(writeRes.statusCode).toBe(409);
    expect(writeRes.body.exists).toBe(true);
  });

  it('serializes the new-file race: second create-only writer conflicts', async () => {
    const mem = createMemoryFs({});
    const { write } = registerReadWrite(mem.fsPromises);
    const [firstRes, secondRes] = await Promise.all([
      (async () => { const r = createMockResponse(); await write({ body: { path: '/repo/new.txt', content: 'first', expectedRevision: null } }, r); return r; })(),
      (async () => { const r = createMockResponse(); await write({ body: { path: '/repo/new.txt', content: 'second', expectedRevision: null } }, r); return r; })(),
    ]);
    const successes = [firstRes, secondRes].filter((r) => r.statusCode === 200);
    const conflicts = [firstRes, secondRes].filter((r) => r.statusCode === 409);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].body.reason).toBe('file-revision-conflict');
  });

  it('treats identical-content saves as no-ops without conflict', async () => {
    const mem = createMemoryFs({ '/repo/a.txt': 'same' });
    const { read, write } = registerReadWrite(mem.fsPromises);
    const readRes = createMockResponse();
    await read({ query: { path: '/repo/a.txt' } }, readRes);
    const stale = readRes.getHeader('x-pichamber-file-revision');
    mem.externalWrite('/repo/a.txt', 'same');
    const writeRes = createMockResponse();
    await write({ body: { path: '/repo/a.txt', content: 'same', expectedRevision: stale } }, writeRes);
    expect(writeRes.statusCode).toBe(200);
    expect(writeRes.body.success).toBe(true);
    expect(mem.fsPromises.rename).not.toHaveBeenCalled();
  });

  it('honors explicit overwrite over stale revisions and recreates deleted files', async () => {
    const mem = createMemoryFs({ '/repo/a.txt': 'v1' });
    const { read, write } = registerReadWrite(mem.fsPromises);
    const readRes = createMockResponse();
    await read({ query: { path: '/repo/a.txt' } }, readRes);
    const stale = readRes.getHeader('x-pichamber-file-revision');
    mem.externalWrite('/repo/a.txt', 'external');
    const overwriteRes = createMockResponse();
    await write({ body: { path: '/repo/a.txt', content: 'forced', expectedRevision: stale, overwrite: true } }, overwriteRes);
    expect(overwriteRes.statusCode).toBe(200);
    expect(overwriteRes.body.success).toBe(true);
    mem.externalDelete('/repo/a.txt');
    const recreate = createMockResponse();
    await write({ body: { path: '/repo/a.txt', content: 'recreated', expectedRevision: stale, overwrite: true } }, recreate);
    expect(recreate.statusCode).toBe(200);
  });

  it('preserves CRLF bytes and file mode across atomic replace', async () => {
    const mem = createMemoryFs({ '/repo/a.txt': 'one\r\ntwo\r\n' });
    const { write } = registerReadWrite(mem.fsPromises);
    const writeRes = createMockResponse();
    await write({ body: { path: '/repo/a.txt', content: 'a\r\nb\r\n' } }, writeRes);
    expect(writeRes.statusCode).toBe(200);
    expect(mem.store.get('/repo/a.txt')).toBe('a\r\nb\r\n');
    expect(mem.calls.chmod.length).toBeGreaterThan(0);
    expect(mem.calls.chmod[0][1] & 0o777).toBe(0o600);
  });

  it('exposes revisions on stat and read for guarded saves', async () => {
    const mem = createMemoryFs({ '/repo/a.txt': 'hello' });
    const { read, stat } = registerReadWrite(mem.fsPromises);
    const readRes = createMockResponse();
    await read({ query: { path: '/repo/a.txt' } }, readRes);
    const statRes = createMockResponse();
    await stat({ query: { path: '/repo/a.txt' } }, statRes);
    expect(typeof readRes.getHeader('x-pichamber-file-revision')).toBe('string');
    expect(typeof statRes.body.revision).toBe('string');
    expect(statRes.body.revision).toBe(readRes.getHeader('x-pichamber-file-revision'));
  });

  it('serializes concurrent guarded writes through a symlink alias and the canonical path', async () => {
    const mem = createMemoryFs({ '/repo/a.txt': 'base' });
    // /repo/link.txt is a symlink alias of /repo/a.txt: realpath maps it even
    // though the store only knows the canonical entry.
    mem.fsPromises.realpath = vi.fn(async (targetPath) =>
      targetPath === '/repo/link.txt' ? '/repo/a.txt' : targetPath);
    const { read, write } = registerReadWrite(mem.fsPromises);
    const readRes = createMockResponse();
    await read({ query: { path: '/repo/link.txt' } }, readRes);
    const baseRev = readRes.getHeader('x-pichamber-file-revision');
    const [viaAlias, viaCanonical] = await Promise.all([
      (async () => { const r = createMockResponse(); await write({ body: { path: '/repo/link.txt', content: 'alias-writer', expectedRevision: baseRev } }, r); return r; })(),
      (async () => { const r = createMockResponse(); await write({ body: { path: '/repo/a.txt', content: 'canonical-writer', expectedRevision: baseRev } }, r); return r; })(),
    ]);
    const successes = [viaAlias, viaCanonical].filter((r) => r.statusCode === 200);
    const conflicts = [viaAlias, viaCanonical].filter((r) => r.statusCode === 409);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].body.reason).toBe('file-revision-conflict');
    expect(typeof conflicts[0].body.currentRevision).toBe('string');
  });

  it('serializes create-only writes through a dangling symlink alias and its target', async () => {
    const mem = createMemoryFs({});
    // Dangling symlink: realpath resolves the alias name to the missing target.
    mem.fsPromises.realpath = vi.fn(async (targetPath) =>
      targetPath === '/repo/link.txt' ? '/repo/a.txt' : targetPath);
    const { write } = registerReadWrite(mem.fsPromises);
    const [viaAlias, viaTarget] = await Promise.all([
      (async () => { const r = createMockResponse(); await write({ body: { path: '/repo/link.txt', content: 'alias-create', expectedRevision: null } }, r); return r; })(),
      (async () => { const r = createMockResponse(); await write({ body: { path: '/repo/a.txt', content: 'target-create', expectedRevision: null } }, r); return r; })(),
    ]);
    const successes = [viaAlias, viaTarget].filter((r) => r.statusCode === 200);
    const conflicts = [viaAlias, viaTarget].filter((r) => r.statusCode === 409);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].body.reason).toBe('file-revision-conflict');
    expect(conflicts[0].body.exists).toBe(true);
  });

  it('skips read+hash on stat when knownRevision still matches', async () => {
    const mem = createMemoryFs({ '/repo/a.txt': 'hello' });
    const { read, stat } = registerReadWrite(mem.fsPromises);
    const readRes = createMockResponse();
    await read({ query: { path: '/repo/a.txt' } }, readRes);
    const baseRev = readRes.getHeader('x-pichamber-file-revision');
    // The initial read consumes one readFile call; stat must add none.
    const readCallsAfterRead = mem.fsPromises.readFile.mock.calls.length;
    const statRes = createMockResponse();
    await stat({ query: { path: '/repo/a.txt', knownRevision: baseRev } }, statRes);
    expect(statRes.statusCode).toBe(200);
    expect(statRes.body.revision).toBe(baseRev);
    expect(statRes.body.exists).toBe(true);
    // The cheap path must not read the file again.
    expect(mem.fsPromises.readFile.mock.calls.length).toBe(readCallsAfterRead);
  });

  it('recomputes the revision when knownRevision no longer matches', async () => {
    const mem = createMemoryFs({ '/repo/a.txt': 'hello' });
    const { read, stat } = registerReadWrite(mem.fsPromises);
    const readRes = createMockResponse();
    await read({ query: { path: '/repo/a.txt' } }, readRes);
    const baseRev = readRes.getHeader('x-pichamber-file-revision');
    mem.externalWrite('/repo/a.txt', 'changed');
    const statRes = createMockResponse();
    await stat({ query: { path: '/repo/a.txt', knownRevision: baseRev } }, statRes);
    expect(statRes.statusCode).toBe(200);
    expect(statRes.body.revision).not.toBe(baseRev);
    expect(typeof statRes.body.revision).toBe('string');
  });

  it('does not shortcut a hand-crafted revision whose hash contradicts the ceiling', async () => {
    const mem = createMemoryFs({ '/repo/a.txt': 'tiny' });
    const { stat } = registerReadWrite(mem.fsPromises);
    // A revision claiming a hash for a size above the hash ceiling is
    // inconsistent (clients must only echo server revisions). Size+mtime
    // match, but the server must still recompute instead of echoing it back.
    const fakeHash = 'a'.repeat(64);
    const craftedRevision = `v1:${5 * 1024 * 1024 + 1}:1000:${fakeHash}`;
    const statRes = createMockResponse();
    await stat({ query: { path: '/repo/a.txt', knownRevision: craftedRevision } }, statRes);
    expect(statRes.body.revision).not.toBe(craftedRevision);
    expect(statRes.body.revision).toMatch(/^v1:4:1000:[0-9a-f]{64}$/);
  });

  it('serializes concurrent guarded writes through two symlink aliases of one file', async () => {
    const mem = createMemoryFs({ '/repo/a.txt': 'base' });
    mem.fsPromises.realpath = vi.fn(async (targetPath) => {
      if (targetPath === '/repo/link-one.txt' || targetPath === '/repo/link-two.txt') return '/repo/a.txt';
      return targetPath;
    });
    const { read, write } = registerReadWrite(mem.fsPromises);
    const readRes = createMockResponse();
    await read({ query: { path: '/repo/link-two.txt' } }, readRes);
    const baseRev = readRes.getHeader('x-pichamber-file-revision');
    const [first, second] = await Promise.all([
      (async () => { const r = createMockResponse(); await write({ body: { path: '/repo/link-one.txt', content: 'one', expectedRevision: baseRev } }, r); return r; })(),
      (async () => { const r = createMockResponse(); await write({ body: { path: '/repo/link-two.txt', content: 'two', expectedRevision: baseRev } }, r); return r; })(),
    ]);
    const successes = [first, second].filter((r) => r.statusCode === 200);
    const conflicts = [first, second].filter((r) => r.statusCode === 409);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].body.reason).toBe('file-revision-conflict');
  });
});

describe('fs read', () => {
  it('rejects outside workspace reads without a grant', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fsPromises = {
      stat: vi.fn(async () => ({ isFile: () => true, size: 3 })),
      readFile: vi.fn(async () => 'secret'),
    };
    const handler = registerRead(fsPromises);

    const res = await callRead(handler, { path: '/etc/passwd', allowOutsideWorkspace: 'true' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Outside workspace file access requires a grant' });
    expect(fsPromises.readFile).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('allows outside workspace reads with an exact-path grant', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => 'secret'),
    };
    const grant = await mintOutsideFileGrant('/outside/plan.txt', {
      fsPromises,
      path: path.posix,
      crypto: { randomUUID: () => 'grant-read' },
    });
    const handler = registerRead(fsPromises);

    const res = await callRead(handler, {
      path: '/outside/plan.txt',
      allowOutsideWorkspace: 'true',
      outsideFileGrant: grant.outsideFileGrant,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('secret');
  });

  it('rejects outside workspace grants for a different canonical path', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => 'secret'),
    };
    const grant = await mintOutsideFileGrant('/outside/a.txt', {
      fsPromises,
      path: path.posix,
      crypto: { randomUUID: () => 'grant-mismatch' },
    });
    const handler = registerRead(fsPromises);

    const res = await callRead(handler, {
      path: '/outside/b.txt',
      allowOutsideWorkspace: 'true',
      outsideFileGrant: grant.outsideFileGrant,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Outside workspace file grant does not match requested path' });
    expect(fsPromises.readFile).not.toHaveBeenCalled();
  });

  it('sets no-referrer on raw responses served through outside file grants', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => Buffer.from('secret')),
    };
    const grant = await mintOutsideFileGrant('/outside/image.png', {
      scopes: ['raw'],
      fsPromises,
      path: path.posix,
      crypto: { randomUUID: () => 'grant-raw' },
    });
    const handler = registerRaw(fsPromises);

    const res = await callRaw(handler, {
      path: '/outside/image.png',
      allowOutsideWorkspace: 'true',
      outsideFileGrant: grant.outsideFileGrant,
    });

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('referrer-policy')).toBe('no-referrer');
  });

  it('rejects outside workspace mkdir without a trusted directory grant', async () => {
    const fsPromises = {
      mkdir: vi.fn(async () => undefined),
    };
    const handler = registerMkdir(fsPromises);

    const res = await callMkdir(handler, { path: '/tmp/staging', allowOutsideWorkspace: true });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Outside workspace directory creation requires a grant' });
    expect(fsPromises.mkdir).not.toHaveBeenCalled();
  });

  it('logs when empty-read retries are exhausted after non-empty stat', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fsPromises = {
      stat: vi.fn(async () => ({ isFile: () => true, size: 3 })),
      readFile: vi.fn(async () => ''),
    };
    const handler = registerRead(fsPromises);

    const res = await callRead(handler, { path: '/repo/file.txt' });

    expect(res.body).toBe('');
    expect(fsPromises.readFile).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Read retry exhausted for /repo/file.txt'));
    warn.mockRestore();
  });
});

describe('fs clone', () => {
  it('clones into a new destination through the registered route', async () => {
    const notFound = () => Promise.reject(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    const fsPromises = {
      stat: vi.fn(notFound),
      access: vi.fn(notFound),
      mkdir: vi.fn(async () => undefined),
    };
    const { spawn } = createSpawn();
    const handler = registerClone({ fsPromises, spawn });

    const res = await callClone(handler, {
      remoteUrl: 'https://github.com/example/repository.git',
      destinationPath: '/home/user/projects/repository',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      path: '/home/user/projects/repository',
      output: '',
    });
    expect(fsPromises.mkdir).toHaveBeenCalledWith('/home/user/projects', { recursive: true });
    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['clone', '--', 'https://github.com/example/repository.git', 'repository'],
      expect.objectContaining({
        cwd: '/home/user/projects',
        env: expect.objectContaining({ GIT_TERMINAL_PROMPT: '0' }),
      }),
    );
  });

  it('rejects a clone request without a repository URL', async () => {
    const { spawn } = createSpawn();
    const handler = registerClone({
      fsPromises: { stat: vi.fn(), access: vi.fn(), mkdir: vi.fn() },
      spawn,
    });

    const res = await callClone(handler, { destinationPath: '/home/user/projects/repository' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Repository URL is required' });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('fs reveal', () => {
  it.each([
    ['linux', 'xdg-open', ['/repo']],
    ['darwin', 'open', ['-R', '/repo/file.txt']],
  ])('returns a controlled error when the %s launcher is unavailable', async (platform, command, args) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const child = new EventEmitter();
    child.unref = vi.fn();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' })));
      return child;
    });
    const handler = registerReveal({
      fsPromises: {
        access: vi.fn(async () => undefined),
        stat: vi.fn(async () => ({ isDirectory: () => false })),
      },
      spawn,
      platform,
    });

    const res = await callReveal(handler, { path: '/repo/file.txt' });

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to launch file browser' });
    expect(spawn).toHaveBeenCalledWith(command, args, { windowsHide: true, stdio: 'ignore', detached: true });
    expect(child.unref).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('unrefs a detached launcher only after it spawns successfully', async () => {
    const child = new EventEmitter();
    child.unref = vi.fn();
    const spawn = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
    const handler = registerReveal({
      fsPromises: {
        access: vi.fn(async () => undefined),
        stat: vi.fn(async () => ({ isDirectory: () => false })),
      },
      spawn,
    });

    const res = await callReveal(handler, { path: '/repo/file.txt' });

    expect(res.body).toEqual({ success: true, path: '/repo/file.txt' });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('returns a controlled error when the launcher throws synchronously', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spawnError = Object.assign(new Error('not found'), { code: 'ENOENT' });
    const handler = registerReveal({
      fsPromises: {
        access: vi.fn(async () => undefined),
        stat: vi.fn(async () => ({ isDirectory: () => false })),
      },
      spawn: vi.fn(() => { throw spawnError; }),
    });

    const res = await callReveal(handler, { path: '/repo/file.txt' });

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to launch file browser' });
    expect(error).toHaveBeenCalledWith('Failed to reveal path:', expect.objectContaining({ cause: spawnError }));
    error.mockRestore();
  });
});

describe('fs exec git-read cache', () => {
  beforeEach(() => {
    delete process.env.PICHAMBER_GIT_READ_CACHE_TTL_MS;
  });

  afterEach(() => {
    delete process.env.PICHAMBER_GIT_READ_CACHE_TTL_MS;
  });

  it('rejects background command execution', async () => {
    const { spawn } = createSpawn();
    const handler = registerExec({ spawn });

    const res = await callExec(handler, { commands: ['id'], cwd: '/repo', background: true });

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Background command execution is not allowed' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects command execution outside the workspace', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { spawn } = createSpawn();
    const handler = registerExec({ spawn });

    const res = await callExec(handler, { commands: ['id'], cwd: '/' });

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Path is outside of active workspace' });
    expect(spawn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('caches an allowlisted git rev-parse across identical requests', async () => {
    const command = 'git rev-parse --absolute-git-dir --git-common-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: '/repo/.git\n.git\n' } });
    const handler = registerExec({ spawn });

    const first = await callExec(handler, { commands: [command], cwd: '/repo' });
    const second = await callExec(handler, { commands: [command], cwd: '/repo' });

    expect(first.body.results[0].stdout).toBe('/repo/.git\n.git');
    expect(second.body.results[0].stdout).toBe('/repo/.git\n.git');
    expect(second.body.success).toBe(true);
    // Spawned once; the second request is served from cache.
    expect(calls.length).toBe(1);
  });

  it('dedupes concurrent identical git-read requests while the first is in flight', async () => {
    const command = 'git rev-parse --absolute-git-dir --git-common-dir';
    const { spawn, calls, closeNext } = createDeferredSpawn({ stdoutByCommand: { [command]: '/repo/.git\n.git\n' } });
    const handler = registerExec({ spawn });

    const first = callExec(handler, { commands: [command], cwd: '/repo' });
    const second = callExec(handler, { commands: [command], cwd: '/repo' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.length).toBe(1);

    closeNext();
    const [firstRes, secondRes] = await Promise.all([first, second]);

    expect(firstRes.body.results[0].stdout).toBe('/repo/.git\n.git');
    expect(secondRes.body.results[0].stdout).toBe('/repo/.git\n.git');
    expect(calls.length).toBe(1);
  });

  it('returns the current request command for normalized cache hits', async () => {
    const firstCommand = 'git   rev-parse   --absolute-git-dir';
    const secondCommand = 'git rev-parse --absolute-git-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [firstCommand]: '/repo/.git\n' } });
    const handler = registerExec({ spawn });

    const first = await callExec(handler, { commands: [firstCommand], cwd: '/repo' });
    const second = await callExec(handler, { commands: [secondCommand], cwd: '/repo' });

    expect(first.body.results[0].command).toBe(firstCommand);
    expect(second.body.results[0].command).toBe(secondCommand);
    expect(calls.length).toBe(1);
  });

  it('keys the cache by working directory', async () => {
    const command = 'git rev-parse --absolute-git-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: '/x/.git\n' } });
    const handler = registerExec({ spawn });

    await callExec(handler, { commands: [command], cwd: '/repo/a' });
    await callExec(handler, { commands: [command], cwd: '/repo/b' });

    expect(calls.length).toBe(2);
  });

  it('never caches non-allowlisted commands', async () => {
    const command = 'git status';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: 'clean\n' } });
    const handler = registerExec({ spawn });

    await callExec(handler, { commands: [command], cwd: '/repo' });
    await callExec(handler, { commands: [command], cwd: '/repo' });

    expect(calls.length).toBe(2);
  });

  it('does not cache failed git-read results', async () => {
    const command = 'git rev-parse --absolute-git-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: {}, exitCode: 128 });
    const handler = registerExec({ spawn });

    await callExec(handler, { commands: [command], cwd: '/repo/not-a-repo' });
    await callExec(handler, { commands: [command], cwd: '/repo/not-a-repo' });

    expect(calls.length).toBe(2);
  });

  it('disables caching when TTL is 0', async () => {
    process.env.PICHAMBER_GIT_READ_CACHE_TTL_MS = '0';
    const command = 'git rev-parse --absolute-git-dir';
    const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: '/repo/.git\n' } });
    const handler = registerExec({ spawn });

    await callExec(handler, { commands: [command], cwd: '/repo' });
    await callExec(handler, { commands: [command], cwd: '/repo' });

    expect(calls.length).toBe(2);
  });

  it('re-runs once a cached entry ages past the TTL', async () => {
    vi.useFakeTimers();
    try {
      const command = 'git rev-parse --absolute-git-dir';
      const { spawn, calls } = createSpawn({ stdoutByCommand: { [command]: '/repo/.git\n' } });
      const handler = registerExec({ spawn }); // default 30s TTL

      await callExec(handler, { commands: [command], cwd: '/repo' });
      vi.advanceTimersByTime(31_000);
      await callExec(handler, { commands: [command], cwd: '/repo' });

      // Stale entry is not served; a fresh subprocess fires.
      expect(calls.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the cache by evicting the least-recently-used entry past the count cap', async () => {
    const command = 'git rev-parse --absolute-git-dir';
    const { spawn, calls } = createSpawn(); // exit 0, empty stdout — still cacheable
    const handler = registerExec({ spawn });

    // Fill to the 500-entry ceiling with distinct working directories.
    for (let i = 0; i < 500; i += 1) {
      await callExec(handler, { commands: [command], cwd: `/repo/worktree-${i}` });
    }
    const afterFill = calls.length;
    expect(afterFill).toBe(500);

    // One more distinct dir evicts the oldest entry (/repo/worktree-0).
    await callExec(handler, { commands: [command], cwd: '/repo/worktree-overflow' });
    // Evicted entry must re-run; a surviving entry must still be served.
    await callExec(handler, { commands: [command], cwd: '/repo/worktree-0' });   // evicted -> spawns
    await callExec(handler, { commands: [command], cwd: '/repo/worktree-499' }); // cached  -> no spawn

    expect(calls.length).toBe(afterFill + 2);
  });
});

describe('fs raw download Content-Disposition', () => {
  it('uses RFC 5987 filename*= encoding for non-ASCII filenames on download', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => Buffer.from('content')),
    };
    const handler = registerRaw(fsPromises);

    const res = await callRaw(handler, {
      path: '/repo/文件.txt',
      download: 'true',
    });

    expect(res.statusCode).toBe(200);
    const cd = res.getHeader('content-disposition');
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).toContain(encodeURIComponent('文件.txt'));
    // ASCII fallback strips non-ASCII chars, leaving extension
    expect(cd).toContain('filename=".txt"');
  });

  it('uses plain filename for ASCII-only filenames on download', async () => {
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => Buffer.from('content')),
    };
    const handler = registerRaw(fsPromises);

    const res = await callRaw(handler, { path: '/repo/readme.txt', download: 'true' });

    expect(res.statusCode).toBe(200);
    const cd = res.getHeader('content-disposition');
    expect(cd).toContain('filename="readme.txt"');
    expect(cd).toContain("filename*=UTF-8''readme.txt");
  });
});

describe('fs list symlink path space (issue 2627)', () => {
  const registerList = (fsPromises) => {
    const { app, getRoute } = createRouteRegistry();
    registerFsRoutes(app, {
      os: { homedir: () => '/home/user' },
      path: path.posix,
      fsPromises: {
        realpath: async (targetPath) => targetPath,
        ...fsPromises,
      },
      spawn: vi.fn(),
      crypto: { randomUUID: () => 'job-0' },
      normalizeDirectoryPath: (p) => p,
      resolveProjectDirectory: async () => ({ directory: '/workspace' }),
      buildAugmentedPath: () => '/usr/bin',
      resolveGitBinaryForSpawn: () => 'git',
      pichamberUserConfigRoot: '/home/user/.config',
    });
    return getRoute('GET', '/api/fs/list');
  };

  const callList = async (handler, query) => {
    const res = createMockResponse();
    await handler({ query }, res);
    return res;
  };

  it('keeps entry paths in the requested path space when listing through a symlink', async () => {
    const dirents = [
      {
        name: 'src',
        isDirectory: () => true,
        isSymbolicLink: () => false,
        isFile: () => false,
      },
      {
        name: 'README.md',
        isDirectory: () => false,
        isSymbolicLink: () => false,
        isFile: () => true,
      },
    ];
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => (
        targetPath === '/workspace/pkg' ? '/real/pkg' : targetPath
      )),
      stat: vi.fn(async () => ({ isDirectory: () => true })),
      readdir: vi.fn(async () => dirents),
    };
    const handler = registerList(fsPromises);

    const res = await callList(handler, { path: '/workspace/pkg' });

    expect(res.statusCode).toBe(200);
    expect(res.body.path).toBe('/workspace/pkg');
    expect(res.body.entries).toEqual([
      {
        name: 'src',
        path: '/workspace/pkg/src',
        isDirectory: true,
        isFile: false,
        isSymbolicLink: false,
      },
      {
        name: 'README.md',
        path: '/workspace/pkg/README.md',
        isDirectory: false,
        isFile: true,
        isSymbolicLink: false,
      },
    ]);
    expect(fsPromises.readdir).toHaveBeenCalledWith('/real/pkg', { withFileTypes: true });
  });

  for (const code of ['EACCES', 'EPERM']) {
    it(`maps ${code} to the os-permission contract`, async () => {
      const error = Object.assign(new Error('denied'), { code });
      const handler = registerList({
        stat: vi.fn(async () => ({ isDirectory: () => true })),
        readdir: vi.fn(async () => { throw error; }),
      });

      const res = await callList(handler, { path: '/workspace/protected' });

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'Access to directory denied', reason: 'os-permission' });
    });
  }
});

describe('/api/fs/find', () => {
  it('searches the active workspace instead of failing during path resolution', async () => {
    const handler = registerFind({
      fsPromises: {
        readdir: vi.fn(async (directory) => directory === '/repo'
          ? [{ name: 'src', isDirectory: () => true, isFile: () => false }]
          : [{ name: 'app.ts', isDirectory: () => false, isFile: () => true }]),
      },
      spawn: createSpawn().spawn,
    });
    const res = createMockResponse();

    await handler({
      query: {
        directory: '/repo',
        query: 'app',
        limit: '80',
        includeHidden: 'true',
        respectGitignore: 'true',
        type: 'file',
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      files: [{
        name: 'app.ts',
        path: '/repo/src/app.ts',
        relativePath: 'src/app.ts',
        extension: 'ts',
      }],
    });
  });

  it('returns matching directories', async () => {
    const handler = registerFind({
      fsPromises: {
        readdir: vi.fn(async (directory) => directory === '/repo'
          ? [{ name: 'src', isDirectory: () => true, isFile: () => false }]
          : []),
      },
      spawn: createSpawn().spawn,
    });
    const res = createMockResponse();

    await handler({
      query: {
        directory: '/repo',
        query: 'src',
        type: 'directory',
        respectGitignore: 'true',
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.files).toEqual([{
      name: 'src',
      path: '/repo/src',
      relativePath: 'src',
    }]);
  });

  it('does not return gitignored files', async () => {
    const spawn = vi.fn((_command, _args, options) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        if (options.cwd === '/repo') {
          child.stdout.emit('data', Buffer.from('ignored.ts\n'));
        }
        child.emit('close', 0, null);
      });
      return child;
    });
    const handler = registerFind({
      fsPromises: {
        readdir: vi.fn(async () => [
          { name: 'ignored.ts', isDirectory: () => false, isFile: () => true },
          { name: 'visible.ts', isDirectory: () => false, isFile: () => true },
        ]),
      },
      spawn,
    });
    const res = createMockResponse();

    await handler({
      query: {
        directory: '/repo',
        query: 'i',
        type: 'file',
        respectGitignore: 'true',
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.files.map((file) => file.name)).toEqual(['visible.ts']);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('keeps result paths in the requested symlink path space', async () => {
    const handler = registerFind({
      fsPromises: {
        realpath: vi.fn(async (targetPath) => targetPath === '/repo-link' ? '/repo' : targetPath),
        readdir: vi.fn(async () => [
          { name: 'app.ts', isDirectory: () => false, isFile: () => true },
        ]),
      },
      spawn: createSpawn().spawn,
      resolveProjectDirectory: async () => ({ directory: '/repo-link' }),
    });
    const res = createMockResponse();

    await handler({
      query: {
        directory: '/repo-link',
        query: 'app',
        type: 'file',
        respectGitignore: 'true',
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.files[0]).toMatchObject({
      path: '/repo-link/app.ts',
      relativePath: 'app.ts',
    });
  });

  it('shares gitignore checks across concurrent file and directory searches', async () => {
    const deferred = createDeferredSpawn();
    const handler = registerFind({
      fsPromises: {
        readdir: vi.fn(async () => [
          { name: 'app.ts', isDirectory: () => false, isFile: () => true },
        ]),
      },
      spawn: deferred.spawn,
    });
    const fileResponse = createMockResponse();
    const directoryResponse = createMockResponse();

    const fileSearch = handler({
      query: { directory: '/repo', query: 'app', type: 'file', respectGitignore: 'true' },
    }, fileResponse);
    const directorySearch = handler({
      query: { directory: '/repo', query: 'app', type: 'directory', respectGitignore: 'true' },
    }, directoryResponse);

    await vi.waitFor(() => expect(deferred.spawn).toHaveBeenCalledTimes(1));
    deferred.closeNext();
    await Promise.all([fileSearch, directorySearch]);

    expect(fileResponse.statusCode).toBe(200);
    expect(directoryResponse.statusCode).toBe(200);
    expect(deferred.spawn).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled gitignore check instead of returning unfiltered files', async () => {
    const previousTimeout = process.env.PICHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS;
    process.env.PICHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS = '5';
    let killed = false;
    const spawn = vi.fn(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => { killed = true; };
      return child;
    });

    try {
      const handler = registerFind({
        fsPromises: {
          readdir: vi.fn(async () => [
            { name: 'possibly-ignored.ts', isDirectory: () => false, isFile: () => true },
          ]),
        },
        spawn,
      });
      const res = createMockResponse();

      await handler({
        query: {
          directory: '/repo',
          query: 'ignored',
          type: 'file',
          respectGitignore: 'true',
        },
      }, res);

      expect(killed).toBe(true);
      expect(res.statusCode).toBe(500);
      expect(res.body.files).toBeUndefined();
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.PICHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS;
      } else {
        process.env.PICHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS = previousTimeout;
      }
    }
  });
});

describe('/api/fs/home', () => {
  const registerHome = ({ env = {}, homedir = () => '/home/user' } = {}) => {
    const { app, getRoute } = createRouteRegistry();
    registerFsRoutes(app, {
      os: { homedir },
      path,
      fsPromises: {
        realpath: async (targetPath) => targetPath,
        stat: async () => ({ isDirectory: () => true }),
      },
      spawn: vi.fn(),
      crypto: { randomUUID: () => 'job-0' },
      normalizeDirectoryPath: (p) => p,
      resolveProjectDirectory: async () => ({ directory: '/repo' }),
      buildAugmentedPath: () => '/usr/bin',
      resolveGitBinaryForSpawn: () => 'git',
      pichamberUserConfigRoot: '/home/user/.config',
      resolvePiChamberDataDir: () => require('os').platform ? path.join(homedir(), '.config', 'pichamber') : '/home/user/.config/pichamber',
    });
    return getRoute('GET', '/api/fs/home');
  };

  it('returns both home and pichamberDataDir with the default data root', async () => {
    const handler = registerHome();
    const res = createMockResponse();
    await handler({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      home: '/home/user',
      pichamberDataDir: path.join('/home/user', '.config', 'pichamber'),
    });
  });
});

describe('/api/fs/pick-directory', () => {
  const registerPick = ({ pickDirectory, fsPromises }) => {
    const { app, getRoute } = createRouteRegistry();
    registerFsRoutes(app, {
      os: { homedir: () => '/home/user' },
      path: path.posix,
      fsPromises: {
        realpath: async (targetPath) => targetPath,
        stat: async () => ({ isDirectory: () => true }),
        ...fsPromises,
      },
      spawn: vi.fn(),
      crypto: { randomUUID: () => 'job-0' },
      normalizeDirectoryPath: (p) => p,
      resolveProjectDirectory: async () => ({ directory: '/repo' }),
      buildAugmentedPath: () => '/usr/bin',
      resolveGitBinaryForSpawn: () => 'git',
      pichamberUserConfigRoot: '/home/user/.config',
      pickDirectory,
    });
    return getRoute('POST', '/api/fs/pick-directory');
  };

  const callPick = async (handler, body) => {
    const res = createMockResponse();
    await handler({ body }, res);
    return res;
  };

  it('returns the resolved directory path', async () => {
    const handler = registerPick({
      pickDirectory: vi.fn(async () => ({ status: 'ok', path: '/home/user/src' })),
      fsPromises: {
        stat: vi.fn(async () => ({ isDirectory: () => true })),
      },
    });
    const res = await callPick(handler, { path: '/home/user' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ path: '/home/user/src' });
  });

  it('returns cancelled without treating it as an empty success path', async () => {
    const handler = registerPick({
      pickDirectory: vi.fn(async () => ({ status: 'cancelled' })),
    });
    const res = await callPick(handler, { path: '/home/user' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ cancelled: true });
  });

  it('returns 501 when no host picker is available', async () => {
    const handler = registerPick({
      pickDirectory: vi.fn(async () => ({ status: 'unavailable' })),
    });
    const res = await callPick(handler, {});
    expect(res.statusCode).toBe(501);
    expect(res.body).toEqual({ error: 'Folder picker is not available on this host.' });
  });
});

