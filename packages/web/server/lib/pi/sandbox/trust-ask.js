import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

const MAX_DIRECTORIES = 4096;

/**
 * Folders whose Pi project trust was reset to "ask" when their project was
 * switched from sandboxed to off (#242). A sandboxed agent may have written
 * project `.pi` extensions; PiChamber's automatic trust of known projects
 * must not trust them again unasked. The list lives in PiChamber's data
 * folder, which no sandbox can write, and an explicit trust decision for a
 * folder removes it.
 */
export const trustAskFile = (dataDir) => join(dataDir, 'pi', 'trust-ask.json');

const normalizeList = (value) => {
  if (!value || typeof value !== 'object' || !Array.isArray(value.directories)) return null;
  if (!value.directories.every((dir) => typeof dir === 'string' && isAbsolute(dir))) return null;
  return value.directories.map((dir) => resolve(dir));
};

const inside = (root, directory) => directory === root
  || directory.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

export const createTrustAskStore = ({ dataDir, file = trustAskFile(dataDir) }) => {
  let queue = Promise.resolve();
  // Missing means nothing is recorded. A file that exists but cannot be read
  // or parsed throws: reading it as empty and writing on top of it would
  // forget folders whose trust was reset, and they would be trusted again.
  const read = async () => {
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw Object.assign(new Error('The trust-ask list is unreadable.'), { code: 'TRUST_ASK_UNREADABLE' });
    }
    let parsed = null;
    try {
      parsed = normalizeList(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (!parsed) throw Object.assign(new Error('The trust-ask list is unreadable.'), { code: 'TRUST_ASK_UNREADABLE' });
    return parsed;
  };
  const write = async (directories) => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, directories }, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  };
  const update = (change) => {
    const run = queue.then(async () => {
      const current = await read();
      const next = change(current);
      if (next === current) return;
      // A full list refuses new folders instead of forgetting old ones:
      // a forgotten folder would be trusted again without being asked.
      if (next.length > MAX_DIRECTORIES && next.length > current.length) {
        throw Object.assign(new Error('The trust-ask list is full.'), { code: 'TRUST_ASK_FULL' });
      }
      await write(next);
    });
    queue = run.catch(() => {});
    return run;
  };
  return {
    list: read,
    add: (directories) => update((current) => {
      const additions = directories.filter((dir) => typeof dir === 'string' && isAbsolute(dir)).map((dir) => resolve(dir))
        .filter((dir) => !current.includes(dir));
      return additions.length > 0 ? [...current, ...additions] : current;
    }),
    remove: (directory) => update((current) => {
      if (typeof directory !== 'string' || !isAbsolute(directory)) return current;
      const target = resolve(directory);
      return current.includes(target) ? current.filter((dir) => dir !== target) : current;
    }),
  };
};

/**
 * Daemon-side check, synchronous because Pi's trust store is: whether
 * `directory` (or a folder containing it) must stay "ask". Reread only when
 * the file changes. A malformed or unreadable file counts as every folder.
 * Folders are compared by their written and their real path, so a symlinked
 * spelling of a listed folder still asks.
 */
export const createTrustAskReader = ({ dataDir, file = dataDir ? trustAskFile(dataDir) : null } = {}) => {
  let cachedStamp = null;
  let cached = [];
  const load = () => {
    if (!file) return [];
    let stamp;
    try {
      const info = statSync(file);
      stamp = `${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch (error) {
      cachedStamp = null;
      cached = [];
      return error?.code === 'ENOENT' ? [] : null;
    }
    if (stamp === cachedStamp) return cached;
    try {
      cached = normalizeList(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      cached = null;
    }
    cachedStamp = stamp;
    return cached;
  };
  return (directory) => {
    const list = load();
    if (list === null) return true;
    if (typeof directory !== 'string' || directory.length === 0) return true;
    const target = resolve(directory);
    if (list.some((root) => inside(root, target))) return true;
    // The real path of the nearest folder that exists, plus the rest, so a
    // symlinked spelling of a folder that is not there yet still matches.
    let real = target;
    let rest = '';
    for (let probe = target; ; probe = dirname(probe)) {
      try {
        real = join(realpathSync(probe), rest);
        break;
      } catch {
        if (dirname(probe) === probe) break;
        rest = rest ? join(basename(probe), rest) : basename(probe);
      }
    }
    return real !== target && list.some((root) => inside(root, real));
  };
};
