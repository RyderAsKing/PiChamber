import { appendFile, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createPiSessionJsonlListCache,
  encodePiSessionCwd,
  findPiSessionJsonlById,
  getPiSessionDirectory,
  listPiSessionJsonlDirectory,
  matchesPiSessionJsonlName,
  normalizeWindowsShellPath,
  validatePiSessionJsonlDirectory,
  validatePiSessionJsonlFile,
} from './session-jsonl.js';

const validHeader = (cwd) => JSON.stringify({
  type: 'session',
  version: 3,
  id: 'session-one',
  timestamp: '2026-01-01T00:00:00.000Z',
  cwd,
});

describe('Pi session JSONL validation', () => {
  it('encodes Windows drive-letter cwds the same way Pi SessionManager does', () => {
    expect(encodePiSessionCwd('C:\\Users\\name\\project')).toBe('--C--Users-name-project--');
    expect(encodePiSessionCwd('/home/ryder/project')).toBe('--home-ryder-project--');
  });

  it('normalizes Git Bash drive paths before encoding on Windows', () => {
    expect(normalizeWindowsShellPath('/c/Users/name/project')).toBe('C:\\Users\\name\\project');
    expect(normalizeWindowsShellPath('/cygdrive/d/code')).toBe('D:\\code');
    expect(normalizeWindowsShellPath('/mnt/e/repo')).toBe('E:\\repo');
    const directory = getPiSessionDirectory({
      cwd: '/c/Users/name/project',
      agentDir: 'C:\\Users\\name\\.pi\\agent',
      platform: 'win32',
      resolvePath: (value) => value,
    });
    expect(directory.replace(/\\/g, '/')).toMatch(/sessions\/--C--Users-name-project--$/);
  });

  it('accepts valid Pi session JSONL files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-jsonl-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const sessionDirectory = getPiSessionDirectory({ cwd, agentDir });
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, 'valid.jsonl'), `${validHeader(cwd)}\n`);

    await expect(validatePiSessionJsonlDirectory({ cwd, agentDir })).resolves.toBeUndefined();
  });

  it('reports malformed JSONL rather than silently omitting the session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-jsonl-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const sessionDirectory = getPiSessionDirectory({ cwd, agentDir });
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, 'corrupt.jsonl'), `${validHeader(cwd)}\nnot-json\n`);

    await expect(validatePiSessionJsonlFile(join(sessionDirectory, 'corrupt.jsonl'))).rejects.toMatchObject({
      code: 'MALFORMED_SESSION_JSONL',
    });
    // Directory list/startup only require a valid header so a later corrupt
    // line cannot make every sessions.list read 16MB transcripts.
    await expect(validatePiSessionJsonlDirectory({ cwd, agentDir })).resolves.toBeUndefined();
    await expect(listPiSessionJsonlDirectory({ cwd, agentDir })).resolves.toEqual([
      expect.objectContaining({ id: 'session-one', cwd }),
    ]);
  });

  it('reports unreadable session files explicitly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-jsonl-'));

    await expect(validatePiSessionJsonlFile(join(root, 'missing.jsonl'))).rejects.toMatchObject({
      code: 'SESSION_JSONL_UNREADABLE',
    });
  });

  it('matches Pi SessionManager filenames without treating session-1 as session-10', () => {
    expect(matchesPiSessionJsonlName('2026-01-01T00-00-00-000Z_session-one.jsonl', 'session-one')).toBe(true);
    expect(matchesPiSessionJsonlName('session-one.jsonl', 'session-one')).toBe(true);
    expect(matchesPiSessionJsonlName('2026-01-01T00-00-00-000Z_session-10.jsonl', 'session-1')).toBe(false);
    expect(matchesPiSessionJsonlName('other.jsonl', 'session-one')).toBe(false);
  });

  it('finds a session by filename without reading unrelated transcripts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-jsonl-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const sessionDirectory = getPiSessionDirectory({ cwd, agentDir });
    await mkdir(sessionDirectory, { recursive: true });
    const targetId = '01a019b7-ce87-7be9-8fdd-4ed2ce979f5f';
    await writeFile(
      join(sessionDirectory, `2026-08-19T11-13-31-038Z_${targetId}.jsonl`),
      `${JSON.stringify({ type: 'session', version: 3, id: targetId, timestamp: '2026-08-19T11:13:31.038Z', cwd })}\n`,
    );
    await writeFile(join(sessionDirectory, 'unrelated.jsonl'), `${validHeader(cwd)}\n`);

    await expect(findPiSessionJsonlById({ sessionId: targetId, agentDir })).resolves.toMatchObject({
      id: targetId,
      cwd,
    });
    await expect(findPiSessionJsonlById({ sessionId: '01a019b7-ce87-7be9-8fdd-missing', agentDir })).resolves.toBeNull();
  });

  it('lists session metadata for a padded transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-jsonl-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const sessionDirectory = getPiSessionDirectory({ cwd, agentDir });
    await mkdir(sessionDirectory, { recursive: true });
    const padding = `${JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'x'.repeat(1024) } })}\n`.repeat(800);
    await writeFile(
      join(sessionDirectory, '2026-01-01T00-00-00-000Z_session-one.jsonl'),
      [
        validHeader(cwd),
        JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'First prompt about listing' }] } }),
        padding.trimEnd(),
        JSON.stringify({ type: 'session_info', name: 'Renamed from tail' }),
        '',
      ].join('\n'),
    );

    const started = Date.now();
    const listed = await listPiSessionJsonlDirectory({ cwd, agentDir });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(listed).toEqual([
      expect.objectContaining({
        id: 'session-one',
        cwd,
        name: 'Renamed from tail',
        firstMessage: 'First prompt about listing',
      }),
    ]);
    expect(listed[0].path).toContain('session-one.jsonl');
  });

  it('lists every session file in a crowded directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-jsonl-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const sessionDirectory = getPiSessionDirectory({ cwd, agentDir });
    await mkdir(sessionDirectory, { recursive: true });
    const ids = Array.from({ length: 24 }, (_, index) => `session-${String(index).padStart(2, '0')}`);
    await Promise.all(ids.map((id) => writeFile(
      join(sessionDirectory, `${id}.jsonl`),
      `${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd })}\n${JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `Prompt ${id}` }] } })}\n`,
    )));

    const listed = await listPiSessionJsonlDirectory({ cwd, agentDir });
    expect(listed.map((session) => session.id).sort()).toEqual([...ids].sort());
    expect(listed.every((session) => session.cwd === cwd && session.firstMessage?.startsWith('Prompt '))).toBe(true);
  });

  it('fails the directory list when one session header is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-jsonl-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const sessionDirectory = getPiSessionDirectory({ cwd, agentDir });
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, 'valid.jsonl'), `${validHeader(cwd)}\n`);
    await writeFile(join(sessionDirectory, 'broken.jsonl'), '{"type":"not-a-session"}\n');

    await expect(listPiSessionJsonlDirectory({ cwd, agentDir })).rejects.toMatchObject({
      code: 'MALFORMED_SESSION_JSONL',
    });
  });

  describe('cached incremental list metadata', () => {
    const userLine = (text) => JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });
    const fillerLine = (index) => JSON.stringify({
      type: 'message',
      message: { role: 'assistant', content: `${index} ${'x'.repeat(10_000)}` },
    });
    const infoLine = (name) => JSON.stringify({ type: 'session_info', name });
    const filler = (count) => Array.from({ length: count }, (_, index) => fillerLine(index)).join('\n');

    const setup = async () => {
      const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-jsonl-cache-'));
      const cwd = join(root, 'project');
      const agentDir = join(root, 'agent');
      const sessionDirectory = getPiSessionDirectory({ cwd, agentDir });
      await mkdir(sessionDirectory, { recursive: true });
      const file = join(sessionDirectory, '2026-01-01T00-00-00-000Z_session-one.jsonl');
      const cache = createPiSessionJsonlListCache();
      const list = () => listPiSessionJsonlDirectory({ cwd, agentDir, cache });
      return { cwd, sessionDirectory, file, cache, list };
    };

    it('keeps a rename made far before the end of a large transcript', async () => {
      const { cwd, file, list } = await setup();
      // ~600KB after the rename: deeper than the old 128KB tail window in a >512KB file.
      await writeFile(file, [validHeader(cwd), userLine('first prompt'), infoLine('Renamed early'), filler(60), ''].join('\n'));
      const [row] = await list();
      expect(row).toMatchObject({ name: 'Renamed early', firstMessage: 'first prompt' });
    });

    it('scans only appended bytes after growth and keeps the latest rename', async () => {
      const { cwd, file, cache, list } = await setup();
      await writeFile(file, [validHeader(cwd), userLine('first prompt'), infoLine('Before'), filler(60), ''].join('\n'));
      await list();
      const bytesAfterCold = cache.stats.bytesRead;
      const appended = [filler(2), infoLine('After'), ''].join('\n');
      await appendFile(file, appended);
      const [row] = await list();
      expect(row.name).toBe('After');
      expect(cache.stats.incrementalScans).toBe(1);
      expect(cache.stats.bytesRead - bytesAfterCold).toBe(Buffer.byteLength(appended));
    });

    it('carries a partial trailing line to the next scan', async () => {
      const { cwd, file, list } = await setup();
      const pending = infoLine('Split rename');
      await writeFile(file, [validHeader(cwd), userLine('first prompt'), pending.slice(0, 10)].join('\n'));
      expect((await list())[0].name).toBeUndefined();
      await appendFile(file, `${pending.slice(10)}\n`);
      expect((await list())[0].name).toBe('Split rename');
    });

    it('treats an empty session_info as an explicit clear', async () => {
      const { cwd, file, list } = await setup();
      await writeFile(file, [validHeader(cwd), userLine('first prompt'), infoLine('Named'), filler(60), ''].join('\n'));
      expect((await list())[0].name).toBe('Named');
      await appendFile(file, `${infoLine('   ')}\n`);
      const [row] = await list();
      expect(row.name).toBeUndefined();
      expect(row.firstMessage).toBe('first prompt');
    });

    it('rescans a replaced or shrunk file from the start', async () => {
      const { cwd, file, sessionDirectory, cache, list } = await setup();
      await writeFile(file, [validHeader(cwd), userLine('first prompt'), infoLine('Old name'), filler(3), ''].join('\n'));
      await list();
      await writeFile(file, [validHeader(cwd), userLine('other prompt'), ''].join('\n'));
      let [row] = await list();
      expect(row.name).toBeUndefined();
      expect(row.firstMessage).toBe('other prompt');
      expect(cache.stats.fullScans).toBe(2);

      const replacement = join(sessionDirectory, 'replacement.tmp');
      await writeFile(replacement, [validHeader(cwd), userLine('other prompt'), infoLine('Replaced name'), filler(3), ''].join('\n'));
      await rename(replacement, file);
      [row] = await list();
      expect(row.name).toBe('Replaced name');
      expect(cache.stats.fullScans).toBe(3);
    });

    it('serves unchanged files from cache without reading them', async () => {
      const { cwd, file, cache, list } = await setup();
      await writeFile(file, [validHeader(cwd), userLine('first prompt'), infoLine('Named'), filler(60), ''].join('\n'));
      const first = await list();
      const snapshot = { ...cache.stats };
      const second = await list();
      expect(second).toEqual(first);
      expect(cache.stats).toEqual(snapshot);
    });

    it('prunes cache entries for deleted files and still fails on a malformed header', async () => {
      const { cwd, file, sessionDirectory, cache, list } = await setup();
      await writeFile(file, [validHeader(cwd), userLine('first prompt'), ''].join('\n'));
      await list();
      expect(cache.entries.has(file)).toBe(true);
      await rename(file, join(sessionDirectory, 'moved.txt'));
      expect(await list()).toEqual([]);
      expect(cache.entries.size).toBe(0);
      await writeFile(join(sessionDirectory, 'bad.jsonl'), '{"type":"message"}\n');
      await expect(list()).rejects.toMatchObject({ code: 'MALFORMED_SESSION_JSONL' });
      expect(cache.entries.size).toBe(0);
    });
  });
});
