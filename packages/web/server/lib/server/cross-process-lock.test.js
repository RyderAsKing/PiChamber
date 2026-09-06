import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withCrossProcessLock } from './cross-process-lock.js';

describe('cross-process lock', () => {
  it('serializes concurrent critical sections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-lock-'));
    const lockFile = join(root, 'write.lock');
    let releaseFirst;
    const firstMayFinish = new Promise((resolve) => { releaseFirst = resolve; });
    let firstEntered;
    const firstDidEnter = new Promise((resolve) => { firstEntered = resolve; });
    let active = 0;
    let maximumActive = 0;
    const enter = async (waitFor) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      firstEntered?.();
      await waitFor;
      active -= 1;
    };

    const first = withCrossProcessLock(lockFile, () => enter(firstMayFinish));
    await firstDidEnter;
    const second = withCrossProcessLock(lockFile, () => enter(Promise.resolve()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(maximumActive).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(maximumActive).toBe(1);
  });

  it('does not remove a replacement lock owned by another nonce', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-lock-'));
    const lockFile = join(root, 'owner.lock');
    const replacement = { pid: process.pid, nonce: 'replacement-owner' };
    await withCrossProcessLock(lockFile, async () => {
      const claim = JSON.parse(await readFile(lockFile, 'utf8'));
      expect(claim.pid).toBe(process.pid);
      expect(typeof claim.nonce).toBe('string');
      await writeFile(lockFile, JSON.stringify(replacement));
    });
    await expect(readFile(lockFile, 'utf8')).resolves.toBe(JSON.stringify(replacement));
    await rm(lockFile, { force: true });
  });

  it('reclaims a lock whose owner pid is dead', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-lock-'));
    const lockFile = join(root, 'dead.lock');
    const deadPid = 987_654_321;
    await writeFile(lockFile, JSON.stringify({ pid: deadPid, nonce: 'dead-owner' }));
    const processLike = {
      pid: process.pid,
      kill(pid, signal) {
        if (pid === deadPid && signal === 0) {
          const error = new Error('ESRCH');
          error.code = 'ESRCH';
          throw error;
        }
        return process.kill(pid, signal);
      },
    };

    await expect(withCrossProcessLock(lockFile, async () => 'acquired', { processLike })).resolves.toBe('acquired');
    await expect(readFile(lockFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
