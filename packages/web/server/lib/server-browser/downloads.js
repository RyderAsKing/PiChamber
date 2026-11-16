import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_DOWNLOADS = 50;
// Progress goes to viewers at most this often per download; state changes go at once.
const PROGRESS_INTERVAL_MS = 250;
// Chrome's progress for downloads Playwright has not reported yet.
const MAX_UNPAIRED = 50;
const MAX_NAME_ATTEMPTS = 1000;

export const safeFileName = (value) => {
  const base = path.basename(String(value || '')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  if (!base || base === '.' || base === '..') return 'file';
  return base.slice(0, 200);
};

/** `name (1).ext`, `name (2).ext`, ... for a name that is taken. */
const numberedName = (filename, n) => {
  if (n === 0) return filename;
  const ext = path.extname(filename);
  return `${filename.slice(0, filename.length - ext.length)} (${n})${ext}`;
};

/**
 * Files pages download. Each is saved under its own name in a folder of a
 * per-run directory in the system temp directory (owner-only), and offered
 * to the viewers of the tab it came from. The newest 50 are kept. Downloads
 * are indexed in memory only, and the temp directory is deleted on
 * `dispose()`, so files from an earlier run are never served.
 *
 * Progress comes from Chrome (`Page.downloadWillBegin` and
 * `Page.downloadProgress`, passed to `progress()`); the file comes from
 * Playwright (`add()`). The two are paired by tab and address, in order.
 *
 * `broadcast(tabKey, message)` sends a message to a tab's viewers.
 * `serverDownloadsDir()` is where Save to server copies files.
 */
export const createDownloadStore = ({
  broadcast = () => {},
  tmpRoot = os.tmpdir(),
  serverDownloadsDir = () => path.join(os.homedir(), 'Downloads'),
  log = () => {},
} = {}) => {
  const downloads = new Map();
  // Chrome downloads not yet paired with an entry, by Chrome's guid.
  const unpaired = new Map();
  // Save to server in progress, by download id, shared by overlapping calls.
  const savingToServer = new Map();
  let dirPromise = null;
  let disposed = false;

  const ensureDir = () => {
    dirPromise ??= fs.promises.mkdtemp(path.join(tmpRoot, 'pichamber-downloads-')).catch((error) => {
      dirPromise = null;
      throw error;
    });
    return dirPromise;
  };

  const message = (entry) => ({
    type: 'download',
    id: entry.id,
    filename: entry.filename,
    url: entry.url,
    state: entry.state,
    receivedBytes: entry.receivedBytes,
    totalBytes: entry.totalBytes,
    path: entry.state === 'completed' ? entry.path : null,
    savedPath: entry.savedPath,
    startedAt: entry.startedAt,
  });

  const send = (entry) => {
    clearTimeout(entry.progressTimer);
    entry.progressTimer = null;
    entry.sentAt = Date.now();
    broadcast(entry.tabKey, message(entry));
  };

  // In-progress updates are paced; the last one is never dropped.
  const sendProgress = (entry) => {
    if (entry.progressTimer) return;
    const wait = PROGRESS_INTERVAL_MS - (Date.now() - entry.sentAt);
    if (wait <= 0) {
      send(entry);
      return;
    }
    entry.progressTimer = setTimeout(() => {
      entry.progressTimer = null;
      if (downloads.get(entry.id) === entry && entry.state === 'inProgress') send(entry);
    }, wait);
    entry.progressTimer.unref?.();
  };

  const removeFiles = (entry) => {
    if (!entry.folder) return;
    void fs.promises.rm(entry.folder, { recursive: true, force: true }).catch(() => {});
  };

  const evict = () => {
    while (downloads.size > MAX_DOWNLOADS) {
      const [oldest] = downloads.values();
      downloads.delete(oldest.id);
      clearTimeout(oldest.progressTimer);
      // Its viewers drop the row: nothing can be saved from it any more.
      broadcast(oldest.tabKey, { type: 'download-removed', id: oldest.id });
      if (oldest.state === 'inProgress') void oldest.download?.cancel().catch(() => {});
      removeFiles(oldest);
    }
  };

  const applyProgress = (entry, update) => {
    if (entry.state !== 'inProgress') return;
    if (Number.isFinite(update.receivedBytes)) entry.receivedBytes = Math.max(0, update.receivedBytes);
    if (Number.isFinite(update.totalBytes) && update.totalBytes > 0) entry.totalBytes = update.totalBytes;
    sendProgress(entry);
  };

  const pairWithChrome = (entry) => {
    for (const [guid, pending] of unpaired) {
      if (pending.tabKey !== entry.tabKey || pending.url !== entry.url) continue;
      unpaired.delete(guid);
      entry.guid = guid;
      applyProgress(entry, pending);
      return;
    }
  };

  const entryForGuid = (guid) => {
    for (const entry of downloads.values()) {
      if (entry.guid === guid) return entry;
    }
    return null;
  };

  const finish = async (entry) => {
    const { download } = entry;
    try {
      const failure = await download.failure();
      if (failure) throw new Error(failure);
      const dir = await ensureDir();
      entry.folder = path.join(dir, entry.id);
      await fs.promises.mkdir(entry.folder, { mode: 0o700 });
      entry.path = path.join(entry.folder, entry.filename);
      await download.saveAs(entry.path);
      // saveAs copies with the process umask; a download stays owner-only.
      await fs.promises.chmod(entry.path, 0o600);
      const size = (await fs.promises.stat(entry.path)).size;
      entry.receivedBytes = size;
      entry.totalBytes = size;
      entry.state = 'completed';
      // Evicted or disposed while it downloaded: nothing can ask for it.
      if (downloads.get(entry.id) !== entry || disposed) removeFiles(entry);
    } catch (error) {
      entry.state = entry.cancelRequested ? 'canceled' : 'failed';
      if (!entry.cancelRequested) log(`[server-browser] download failed: ${error?.message || error}`);
      removeFiles(entry);
      entry.folder = null;
      entry.path = null;
    } finally {
      entry.download = null;
      // saveAs copied it; Playwright's own copy is not needed.
      await download.delete().catch(() => {});
    }
    if (downloads.get(entry.id) === entry) send(entry);
  };

  const saveCopy = async (id) => {
    const entry = downloads.get(id);
    if (!entry || entry.state !== 'completed' || !entry.path) return null;
    if (entry.savedPath && fs.existsSync(entry.savedPath)) return { path: entry.savedPath };
    const dir = serverDownloadsDir();
    await fs.promises.mkdir(dir, { recursive: true });
    for (let n = 0; n < MAX_NAME_ATTEMPTS; n += 1) {
      const target = path.join(dir, numberedName(entry.filename, n));
      try {
        await fs.promises.copyFile(entry.path, target, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if (error?.code === 'EEXIST') continue;
        throw error;
      }
      entry.savedPath = target;
      if (downloads.get(id) === entry) send(entry);
      return { path: target };
    }
    throw new Error(`${entry.filename} and its numbered names are all taken in ${dir}`);
  };

  return {
    /** A Playwright download from the tab `tabKey`; saves it and tells the tab's viewers. */
    add(tabKey, download) {
      if (disposed) {
        void download.cancel().catch(() => {});
        return Promise.resolve();
      }
      const id = crypto.randomUUID();
      const entry = {
        id,
        tabKey,
        guid: null,
        download,
        url: typeof download.url === 'function' ? download.url() : '',
        filename: safeFileName(download.suggestedFilename()),
        state: 'inProgress',
        receivedBytes: 0,
        totalBytes: 0,
        folder: null,
        path: null,
        savedPath: null,
        startedAt: Date.now(),
        cancelRequested: false,
        progressTimer: null,
        sentAt: 0,
      };
      downloads.set(id, entry);
      evict();
      pairWithChrome(entry);
      send(entry);
      return finish(entry);
    },

    /**
     * Chrome's view of a download in `tabKey`: `{ guid, url }` when it
     * begins, then `{ guid, receivedBytes, totalBytes }` as it runs.
     */
    progress(tabKey, update) {
      const guid = update?.guid;
      if (typeof guid !== 'string' || !guid) return;
      const paired = entryForGuid(guid);
      if (paired) {
        applyProgress(paired, update);
        return;
      }
      const pending = unpaired.get(guid) ?? { tabKey, url: '', receivedBytes: 0, totalBytes: 0 };
      if (typeof update.url === 'string' && update.url) pending.url = update.url;
      if (Number.isFinite(update.receivedBytes)) pending.receivedBytes = update.receivedBytes;
      if (Number.isFinite(update.totalBytes)) pending.totalBytes = update.totalBytes;
      // Playwright may have reported the download first.
      for (const entry of downloads.values()) {
        if (entry.guid || entry.state !== 'inProgress' || entry.tabKey !== tabKey || entry.url !== pending.url || !pending.url) continue;
        unpaired.delete(guid);
        entry.guid = guid;
        applyProgress(entry, pending);
        return;
      }
      if (update.state === 'completed' || update.state === 'canceled') {
        unpaired.delete(guid);
        return;
      }
      unpaired.set(guid, pending);
      while (unpaired.size > MAX_UNPAIRED) unpaired.delete(unpaired.keys().next().value);
    },

    /** Stops a download in progress. */
    async cancel(id) {
      const entry = downloads.get(id);
      if (!entry || entry.state !== 'inProgress' || !entry.download) return false;
      entry.cancelRequested = true;
      await entry.download.cancel().catch(() => {});
      return true;
    },

    get(id) {
      const entry = downloads.get(id);
      if (!entry || entry.state !== 'completed' || !entry.path) return null;
      return { path: entry.path, filename: entry.filename };
    },

    /**
     * Copies a finished download into the server's Downloads folder under
     * its own name (numbered when taken) and returns where. A second call
     * returns the same copy while it exists.
     */
    saveToServer(id) {
      const pending = savingToServer.get(id);
      if (pending) return pending;
      const saving = saveCopy(id).finally(() => savingToServer.delete(id));
      savingToServer.set(id, saving);
      return saving;
    },

    /** The downloads of `tabKey`, oldest first, as viewer messages. */
    messagesFor(tabKey) {
      return [...downloads.values()].filter((entry) => entry.tabKey === tabKey).map(message);
    },

    /** Cancels downloads in progress and deletes the temp directory. */
    async dispose() {
      disposed = true;
      for (const entry of downloads.values()) {
        clearTimeout(entry.progressTimer);
        if (entry.state === 'inProgress') void entry.download?.cancel().catch(() => {});
      }
      downloads.clear();
      unpaired.clear();
      const dir = await dirPromise?.catch(() => null);
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
};
