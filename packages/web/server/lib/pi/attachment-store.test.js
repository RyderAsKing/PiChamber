import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPiAttachmentStore, PiAttachmentStoreError } from './attachment-store.js';

const base64 = (value) => Buffer.from(value).toString('base64');

describe('Pi attachment store', () => {
  let store;

  afterEach(async () => {
    await store?.dispose();
    store = undefined;
  });

  it('writes bounded uploads using opaque ids and keeps paths private', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pichamber-pi-attachments-'));
    store = createPiAttachmentStore({ directory });
    const attachment = await store.create({ filename: '../../notes?.txt', mime: 'text/plain', base64: base64('hello') });

    expect(attachment).toEqual(expect.objectContaining({ name: 'notes_.txt', mime: 'text/plain', size: 5 }));
    expect(attachment).not.toHaveProperty('path');
    const [privateAttachment] = await store.resolve([attachment.id]);
    await expect(readFile(privateAttachment.path, 'utf8')).resolves.toBe('hello');
  });

  it('streams binary uploads, removes unused files, and frees active slots after prompt acceptance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pichamber-pi-attachments-'));
    store = createPiAttachmentStore({ directory });
    const streamed = await store.createFromStream({
      filename: 'stream.txt',
      mime: 'text/plain',
      stream: (async function* () { yield Buffer.from('hel'); yield Buffer.from('lo'); })(),
    });
    expect(streamed).toEqual(expect.objectContaining({ name: 'stream.txt', size: 5 }));
    const [resolved] = await store.resolve([streamed.id]);
    await expect(readFile(resolved.path, 'utf8')).resolves.toBe('hello');

    await store.consume([streamed.id]);
    const [retired] = await store.resolve([streamed.id]);
    expect(retired.path).toBe(resolved.path);
    await expect(readFile(resolved.path, 'utf8')).resolves.toBe('hello');

    const unused = await store.create({ filename: 'unused.txt', mime: 'text/plain', base64: base64('x') });
    expect(await store.remove(unused.id)).toBe(true);
    await expect(store.resolve([unused.id])).rejects.toMatchObject({ code: 'ATTACHMENT_MISSING' });
  });

  it('rejects malformed, executable, missing, and expired uploads explicitly', async () => {
    let now = 0;
    store = createPiAttachmentStore({ directory: await mkdtemp(join(tmpdir(), 'pichamber-pi-attachments-')), now: () => now, ttlMs: 1 });
    await expect(store.create({ filename: 'bad', mime: 'text/plain', base64: 'not base64!' })).rejects.toMatchObject({ code: 'ATTACHMENT_FAILED' });
    await expect(store.create({ filename: 'bad.exe', mime: 'application/x-msdownload', base64: base64('x') })).rejects.toMatchObject({ code: 'ATTACHMENT_FAILED' });
    await expect(store.resolve(['missing'])).rejects.toBeInstanceOf(PiAttachmentStoreError);
    await expect(store.resolve(Array.from({ length: 21 }, (_, index) => `attachment-${index}`))).rejects.toMatchObject({ code: 'ATTACHMENT_FAILED' });

    const attachment = await store.create({ filename: 'note.txt', mime: 'text/plain', base64: base64('x') });
    now = 2;
    await expect(store.resolve([attachment.id])).rejects.toMatchObject({ code: 'ATTACHMENT_MISSING' });
  });
});
