import crypto from 'node:crypto';

import { safeFileName } from './downloads.js';

/**
 * Files one file chooser answer can give a page, together. Playwright passes
 * in-memory files to the page and refuses 50 MB or more in one call.
 */
export const MAX_CHOOSER_BYTES = 50 * 1024 * 1024 - 1;
// Uploads wait here only between their upload and the chooser answer.
const UPLOAD_HOLD_MS = 10 * 60 * 1000;
// Memory all waiting uploads may take together.
const MAX_HELD_BYTES = 4 * MAX_CHOOSER_BYTES;

const tooLarge = (message) => Object.assign(new Error(message), { code: 'TOO_LARGE' });

const MIME_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

/**
 * Files the person picked for a page's file chooser, held in memory until
 * the chooser answer takes them. The page then holds them itself, as files
 * picked in a desktop browser; nothing is written to the server's disk.
 */
export const createUploadStore = () => {
  const uploads = new Map();
  let heldBytes = 0;

  const drop = (id) => {
    const upload = uploads.get(id);
    if (!upload) return null;
    uploads.delete(id);
    clearTimeout(upload.timer);
    heldBytes -= upload.buffer.byteLength;
    return upload;
  };

  return {
    /** Reads one file from `stream`; returns its id. */
    async save({ name, mimeType, lastModified, stream }) {
      const chunks = [];
      let received = 0;
      for await (const data of stream) {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        received += chunk.length;
        if (received > MAX_CHOOSER_BYTES) throw tooLarge('Files for one upload must be under 50 MB together');
        if (heldBytes + received > MAX_HELD_BYTES) throw tooLarge('Too many uploads are waiting for a page');
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      if (heldBytes + buffer.byteLength > MAX_HELD_BYTES) throw tooLarge('Too many uploads are waiting for a page');
      const id = crypto.randomUUID();
      const timer = setTimeout(() => drop(id), UPLOAD_HOLD_MS);
      timer.unref?.();
      heldBytes += buffer.byteLength;
      uploads.set(id, {
        name: safeFileName(name),
        mimeType: typeof mimeType === 'string' && MIME_TYPE.test(mimeType) ? mimeType : undefined,
        lastModifiedMs: Number.isFinite(lastModified) && lastModified > 0 ? lastModified : undefined,
        buffer,
        timer,
      });
      return { id };
    },

    /**
     * Takes the uploads `ids` names, for a chooser answer; each can be taken
     * once. Unknown and expired ids are left out.
     */
    take: (ids) => (Array.isArray(ids) ? ids : [])
      .map((id) => drop(id))
      .filter(Boolean)
      .map(({ name, mimeType, lastModifiedMs, buffer }) => ({ name, mimeType, lastModifiedMs, buffer })),

    clear() {
      for (const id of [...uploads.keys()]) drop(id);
    },
  };
};
