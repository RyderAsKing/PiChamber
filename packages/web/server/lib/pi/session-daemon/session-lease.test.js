import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireSessionLease,
  readSessionLeaseOwner,
  releaseSessionLease,
  resolveSessionLeaseFile,
  scopedLeaseDir,
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
  // Sandbox daemons can write the lease folder, so nothing in it is trusted.
  describe.skipIf(process.platform === 'win32')('a lease folder untrusted code can write', () => {
    const setup = async () => {
      const root = await mkdtemp(join(tmpdir(), 'pichamber-lease-'));
      const agentDir = join(root, 'agent');
      const cwd = join(root, 'project');
      const { file } = resolveSessionLeaseFile({ agentDir, cwd, sessionId: 'session-1' });
      await mkdir(join(file, '..'), { recursive: true });
      const victim = join(root, 'victim.txt');
      await writeFile(victim, 'keep me');
      return { agentDir, cwd, file, victim };
    };

    it('never writes through a symlink planted at the old temp name', async () => {
      const { agentDir, cwd, file, victim } = await setup();
      await symlink(victim, `${file}.${process.pid}.tmp`);

      await expect(acquireSessionLease({ agentDir, cwd, sessionId: 'session-1', owner: ownerA }))
        .resolves.toMatchObject({ acquired: true });
      expect(await readFile(victim, 'utf8')).toBe('keep me');
    });

    it('does not follow a symlink planted as the lease file', async () => {
      const { agentDir, cwd, file, victim } = await setup();
      await writeFile(victim, JSON.stringify({ ...ownerB, sessionId: 'session-1' }));
      await symlink(victim, file);

      await expect(acquireSessionLease({ agentDir, cwd, sessionId: 'session-1', owner: ownerA }))
        .rejects.toMatchObject({ code: 'LEASE_UNREADABLE' });
      expect(await readSessionLeaseOwner({ agentDir, cwd, sessionId: 'session-1' })).toBeNull();
      expect(JSON.parse(await readFile(victim, 'utf8')).daemonId).toBe('daemon-b');
    });

    it('does not wait on a FIFO planted as the lease file', async () => {
      const { agentDir, cwd, file } = await setup();
      execFileSync('mkfifo', [file]);

      await expect(acquireSessionLease({ agentDir, cwd, sessionId: 'session-1', owner: ownerA, timeoutMs: 500 }))
        .rejects.toMatchObject({ code: 'LEASE_UNREADABLE' });
    });
  });
  // A sandbox daemon keeps its leases in its own folder (its scope).
  describe('a sandbox daemon\'s lease folder', () => {
    const dirs = async () => {
      const root = await mkdtemp(join(tmpdir(), 'pichamber-lease-'));
      return { agentDir: join(root, 'agent'), cwd: join(root, 'project') };
    };
    const sandboxOwner = { ...ownerB, daemonId: 'daemon-sandbox' };

    it('holds the lease where no other project\'s leases are', async () => {
      const { agentDir, cwd } = await dirs();
      await acquireSessionLease({ agentDir, cwd, sessionId: 'session-1', owner: sandboxOwner, scope: 'proj-a' });
      const { file } = resolveSessionLeaseFile({ agentDir, cwd, sessionId: 'session-1', scope: 'proj-a' });
      expect(file.startsWith(`${scopedLeaseDir(agentDir, 'proj-a')}/`)).toBe(true);
      expect(await readSessionLeaseOwner({ agentDir, cwd, sessionId: 'session-1' })).toBeNull();
      expect((await readSessionLeaseOwner({ agentDir, cwd, sessionId: 'session-1', scope: 'proj-a' }))?.daemonId).toBe('daemon-sandbox');
      expect(() => resolveSessionLeaseFile({ agentDir, cwd, sessionId: 'session-1', scope: '../sessions' })).toThrow();
    });

    it('keeps a daemon outside the sandbox out of a session the sandbox runs, until it lets go', async () => {
      const { agentDir, cwd } = await dirs();
      await acquireSessionLease({ agentDir, cwd, sessionId: 'session-1', owner: sandboxOwner, scope: 'proj-a' });

      const contention = await acquireSessionLease({ agentDir, cwd, sessionId: 'session-1', owner: ownerA });
      expect(contention).toMatchObject({ acquired: false, owner: { daemonId: 'daemon-sandbox' } });
      // Another session is not affected.
      await expect(acquireSessionLease({ agentDir, cwd, sessionId: 'session-2', owner: ownerA })).resolves.toMatchObject({ acquired: true });

      await releaseSessionLease({ agentDir, cwd, sessionId: 'session-1', owner: sandboxOwner, scope: 'proj-a' });
      await expect(acquireSessionLease({ agentDir, cwd, sessionId: 'session-1', owner: ownerA })).resolves.toMatchObject({ acquired: true });
    });

    it('lets a replacement daemon of the same project see the lease', async () => {
      const { agentDir, cwd } = await dirs();
      await acquireSessionLease({ agentDir, cwd, sessionId: 'session-1', owner: sandboxOwner, scope: 'proj-a' });
      const next = await acquireSessionLease({ agentDir, cwd, sessionId: 'session-1', owner: { ...sandboxOwner, daemonId: 'daemon-next' }, scope: 'proj-a' });
      expect(next.acquired).toBe(false);
    });

    it('ignores a file in a sandbox folder that is not a lease for the session', async () => {
      const { agentDir, cwd } = await dirs();
      const { name } = resolveSessionLeaseFile({ agentDir, cwd, sessionId: 'session-1' });
      const scope = scopedLeaseDir(agentDir, 'proj-a');
      await mkdir(scope, { recursive: true });
      // A lease for another session copied under this session's name.
      await writeFile(join(scope, name), JSON.stringify({ ...sandboxOwner, sessionId: 'session-9' }));
      await expect(acquireSessionLease({ agentDir, cwd, sessionId: 'session-1', owner: ownerA })).resolves.toMatchObject({ acquired: true });
    });
  });
});
