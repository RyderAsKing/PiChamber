import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolvePiChamberDataDir } from '../pichamber-data-dir.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_KEY_LENGTH = 2_048;
const MAX_NAME_LENGTH = 500;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const invalid = () => new Error('SESSION_FOLDERS_INVALID');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validString = (value, max = MAX_KEY_LENGTH) => typeof value === 'string' && value.length > 0 && value.length <= max;

const validateSnapshot = (value) => {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.foldersMap)
    || !Array.isArray(value.collapsedFolderIds) || !Number.isFinite(value.updatedAt) || value.updatedAt < 0) throw invalid();

  for (const [scopeKey, folders] of Object.entries(value.foldersMap)) {
    if (!validString(scopeKey) || FORBIDDEN_KEYS.has(scopeKey) || !Array.isArray(folders)) throw invalid();
    for (const folder of folders) {
      if (!isRecord(folder) || !validString(folder.id) || !validString(folder.name, MAX_NAME_LENGTH)
        || !Array.isArray(folder.sessionIds) || !Number.isFinite(folder.createdAt)
        || (folder.parentId !== undefined && folder.parentId !== null && !validString(folder.parentId))) throw invalid();
      if (folder.sessionIds.some((sessionId) => !validString(sessionId))) throw invalid();
    }
  }
  if (value.collapsedFolderIds.some((folderId) => !validString(folderId))) throw invalid();

  const snapshot = {
    version: 1,
    foldersMap: value.foldersMap,
    collapsedFolderIds: value.collapsedFolderIds,
    updatedAt: value.updatedAt,
  };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_FILE_BYTES) throw invalid();
  return snapshot;
};

export const createPiSessionFoldersStore = ({
  file = join(resolvePiChamberDataDir(), 'pi', 'session-folders.json'),
  fs = { chmod, mkdir, readFile, rename, writeFile },
} = {}) => {
  let mutation = Promise.resolve();

  const read = async () => {
    try {
      const raw = await fs.readFile(file, 'utf8');
      if (Buffer.byteLength(raw) > MAX_FILE_BYTES) throw invalid();
      return { exists: true, ...validateSnapshot(JSON.parse(raw)) };
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false };
      throw invalid();
    }
  };

  const write = async (value) => {
    const snapshot = validateSnapshot(value);
    const operation = mutation.then(async () => {
      const parent = dirname(file);
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
      await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, file);
      if (process.platform !== 'win32') await fs.chmod(file, 0o600);
      return { exists: true, ...snapshot };
    });
    mutation = operation.catch(() => {});
    return operation;
  };

  return { file, read, write };
};
