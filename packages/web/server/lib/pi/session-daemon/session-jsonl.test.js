import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
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

  it('lists session metadata without reading a padded transcript body', async () => {
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
});
