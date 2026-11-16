import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const MAX_DIRECTORIES = 4096;

/**
 * The folders that sandbox daemons own (#242): each sandboxed project's
 * root, its real path, and its worktree root. The server writes the list
 * whenever ownership changes and the main daemon reads it before it starts
 * a Pi runtime, so nothing it is asked (a request without a folder, a
 * catalog read, a reopened session) can load a sandboxed project's
 * extensions outside the sandbox. The list lives in PiChamber's data
 * folder, which no sandbox can write.
 */
export const sandboxedFoldersFile = (dataDir) => join(dataDir, 'pi', 'sandboxed-folders.json');

const normalizeList = (value) => {
  if (!value || typeof value !== 'object' || !Array.isArray(value.directories)) return null;
  if (!value.directories.every((dir) => typeof dir === 'string' && isAbsolute(dir))) return null;
  return value.directories.map((dir) => resolve(dir));
};

const inside = (root, directory) => directory === root
  || directory.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

export const createSandboxedFoldersStore = ({ dataDir, file = sandboxedFoldersFile(dataDir) }) => {
  let queue = Promise.resolve();
  let written = null;
  return {
    /**
     * Replace the list. Writes run one at a time; an unchanged list is not
     * written again. A list too long to record is refused: a folder left
     * out would be the main daemon's to run.
     */
    set: (directories) => {
      const next = [...new Set(directories.map((dir) => resolve(dir)))].sort();
      const run = queue.then(async () => {
        if (next.length > MAX_DIRECTORIES) {
          throw Object.assign(new Error('Too many sandboxed folders to record.'), { code: 'SANDBOXED_FOLDERS_FULL' });
        }
        const body = `${JSON.stringify({ version: 1, directories: next }, null, 2)}\n`;
        if (body === written) return;
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temp, body, { mode: 0o600 });
        await rename(temp, file);
        written = body;
      });
      queue = run.catch(() => {});
      return run;
    },
  };
};

/**
 * Daemon-side check, synchronous because it guards runtime creation:
 * whether `directory`, by its written or its real path, is a sandboxed
 * folder or inside one. Reread only when the file changes. A missing file
 * lists nothing; a malformed or unreadable one counts as every folder.
 */
export const createSandboxedFoldersReader = ({ file } = {}) => {
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
    if (list.length === 0 || typeof directory !== 'string' || directory.length === 0) return false;
    const target = resolve(directory);
    if (list.some((root) => inside(root, target))) return true;
    let real = target;
    try {
      real = realpathSync(target);
    } catch {
      // A folder that does not exist has no other spelling.
    }
    return real !== target && list.some((root) => inside(root, real));
  };
};
