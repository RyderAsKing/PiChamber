import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createPiArchiveStore } from './archive-store.js';
import { createPiSessionShelfStore } from './session-shelf-store.js';

const createStore = async (clock = { now: 1_000 }, { archiveStore } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-shelf-'));
  const file = join(root, 'pi', 'session-shelf.json');
  const archiveFile = join(root, 'pi', 'session-archive.json');
  const archive = archiveStore ?? createPiArchiveStore({ file: archiveFile });
  return {
    file,
    archiveFile,
    archive,
    clock,
    store: createPiSessionShelfStore({ file, now: () => clock.now, archiveStore: archive }),
  };
};

const writeLegacyShelf = async (file, shelf) => {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, JSON.stringify(shelf));
};

describe('Pi session shelf sidecar', () => {
  it('reads a missing file as an empty shelf', async () => {
    const { store } = await createStore();
    await expect(store.read()).resolves.toEqual({});
  });

  it('snoozes and wakes a session', async () => {
    const { store, clock } = await createStore();
    await expect(store.update('s1', { snoozedUntil: 9_000 })).resolves.toEqual({ snoozedUntil: 9_000, snoozedAt: 1_000 });
    clock.now = 2_000;
    await expect(store.update('s1', { snoozedUntil: 12_000 })).resolves.toEqual({ snoozedUntil: 12_000, snoozedAt: 2_000 });
    await expect(store.update('s1', { snoozedUntil: null })).resolves.toBeNull();
    await expect(store.read()).resolves.toEqual({});
  });

  it('clears on activity and on delete without touching other sessions', async () => {
    const { store } = await createStore();
    await store.update('s1', { snoozedUntil: 9_000 });
    await store.update('s2', { snoozedUntil: 9_000 });
    await store.update('s3', { snoozedUntil: 9_000 });
    await expect(store.clearForActivity('s1')).resolves.toBeNull();
    await expect(store.clearForActivity('missing')).resolves.toBeNull();
    await store.remove('s2');
    await expect(store.read()).resolves.toEqual({ s3: { snoozedUntil: 9_000, snoozedAt: 1_000 } });
  });

  it('rejects invalid requests, including the retired settled field', async () => {
    const { store } = await createStore();
    await expect(store.update('s1', {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(store.update('s1', { settled: 'settled' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(store.update('s1', { snoozedUntil: -1 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(store.update('__proto__', { snoozedUntil: 9_000 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('fails on malformed metadata instead of reading it as empty', async () => {
    const { store, file } = await createStore();
    await store.update('s1', { snoozedUntil: 9_000 });
    await writeFile(file, 'not-json');
    await expect(store.read()).rejects.toMatchObject({ code: 'SESSION_SHELF_INVALID' });
    await writeFile(file, JSON.stringify({ s1: { snoozedUntil: 9_000 } }));
    await expect(store.read()).rejects.toMatchObject({ code: 'SESSION_SHELF_INVALID' });
    // A failed read must not overwrite the file.
    await expect(store.update('s2', { snoozedUntil: 9_000 })).rejects.toMatchObject({ code: 'SESSION_SHELF_INVALID' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ s1: { snoozedUntil: 9_000 } });
  });

  describe('settled migration', () => {
    it('archives hand-settled sessions at their settle time and drops the settled fields', async () => {
      const { store, file, archive } = await createStore();
      await writeLegacyShelf(file, {
        settledOnly: { settled: 'settled', settledAt: 500 },
        keptActive: { settled: 'active' },
        keptActiveSnoozed: { settled: 'active', snoozedUntil: 9_000, snoozedAt: 700 },
        snoozed: { snoozedUntil: 9_000, snoozedAt: 800 },
      });

      await expect(store.read()).resolves.toEqual({
        keptActiveSnoozed: { snoozedUntil: 9_000, snoozedAt: 700 },
        snoozed: { snoozedUntil: 9_000, snoozedAt: 800 },
      });
      await expect(archive.read()).resolves.toEqual({ settledOnly: 500 });
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        keptActiveSnoozed: { snoozedUntil: 9_000, snoozedAt: 700 },
        snoozed: { snoozedUntil: 9_000, snoozedAt: 800 },
      });
    });

    it('keeps an existing archive time and leaves other archived sessions alone', async () => {
      const { store, file, archive, archiveFile } = await createStore();
      await mkdir(join(archiveFile, '..'), { recursive: true });
      await writeFile(archiveFile, JSON.stringify({ settled: 300, other: 400 }));
      await writeLegacyShelf(file, { settled: { settled: 'settled', settledAt: 500 } });
      await store.read();
      await expect(archive.read()).resolves.toEqual({ settled: 300, other: 400 });
    });

    it('runs once: an unarchive after the migration sticks', async () => {
      const { store, file, archive } = await createStore();
      await writeLegacyShelf(file, { s1: { settled: 'settled', settledAt: 500 } });
      await store.read();
      await archive.set('s1', false);
      await store.read();
      await store.update('s2', { snoozedUntil: 9_000 });
      await expect(archive.read()).resolves.toEqual({});
    });

    it('keeps settled marks while the archive write fails, lets snooze writes through, and retries on the next read', async () => {
      const real = createPiArchiveStore({ file: join(await mkdtemp(join(tmpdir(), 'pichamber-pi-archive-')), 'a.json') });
      let failing = true;
      const archiveStore = {
        read: real.read,
        set: real.set,
        archiveMissing: async (entries) => {
          if (failing) throw Object.assign(new Error('disk full'), { code: 'EIO' });
          return real.archiveMissing(entries);
        },
      };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { store, file, clock } = await createStore(undefined, { archiveStore });
      const legacy = {
        s1: { settled: 'settled', settledAt: 500 },
        s2: { snoozedUntil: 9_000, snoozedAt: 800 },
        s4: { settled: 'settled', settledAt: 600, snoozedUntil: 9_500, snoozedAt: 700 },
      };
      await writeLegacyShelf(file, legacy);

      // Reads answer with the snooze state; the file keeps the legacy data.
      await expect(store.read()).resolves.toEqual({
        s2: { snoozedUntil: 9_000, snoozedAt: 800 },
        s4: { snoozedUntil: 9_500, snoozedAt: 700 },
      });
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(legacy);

      // Snooze and wake still write and leave the settled fields as they
      // were. A send or a delete drops that session's settled mark too, so
      // the retried migration never archives a session the user just used.
      clock.now = 2_000;
      await expect(store.update('s3', { snoozedUntil: 9_000 })).resolves.toEqual({ snoozedUntil: 9_000, snoozedAt: 2_000 });
      await expect(store.update('s1', { snoozedUntil: 8_000 })).resolves.toEqual({ snoozedUntil: 8_000, snoozedAt: 2_000 });
      await expect(store.clearForActivity('s4')).resolves.toBeNull();
      await expect(store.update('s2', { snoozedUntil: null })).resolves.toBeNull();
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        s1: { settled: 'settled', settledAt: 500, snoozedUntil: 8_000, snoozedAt: 2_000 },
        s3: { snoozedUntil: 9_000, snoozedAt: 2_000 },
      });
      await expect(real.read()).resolves.toEqual({});
      expect(warn).toHaveBeenCalled();

      failing = false;
      await store.read();
      await expect(real.read()).resolves.toEqual({ s1: 500 });
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        s1: { snoozedUntil: 8_000, snoozedAt: 2_000 },
        s3: { snoozedUntil: 9_000, snoozedAt: 2_000 },
      });
      warn.mockRestore();
    });

    it('migrates before a write so settled sessions are never dropped unarchived', async () => {
      const { store, file, archive } = await createStore();
      await writeLegacyShelf(file, { s1: { settled: 'settled', settledAt: 500 } });
      await store.update('s2', { snoozedUntil: 9_000 });
      await expect(archive.read()).resolves.toEqual({ s1: 500 });
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ s2: { snoozedUntil: 9_000, snoozedAt: 1_000 } });
    });
  });
});
