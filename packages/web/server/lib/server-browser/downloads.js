import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_DOWNLOADS = 50;

export const safeFileName = (value) => {
  const base = path.basename(String(value || '')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  return (base || 'file').slice(0, 200);
};

/**
 * Files pages downloaded, saved under `dir` (owner-only) and offered to the
 * tab's viewers. The newest 50 are kept. Downloads are indexed in memory
 * only, so files from an earlier run are never served; `dir` is emptied on
 * start.
 */
export const createDownloadStore = ({ dir, log = () => {} }) => {
  const downloads = new Map();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* unreadable; left alone */ }

  const message = (entry) => ({
    type: 'download',
    id: entry.id,
    filename: entry.filename,
    state: entry.state,
    receivedBytes: entry.bytes,
    totalBytes: entry.bytes,
  });

  const evict = () => {
    while (downloads.size > MAX_DOWNLOADS) {
      const [oldest] = downloads.values();
      downloads.delete(oldest.id);
      void fs.promises.rm(oldest.path, { force: true }).catch(() => {});
    }
  };

  return {
    /** Saves a Playwright download for `tab`, telling its viewers when it starts and ends. */
    async add(tab, download) {
      const id = crypto.randomUUID();
      const entry = { id, filename: safeFileName(download.suggestedFilename()), path: path.join(dir, id), state: 'inProgress', bytes: 0 };
      downloads.set(id, entry);
      evict();
      tab.broadcast(message(entry));
      try {
        const failure = await download.failure();
        if (failure) throw new Error(failure);
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
        await download.saveAs(entry.path);
        // saveAs copies with the process umask; a download stays owner-only.
        await fs.promises.chmod(entry.path, 0o600);
        entry.bytes = (await fs.promises.stat(entry.path)).size;
        entry.state = 'completed';
        // Evicted while it downloaded: nothing can ask for it.
        if (downloads.get(id) !== entry) await fs.promises.rm(entry.path, { force: true });
      } catch (error) {
        entry.state = 'canceled';
        log(`[server-browser] download failed: ${error?.message || error}`);
        await fs.promises.rm(entry.path, { force: true }).catch(() => {});
      } finally {
        // saveAs copied it; Playwright's own copy is not needed.
        await download.delete().catch(() => {});
      }
      tab.broadcast(message(entry));
    },

    get(id) {
      const entry = downloads.get(id);
      if (!entry || entry.state !== 'completed') return null;
      return { path: entry.path, filename: entry.filename };
    },
  };
};
