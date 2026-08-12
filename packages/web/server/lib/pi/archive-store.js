import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolvePiChamberDataDir } from '../pichamber-data-dir.js';

const invalidArchive = () => {
  const error = new Error('Pi archive metadata is invalid.');
  error.code = 'ARCHIVE_METADATA_INVALID';
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

  const set = async (sessionId, archived) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof archived !== 'boolean') {
      const error = new Error('The archive request is invalid.');
      error.code = 'INVALID_ARGUMENT';
      throw error;
    }
    const operation = writeChain.then(async () => {
      const current = await read();
      if (archived) current[sessionId] = Date.now();
      else delete current[sessionId];
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp`;
      await writeFile(temporary, JSON.stringify(current), { mode: 0o600 });
      await rename(temporary, file);
      return archived ? current[sessionId] : undefined;
    });
    writeChain = operation.catch(() => {});
    return operation;
  };

  return { read, set };
};
