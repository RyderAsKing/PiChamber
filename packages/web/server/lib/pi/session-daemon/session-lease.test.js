import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireSessionLease,
  readSessionLeaseOwner,
  releaseSessionLease,
} from './session-lease.js';

const ownerA = {
  profileKey: 'web-p3000',
  serverInstanceId: 'server-a',
  daemonId: 'daemon-a',
  daemonPid: process.pid,
};

const ownerB = {
  profileKey: 'web-dev-p3902',
  serverInstanceId: 'server-b',
  daemonId: 'daemon-b',
  daemonPid: process.pid,
};

describe('session lease', () => {
  it('grants one owner and reports contention without hiding the session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-lease-'));
    const agentDir = join(root, 'agent');
    const cwd = join(root, 'project');
    const sessionId = 'session-1';

    await expect(acquireSessionLease({ agentDir, cwd, sessionId, owner: ownerA })).resolves.toMatchObject({
      acquired: true,
    });
    const contention = await acquireSessionLease({ agentDir, cwd, sessionId, owner: ownerB });
    expect(contention.acquired).toBe(false);
    expect(contention.owner?.profileKey).toBe('web-p3000');

    // The session remains visible: the lease owner is readable.
    await expect(readSessionLeaseOwner({ agentDir, cwd, sessionId })).resolves.toMatchObject({
      profileKey: 'web-p3000',
    });

    // Another profile must not release the lease.
    await expect(releaseSessionLease({ agentDir, cwd, sessionId, owner: ownerB })).resolves.toEqual({
      released: false,
    });
    await expect(releaseSessionLease({ agentDir, cwd, sessionId, owner: ownerA })).resolves.toEqual({
      released: true,
    });
    await expect(acquireSessionLease({ agentDir, cwd, sessionId, owner: ownerB })).resolves.toMatchObject({
      acquired: true,
    });
  });

  it('keeps a resident lease owned by the daemon after its server owner changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-lease-'));
    const agentDir = join(root, 'agent');
    const cwd = join(root, 'project');
    const sessionId = 'session-claimed';
    const claimedOwner = { ...ownerA, serverInstanceId: 'server-a-restarted' };

    await expect(acquireSessionLease({ agentDir, cwd, sessionId, owner: ownerA })).resolves.toMatchObject({
      acquired: true,
    });
    await expect(releaseSessionLease({ agentDir, cwd, sessionId, owner: claimedOwner })).resolves.toEqual({
      released: true,
    });
  });

  it('reclaims a lease from a dead daemon pid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-lease-'));
    const agentDir = join(root, 'agent');
    const cwd = join(root, 'project');
    const sessionId = 'session-dead-owner';
    const deadOwner = { ...ownerA, daemonPid: 987_654_321 };
    const processLike = {
      pid: process.pid,
      kill(pid, signal) {
        if (pid === deadOwner.daemonPid && signal === 0) {
          const error = new Error('ESRCH');
          error.code = 'ESRCH';
          throw error;
        }
        return process.kill(pid, signal);
      },
    };

    await expect(acquireSessionLease({ agentDir, cwd, sessionId, owner: deadOwner })).resolves.toMatchObject({ acquired: true });
    await expect(acquireSessionLease({ agentDir, cwd, sessionId, owner: ownerB, processLike })).resolves.toMatchObject({
      acquired: true,
      lease: { daemonId: ownerB.daemonId },
    });
  });

  it('allows different sessions to run in parallel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-lease-'));
    const agentDir = join(root, 'agent');
    const cwd = join(root, 'project');
    await expect(acquireSessionLease({ agentDir, cwd, sessionId: 'a', owner: ownerA })).resolves.toMatchObject({
      acquired: true,
    });
    await expect(acquireSessionLease({ agentDir, cwd, sessionId: 'b', owner: ownerB })).resolves.toMatchObject({
      acquired: true,
    });
  });
});
