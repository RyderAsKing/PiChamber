import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createUpdateJobStore } from './update-job-store.js';

const temporaryDirectories = [];

const createStore = async (options = {}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pichamber-update-job-'));
  temporaryDirectories.push(directory);
  return {
    file: path.join(directory, 'run', 'update-job.json'),
    store: createUpdateJobStore({ file: path.join(directory, 'run', 'update-job.json'), ...options }),
  };
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('update job store', () => {
  it('persists update state without secrets and reads it after recreation', async () => {
    const id = '10000000-0000-4000-8000-000000000001';
    const { file, store } = await createStore({ createId: () => id, now: () => 100 });

    await store.claim({ previousVersion: '1.0.0', targetVersion: '2.0.0-rc.2', packageManager: 'npm', channel: 'rc' });
    await store.update(id, { state: 'installing' });

    await expect(createUpdateJobStore({ file }).read(id)).resolves.toMatchObject({
      id,
      state: 'installing',
      previousVersion: '1.0.0',
      targetVersion: '2.0.0-rc.2',
      packageManager: 'npm',
      channel: 'rc',
    });
    expect(await readFile(file, 'utf8')).not.toContain('password');
  });

  it('returns an active job instead of starting a concurrent update', async () => {
    const { store } = await createStore({
      createId: () => '10000000-0000-4000-8000-000000000001',
      now: () => 100,
    });

    const first = await store.claim();
    const second = await store.claim();

    expect(first.created).toBe(true);
    expect(second).toEqual({ job: first.job, created: false });
  });

  it('replaces a stale active job', async () => {
    let timestamp = 100;
    let sequence = 0;
    const ids = [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
    ];
    const { store } = await createStore({
      createId: () => ids[sequence++],
      now: () => timestamp,
      maxAgeMs: 50,
    });

    const first = await store.claim();
    timestamp = 151;
    const second = await store.claim();

    expect(second.created).toBe(true);
    expect(second.job.id).not.toBe(first.job.id);
  });

  it('allows retry immediately when a claimed worker has exited', async () => {
    let sequence = 0;
    const ids = [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
    ];
    const { store } = await createStore({
      createId: () => ids[sequence++],
      now: () => 100,
      processLike: { kill: () => { const error = new Error('missing'); error.code = 'ESRCH'; throw error; } },
    });
    const first = await store.claim();
    await store.update(first.job.id, { state: 'installing', workerPid: 12345 });

    const retried = await store.claim();

    expect(retried.created).toBe(true);
    expect(retried.job.id).toBe(ids[1]);
  });

  it('protects job identity and start time from status patches', async () => {
    const id = '10000000-0000-4000-8000-000000000001';
    const { store } = await createStore({ createId: () => id, now: () => 100 });
    await store.claim();

    const updated = await store.update(id, {
      state: 'installing',
      id: '10000000-0000-4000-8000-000000000002',
      startedAt: 999,
      unexpected: 'value',
    });

    expect(updated).toMatchObject({ id, startedAt: 100, state: 'installing' });
    expect(updated).not.toHaveProperty('unexpected');
  });

  it('does not let an old worker overwrite a newer job', async () => {
    let timestamp = 100;
    let sequence = 0;
    const ids = [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
    ];
    const { store } = await createStore({
      createId: () => ids[sequence++],
      now: () => timestamp,
      maxAgeMs: 50,
    });

    const first = await store.claim();
    timestamp = 151;
    await store.claim();

    await expect(store.update(first.job.id, { state: 'complete' })).rejects.toMatchObject({
      code: 'UPDATE_JOB_NOT_FOUND',
    });
  });
});
