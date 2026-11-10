import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolvePiChamberDataDir } from '../pichamber-data-dir.js';
import { withCrossProcessLock } from '../server/cross-process-lock.js';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_ID_LENGTH = 512;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SETTLED_STATES = new Set(['settled', 'active']);

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

// One session's entry, or null when it holds nothing. Fields only travel in
// pairs: a settled override without its time, or a snooze without its wake,
// is malformed.
const validateEntry = (value) => {
  if (!isRecord(value)) throw invalidShelf();
  const entry = {};
  if (value.settled !== undefined) {
    if (!SETTLED_STATES.has(value.settled)) throw invalidShelf();
    entry.settled = value.settled;
    if (value.settled === 'settled') {
      if (!isTimestamp(value.settledAt)) throw invalidShelf();
      entry.settledAt = value.settledAt;
    }
  }
  if (value.snoozedUntil !== undefined) {
    if (!isTimestamp(value.snoozedUntil) || !isTimestamp(value.snoozedAt)) throw invalidShelf();
    entry.snoozedUntil = value.snoozedUntil;
    entry.snoozedAt = value.snoozedAt;
  }
  return Object.keys(entry).length > 0 ? entry : null;
};

const validateShelf = (value) => {
  if (!isRecord(value)) throw invalidShelf();
  const shelf = {};
  for (const [sessionId, raw] of Object.entries(value)) {
    if (!isSessionId(sessionId)) throw invalidShelf();
    const entry = validateEntry(raw);
    if (entry) shelf[sessionId] = entry;
  }
  return shelf;
};

/**
 * PiChamber-owned sidebar shelf metadata: whether a session was settled or
 * kept active by hand, and when a snoozed session wakes. Like the archive
 * sidecar, it is keyed only by opaque Pi session IDs, leaves Pi JSONL
 * untouched, and every write is atomic under a cross-process lock.
 *
 * - `settled: 'settled'` moves a session to Settled; `settled: 'active'`
 *   keeps it out of Settled even when it would auto-settle. `null` clears
 *   the override so the client's auto-settle rule applies again.
 * - `snoozedUntil` hides a session until that time. Snoozing clears a
 *   settled override, so the session wakes into the active list.
 * - Settling clears a snooze.
 * - `clearForActivity` drops both when the user sends to the session.
 */
export const createPiSessionShelfStore = ({
  file = join(resolvePiChamberDataDir(), 'pi', 'session-shelf.json'),
  now = () => Date.now(),
} = {}) => {
  let writeChain = Promise.resolve();

  const read = async () => {
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw invalidShelf();
    }
    if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw invalidShelf();
    try {
      return validateShelf(JSON.parse(raw));
    } catch {
      throw invalidShelf();
    }
  };

  // Serializes writes in this process and across processes sharing the
  // data directory. `change` receives the current entry (or null) and
  // returns the next entry (or null to remove it).
  const mutate = (sessionId, change) => {
    const operation = writeChain.then(() => withCrossProcessLock(`${file}.lock`, async () => {
      const current = await read();
      const previous = current[sessionId] ?? null;
      const next = change(previous);
      if (next) current[sessionId] = next;
      else delete current[sessionId];
      if (JSON.stringify(previous) === JSON.stringify(next ?? null)) return next ?? null;
      const serialized = JSON.stringify(current);
      if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw invalidShelf();
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp`;
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, file);
      return next ?? null;
    }));
    writeChain = operation.catch(() => {});
    return operation;
  };

  /**
   * Apply `{ settled?, snoozedUntil? }`. An omitted field is left alone;
   * `null` clears it. Returns the session's entry after the write, or null.
   */
  const update = async (sessionId, patch) => {
    if (!isSessionId(sessionId) || !isRecord(patch)) throw invalidArgument();
    const hasSettled = Object.hasOwn(patch, 'settled');
    const hasSnooze = Object.hasOwn(patch, 'snoozedUntil');
    if (!hasSettled && !hasSnooze) throw invalidArgument();
    if (hasSettled && patch.settled !== null && !SETTLED_STATES.has(patch.settled)) throw invalidArgument();
    if (hasSnooze && patch.snoozedUntil !== null && !isTimestamp(patch.snoozedUntil)) throw invalidArgument();
    if (hasSettled && hasSnooze && patch.settled === 'settled' && patch.snoozedUntil !== null) throw invalidArgument();

    return mutate(sessionId, (previous) => {
      const at = now();
      const next = { ...previous };
      if (hasSettled) {
        delete next.settled;
        delete next.settledAt;
        if (patch.settled === 'settled') {
          next.settled = 'settled';
          next.settledAt = previous?.settled === 'settled' && previous.settledAt ? previous.settledAt : at;
          delete next.snoozedUntil;
          delete next.snoozedAt;
        } else if (patch.settled === 'active') {
          next.settled = 'active';
        }
      }
      if (hasSnooze) {
        delete next.snoozedUntil;
        delete next.snoozedAt;
        if (patch.snoozedUntil !== null) {
          next.snoozedUntil = patch.snoozedUntil;
          next.snoozedAt = at;
          if (next.settled === 'settled') {
            delete next.settled;
            delete next.settledAt;
          }
        }
      }
      return Object.keys(next).length > 0 ? next : null;
    });
  };

  /** A message the user sent ends a snooze and drops any settled override. */
  const clearForActivity = async (sessionId) => {
    if (!isSessionId(sessionId)) return null;
    const shelf = await read();
    if (!shelf[sessionId]) return null;
    return mutate(sessionId, () => null);
  };

  const remove = async (sessionId) => {
    if (!isSessionId(sessionId)) return;
    const shelf = await read();
    if (!shelf[sessionId]) return;
    await mutate(sessionId, () => null);
  };

  return { read, update, clearForActivity, remove };
};
