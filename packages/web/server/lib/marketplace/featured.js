// The marketplace's curated list: packages shown first, and packages never
// shown. It ships with the app (`packages/web/plugins/featured.json`) and is
// refreshed from the PiChamber repository, so picks change without a release.
// The last good remote copy is kept in the data folder. See DOCUMENTATION.md.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isValidNpmName } from './npm-registry.js';

const BUILTIN_FEATURED_PATH = fileURLToPath(new URL('../../../plugins/featured.json', import.meta.url));
export const DEFAULT_FEATURED_URL = 'https://raw.githubusercontent.com/RyderAsKing/PiChamber/main/packages/web/plugins/featured.json';

const REFRESH_MS = 6 * 60 * 60 * 1000;
/** After a failed refresh, wait this long before trying again. */
const RETRY_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 5_000;
const MAX_BYTES = 64 * 1024;
const MAX_FEATURED = 24;
const MAX_HIDDEN = 500;
const MAX_NOTE_LENGTH = 120;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Parse a featured file. Returns `undefined` when the file is unusable as a
 * whole (wrong version, bad date, not an object); a bad entry is skipped.
 * `{ version: 1, updated: 'YYYY-MM-DD', featured: [{ name, note? }], hidden: [name] }`.
 */
export const parseFeaturedList = (value) => {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (typeof value.updated !== 'string' || !DATE_PATTERN.test(value.updated) || !Number.isFinite(Date.parse(value.updated))) {
    return undefined;
  }
  const hidden = [];
  for (const name of Array.isArray(value.hidden) ? value.hidden : []) {
    if (isValidNpmName(name) && !hidden.includes(name)) hidden.push(name);
    if (hidden.length === MAX_HIDDEN) break;
  }
  const featured = [];
  for (const entry of Array.isArray(value.featured) ? value.featured : []) {
    if (!isRecord(entry) || !isValidNpmName(entry.name) || hidden.includes(entry.name)) continue;
    if (featured.some((item) => item.name === entry.name)) continue;
    // eslint-disable-next-line no-control-regex
    const note = typeof entry.note === 'string' ? entry.note.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
    featured.push({ name: entry.name, ...(note.length > 0 && note.length <= MAX_NOTE_LENGTH ? { note } : {}) });
    if (featured.length === MAX_FEATURED) break;
  }
  return { updated: value.updated, featured, hidden };
};

/** The newer of two lists by their `updated` date; `a` wins a tie. */
const newer = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  return b.updated > a.updated ? b : a;
};

/**
 * `remoteUrl`: `null` turns refreshing off. Reads never wait for the network:
 * they answer from the newest of the built-in and cached lists and start a
 * refresh in the background when the cache is old.
 */
export const createFeaturedSource = ({
  builtinPath = BUILTIN_FEATURED_PATH,
  cachePath,
  remoteUrl = DEFAULT_FEATURED_URL,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  logger = console,
} = {}) => {
  let builtin;
  let cached;
  let cacheLoaded = false;
  let fetchedAt = 0;
  let lastAttempt = 0;
  let refreshing = null;

  const loadBuiltin = async () => {
    if (builtin !== undefined) return builtin;
    try {
      builtin = parseFeaturedList(JSON.parse(await readFile(builtinPath, 'utf8'))) ?? null;
    } catch {
      builtin = null;
    }
    if (!builtin) logger.warn('[marketplace] the built-in featured list is unreadable');
    return builtin;
  };

  const loadCache = async () => {
    if (cacheLoaded || !cachePath) return;
    cacheLoaded = true;
    try {
      const stored = JSON.parse(await readFile(cachePath, 'utf8'));
      const list = parseFeaturedList(stored?.list);
      if (list && Number.isFinite(stored.fetchedAt)) {
        cached = list;
        fetchedAt = stored.fetchedAt;
      }
    } catch {
      // Missing or unreadable: the built-in list answers until a refresh lands.
    }
  };

  const writeCache = async (list, at) => {
    if (!cachePath) return;
    const temporary = join(dirname(cachePath), `.featured.${randomUUID()}.tmp`);
    try {
      await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify({ fetchedAt: at, list: { version: 1, ...list } }), { mode: 0o600 });
      await rename(temporary, cachePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      logger.warn('[marketplace] could not keep the featured list', error?.code ?? error?.message ?? error);
    }
  };

  const fetchRemote = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetchImpl(remoteUrl, {
        headers: { accept: 'application/json', 'user-agent': 'PiChamber' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const text = await response.text();
      if (text.length > MAX_BYTES) throw new Error('too large');
      const list = parseFeaturedList(JSON.parse(text));
      if (!list) throw new Error('malformed');
      return list;
    } finally {
      clearTimeout(timer);
    }
  };

  /** Fetch the remote list once; concurrent callers share the attempt. */
  const refresh = () => {
    if (!remoteUrl) return Promise.resolve(false);
    if (refreshing) return refreshing;
    lastAttempt = now();
    refreshing = (async () => {
      try {
        const list = await fetchRemote();
        const at = now();
        cached = list;
        fetchedAt = at;
        await writeCache(list, at);
        return true;
      } catch (error) {
        logger.warn('[marketplace] could not refresh the featured list', error?.message ?? error);
        return false;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };

  /** `{ updated, featured, hidden, source: 'remote' | 'builtin' }`, never throws. */
  const get = async () => {
    const [base] = await Promise.all([loadBuiltin(), loadCache()]);
    const time = now();
    if (remoteUrl && time - fetchedAt > REFRESH_MS && time - lastAttempt > RETRY_MS) void refresh();
    // On the same date the fetched copy wins: it is what the repository says now.
    const list = newer(cached, base);
    if (!list) return { updated: null, featured: [], hidden: [], source: 'builtin' };
    return { ...list, source: list === base ? 'builtin' : 'remote' };
  };

  return { get, refresh };
};
