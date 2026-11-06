import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { createSessionDaemon } from './session-daemon.js';

const credential = 'a-private-daemon-credential';

const samePath = (left, right) => resolve(left) === resolve(right);

// The private daemon endpoint is a named pipe on Windows and a socket file
// everywhere else.
function testDaemonEndpoint(root) {
  if (process.platform === 'win32') {
    const pipeHash = createHash('sha1').update(root).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\pichamber-test-${pipeHash}`;
  }
  return join(root, 'daemon.sock');
}

/**
 * A Pi runtime whose whole identity is the directory it was created for:
 * extensions, commands, skills, prompts, and models are all tagged with that
 * directory so a catalog response can be attributed to exactly one project.
 */
const createFakeRuntime = ({ cwd, tag, onDispose, onRefresh }) => {
  const session = {
    sessionId: `pi-session-${tag}`,
    isStreaming: false,
    subscribe: () => () => {},
    bindExtensions: async () => {},
    sessionManager: {
      getSessionFile: () => undefined,
      getHeader: () => ({ timestamp: '2026-01-01T00:00:00.000Z' }),
      getEntries: () => [],
      getBranch: () => [],
      getLeafId: () => 'fake-entry',
      appendSessionInfo: () => {},
      getSessionName: () => undefined,
    },
    modelRuntime: {
      getModels: () => [{ provider: `${tag}-provider`, id: `${tag}-model`, name: `${tag} model` }],
      getProvider: (providerId) => ({ name: providerId }),
      getProviderAuthStatus: () => ({ configured: true }),
      getProviders: () => [],
      refresh: async () => {
        onRefresh?.(tag);
        return {};
      },
    },
    extensionRunner: {
      getExtensionPaths: () => [join(cwd, '.pi', 'extensions', `${tag}-extension.ts`)],
      getRegisteredCommands: () => [{
        invocationName: `${tag}-only-command`,
        description: `Registered only in ${tag}`,
        scope: 'project',
      }],
    },
  };

  return {
    cwd,
    session,
    services: {
      resourceLoader: {
        getSkills: () => ({
          skills: [{
            name: `${tag}-skill`,
            description: `${tag} skill`,
            filePath: join(cwd, '.pi', 'skills', `${tag}-SKILL.md`),
            sourceInfo: { scope: 'project' },
          }],
        }),
        getPrompts: () => ({ prompts: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
      },
    },
    async dispose() {
      onDispose?.(tag);
    },
  };
};

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

  const next = (predicate) => new Promise((resolvePromise, reject) => {
    const existing = messages.find(predicate);
    if (existing) {
      resolvePromise(existing);
      return;
    }
    const timer = setTimeout(() => {
      const index = waiters.findIndex((waiter) => waiter.resolve === resolvePromise);
      if (index !== -1) waiters.splice(index, 1);
      reject(new Error('Timed out waiting for daemon message'));
    }, 2_000);
    waiters.push({
      predicate,
      reject,
      resolve: (message) => {
        clearTimeout(timer);
        resolvePromise(message);
      },
    });
  });

  return {
    async authenticate() {
      await new Promise((resolvePromise, reject) => {
        socket.once('connect', resolvePromise);
        socket.once('error', reject);
      });
      socket.write(`${JSON.stringify({ kind: 'authenticate', credential })}\n`);
      await next((message) => message.kind === 'authenticated');
    },
    async request(command, payload = {}) {
      const requestId = `request-${Math.random()}`;
      socket.write(`${JSON.stringify({ protocolVersion: 1, kind: 'request', requestId, command, payload })}\n`);
      const response = await next((message) => message.kind === 'response' && message.requestId === requestId);
      if (response.error) throw Object.assign(new Error(response.error), { code: response.code });
      return response;
    },
    close() {
      socket.end();
    },
  };
}

describe('Pi session daemon directory-scoped catalogs', () => {
  let daemon;

  /**
   * Two independent projects. The daemon starts in `beta` so that beta holds
   * the resident runtime first, which is the state that made every catalog
   * request answer with beta's resources (issue #199).
   */
  const startDaemonWithTwoProjects = async ({ idleTimeoutMs = 60_000, beforeCreate } = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-directory-catalog-'));
    const alphaDir = join(root, 'alpha');
    const betaDir = join(root, 'beta');
    const agentDir = join(root, 'agent');
    await mkdir(alphaDir, { recursive: true });
    await mkdir(betaDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });

    const created = [];
    const disposed = [];
    const refreshed = [];
    const endpoint = testDaemonEndpoint(root);
    daemon = createSessionDaemon({
      endpoint,
      credential,
      cwd: betaDir,
      agentDir,
      idleTimeoutMs,
      createRuntime: async (options) => {
        const cwd = options.cwd;
        created.push(options);
        const tag = basename(cwd);
        await beforeCreate?.(tag);
        return createFakeRuntime({
          cwd,
          tag,
          onDispose: (disposedTag) => disposed.push(disposedTag),
          onRefresh: (refreshedTag) => refreshed.push(refreshedTag),
        });
      },
    });
    await daemon.start();

    const clients = [];
    // Requests on one connection are handled in order, so concurrency tests
    // open one connection per in-flight request.
    const openClient = async () => {
      const opened = connectClient(endpoint);
      await opened.authenticate();
      clients.push(opened);
      return opened;
    };
    const client = await openClient();
    return { client, openClient, alphaDir, betaDir, created, disposed, refreshed };
  };

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
  });

  const commandNames = (result) => result.commands.map((command) => command.name);
  const skillNames = (result) => result.skills.map((skill) => skill.name);
  const modelIds = (result) => result.providers.flatMap((provider) => provider.models.map((model) => model.id));

  it('answers extensions.list from the requested directory, not the active runtime', async () => {
    const { client, alphaDir, betaDir } = await startDaemonWithTwoProjects();

    // beta becomes the daemon's active runtime first.
    const beta = (await client.request('extensions.list', { directory: betaDir })).result;
    expect(commandNames(beta)).toEqual(['beta-only-command']);

    const alpha = (await client.request('extensions.list', { directory: alphaDir })).result;
    expect(commandNames(alpha)).toEqual(['alpha-only-command']);
    expect(commandNames(alpha)).not.toContain('beta-only-command');
    expect(samePath(alpha.directory, alphaDir)).toBe(true);
  });

  it('answers resources.list with the requested directory skills, not the active runtime skills', async () => {
    const { client, alphaDir, betaDir } = await startDaemonWithTwoProjects();

    const beta = (await client.request('resources.list', { directory: betaDir })).result;
    expect(skillNames(beta)).toEqual(['beta-skill']);

    const alpha = (await client.request('resources.list', { directory: alphaDir })).result;
    expect(skillNames(alpha)).toEqual(['alpha-skill']);
    expect(skillNames(alpha)).not.toContain('beta-skill');
  });

  it('answers providers.list with the requested directory models, not the active runtime models', async () => {
    const { client, alphaDir, betaDir } = await startDaemonWithTwoProjects();

    const beta = (await client.request('providers.list', { directory: betaDir })).result;
    expect(modelIds(beta)).toEqual(['beta-model']);

    const alpha = (await client.request('providers.list', { directory: alphaDir })).result;
    expect(modelIds(alpha)).toEqual(['alpha-model']);
    expect(modelIds(alpha)).not.toContain('beta-model');
  });

  it('answers every catalog command from the requested directory without displacing the active project', async () => {
    const { client, alphaDir, betaDir } = await startDaemonWithTwoProjects();

    await client.request('extensions.list', { directory: betaDir });
    await client.request('extensions.list', { directory: alphaDir });

    // A directory-less request keeps answering for the daemon's active
    // directory; reading another project's catalog must not switch projects.
    const again = (await client.request('extensions.list', {})).result;
    expect(commandNames(again)).toEqual(['beta-only-command']);
  });

  it('reuses one resident runtime per directory instead of creating one per request', async () => {
    const { client, alphaDir, betaDir, created } = await startDaemonWithTwoProjects();

    await client.request('extensions.list', { directory: alphaDir });
    await client.request('extensions.list', { directory: alphaDir });
    await client.request('resources.list', { directory: alphaDir });
    await client.request('providers.list', { directory: alphaDir });
    await client.request('extensions.list', { directory: betaDir });
    await client.request('extensions.list', { directory: betaDir });

    const alphaStarts = created.filter((options) => samePath(options.cwd, alphaDir));
    const betaStarts = created.filter((options) => samePath(options.cwd, betaDir));
    expect(alphaStarts).toHaveLength(1);
    expect(betaStarts).toHaveLength(1);
  });

  it('starts a directory runtime for the requested directory rather than reusing another directory session file', async () => {
    const { client, alphaDir, betaDir, created } = await startDaemonWithTwoProjects();

    await client.request('extensions.list', { directory: betaDir });
    await client.request('extensions.list', { directory: alphaDir });

    const alphaStart = created.find((options) => samePath(options.cwd, alphaDir));
    expect(alphaStart).toBeDefined();
    // A dormant session from another project must never become the runtime
    // that answers for this directory.
    expect(alphaStart.sessionFile).toBeUndefined();
  });

  it('retires a runtime that was only read for another directory', async () => {
    const { client, alphaDir, betaDir, created, disposed } = await startDaemonWithTwoProjects({ idleTimeoutMs: 40 });

    await client.request('extensions.list', { directory: betaDir });
    await client.request('extensions.list', { directory: alphaDir });
    expect(created.filter((options) => samePath(options.cwd, alphaDir))).toHaveLength(1);

    // A browsed project keeps the same idle lifetime as any other browse-only
    // session, so reading many projects cannot accumulate resident runtimes.
    await vi.waitFor(() => expect(disposed).toContain('alpha'), { timeout: 4_000, interval: 10 });
    expect(disposed).not.toContain('beta');

    // The next read starts a fresh runtime for that directory and still answers
    // for that directory.
    const alpha = (await client.request('extensions.list', { directory: alphaDir })).result;
    expect(commandNames(alpha)).toEqual(['alpha-only-command']);
    expect(created.filter((options) => samePath(options.cwd, alphaDir))).toHaveLength(2);
  });
  it('does not adopt another directory runtime while the active directory has no resident runtime', async () => {
    // A fresh daemon has no runtime yet but already names beta as its active
    // directory; the same state follows idle disposal of the active runtime.
    const { client, alphaDir } = await startDaemonWithTwoProjects();

    const alpha = (await client.request('extensions.list', { directory: alphaDir })).result;
    expect(commandNames(alpha)).toEqual(['alpha-only-command']);

    const active = (await client.request('extensions.list', {})).result;
    expect(commandNames(active)).toEqual(['beta-only-command']);
  });

  it('shares a concurrent start per directory and never across directories', async () => {
    const releases = new Map();
    const gate = (tag) => new Promise((resolvePromise) => releases.set(tag, resolvePromise));
    const { client, openClient, alphaDir, betaDir, created } = await startDaemonWithTwoProjects({ beforeCreate: gate });
    const [second, third] = [await openClient(), await openClient()];

    const alphaFirst = client.request('extensions.list', { directory: alphaDir });
    const alphaSecond = second.request('resources.list', { directory: alphaDir });
    const beta = third.request('extensions.list', { directory: betaDir });
    await vi.waitFor(() => expect(releases.size).toBe(2), { timeout: 2_000, interval: 5 });

    releases.get('beta')();
    expect(commandNames((await beta).result)).toEqual(['beta-only-command']);
    releases.get('alpha')();
    expect(commandNames((await alphaFirst).result)).toEqual(['alpha-only-command']);
    expect(skillNames((await alphaSecond).result)).toEqual(['alpha-skill']);

    expect(created.filter((options) => samePath(options.cwd, alphaDir))).toHaveLength(1);
    expect(created.filter((options) => samePath(options.cwd, betaDir))).toHaveLength(1);
  });

  it('refreshes and answers providers.refresh for a requested directory that is not resident', async () => {
    const { client, alphaDir, betaDir, refreshed } = await startDaemonWithTwoProjects();

    await client.request('extensions.list', { directory: betaDir });
    const alpha = (await client.request('providers.refresh', { directory: alphaDir })).result;

    expect(modelIds(alpha)).toEqual(['alpha-model']);
    expect(refreshed).toContain('alpha');
  });

  it('keeps concurrent providers.refresh requests for different directories separate', async () => {
    const releases = new Map();
    const gate = (tag) => new Promise((resolvePromise) => releases.set(tag, resolvePromise));
    const { client, openClient, alphaDir, betaDir } = await startDaemonWithTwoProjects({ beforeCreate: gate });
    const second = await openClient();

    const alpha = client.request('providers.refresh', { directory: alphaDir });
    const beta = second.request('providers.refresh', { directory: betaDir });
    // beta's refresh is queued behind alpha's, then starts its own runtime.
    await vi.waitFor(() => expect(releases.has('alpha')).toBe(true), { timeout: 2_000, interval: 5 });
    releases.get('alpha')();
    await vi.waitFor(() => expect(releases.has('beta')).toBe(true), { timeout: 2_000, interval: 5 });
    releases.get('beta')();

    expect(modelIds((await alpha).result)).toEqual(['alpha-model']);
    expect(modelIds((await beta).result)).toEqual(['beta-model']);
  });
});
