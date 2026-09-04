import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    rm: async (...args) => {
      const target = String(args[0] ?? '');
      const failPath = globalThis.__PROMPT_ROLLBACK_PATH__;
      if (globalThis.__PROMPT_ROLLBACK_FAIL__ && failPath && target === String(failPath)) {
        globalThis.__PROMPT_ROLLBACK_FAIL__ = false;
        const error = new Error('remove failed');
        error.code = 'EACCES';
        throw error;
      }
      return actual.rm(...args);
    },
  };
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionDaemon as createSessionDaemonImpl } from './session-daemon.js';
import { requestSessionDaemon } from './ipc-client.js';

const credential = 'test-prompt-credential';

function createSessionDaemon(options) {
  return createSessionDaemonImpl({ ...options, agentDir: options.agentDir ?? options.cwd });
}

class FakeSession {
  constructor() {
    this.sessionId = 'sess-1';
    this.isStreaming = false;
    this.isCompacting = false;
    this.listeners = new Set();
    this.reloadCount = 0;
    this.reloadError = null;
    this.promptImpl = async () => {};
  }
  subscribe(l) { this.listeners.add(l); return () => this.listeners.delete(l); }
  emit(event) { for (const listener of this.listeners) listener(event); }
  async reload() {
    this.reloadCount += 1;
    if (this.reloadError) throw this.reloadError;
  }
  prompt(...args) { return this.promptImpl(...args); }
  async sendUserMessage() {}
  async dispose() {}
}

function testDaemonEndpoint(root) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\pichamber-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return join(root, 'daemon.sock');
}

