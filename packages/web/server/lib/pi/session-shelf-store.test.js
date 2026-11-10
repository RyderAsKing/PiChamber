import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createPiSessionShelfStore } from './session-shelf-store.js';

const createStore = async (clock = { now: 1_000 }) => {
  const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-shelf-'));
  const file = join(root, 'pi', 'session-shelf.json');
  return { file, clock, store: createPiSessionShelfStore({ file, now: () => clock.now }) };
};

describe('Pi session shelf sidecar', () => {
  it('reads a missing file as an empty shelf', async () => {
    const { store } = await createStore();
    await expect(store.read()).resolves.toEqual({});
  });

  it('settles, keeps active, and clears an override', async () => {
    const { store, clock } = await createStore();
    await expect(store.update('s1', { settled: 'settled' })).resolves.toEqual({ settled: 'settled', settledAt: 1_000 });
    clock.now = 2_000;
    // Settling again keeps the first settle time.
    await expect(store.update('s1', { settled: 'settled' })).resolves.toEqual({ settled: 'settled', settledAt: 1_000 });
    await expect(store.update('s1', { settled: 'active' })).resolves.toEqual({ settled: 'active' });
    await expect(store.update('s1', { settled: null })).resolves.toBeNull();
    await expect(store.read()).resolves.toEqual({});
  });

  it('snoozing clears a settled override and settling clears a snooze', async () => {
    const { store, clock } = await createStore();
    await store.update('s1', { settled: 'settled' });
    clock.now = 5_000;
    await expect(store.update('s1', { snoozedUntil: 9_000 })).resolves.toEqual({ snoozedUntil: 9_000, snoozedAt: 5_000 });
    await expect(store.update('s1', { settled: 'settled' })).resolves.toEqual({ settled: 'settled', settledAt: 5_000 });
    await store.update('s2', { settled: 'active' });
    await expect(store.update('s2', { snoozedUntil: 9_000 })).resolves.toEqual({ settled: 'active', snoozedUntil: 9_000, snoozedAt: 5_000 });
    await expect(store.update('s2', { snoozedUntil: null })).resolves.toEqual({ settled: 'active' });
  });

  it('clears both on activity and on delete without touching other sessions', async () => {
    const { store } = await createStore();
    await store.update('s1', { snoozedUntil: 9_000 });
    await store.update('s2', { settled: 'settled' });
    await store.update('s3', { settled: 'active' });
    await expect(store.clearForActivity('s1')).resolves.toBeNull();
    await expect(store.clearForActivity('missing')).resolves.toBeNull();
    await store.remove('s2');
    await expect(store.read()).resolves.toEqual({ s3: { settled: 'active' } });
  });

  it('rejects invalid requests', async () => {
    const { store } = await createStore();
    await expect(store.update('s1', {})).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(store.update('s1', { settled: 'done' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(store.update('s1', { snoozedUntil: -1 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(store.update('s1', { settled: 'settled', snoozedUntil: 9_000 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(store.update('__proto__', { settled: 'settled' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('fails on malformed metadata instead of reading it as empty', async () => {
    const { store, file } = await createStore();
    await store.update('s1', { settled: 'settled' });
    await writeFile(file, 'not-json');
    await expect(store.read()).rejects.toMatchObject({ code: 'SESSION_SHELF_INVALID' });
    await writeFile(file, JSON.stringify({ s1: { settled: 'settled' } }));
    await expect(store.read()).rejects.toMatchObject({ code: 'SESSION_SHELF_INVALID' });
    // A failed read must not overwrite the file.
    await expect(store.update('s2', { settled: 'active' })).rejects.toMatchObject({ code: 'SESSION_SHELF_INVALID' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ s1: { settled: 'settled' } });
  });
});
