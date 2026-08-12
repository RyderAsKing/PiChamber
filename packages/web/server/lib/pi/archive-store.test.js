import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createPiArchiveStore } from './archive-store.js';

describe('Pi archive sidecar', () => {
  it('round-trips opaque session archive metadata without modifying Pi JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-archive-'));
    const jsonl = join(root, 'session.jsonl');
    const archive = createPiArchiveStore({ file: join(root, 'pi', 'session-archive.json') });
    await writeFile(jsonl, '{"type":"session"}\n');
    const before = await readFile(jsonl, 'utf8');

    await archive.set('pi-session-1', true);
    expect(await archive.read()).toMatchObject({ 'pi-session-1': expect.any(Number) });
    expect(await readFile(jsonl, 'utf8')).toBe(before);

    await archive.set('pi-session-1', false);
    await expect(archive.read()).resolves.toEqual({});
  });

  it('fails explicitly rather than treating malformed metadata as an empty archive state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-archive-'));
    const file = join(root, 'pi', 'session-archive.json');
    const archive = createPiArchiveStore({ file });
    await archive.set('pi-session-1', true);
    await writeFile(file, 'not-json');
    await expect(archive.read()).rejects.toMatchObject({ code: 'ARCHIVE_METADATA_INVALID' });
  });
});
