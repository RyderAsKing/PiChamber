import type { GitStatus } from '@/lib/api/types';

export const haveDiffStatsChanged = (
  previous?: GitStatus['diffStats'],
  next?: GitStatus['diffStats']
): boolean => {
  if (!previous && !next) return false;
  if (!previous || !next) return true;

  const paths = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const path of paths) {
    const prevEntry = previous[path];
    const nextEntry = next[path];

    if (!prevEntry && !nextEntry) continue;
    if (!prevEntry || !nextEntry) return true;
    if (
      prevEntry.insertions !== nextEntry.insertions ||
      prevEntry.deletions !== nextEntry.deletions
    ) {
      return true;
    }
  }

  return false;
};

export const haveRemoteComparisonChanged = (
  previous?: GitStatus['upstreamComparison'],
  next?: GitStatus['upstreamComparison']
): boolean => {
  if (!previous && !next) return false;
  if (!previous || !next) return true;

  return (
    previous.remote !== next.remote ||
    previous.branch !== next.branch ||
    previous.ahead !== next.ahead ||
    previous.behind !== next.behind
  );
};

export const hasStatusChanged = (
  oldStatus: GitStatus | null,
  newStatus: GitStatus | null
): boolean => {
  if (!oldStatus && !newStatus) return false;
  if (!oldStatus || !newStatus) return true;

  const oldFiles = oldStatus.files ?? [];
  const newFiles = newStatus.files ?? [];

  if (oldFiles.length !== newFiles.length) return true;
  if (oldStatus.ahead !== newStatus.ahead) return true;
  if (oldStatus.behind !== newStatus.behind) return true;
  if (oldStatus.current !== newStatus.current) return true;
  if (oldStatus.tracking !== newStatus.tracking) return true;
  if (oldStatus.isClean !== newStatus.isClean) return true;
  if (
    newStatus.upstreamComparison !== undefined &&
    haveRemoteComparisonChanged(
      oldStatus.upstreamComparison,
      newStatus.upstreamComparison
    )
  ) {
    return true;
  }

  const oldPaths = new Set(
    oldFiles.map((f) => `${f.path}:${f.index}:${f.working_dir}`)
  );
  for (const file of newFiles) {
    if (!oldPaths.has(`${file.path}:${file.index}:${file.working_dir}`)) {
      return true;
    }
  }

  // Skip diffStats comparison when light mode omits them (undefined)
  if (
    newStatus.diffStats !== undefined &&
    haveDiffStatsChanged(oldStatus.diffStats, newStatus.diffStats)
  )
    return true;

  return false;
};

export const getChangedFilePaths = (
  oldStatus: GitStatus | null,
  newStatus: GitStatus | null
): Set<string> => {
  const changed = new Set<string>();
  if (!newStatus) return changed;

  const oldFiles = oldStatus?.files ?? [];
  const newFiles = newStatus.files ?? [];

  const oldFileMap = new Map(oldFiles.map((f) => [f.path, f] as const));
  const newFileMap = new Map(newFiles.map((f) => [f.path, f] as const));

  const allFilePaths = new Set<string>([
    ...oldFileMap.keys(),
    ...newFileMap.keys(),
  ]);
  for (const filePath of allFilePaths) {
    const oldFile = oldFileMap.get(filePath);
    const newFile = newFileMap.get(filePath);

    // Added/removed/renamed
    if (!oldFile || !newFile) {
      changed.add(filePath);
      continue;
    }

    // Index/worktree state changed (indicates actual content/state changed)
    if (
      oldFile.index !== newFile.index ||
      oldFile.working_dir !== newFile.working_dir
    ) {
      changed.add(filePath);
      continue;
    }
  }

  // Only compare diffStats when light mode provides them (non-undefined)
  if (newStatus.diffStats !== undefined) {
    const oldStats = oldStatus?.diffStats ?? {};
    const newStats = newStatus.diffStats ?? {};
    const allStatPaths = new Set<string>([
      ...Object.keys(oldStats),
      ...Object.keys(newStats),
    ]);

    for (const filePath of allStatPaths) {
      const oldEntry = oldStats[filePath];
      const newEntry = newStats[filePath];

      if (!oldEntry || !newEntry) {
        changed.add(filePath);
        continue;
      }

      if (
        oldEntry.insertions !== newEntry.insertions ||
        oldEntry.deletions !== newEntry.deletions
      ) {
        changed.add(filePath);
      }
    }
  }

  return changed;
};

export const hasIndexStatusChanged = (
  oldStatus: GitStatus | null,
  newStatus: GitStatus | null
): boolean => {
  if (!oldStatus && !newStatus) return false;
  if (!oldStatus || !newStatus) return true;

  const oldFiles = oldStatus.files ?? [];
  const newFiles = newStatus.files ?? [];
  const normalizeIndexStatus = (value?: string | null): string => {
    const trimmed = value?.trim() ?? '';
    return trimmed === '?' ? '' : trimmed;
  };

  const oldIndexByPath = new Map(
    oldFiles.map(
      (file) => [file.path, normalizeIndexStatus(file.index)] as const
    )
  );
  const newIndexByPath = new Map(
    newFiles.map(
      (file) => [file.path, normalizeIndexStatus(file.index)] as const
    )
  );
  const paths = new Set<string>([
    ...oldIndexByPath.keys(),
    ...newIndexByPath.keys(),
  ]);

  for (const path of paths) {
    if ((oldIndexByPath.get(path) ?? '') !== (newIndexByPath.get(path) ?? '')) {
      return true;
    }
  }

  return false;
};

export const isBlankStatusCode = (value?: string | null): boolean =>
  !value || value.trim().length === 0;
export const isConflictStatusCode = (value?: string | null): boolean =>
  (value || '').trim() === 'U';

export const toStagedStatusFile = (
  file: GitStatus['files'][number]
): GitStatus['files'][number] => {
  const index = (file.index || '').trim();
  const workingDir = (file.working_dir || '').trim();

  if (isConflictStatusCode(index) || isConflictStatusCode(workingDir)) {
    return file;
  }

  const nextIndex =
    index === '?' || workingDir === '?'
      ? 'A'
      : index || workingDir || ' ';

  return {
    ...file,
    index: nextIndex,
    working_dir: ' ',
  };
};

export const toUnstagedStatusFile = (
  file: GitStatus['files'][number]
): GitStatus['files'][number] => {
  const index = (file.index || '').trim();
  const workingDir = (file.working_dir || '').trim();

  if (isConflictStatusCode(index) || isConflictStatusCode(workingDir)) {
    return file;
  }

  const nextWorkingDir =
    workingDir || (index === 'A' || index === '?' ? '?' : index) || ' ';

  return {
    ...file,
    index: ' ',
    working_dir: nextWorkingDir,
  };
};

export const isCleanStatusFile = (
  file: GitStatus['files'][number]
): boolean =>
  isBlankStatusCode(file.index) && isBlankStatusCode(file.working_dir);
