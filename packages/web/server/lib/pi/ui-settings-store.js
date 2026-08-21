import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolvePiChamberDataDir } from '../pichamber-data-dir.js';

const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const validateValue = (value, depth = 0) => {
  if (depth > 64) throw new Error('UI_SETTINGS_INVALID');
  if (Array.isArray(value)) {
    for (const entry of value) validateValue(entry, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new Error('UI_SETTINGS_INVALID');
    validateValue(entry, depth + 1);
  }
};

const validateRecord = (value) => {
  if (!isRecord(value)) throw new Error('UI_SETTINGS_INVALID');
  validateValue(value);
  return value;
};

export const createPiUiSettingsStore = ({
  file = join(resolvePiChamberDataDir(), 'settings.json'),
  fs = { chmod, mkdir, readFile, rename, writeFile },
} = {}) => {
  let mutation = Promise.resolve();
  let revision = 0;
  const listeners = new Set();

  const read = async () => {
    try {
      const raw = await fs.readFile(file, 'utf8');
      if (Buffer.byteLength(raw) > MAX_SETTINGS_BYTES) throw new Error('UI_SETTINGS_INVALID');
      return validateRecord(JSON.parse(raw));
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      if (error?.message === 'UI_SETTINGS_INVALID') throw error;
      throw new Error('UI_SETTINGS_INVALID');
    }
  };

  const write = async (changes) => {
    validateRecord(changes);
    const operation = mutation.then(async () => {
      const current = await read();
      const next = { ...current, ...changes };
      const serialized = `${JSON.stringify(next, null, 2)}\n`;
      if (Buffer.byteLength(serialized) > MAX_SETTINGS_BYTES) throw new Error('UI_SETTINGS_INVALID');
      const parent = dirname(file);
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
      await fs.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, file);
      if (process.platform !== 'win32') await fs.chmod(file, 0o600);
      revision += 1;
      for (const listener of listeners) {
        try {
          listener(revision);
        } catch {
          // Notification failure cannot turn a committed settings write into
          // an apparent write failure. The fallback refresh repairs misses.
        }
      }
      return next;
    });
    mutation = operation.catch(() => {});
    return operation;
  };

  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return { file, read, write, getRevision: () => revision, subscribe };
};
