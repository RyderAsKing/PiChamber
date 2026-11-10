import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolvePiChamberDataDir } from '../pichamber-data-dir.js';
import { withCrossProcessLock } from '../server/cross-process-lock.js';

const invalidArchive = () => {
  const error = new Error('Pi archive metadata is invalid.');
  error.code = 'ARCHIVE_METADATA_INVALID';
  return error;
};

const invalidArgument = () => {
  const error = new Error('The archive request is invalid.');
  error.code = 'INVALID_ARGUMENT';
  return error;
};

/**
 * PiChamber-owned archive metadata. Pi JSONL remains untouched: the sidecar is
 * keyed only by opaque Pi session IDs and every write is atomic.
 */
export const createPiArchiveStore = ({ file = join(resolvePiChamberDataDir(), 'pi', 'session-archive.json') } = {}) => {
  let writeChain = Promise.resolve();

  const read = async () => {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidArchive();
      return Object.fromEntries(Object.entries(parsed).filter(([, value]) => Number.isSafeInteger(value) && value > 0));
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      if (error?.code === 'ARCHIVE_METADATA_INVALID') throw error;
      throw invalidArchive();
    }
  };

  // Serializes writes in this process and across processes sharing the data
  // directory. `change` edits the current map in place.
  const mutate = (change) => {
    const operation = writeChain.then(() => withCrossProcessLock(`${file}.lock`, async () => {
      const current = await read();
      const result = change(current);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp`;
      await writeFile(temporary, JSON.stringify(current), { mode: 0o600 });
      await rename(temporary, file);
      return result;
    }));
    writeChain = operation.catch(() => {});
    return operation;
  };

  const set = async (sessionId, archived) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof archived !== 'boolean') throw invalidArgument();
    return mutate((current) => {
      if (archived) current[sessionId] = Date.now();
      else delete current[sessionId];
      return archived ? current[sessionId] : undefined;
    });
  };

  /**
   * Archive each `{ sessionId: archivedAt }` that is not archived yet, at the
   * given time. Sessions already archived keep their time. Used by the
   * one-time settled-shelf migration.
   */
  const archiveMissing = async (entries) => {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw invalidArgument();
    const list = Object.entries(entries);
    if (list.some(([sessionId, at]) => sessionId.length === 0 || !Number.isSafeInteger(at) || at <= 0)) throw invalidArgument();
    if (list.length === 0) return;
    await mutate((current) => {
      for (const [sessionId, at] of list) {
        if (!Object.hasOwn(current, sessionId)) current[sessionId] = at;
      }
    });
  };

  return { read, set, archiveMissing };
};
