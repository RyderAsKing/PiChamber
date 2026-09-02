export type GitViewSnapshot = {
  directory?: string;
  commitMessage: string;
};

export const GIT_VIEW_SNAPSHOTS_CAP = 20;

const gitViewSnapshots = new Map<string, GitViewSnapshot>();

export function getGitViewSnapshot(key: string): GitViewSnapshot | null {
  return gitViewSnapshots.get(key) ?? null;
}

export function rememberGitViewSnapshot(key: string, snapshot: GitViewSnapshot): void {
  // Touch-on-write LRU: deleting before re-inserting promotes the key to
  // the Map's insertion order, so the oldest key falls off the end.
  gitViewSnapshots.delete(key);
  gitViewSnapshots.set(key, snapshot);
  if (gitViewSnapshots.size > GIT_VIEW_SNAPSHOTS_CAP) {
    const oldest = gitViewSnapshots.keys().next().value;
    if (oldest !== undefined) {
      gitViewSnapshots.delete(oldest);
    }
  }
}

export function clearGitViewSnapshots(): void {
  gitViewSnapshots.clear();
}
