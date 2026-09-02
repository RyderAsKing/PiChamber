import { getRuntimeKey } from '@/lib/runtime-switch';
import type {
  GitRequestToken,
  GitStatusFetchMode,
} from './gitStoreTypes';

export const inFlightDiffFetchesByDirectory = new Map<string, Set<string>>();
export const diffFetchGenerationByDirectory = new Map<string, number>();
export const inFlightStatusFetches = new Map<string, Promise<boolean>>();
export const inFlightBranchFetches = new Map<string, Promise<void>>();
export const inFlightEnsureAllByDirectory = new Map<string, Promise<void>>();
export const requestGenerationByChannel = new Map<string, number>();
export const statusMutationRevisionByDirectory = new Map<string, number>();

let gitRuntimeGeneration = 0;
let activeGitRuntimeKey = getRuntimeKey();

export const getGitRuntimeGeneration = () => gitRuntimeGeneration;
export const getActiveGitRuntimeKey = () => activeGitRuntimeKey;

export const resetGitRuntimeGuards = (runtimeKey: string) => {
  gitRuntimeGeneration += 1;
  activeGitRuntimeKey = runtimeKey;
  requestGenerationByChannel.clear();
  statusMutationRevisionByDirectory.clear();
  inFlightStatusFetches.clear();
  inFlightBranchFetches.clear();
  inFlightEnsureAllByDirectory.clear();
  inFlightDiffFetchesByDirectory.clear();
  diffFetchGenerationByDirectory.clear();
};

export const runtimeDirectoryKey = (runtimeKey: string, directory: string) =>
  JSON.stringify([runtimeKey, directory]);

export const getStatusFetchKey = (
  runtimeKey: string,
  directory: string,
  mode: GitStatusFetchMode
): string => JSON.stringify([runtimeKey, directory, mode]);

export const channelKey = (
  runtimeKey: string,
  directory: string,
  channel: string
) => JSON.stringify([runtimeKey, directory, channel]);

export const startRequest = (
  directory: string,
  channel: string,
  includeStatusMutation = false
): GitRequestToken => {
  const runtimeKey = getRuntimeKey();
  const key = channelKey(runtimeKey, directory, channel);
  const requestGeneration = (requestGenerationByChannel.get(key) ?? 0) + 1;
  requestGenerationByChannel.set(key, requestGeneration);
  return {
    runtimeKey,
    runtimeGeneration: gitRuntimeGeneration,
    channelKey: key,
    requestGeneration,
    ...(includeStatusMutation
      ? {
          statusMutationRevision:
            statusMutationRevisionByDirectory.get(
              runtimeDirectoryKey(runtimeKey, directory)
            ) ?? 0,
        }
      : {}),
  };
};

export const isRequestCurrent = (
  token: GitRequestToken,
  directory: string
): boolean =>
  token.runtimeKey === getRuntimeKey() &&
  token.runtimeKey === activeGitRuntimeKey &&
  token.runtimeGeneration === gitRuntimeGeneration &&
  requestGenerationByChannel.get(token.channelKey) === token.requestGeneration &&
  (token.statusMutationRevision === undefined ||
    token.statusMutationRevision ===
      (statusMutationRevisionByDirectory.get(
        runtimeDirectoryKey(token.runtimeKey, directory)
      ) ?? 0));

export const bumpStatusMutationRevision = (
  runtimeKey: string,
  directory: string
): void => {
  const key = runtimeDirectoryKey(runtimeKey, directory);
  statusMutationRevisionByDirectory.set(
    key,
    (statusMutationRevisionByDirectory.get(key) ?? 0) + 1
  );
};

export const getDiffFetchGeneration = (directory: string): number =>
  diffFetchGenerationByDirectory.get(
    runtimeDirectoryKey(getRuntimeKey(), directory)
  ) ?? 0;

export const bumpDiffFetchGeneration = (directory: string): number => {
  const next = getDiffFetchGeneration(directory) + 1;
  diffFetchGenerationByDirectory.set(
    runtimeDirectoryKey(getRuntimeKey(), directory),
    next
  );
  return next;
};

export const getInFlightDiffs = (directory: string): Set<string> => {
  const key = runtimeDirectoryKey(getRuntimeKey(), directory);
  const existing = inFlightDiffFetchesByDirectory.get(key);
  if (existing) {
    return existing;
  }
  const created = new Set<string>();
  inFlightDiffFetchesByDirectory.set(key, created);
  return created;
};
