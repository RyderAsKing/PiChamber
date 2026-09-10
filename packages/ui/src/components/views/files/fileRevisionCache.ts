import type { FileContentRevision } from '@/lib/api/types';

/**
 * File-save revision cache helpers (finding #8).
 *
 * The opaque read-content revision is retained exact with buffer (draft),
 * runtime, path, and load generation. Any mismatch invalidates the cached
 * revision so a stale read can never authorize a guarded save against the
 * wrong file, runtime, or generation.
 */

export type FileRevisionScope = {
  runtimeKey: string;
  root: string;
  path: string;
  generation: number;
};

export type CachedFileRevision = FileRevisionScope & {
  revision: FileContentRevision;
};

/** Exact opaque compare: no trimming, no case folding, no coercion. */
export const isSameFileRevision = (
  left: FileContentRevision,
  right: FileContentRevision,
): boolean => left === right;

/** Whether a cached revision may be sent as `expectedRevision`. */
export const isRevisionUsableForSave = (revision: FileContentRevision): boolean => (
  typeof revision === 'string' || revision === null
);

/**
 * Whether the cached revision is stale for the current scope. True when
 * runtime, root, path, or generation differ, or when no revision was ever
 * captured. Path/root callers must pass already-normalized values so this
 * stays an exact compare.
 */
export const shouldInvalidateLoadedRevision = (
  cached: CachedFileRevision | null | undefined,
  current: FileRevisionScope,
): boolean => {
  if (!cached) return true;
  if (cached.runtimeKey !== current.runtimeKey) return true;
  if (cached.root !== current.root) return true;
  if (cached.path !== current.path) return true;
  if (cached.generation !== current.generation) return true;
  return false;
};

/** Resolve the `expectedRevision` wire value for a guarded save. */
export const toExpectedRevision = (
  revision: FileContentRevision,
): string | null | undefined => {
  if (typeof revision === 'string') return revision;
  if (revision === null) return null;
  return undefined;
};

/** Build the adapter write options for a guarded save. */
export const buildGuardedWriteOptions = (
  expectedRevision: FileContentRevision,
  overwrite?: boolean,
): { expectedRevision?: string | null; overwrite?: boolean } | undefined => {
  if (overwrite === true) {
    return expectedRevision !== undefined
      ? { expectedRevision: toExpectedRevision(expectedRevision), overwrite: true }
      : { overwrite: true };
  }
  if (expectedRevision === undefined) return undefined;
  return { expectedRevision: toExpectedRevision(expectedRevision) };
};

/**
 * Whether an in-flight save captured under `scope` may still commit its
 * completion: runtime, root, path, and generation must all match the current
 * scope exactly. A save that outlives its authority (file switch, reload,
 * runtime switch) must be dropped instead of clobbering the now-selected
 * document with the previous buffer.
 */
export const isSaveScopeCurrent = (
  scope: FileRevisionScope | null | undefined,
  current: FileRevisionScope | null | undefined,
): boolean => Boolean(
  scope
  && current
  && scope.runtimeKey === current.runtimeKey
  && scope.root === current.root
  && scope.path === current.path
  && scope.generation === current.generation,
);