const parseDescription = (raw) => {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return undefined;
  const line = m[1].split(/\r?\n/).find((l) => /^description\s*:/.test(l));
  if (!line) return undefined;
  const v = line.slice(line.indexOf(':') + 1).trim();
  try { return JSON.parse(v); } catch { return v.replace(/^['\"]|['\"]$/g, ''); }
};

const makeLoader = (agentDir, getCwd) => ({
  getSkills: () => ({ skills: [] }),
  getPrompts: () => {
    const cwd = getCwd();
    const entries = [];
    const scan = (dir, scope) => {
      const promptDir = join(dir, 'prompts');
      if (!existsSync(promptDir)) return;
      for (const file of readdirSync(promptDir)) {
        if (!file.endsWith('.md')) continue;
        const filePath = join(promptDir, file);
        const raw = readFileSync(filePath, 'utf8');
        const name = file.slice(0, -3);
        const desc = parseDescription(raw);
        const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
        entries.push({
          name,
          ...(desc !== undefined ? { description: desc } : {}),
          content: body,
          filePath,
          sourceInfo: { origin: 'top-level', scope },
        });
      }
    };
    scan(agentDir, 'user');
    if (cwd) scan(join(cwd, '.pi'), 'project');
    return { prompts: entries };
  },
  getAgentsFiles: () => ({ agentsFiles: [] }),
});

describe('prompt template daemon operations', () => {
  const dirs = [];
  let daemon = null;
  afterEach(async () => {
    if (daemon) { await daemon.stop().catch(() => {}); daemon = null; }
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  const startDaemon = async ({ session, loader } = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-prompt-'));
    dirs.push(root);
    const endpoint = testDaemonEndpoint(root);
    const agentDir = join(root, 'agent');
    const cwd = join(root, 'project');
    await mkdir(agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const sess = session ?? new FakeSession();
    const baseLoader = loader;
    const runtimeState = { createCount: 0, disposeCount: 0 };
    daemon = createSessionDaemon({
      endpoint, credential, cwd, agentDir,
      createRuntime: async (opts) => {
        runtimeState.createCount += 1;
        const dir = typeof opts?.cwd === "string" && opts.cwd.length > 0 ? opts.cwd : cwd;
        const runtimeLoader = baseLoader ?? makeLoader(agentDir, () => dir);
        return {
          cwd: dir,
          session: sess,
          services: { resourceLoader: runtimeLoader },
          async dispose() { runtimeState.disposeCount += 1; },
        };
      },
    });
    await daemon.start();
    const request = (command, payload = {}) =>
      requestSessionDaemon({ endpoint, credential, command, payload });
    return { root, endpoint, agentDir, cwd, session: sess, runtimeState, request };
  };

  it('creates, reads, updates, renames, and deletes a global prompt', async () => {
    const ctx = await startDaemon();
    const created = await ctx.request('resources.prompts.create', {
      name: 'review', description: 'Review', content: 'Do $1 $@', location: 'global', directory: ctx.cwd,
    });
    expect(created.prompts.some((p) => p.name === 'review')).toBe(true);
    const listed = await ctx.request('resources.list', { directory: ctx.cwd });
    const prompt = listed.prompts.find((p) => p.name === 'review');
    expect(prompt).toMatchObject({ location: 'global', editable: true });
    expect(prompt).not.toHaveProperty('filePath');

    const updated = await ctx.request('resources.prompts.update', {
      resourceId: prompt.id, directory: ctx.cwd, description: 'Updated', content: 'New $1',
    });
    expect(updated.prompts.find((p) => p.id === prompt.id)).toMatchObject({ description: 'Updated' });

    const renamed = await ctx.request('resources.prompts.update', {
      resourceId: prompt.id, directory: ctx.cwd, name: 'review2',
    });
    expect(renamed.prompts.some((p) => p.name === 'review2')).toBe(true);
    expect(renamed.prompts.some((p) => p.name === 'review')).toBe(false);

    const renamedPrompt = renamed.prompts.find((p) => p.name === 'review2');
    const deleted = await ctx.request('resources.prompts.delete', {
      resourceId: renamedPrompt.id, directory: ctx.cwd,
    });
    expect(deleted.prompts.some((p) => p.name === 'review2')).toBe(false);
  });

  it('preserves unknown frontmatter when editing', async () => {
    const ctx = await startDaemon();
    const filePath = join(ctx.agentDir, 'prompts', 'review.md');
    await mkdir(join(ctx.agentDir, 'prompts'), { recursive: true });
    await writeFile(filePath, '---\ndescription: \"Old\"\nargument-hint: \"[file]\"\n---\nBody $1\n', 'utf8');
    const listed = await ctx.request('resources.list', { directory: ctx.cwd });
    const prompt = listed.prompts.find((p) => p.name === 'review');
    expect(prompt).toBeDefined();
    await ctx.request('resources.prompts.update', {
      resourceId: prompt.id, directory: ctx.cwd, description: 'New', content: 'Updated $@',
    });
    const raw = await readFile(filePath, 'utf8');
    expect(raw).toContain('argument-hint');
    expect(raw).toContain('Updated $@');
    expect(raw).toContain('New');
  });

  it('serializes concurrent creates without overwriting the destination', async () => {
    const ctx = await startDaemon();
    const results = await Promise.allSettled([
      ctx.request('resources.prompts.create', {
        name: 'shared', description: 'First', content: 'One', location: 'global', directory: ctx.cwd,
      }),
      ctx.request('resources.prompts.create', {
        name: 'shared', description: 'Second', content: 'Two', location: 'global', directory: ctx.cwd,
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const listed = await ctx.request('resources.list', { directory: ctx.cwd });
    expect(listed.prompts.filter((prompt) => prompt.name === 'shared')).toHaveLength(1);
    const raw = await readFile(join(ctx.agentDir, 'prompts', 'shared.md'), 'utf8');
    expect(['One', 'Two'].some((content) => raw.includes(content))).toBe(true);
  });

  it('rejects duplicate destinations without overwriting', async () => {
    const ctx = await startDaemon();
    await ctx.request('resources.prompts.create', {
      name: 'first', description: 'First', content: 'One', location: 'global', directory: ctx.cwd,
    });
    await ctx.request('resources.prompts.create', {
      name: 'second', description: 'Second', content: 'Two', location: 'global', directory: ctx.cwd,
    });
    const listed = await ctx.request('resources.list', { directory: ctx.cwd });
    const first = listed.prompts.find((p) => p.name === 'first');
    await expect(ctx.request('resources.prompts.update', {
      resourceId: first.id, directory: ctx.cwd, name: 'second',
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const after = await ctx.request('resources.list', { directory: ctx.cwd });
    expect(after.prompts).toHaveLength(2);
  });

  it('supports trusted-project create, update, rename, and delete', async () => {
    const ctx = await startDaemon();
    const dir = join(ctx.root, 'trusted');
    await mkdir(join(dir, '.pi', 'prompts'), { recursive: true });
    const { ProjectTrustStore } = await import('@earendil-works/pi-coding-agent');
    new ProjectTrustStore(ctx.agentDir).set(dir, true);
    const created = await ctx.request('resources.prompts.create', {
      name: 'local', description: 'Local', content: 'Body $1', location: 'project', directory: dir,
    });
    expect(created.prompts.some((p) => p.name === 'local')).toBe(true);
    const listed = await ctx.request('resources.list', { directory: dir });
    const prompt = listed.prompts.find((p) => p.name === 'local');
    expect(prompt).toMatchObject({ location: 'project', editable: true });
    await ctx.request('resources.prompts.update', {
      resourceId: prompt.id, directory: dir, description: 'Updated', content: 'New $@',
    });
    const renamed = await ctx.request('resources.prompts.update', {
      resourceId: prompt.id, directory: dir, name: 'local2',
    });
    expect(renamed.prompts.some((p) => p.name === 'local2')).toBe(true);
    const renamedPrompt = renamed.prompts.find((p) => p.name === 'local2');
    const deleted = await ctx.request('resources.prompts.delete', {
      resourceId: renamedPrompt.id, directory: dir,
    });
    expect(deleted.prompts.some((p) => p.name === 'local2')).toBe(false);
  });

  it('rejects project mutations without trust', async () => {
    const ctx = await startDaemon();
    const dir = join(ctx.root, 'untrusted');
    await mkdir(join(dir, '.pi', 'prompts'), { recursive: true });
    const { ProjectTrustStore } = await import('@earendil-works/pi-coding-agent');
    new ProjectTrustStore(ctx.agentDir).set(dir, false);
    await expect(ctx.request('resources.prompts.create', {
      name: 'local', description: 'Local', content: 'Body', location: 'project', directory: dir,
    })).rejects.toMatchObject({ code: 'PROJECT_UNTRUSTED' });
  });

  it('rejects cross-directory resource ids', async () => {
    const ctx = await startDaemon();
    const dirA = join(ctx.root, 'a');
    const dirB = join(ctx.root, 'b');
    await mkdir(join(dirA, '.pi', 'prompts'), { recursive: true });
    await mkdir(join(dirB, '.pi', 'prompts'), { recursive: true });
    await writeFile(join(dirA, '.pi', 'prompts', 'private.md'), '---\ndescription: \"P\"\n---\nBody\n', 'utf8');
    const { ProjectTrustStore } = await import('@earendil-works/pi-coding-agent');
    new ProjectTrustStore(ctx.agentDir).set(dirA, true);
    new ProjectTrustStore(ctx.agentDir).set(dirB, true);
    const listedA = await ctx.request('resources.list', { directory: dirA });
    const prompt = listedA.prompts.find((p) => p.name === 'private');
    expect(prompt).toBeDefined();
    await expect(ctx.request('resources.prompts.update', {
      resourceId: prompt.id, directory: dirB, content: 'Hacked',
    })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('rolls back the destination when source removal fails', async () => {
    const ctx = await startDaemon();
    await ctx.request('resources.prompts.create', {
      name: 'old', description: 'Old', content: 'Body', location: 'global', directory: ctx.cwd,
    });
    const listed = await ctx.request('resources.list', { directory: ctx.cwd });
    const prompt = listed.prompts.find((p) => p.name === 'old');
    const sourcePath = join(ctx.agentDir, 'prompts', 'old.md');
    const destPath = join(ctx.agentDir, 'prompts', 'renamed.md');
    globalThis.__PROMPT_ROLLBACK_PATH__ = sourcePath;
    globalThis.__PROMPT_ROLLBACK_FAIL__ = true;
    try {
      await expect(ctx.request('resources.prompts.update', {
        resourceId: prompt.id, directory: ctx.cwd, name: 'renamed',
      })).rejects.toBeDefined();
    } finally {
      globalThis.__PROMPT_ROLLBACK_FAIL__ = false;
      globalThis.__PROMPT_ROLLBACK_PATH__ = undefined;
    }
    const fsPromises = await import('node:fs/promises');
    await expect(readFile(sourcePath, 'utf8')).resolves.toContain('Body');
    await expect(fsPromises.stat(destPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const after = await ctx.request('resources.list', { directory: ctx.cwd });
    expect(after.prompts.some((p) => p.name === 'old')).toBe(true);
    expect(after.prompts.some((p) => p.name === 'renamed')).toBe(false);
  });

  it('persists mutations while streaming and reloads without disposing after settlement', async () => {
    const session = new FakeSession();
    const ctx = await startDaemon({ session });
    await ctx.request('resources.list', { directory: ctx.cwd });
    session.isStreaming = true;
    const created = await ctx.request('resources.prompts.create', {
      name: 'during-run', description: 'During run', content: 'x', location: 'global', directory: ctx.cwd,
    });
    expect(created.prompts.some((prompt) => prompt.name === 'during-run')).toBe(true);
    expect(session.reloadCount).toBe(0);
    expect(ctx.runtimeState).toEqual({ createCount: 1, disposeCount: 0 });

    session.isStreaming = false;
    session.emit({ type: 'agent_settled' });
    await expect.poll(() => session.reloadCount).toBe(1);
    expect(ctx.runtimeState).toEqual({ createCount: 1, disposeCount: 0 });
  });

  it('reloads idle prompt resources in place without replacing the runtime', async () => {
    const ctx = await startDaemon();
    await ctx.request('resources.list', { directory: ctx.cwd });
    await ctx.request('resources.prompts.create', {
      name: 'stable', description: 'Stable', content: 'x', location: 'global', directory: ctx.cwd,
    });
    expect(ctx.session.reloadCount).toBe(1);
    expect(ctx.runtimeState).toEqual({ createCount: 1, disposeCount: 0 });
  });

  it('defers reload while a non-streaming slash command is still executing', async () => {
    const session = new FakeSession();
    let finishPrompt;
    session.promptImpl = () => new Promise((resolve) => { finishPrompt = resolve; });
    const ctx = await startDaemon({ session });
    await ctx.request('resources.list', { directory: ctx.cwd });
    await ctx.request('sessions.prompt', { sessionId: session.sessionId, text: '/hold', directory: ctx.cwd });

    const created = await ctx.request('resources.prompts.create', {
      name: 'after-command', description: 'After command', content: 'x', location: 'global', directory: ctx.cwd,
    });
    expect(created.prompts.some((prompt) => prompt.name === 'after-command')).toBe(true);
    expect(session.reloadCount).toBe(0);

    finishPrompt();
    await expect.poll(() => session.reloadCount).toBe(1);
    expect(ctx.runtimeState).toEqual({ createCount: 1, disposeCount: 0 });
  });

  it('reports the committed prompt even when runtime reload fails', async () => {
    const ctx = await startDaemon();
    await ctx.request('resources.list', { directory: ctx.cwd });
    ctx.session.reloadError = new Error('reload failed');
    const created = await ctx.request('resources.prompts.create', {
      name: 'committed', description: 'Committed', content: 'x', location: 'global', directory: ctx.cwd,
    });
    expect(created.prompts.some((prompt) => prompt.name === 'committed')).toBe(true);
    await expect(readFile(join(ctx.agentDir, 'prompts', 'committed.md'), 'utf8')).resolves.toContain('x');
    expect(ctx.runtimeState).toEqual({ createCount: 1, disposeCount: 0 });
  });

  it('keeps package prompts read-only', async () => {
    const loader = {
      getSkills: () => ({ skills: [] }),
      getPrompts: () => ({
        prompts: [{
          name: 'pkg', description: 'Pkg', content: 'Body', filePath: '/pkg/prompts/pkg.md',
          sourceInfo: { origin: 'package', scope: 'user' },
        }],
      }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
    };
    const ctx = await startDaemon({ loader });
    const listed = await ctx.request('resources.list', { directory: ctx.cwd });
    const pkg = listed.prompts.find((p) => p.name === 'pkg');
    expect(pkg.editable).not.toBe(true);
    await expect(ctx.request('resources.prompts.update', {
      resourceId: pkg.id, directory: ctx.cwd, content: 'x',
    })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await expect(ctx.request('resources.prompts.delete', {
      resourceId: pkg.id, directory: ctx.cwd,
    })).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});
