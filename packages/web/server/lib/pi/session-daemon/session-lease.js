import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { withCrossProcessLock } from '../../server/cross-process-lock.js';

export class SessionLeaseError extends Error {
  constructor(code, message = 'The Pi session lease is unavailable.') {
    super(message);
    this.code = code;
  }
}

const isPidAlive = (processLike, pid) => {
  try {
    processLike.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

export const canonicalizeLeaseDir = (value, platform = process.platform) => {
  const resolved = resolve(String(value ?? ''));
  if (platform === 'win32') {
    return resolved.replace(/\\/g, '/').replace(/^([a-z]):/i, (match) => match.toLowerCase());
  }
  return resolved;
};

const leaseHash = ({ agentDir, cwd, sessionId }) => createHash('sha256')
  .update(`${agentDir}\n${cwd}\n${sessionId}`)
  .digest('hex')
  .slice(0, 32);

export const resolveSessionLeaseFile = ({ agentDir, cwd, sessionId, platform = process.platform } = {}) => {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new SessionLeaseError('INVALID_SESSION_ID');
  }
  const canonicalAgentDir = canonicalizeLeaseDir(agentDir, platform);
  const canonicalCwd = canonicalizeLeaseDir(cwd, platform);
  const name = `${leaseHash({ agentDir: canonicalAgentDir, cwd: canonicalCwd, sessionId })}.json`;
  return {
    file: join(canonicalAgentDir, '.pichamber', 'locks', 'sessions', name),
    canonicalAgentDir,
    canonicalCwd,
  };
};

const isValidLease = (value) => (
  value
  && typeof value === 'object'
  && typeof value.profileKey === 'string' && value.profileKey.length > 0
  && typeof value.serverInstanceId === 'string' && value.serverInstanceId.length > 0
  && typeof value.daemonId === 'string' && value.daemonId.length > 0
  && Number.isInteger(value.daemonPid) && value.daemonPid > 0
  && typeof value.sessionId === 'string' && value.sessionId.length > 0
);

// The daemon owns resident Pi runtimes. A same-profile server restart may
// claim that daemon and change serverInstanceId without replacing the daemon
// or its runtimes, so the mutable server owner is diagnostic lease metadata,
// not part of lease ownership.
const isOwnLease = (lease, owner) => (
  lease?.profileKey === owner?.profileKey
  && lease?.daemonId === owner?.daemonId
  && lease?.daemonPid === owner?.daemonPid
);

/**
 * Acquire exclusive cross-daemon ownership of one Pi session.
 *
 * Different sessions may run in parallel. The same session may not be
 * resident in two PiChamber daemons. Contention returns
 * `{ acquired: false, owner }` so the daemon can project SESSION_IN_USE
 * instead of pretending the session is absent.
 */
export const acquireSessionLease = async ({
  agentDir,
  cwd,
  sessionId,
  owner,
  platform = process.platform,
  processLike = process,
  timeoutMs = 5_000,
} = {}) => {
  if (!owner || typeof owner !== 'object') throw new SessionLeaseError('INVALID_OWNER');
  const { file, canonicalAgentDir, canonicalCwd } = resolveSessionLeaseFile({ agentDir, cwd, sessionId, platform });
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  return withCrossProcessLock(`${file}.lock`, async () => {
    let current = null;
    try {
      current = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new SessionLeaseError('LEASE_UNREADABLE');
    }
    if (isValidLease(current) && !isOwnLease(current, owner)) {
      if (isPidAlive(processLike, current.daemonPid)) {
        return { acquired: false, owner: current };
      }
    }
    const lease = {
      profileKey: owner.profileKey,
      serverInstanceId: owner.serverInstanceId,
      daemonId: owner.daemonId,
      daemonPid: owner.daemonPid,
      sessionId,
      cwd: canonicalCwd,
      agentDir: canonicalAgentDir,
      acquiredAt: new Date().toISOString(),
    };
    const temporary = `${file}.${processLike.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(lease), { mode: 0o600 });
    await rename(temporary, file);
    return { acquired: true, lease };
  }, { timeoutMs, processLike });
};

export const releaseSessionLease = async ({
  agentDir,
  cwd,
  sessionId,
  owner,
  platform = process.platform,
  processLike = process,
  timeoutMs = 5_000,
} = {}) => {
  const { file } = resolveSessionLeaseFile({ agentDir, cwd, sessionId, platform });
  return withCrossProcessLock(`${file}.lock`, async () => {
    let current = null;
    try {
      current = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return { released: false };
      throw new SessionLeaseError('LEASE_UNREADABLE');
    }
    if (!isOwnLease(current, owner)) return { released: false };
    await rm(file, { force: true });
    return { released: true };
  }, { timeoutMs, processLike });
};

export const readSessionLeaseOwner = async ({ agentDir, cwd, sessionId, platform = process.platform } = {}) => {
  const { file } = resolveSessionLeaseFile({ agentDir, cwd, sessionId, platform });
  try {
    const current = JSON.parse(await readFile(file, 'utf8'));
    return isValidLease(current) ? current : null;
  } catch {
    return null;
  }
};
