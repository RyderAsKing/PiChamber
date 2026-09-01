import { randomUUID } from 'node:crypto';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 32;
const MAX_ATTACHMENTS_PER_MESSAGE = 20;
const ATTACHMENT_TTL_MS = 60 * 60 * 1_000;
const REJECTED_MIME_PREFIXES = ['application/x-msdownload', 'application/x-dosexec'];

export class PiAttachmentStoreError extends Error {
  constructor(code) {
    super('The Pi attachment could not be processed.');
    this.code = code;
  }
}

const invalid = () => new PiAttachmentStoreError('ATTACHMENT_FAILED');

const sanitizeFilename = (value) => {
  const filename = basename(typeof value === 'string' ? value : 'attachment')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 160);
  return filename || 'attachment';
};

const decodeBase64 = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 8) throw invalid();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) throw invalid();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) throw new PiAttachmentStoreError(bytes.length === 0 ? 'ATTACHMENT_FAILED' : 'ATTACHMENT_TOO_LARGE');
  return bytes;
};

const normalizeMime = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) throw invalid();
  const mime = value.toLowerCase();
  if (REJECTED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) throw invalid();
  return mime;
};

/**
 * Process-lifetime upload map. Available uploads count against the active cap.
 * Accepted uploads move to a retired map so repeated sends free active slots,
 * while their files remain until the original expiry for daemon access.
 */
export const createPiAttachmentStore = ({
  directory = join(tmpdir(), 'pichamber-pi-attachments'),
  now = () => Date.now(),
  ttlMs = ATTACHMENT_TTL_MS,
} = {}) => {
  const entries = new Map();
  const retiredEntries = new Map();
  let pendingCreates = 0;

  const cleanupMap = async (map) => {
    const expired = [...map.values()].filter((entry) => entry.expiresAt <= now());
    await Promise.all(expired.map(async (entry) => {
      map.delete(entry.id);
      await rm(entry.path, { force: true });
    }));
  };

  const cleanup = async () => {
    await Promise.all([cleanupMap(entries), cleanupMap(retiredEntries)]);
  };

  const reserve = async (filename, mime) => {
    await cleanup();
    if (entries.size + pendingCreates >= MAX_ATTACHMENT_COUNT) throw new PiAttachmentStoreError('ATTACHMENT_LIMIT_REACHED');
    const safeName = sanitizeFilename(filename);
    const safeMime = normalizeMime(mime);
    const id = randomUUID();
    const extension = extname(safeName).slice(0, 20);
    const path = join(directory, `pi-clipboard-${id}${extension}`);
    pendingCreates += 1;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      return { id, name: safeName, mime: safeMime, path, expiresAt: now() + ttlMs };
    } catch (error) {
      pendingCreates -= 1;
      throw error;
    }
  };

  const commit = (entry, size) => {
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ATTACHMENT_BYTES) {
      throw new PiAttachmentStoreError(size > MAX_ATTACHMENT_BYTES ? 'ATTACHMENT_TOO_LARGE' : 'ATTACHMENT_FAILED');
    }
    pendingCreates -= 1;
    const committed = { ...entry, size };
    entries.set(entry.id, committed);
    return { id: committed.id, name: committed.name, mime: committed.mime, size, expiresAt: committed.expiresAt };
  };

  const create = async ({ filename, mime, base64 }) => {
    const bytes = decodeBase64(base64);
    const entry = await reserve(filename, mime);
    try {
      await writeFile(entry.path, bytes, { flag: 'wx', mode: 0o600 });
      return commit(entry, bytes.length);
    } catch (error) {
      if (!entries.has(entry.id)) pendingCreates = Math.max(0, pendingCreates - 1);
      await rm(entry.path, { force: true });
      throw error;
    }
  };

  const createFromStream = async ({ filename, mime, stream }) => {
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw invalid();
    const entry = await reserve(filename, mime);
    let handle;
    let size = 0;
    try {
      handle = await open(entry.path, 'wx', 0o600);
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_ATTACHMENT_BYTES) throw new PiAttachmentStoreError('ATTACHMENT_TOO_LARGE');
        if (bytes.length > 0) await handle.write(bytes);
      }
      await handle.close();
      handle = undefined;
      return commit(entry, size);
    } catch (error) {
      if (!entries.has(entry.id)) pendingCreates = Math.max(0, pendingCreates - 1);
      await handle?.close().catch(() => undefined);
      await rm(entry.path, { force: true });
      throw error;
    }
  };

  const resolve = async (ids) => {
    await cleanup();
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENTS_PER_MESSAGE || ids.some((id) => typeof id !== 'string' || id.length === 0)) throw invalid();
    const selected = ids.map((id) => entries.get(id) ?? retiredEntries.get(id));
    if (selected.some((entry) => !entry)) throw new PiAttachmentStoreError('ATTACHMENT_MISSING');
    return selected.map(({ id, name, mime, size, path }) => ({ id, name, mime, size, path }));
  };

  const consume = async (ids) => {
    for (const id of ids) {
      const entry = entries.get(id);
      if (!entry) continue;
      entries.delete(id);
      retiredEntries.set(id, entry);
    }
  };

  const remove = async (id) => {
    if (typeof id !== 'string' || id.length === 0) throw invalid();
    const entry = entries.get(id);
    if (!entry) return false;
    entries.delete(id);
    await rm(entry.path, { force: true });
    return true;
  };

  const dispose = async () => {
    const current = [...entries.values(), ...retiredEntries.values()];
    entries.clear();
    retiredEntries.clear();
    await Promise.all(current.map((entry) => rm(entry.path, { force: true })));
  };

  return { create, createFromStream, resolve, consume, remove, cleanup, dispose };
};
