import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const MAX_PROJECTS = 4096;
const GIT_PROJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The worktree folder id of each sandboxed project, remembered the first
 * time PiChamber sees it (#242). The id comes from `<project>/.git/pichamber`,
 * which a sandboxed agent can rewrite or delete; a project's worktree root is
 * what its sandbox daemon owns and is granted, so the id must not follow
 * that file once it is known. The record lives in PiChamber's data folder,
 * which no sandbox can write.
 */
export const worktreeIdsFile = (dataDir) => join(dataDir, 'pi', 'sandbox', 'worktree-ids.json');

const normalize = (value) => {
  const projects = value && typeof value === 'object' && !Array.isArray(value) ? value.projects : null;
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return null;
  const result = new Map();
  for (const [root, id] of Object.entries(projects)) {
    if (!isAbsolute(root) || typeof id !== 'string' || !GIT_PROJECT_ID.test(id)) return null;
    result.set(resolve(root), id);
  }
  return result;
};

export const createWorktreeIdStore = ({ dataDir, file = worktreeIdsFile(dataDir) }) => {
  let queue = Promise.resolve();
  // Missing means nothing is remembered yet. A file that exists but cannot
  // be read or parsed throws: forgetting an id would hand its worktrees to
  // the main daemon.
  const read = async () => {
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return new Map();
      throw Object.assign(new Error('The worktree id record is unreadable.'), { code: 'SANDBOX_WORKTREE_IDS_UNREADABLE' });
    }
    let parsed = null;
    try {
      parsed = normalize(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (!parsed) throw Object.assign(new Error('The worktree id record is unreadable.'), { code: 'SANDBOX_WORKTREE_IDS_UNREADABLE' });
    return parsed;
  };
  const write = async (projects) => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const entries = [...projects].slice(-MAX_PROJECTS);
    await writeFile(temp, `${JSON.stringify({ version: 1, projects: Object.fromEntries(entries) }, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  };
  return {
    /** Remembered ids, project root -> id. Throws when the record is unreadable. */
    read,
    /**
     * Remember `id` for `projectRoot` unless one is remembered already;
     * returns the id that is remembered afterwards.
     */
    remember: (projectRoot, id) => {
      const run = queue.then(async () => {
        const root = resolve(projectRoot);
        const current = await read();
        const known = current.get(root);
        if (known) return known;
        if (typeof id !== 'string' || !GIT_PROJECT_ID.test(id)) return null;
        current.set(root, id);
        await write(current);
        return id;
      });
      queue = run.catch(() => {});
      return run;
    },
  };
};
