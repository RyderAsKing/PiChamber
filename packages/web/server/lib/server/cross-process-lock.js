import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const RETRYABLE_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY', 'EAGAIN']);
const FRESH_LOCK_MS = 250;

export class CrossProcessLockError extends Error {
  constructor(code, message = 'The cross-process lock is unavailable.') {
    super(message);
    this.code = code;
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isPidAlive = (processLike, pid) => {
  try {
    processLike.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const SMALL_FILE_MAX_BYTES = 8192;

/**
 * Read a small file other processes write, without trusting what sits at the
 * path. A lock or lease folder can be writable by code that is not trusted
 * (a sandboxed daemon shares the session lease folder), so the read never
 * follows a symlink, never waits on a FIFO or device, and never reads more
 * than a claim can hold. Anything else there throws `ENOTREGULAR`.
 */
export const readSmallRegularFile = async (file, maxBytes = SMALL_FILE_MAX_BYTES) => {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) {
      throw Object.assign(new Error('Not a small regular file.'), { code: 'ENOTREGULAR' });
    }
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
};

const readClaim = async (lockFile) => {
  try {
    const claim = JSON.parse(await readSmallRegularFile(lockFile));
    if (Number.isInteger(claim?.pid) && claim.pid > 0 && typeof claim.nonce === 'string' && claim.nonce.length > 0) {
      return { claim };
    }
    return { malformed: true };
  } catch (error) {
    if (error?.code === 'ENOENT') return { missing: true };
    return { malformed: true };
  }
};

const isFreshLock = async (lockFile) => {
  try {
    const info = await stat(lockFile);
    return Date.now() - info.mtimeMs < FRESH_LOCK_MS;
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
};

/**
 * Serialize one critical section across processes sharing a filesystem.
 *
 * The lock file holds an owner pid plus a random nonce. Only the owner nonce
 * may release the lock. A dead owner pid may be stolen; a live owner never is.
 */
export const withCrossProcessLock = async (
  lockFile,
  operation,
  { timeoutMs = 5_000, retryDelayMs = 50, processLike = process, wait = delay } = {},
) => {
  if (typeof lockFile !== 'string' || lockFile.length === 0) {
    throw new CrossProcessLockError('INVALID_LOCK_FILE');
  }
  if (typeof operation !== 'function') {
    throw new CrossProcessLockError('INVALID_OPERATION');
  }
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });
  const nonce = randomUUID();

  while (true) {
    try {
      await writeFile(
        lockFile,
        JSON.stringify({ pid: processLike.pid, nonce, claimedAt: new Date().toISOString() }),
        { flag: 'wx', mode: 0o600 },
      );
    } catch (error) {
      if (!RETRYABLE_CODES.has(error?.code)) throw new CrossProcessLockError('LOCK_UNAVAILABLE');
      const observed = await readClaim(lockFile);
      if (observed.claim) {
        if (isPidAlive(processLike, observed.claim.pid)) {
          if (Date.now() >= deadline) throw new CrossProcessLockError('LOCK_TIMEOUT');
          await wait(retryDelayMs);
          continue;
        }
        await rm(lockFile, { force: true });
      } else if (observed.malformed) {
        if (await isFreshLock(lockFile)) {
          if (Date.now() >= deadline) throw new CrossProcessLockError('LOCK_TIMEOUT');
          await wait(retryDelayMs);
          continue;
        }
        await rm(lockFile, { force: true });
      }
      if (Date.now() >= deadline) throw new CrossProcessLockError('LOCK_TIMEOUT');
      await wait(retryDelayMs);
      continue;
    }

    try {
      return await operation();
    } finally {
      try {
        const current = JSON.parse(await readSmallRegularFile(lockFile));
        if (current?.pid === processLike.pid && current?.nonce === nonce) {
          await rm(lockFile, { force: true });
        }
      } catch {
        // A missing, replaced, or unreadable lock must never remove another owner.
      }
    }
  }
};
