import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolvePiChamberDataDir } from '../pichamber-data-dir.js';
import { withCrossProcessLock } from '../server/cross-process-lock.js';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_ID_LENGTH = 512;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const invalidShelf = () => {
  const error = new Error('Pi session shelf metadata is invalid.');
  error.code = 'SESSION_SHELF_INVALID';
  return error;
};

const invalidArgument = () => {
  const error = new Error('The session shelf request is invalid.');
  error.code = 'INVALID_ARGUMENT';
  return error;
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTimestamp = (value) => Number.isSafeInteger(value) && value > 0;
const isSessionId = (value) => typeof value === 'string' && value.length > 0
  && value.length <= MAX_SESSION_ID_LENGTH && !FORBIDDEN_KEYS.has(value);

// One session's stored entry, or null when it holds nothing. A snooze
// travels with its start time. Files written before Archive replaced Settle
// may also carry `settled` ('settled' with its `settledAt`, or 'active');
// those fields are kept here only so the migration can read them.
const validateStoredEntry = (value) => {
  if (!isRecord(value)) throw invalidShelf();
  const entry = {};
  if (value.settled !== undefined) {
    if (value.settled === 'settled') {
      if (!isTimestamp(value.settledAt)) throw invalidShelf();
      entry.settled = 'settled';
      entry.settledAt = value.settledAt;
    } else if (value.settled === 'active') {
      entry.settled = 'active';
    } else {
      throw invalidShelf();
    }
  }
  if (value.snoozedUntil !== undefined) {
    if (!isTimestamp(value.snoozedUntil) || !isTimestamp(value.snoozedAt)) throw invalidShelf();
    entry.snoozedUntil = value.snoozedUntil;
    entry.snoozedAt = value.snoozedAt;
  }
  return Object.keys(entry).length > 0 ? entry : null;
};

const validateStoredShelf = (value) => {
  if (!isRecord(value)) throw invalidShelf();
  const shelf = {};
  for (const [sessionId, raw] of Object.entries(value)) {
    if (!isSessionId(sessionId)) throw invalidShelf();
    const entry = validateStoredEntry(raw);
    if (entry) shelf[sessionId] = entry;
  }
  return shelf;
};

const hasLegacySettled = (shelf) => Object.values(shelf).some((entry) => entry.settled !== undefined);

// The shelf without the retired settled fields; entries left empty go.
const withoutSettled = (shelf) => {
  const next = {};
  for (const [sessionId, entry] of Object.entries(shelf)) {
    if (entry.snoozedUntil === undefined) continue;
    next[sessionId] = { snoozedUntil: entry.snoozedUntil, snoozedAt: entry.snoozedAt };
  }
  return next;
};

// The snooze-only shelf with the settled fields from `stored` put back, for
// a write while the migration is still pending. `dropSessionId` loses its
// settled mark.
const withSettledKept = (shelf, stored, dropSessionId) => {
  const next = {};
  for (const sessionId of new Set([...Object.keys(stored), ...Object.keys(shelf)])) {
    const entry = {};
    const legacy = stored[sessionId];
    if (legacy?.settled !== undefined && sessionId !== dropSessionId) {
      entry.settled = legacy.settled;
      if (legacy.settled === 'settled') entry.settledAt = legacy.settledAt;
    }
    if (shelf[sessionId]) Object.assign(entry, shelf[sessionId]);
    if (Object.keys(entry).length > 0) next[sessionId] = entry;
  }
  return next;
};

/**
 * PiChamber-owned sidebar shelf metadata: when a snoozed session wakes. Like
 * the archive sidecar, it is keyed only by opaque Pi session IDs, leaves Pi
 * JSONL untouched, and every write is atomic under a cross-process lock.
 *
 * - `snoozedUntil` hides a session until that time; `null` wakes it.
 * - `clearForActivity` drops the snooze when the user sends to the session.
 *
 * Settle was replaced by Archive. A file that still holds settled marks is
 * migrated once, under the shelf lock: hand-settled sessions are archived at
 * their settle time (sessions already archived keep theirs), the archive
 * file is written first, then the shelf file without the settled fields. If
 * the archive write fails, the migration runs again on the next read or
 * write. Until then reads answer with the snooze state, and snooze writes
 * still go through with every settled mark left in the file. A send or a
 * delete drops that one session's settled mark, so the retried migration
 * never archives a session the user just used.
 */
export const createPiSessionShelfStore = ({
  file = join(resolvePiChamberDataDir(), 'pi', 'session-shelf.json'),
  now = () => Date.now(),
  archiveStore,
} = {}) => {
  let writeChain = Promise.resolve();

  const readStored = async () => {
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw invalidShelf();
    }
    if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw invalidShelf();
    try {
      return validateStoredShelf(JSON.parse(raw));
    } catch {
      throw invalidShelf();
    }
  };

  const writeStored = async (shelf) => {
    const serialized = JSON.stringify(shelf);
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw invalidShelf();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, serialized, { mode: 0o600 });
    await rename(temporary, file);
  };

  // Runs under the shelf lock. Returns the migrated shelf; throws (leaving
  // the shelf file untouched) when the archive write fails.
  const migrateLocked = async (stored) => {
    if (!hasLegacySettled(stored)) return stored;
    const toArchive = {};
    for (const [sessionId, entry] of Object.entries(stored)) {
      if (entry.settled === 'settled') toArchive[sessionId] = entry.settledAt;
    }
    if (Object.keys(toArchive).length > 0) {
      if (typeof archiveStore?.archiveMissing !== 'function') {
        throw Object.assign(new Error('No archive store for the settled migration.'), { code: 'SESSION_SHELF_MIGRATION_UNAVAILABLE' });
      }
      await archiveStore.archiveMissing(toArchive);
    }
    const migrated = withoutSettled(stored);
    await writeStored(migrated);
    return migrated;
  };

  // Serializes writes in this process and across processes sharing the data
  // directory. `change` receives the migrated shelf (snooze state only) and
  // may edit it in place; it returns whether the file needs writing, the
  // result, and optionally a session whose settled mark should go too.
  // While the migration keeps failing, writes still go through: the file
  // keeps every other unmigrated settled mark, so the next read retries.
  const locked = (change) => {
    const operation = writeChain.then(() => withCrossProcessLock(`${file}.lock`, async () => {
      const stored = await readStored();
      let shelf;
      let unmigrated = null;
      try {
        shelf = await migrateLocked(stored);
      } catch (error) {
        if (error?.code === 'SESSION_SHELF_INVALID') throw error;
        console.warn('[pi] could not migrate settled sessions to the archive; will retry', error?.code ?? error);
        shelf = withoutSettled(stored);
        unmigrated = stored;
      }
      const { write, result, dropSettled } = change(shelf);
      const dropsMark = unmigrated !== null && dropSettled !== undefined && unmigrated[dropSettled]?.settled !== undefined;
      if (write || dropsMark) await writeStored(unmigrated ? withSettledKept(shelf, unmigrated, dropSettled) : shelf);
      return result;
    }));
    writeChain = operation.catch(() => {});
    return operation;
  };

  const read = async () => {
    const stored = await readStored();
    if (!hasLegacySettled(stored)) return stored;
    try {
      return await locked((shelf) => ({ write: false, result: shelf }));
    } catch (error) {
      if (error?.code === 'SESSION_SHELF_INVALID') throw error;
      console.warn('[pi] could not read the session shelf under its lock', error?.code ?? error);
      return withoutSettled(stored);
    }
  };

  // `change` receives the current entry (or null) and returns the next entry
  // (or null to remove it). `dropSettled` also removes the session's
  // unmigrated settled mark (a send or a delete), so a retried migration
  // cannot archive it afterwards.
  const mutate = (sessionId, change, { dropSettled = false } = {}) => locked((shelf) => {
    const previous = shelf[sessionId] ?? null;
    const next = change(previous);
    if (next) shelf[sessionId] = next;
    else delete shelf[sessionId];
    return {
      write: JSON.stringify(previous) !== JSON.stringify(next ?? null),
      result: next ?? null,
      ...(dropSettled ? { dropSettled: sessionId } : {}),
    };
  });

  /**
   * Apply `{ snoozedUntil }`: a timestamp snoozes, `null` wakes. Returns the
   * session's entry after the write, or null.
   */
  const update = async (sessionId, patch) => {
    if (!isSessionId(sessionId) || !isRecord(patch)) throw invalidArgument();
    if (Object.keys(patch).some((key) => key !== 'snoozedUntil') || !Object.hasOwn(patch, 'snoozedUntil')) throw invalidArgument();
    if (patch.snoozedUntil !== null && !isTimestamp(patch.snoozedUntil)) throw invalidArgument();

    return mutate(sessionId, () => (patch.snoozedUntil === null
      ? null
      : { snoozedUntil: patch.snoozedUntil, snoozedAt: now() }));
  };

  // Whether the file holds anything for this session: a snooze or an
  // unmigrated settled mark (empty entries are never kept).
  const holds = async (sessionId) => Boolean((await readStored())[sessionId]);

  /** A message the user sent ends a snooze. */
  const clearForActivity = async (sessionId) => {
    if (!isSessionId(sessionId)) return null;
    if (!(await holds(sessionId))) return null;
    return mutate(sessionId, () => null, { dropSettled: true });
  };

  const remove = async (sessionId) => {
    if (!isSessionId(sessionId)) return;
    if (!(await holds(sessionId))) return;
    await mutate(sessionId, () => null, { dropSettled: true });
  };

  return { read, update, clearForActivity, remove };
};
