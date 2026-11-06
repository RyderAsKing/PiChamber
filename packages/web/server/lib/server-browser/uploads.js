import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { safeFileName } from './downloads.js';

// A page reads an uploaded file when it submits, so files stay this long.
const UPLOAD_TTL_MS = 60 * 60 * 1000;

/**
 * Files the person picked for a page's file chooser, stored under `dir`
 * (owner-only) until the page has had time to read them. `dir` is emptied on
 * start and on shutdown.
 */
export const createUploadStore = ({ dir }) => {
  const uploads = new Map();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* unreadable; left alone */ }

  const remove = (id) => {
    const upload = uploads.get(id);
    if (!upload) return;
    uploads.delete(id);
    clearTimeout(upload.timer);
    void fs.promises.rm(path.dirname(upload.path), { recursive: true, force: true }).catch(() => {});
  };

  return {
    async save({ name, stream, maxBytes = Infinity }) {
      const id = crypto.randomUUID();
      const uploadDir = path.join(dir, id);
      await fs.promises.mkdir(uploadDir, { recursive: true, mode: 0o700 });
      const file = path.join(uploadDir, safeFileName(name));
      let received = 0;
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (received > maxBytes) {
            callback(Object.assign(new Error('File is too large'), { code: 'TOO_LARGE' }));
            return;
          }
          callback(null, chunk);
        },
      });
      try {
        await pipeline(stream, limit, fs.createWriteStream(file, { mode: 0o600 }));
      } catch (error) {
        await fs.promises.rm(uploadDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      const timer = setTimeout(() => remove(id), UPLOAD_TTL_MS);
      timer.unref?.();
      uploads.set(id, { id, path: file, createdAt: Date.now(), timer });
      return { id };
    },

    // The expiry timer can run late (a busy or suspended server); an expired
    // upload is never handed to a page.
    paths: (ids) => (Array.isArray(ids) ? ids : [])
      .map((id) => uploads.get(id))
      .filter((upload) => upload && Date.now() - upload.createdAt < UPLOAD_TTL_MS)
      .map((upload) => upload.path),

    async clear() {
      for (const upload of uploads.values()) clearTimeout(upload.timer);
      uploads.clear();
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
};
