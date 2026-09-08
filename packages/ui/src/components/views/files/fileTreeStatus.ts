import type { FileStatus } from './FilesViewChrome';
import type { GitStatus } from '@/lib/api/types';

export type GitStatusFile = GitStatus['files'][number];

export interface FolderBadge {
  modified: number;
  added: number;
}

/**
 * Root-relative conversion preserving the exact FilesView behavior:
 * absolute paths under `root` become workspace-relative, everything else
 * (outside-workspace paths, `root` itself, empty root edge cases) passes
 * through unchanged so lookups miss exactly as before.
 */
export const toRootRelativePath = (path: string, root: string): string =>
  path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;

/**
 * Git code precedence preserving FilesView semantics:
 * open beats git at the caller, first duplicate wins via the index map,
 * `A`/`?` -> added, `D` -> deleted, `M` -> modified, anything else -> null.
 * Folder badges count modified and added independently, even when both apply.
 */
export const classifyGitFileStatus = (
  file: Pick<GitStatusFile, 'index' | 'working_dir'>,
): Extract<FileStatus, 'git-added' | 'git-deleted' | 'git-modified'> | null => {
  if (file.index === 'A' || file.working_dir === '?') return 'git-added';
  if (file.index === 'D') return 'git-deleted';
  if (file.index === 'M' || file.working_dir === 'M') return 'git-modified';
  return null;
};

export interface FileTreeStatusIndexInput {
  root: string;
  openPaths: readonly string[];
  gitFiles: readonly GitStatusFile[] | null | undefined;
}

export interface FileTreeStatusIndex {
  getFileStatus: (path: string) => FileStatus | null;
  getFolderBadge: (dirPath: string) => FolderBadge | null;
}

/**
 * Shared per-snapshot index for the file tree.
 *
 * Build once per `gitStatus` snapshot (plus `root`/`openPaths`), then answer
 * every row with O(1) lookups:
 * - `openPaths` set for exact open membership (open beats git).
 * - `statusByPath` map for exact relative-path git lookup (first duplicate wins).
 * - `ancestorCounts` map for folder badges: each changed file increments its
 *   segment-boundary ancestors once at build time instead of scanning all
 *   changed files per directory per row.
 */
export const createFileTreeStatusIndex = ({
  root,
  openPaths,
  gitFiles,
}: FileTreeStatusIndexInput): FileTreeStatusIndex => {
  const openSet = new Set(openPaths);
  const statusByPath = new Map<string, GitStatusFile>();
  const ancestorCounts = new Map<string, FolderBadge>();
  const total: FolderBadge = { modified: 0, added: 0 };

  for (const file of gitFiles ?? []) {
    if (!statusByPath.has(file.path)) {
      statusByPath.set(file.path, file);
    }

    // Badge counts are independent predicates, unlike the row's precedence
    // chain. A staged addition with working-tree edits contributes to both.
    const modified = Number(file.index === 'M' || file.working_dir === 'M');
    const added = Number(file.index === 'A' || file.working_dir === '?');
    if (modified === 0 && added === 0) continue;
    total.modified += modified;
    total.added += added;

    // Segment-boundary ancestors of the relative git path: `a/b/c.ts`
    // contributes to `a` and `a/b`. Files at the repo root contribute only
    // to the total (empty-prefix) bucket.
    const parts = file.path.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const ancestor = parts.slice(0, depth).join('/');
      if (!ancestor) continue;
      let entry = ancestorCounts.get(ancestor);
      if (!entry) {
        entry = { modified: 0, added: 0 };
        ancestorCounts.set(ancestor, entry);
      }
      entry.modified += modified;
      entry.added += added;
    }
  }

  const getFileStatus = (path: string): FileStatus | null => {
    if (openSet.has(path)) return 'open';
    if (statusByPath.size === 0) return null;
    const relative = toRootRelativePath(path, root);
    const file = statusByPath.get(relative);
    if (!file) return null;
    return classifyGitFileStatus(file);
  };

  const getFolderBadge = (dirPath: string): FolderBadge | null => {
    if (!gitFiles) return null;
    const relativeDir = toRootRelativePath(dirPath, root);
    if (!relativeDir) {
      return total.modified + total.added > 0 ? { ...total } : null;
    }
    const entry = ancestorCounts.get(relativeDir);
    return entry ? { ...entry } : null;
  };

  return { getFileStatus, getFolderBadge };
};

/**
 * Expansion membership as a set so `FilesTreePanel` pays O(n) once per
 * snapshot instead of O(rows x expanded) `includes` scans per render.
 */
export const createExpansionSet = (expandedPaths: readonly string[]): Set<string> =>
  new Set(expandedPaths);
