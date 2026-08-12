import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 32;
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
    // The explicit control range is intentional: client-supplied filenames
    // must never produce an ambiguous temporary-file path.
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
 * Process-lifetime upload map. The browser receives opaque ids only; resolved
 * filesystem paths cross the private daemon IPC and are never returned from a
 * public route or persisted in Pi JSONL.
 */
export const createPiAttachmentStore = ({
  directory = join(tmpdir(), 'pichamber-pi-attachments'),
  now = () => Date.now(),
  ttlMs = ATTACHMENT_TTL_MS,
} = {}) => {
  const entries = new Map();

  const cleanup = async () => {
    const expired = [...entries.values()].filter((entry) => entry.expiresAt <= now());
    await Promise.all(expired.map(async (entry) => {
      entries.delete(entry.id);
      await rm(entry.path, { force: true });
    }));
  };

  const create = async ({ filename, mime, base64 }) => {
    await cleanup();
    if (entries.size >= MAX_ATTACHMENT_COUNT) throw new PiAttachmentStoreError('ATTACHMENT_LIMIT_REACHED');
    const safeName = sanitizeFilename(filename);
    const safeMime = normalizeMime(mime);
    const bytes = decodeBase64(base64);
    const extension = extname(safeName).slice(0, 20);
    const id = randomUUID();
    const path = join(directory, `pi-clipboard-${id}${extension}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    const entry = { id, name: safeName, mime: safeMime, size: bytes.length, path, expiresAt: now() + ttlMs };
    entries.set(id, entry);
    return { id: entry.id, name: entry.name, mime: entry.mime, size: entry.size };
  };

  const resolve = async (ids) => {
    await cleanup();
    if (!Array.isArray(ids) || ids.length > MAX_ATTACHMENT_COUNT || ids.some((id) => typeof id !== 'string' || id.length === 0)) throw invalid();
    const selected = ids.map((id) => entries.get(id));
    if (selected.some((entry) => !entry)) throw new PiAttachmentStoreError('ATTACHMENT_MISSING');
    return selected.map(({ id, name, mime, size, path }) => ({ id, name, mime, size, path }));
  };

  const dispose = async () => {
    const current = [...entries.values()];
    entries.clear();
    await Promise.all(current.map((entry) => rm(entry.path, { force: true })));
  };

  return { create, resolve, cleanup, dispose };
};
