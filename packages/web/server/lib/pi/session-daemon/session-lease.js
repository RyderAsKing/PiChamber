import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { readSmallRegularFile, withCrossProcessLock } from '../../server/cross-process-lock.js';

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

const LEASE_SCOPE = /^[A-Za-z0-9_-]{1,64}$/;

/** The folder holding every sandbox's own lease folder, one per scope. */
const scopedLeaseRoot = (agentDir, platform = process.platform) => (
  join(canonicalizeLeaseDir(agentDir, platform), '.pichamber', 'locks', 'sandbox-sessions')
);

/** The lease folder of one scope: all a sandbox daemon is granted. */
export const scopedLeaseDir = (agentDir, scope, platform = process.platform) => {
  if (typeof scope !== 'string' || !LEASE_SCOPE.test(scope)) throw new SessionLeaseError('INVALID_LEASE_SCOPE');
  return join(scopedLeaseRoot(agentDir, platform), scope);
};

/**
 * Where a session's lease lives. A daemon with a `scope` (a sandbox daemon)
 * keeps its leases in its own folder, the only lease folder it can reach;
 * every other daemon uses the shared one. The file name is the same in
 * both, so a daemon outside a sandbox can look a session up in each scope.
 */
export const resolveSessionLeaseFile = ({ agentDir, cwd, sessionId, scope, platform = process.platform } = {}) => {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new SessionLeaseError('INVALID_SESSION_ID');
  }
  const canonicalAgentDir = canonicalizeLeaseDir(agentDir, platform);
  const canonicalCwd = canonicalizeLeaseDir(cwd, platform);
  const name = `${leaseHash({ agentDir: canonicalAgentDir, cwd: canonicalCwd, sessionId })}.json`;
  const directory = scope === undefined
    ? join(canonicalAgentDir, '.pichamber', 'locks', 'sessions')
    : scopedLeaseDir(canonicalAgentDir, scope, platform);
  return {
    file: join(directory, name),
    name,
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

// A live lease a sandbox daemon holds on this session, read from the scope
// folders. Those folders are written by sandboxed code: a file there is read
// as a small regular file or not at all, and only a lease for this very
// session counts.
const scopedLeaseHolder = async ({ canonicalAgentDir, name, sessionId, owner, platform, processLike }) => {
  const root = scopedLeaseRoot(canonicalAgentDir, platform);
  let scopes;
  try {
    scopes = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const scope of scopes) {
    if (!scope.isDirectory() || !LEASE_SCOPE.test(scope.name)) continue;
    let lease;
    try {
      lease = JSON.parse(await readSmallRegularFile(join(root, scope.name, name)));
    } catch {
      continue;
    }
    if (!isValidLease(lease) || lease.sessionId !== sessionId || isOwnLease(lease, owner)) continue;
    if (isPidAlive(processLike, lease.daemonPid)) return lease;
  }
  return null;
};

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
  scope,
} = {}) => {
  if (!owner || typeof owner !== 'object') throw new SessionLeaseError('INVALID_OWNER');
  const { file, name, canonicalAgentDir, canonicalCwd } = resolveSessionLeaseFile({ agentDir, cwd, sessionId, scope, platform });
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  return withCrossProcessLock(`${file}.lock`, async () => {
    let current = null;
    try {
      current = JSON.parse(await readSmallRegularFile(file));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new SessionLeaseError('LEASE_UNREADABLE');
    }
    if (isValidLease(current) && !isOwnLease(current, owner)) {
      if (isPidAlive(processLike, current.daemonPid)) {
        return { acquired: false, owner: current };
      }
    }
    // A sandbox daemon may be running the session. It cannot see this
    // daemon's leases, so the check is made from this side only.
    if (scope === undefined) {
      const holder = await scopedLeaseHolder({ canonicalAgentDir, name, sessionId, owner, platform, processLike });
      if (holder) return { acquired: false, owner: holder };
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
    // Sandbox daemons share this folder, so a name that can be guessed could
    // be planted as a symlink to any file. A random name created with `wx`
    // never writes through one, and the rename replaces whatever sits at the
    // lease path rather than following it.
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(lease), { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      throw new SessionLeaseError('LEASE_UNREADABLE');
    }
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
  scope,
} = {}) => {
  const { file } = resolveSessionLeaseFile({ agentDir, cwd, sessionId, scope, platform });
  return withCrossProcessLock(`${file}.lock`, async () => {
    let current = null;
    try {
      current = JSON.parse(await readSmallRegularFile(file));
    } catch (error) {
      if (error?.code === 'ENOENT') return { released: false };
      throw new SessionLeaseError('LEASE_UNREADABLE');
    }
    if (!isOwnLease(current, owner)) return { released: false };
    await rm(file, { force: true });
    return { released: true };
  }, { timeoutMs, processLike });
};

export const readSessionLeaseOwner = async ({ agentDir, cwd, sessionId, scope, platform = process.platform } = {}) => {
  const { file } = resolveSessionLeaseFile({ agentDir, cwd, sessionId, scope, platform });
  try {
    const current = JSON.parse(await readSmallRegularFile(file));
    return isValidLease(current) ? current : null;
  } catch {
    return null;
  }
};
