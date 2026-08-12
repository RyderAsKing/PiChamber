import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getPiSessionDirectory, validatePiSessionJsonlDirectory, validatePiSessionJsonlFile } from './session-jsonl.js';

const validHeader = (cwd) => JSON.stringify({
  type: 'session',
  version: 3,
  id: 'session-one',
  timestamp: '2026-01-01T00:00:00.000Z',
  cwd,
});

describe('Pi session JSONL validation', () => {
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

    await expect(validatePiSessionJsonlDirectory({ cwd, agentDir })).rejects.toMatchObject({
      code: 'MALFORMED_SESSION_JSONL',
    });
  });

  it('reports unreadable session files explicitly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-jsonl-'));

    await expect(validatePiSessionJsonlFile(join(root, 'missing.jsonl'))).rejects.toMatchObject({
      code: 'SESSION_JSONL_UNREADABLE',
    });
  });
});
