import { createHash } from 'node:crypto';
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
/** A worktree folder id no other project has: a hash of the project's path. */
export const ownWorktreeId = (projectRoot) => createHash('sha256')
  .update(`pichamber-worktrees\n${resolve(projectRoot)}`).digest('hex');

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
    await writeFile(temp, `${JSON.stringify({ version: 1, projects: Object.fromEntries(projects) }, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  };
  return {
    /** Remembered ids, project root -> id. Throws when the record is unreadable. */
    read,
    /**
     * Remember a worktree folder id for `projectRoot` unless one is
     * remembered already; returns the id that is remembered afterwards.
     * `id` (from the project's file) is taken only when no other project
     * uses it: not one in `taken` (the ids of the other known projects) and
     * not one remembered for another root. Two clones of one repository
     * have the same file id, and a sandbox must not be granted a folder
     * another project's worktrees are in. Otherwise, and for a project with
     * no file id yet, the id is the project's own, made from its path.
     */
    remember: (projectRoot, id, { taken = [] } = {}) => {
      const run = queue.then(async () => {
        const root = resolve(projectRoot);
        const current = await read();
        const known = current.get(root);
        if (known) return known;
        // A full record takes no new project: dropping an older one would
        // let that project's file name a new id on its next use.
        if (current.size >= MAX_PROJECTS) {
          throw Object.assign(new Error('The worktree id record is full.'), { code: 'SANDBOX_WORKTREE_IDS_FULL' });
        }
        const free = typeof id === 'string' && GIT_PROJECT_ID.test(id)
          && !taken.includes(id) && ![...current.values()].includes(id);
        const next = free ? id : ownWorktreeId(root);
        current.set(root, next);
        await write(current);
        return next;
      });
      queue = run.catch(() => {});
      return run;
    },
  };
};
