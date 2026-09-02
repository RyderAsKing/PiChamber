import React from 'react';
import { useChildStoreManager } from '@/sync/sync-context';
import { canRequestNativeDirectoryAccess, requestDirectoryAccess } from '@/lib/desktop';
import { normalizePath } from './utils';
import type { SessionGroup } from './types';

export function useSessionGroupBootstrap({
  group,
  isCollapsed,
}: {
  group: SessionGroup;
  isCollapsed: boolean;
}) {
  const childStores = useChildStoreManager();

  const bootstrapDirectories = React.useMemo(() => {
    const directories = group.folderScopes?.map((scope) => normalizePath(scope.directory))
      ?? [normalizePath(group.directory ?? null)];
    return [...new Set(directories.filter((directory): directory is string => Boolean(directory)))];
  }, [group.directory, group.folderScopes]);

  React.useSyncExternalStore(
    React.useCallback(
      (notify) => (bootstrapDirectories.length > 0 ? childStores.subscribeBootstrap(notify) : () => undefined),
      [bootstrapDirectories.length, childStores],
    ),
    React.useCallback(
      () =>
        bootstrapDirectories
          .map(
            (directory) =>
              `${directory}\u0000${childStores.getBootstrapState(directory) ?? ''}\u0000${childStores.getBootstrapFailure(directory) ?? ''}`,
          )
          .join('\u0001'),
      [bootstrapDirectories, childStores],
    ),
    React.useCallback(() => '', []),
  );

  const bootstrapLoading = bootstrapDirectories.some((directory) => {
    const state = childStores.getBootstrapState(directory) as string;
    return state === 'queued' || state === 'running';
  });

  const failedBootstrapDirectory =
    bootstrapDirectories.find(
      (directory) => (childStores.getBootstrapState(directory) as string) === 'failed',
    ) ?? null;

  const bootstrapFailure = failedBootstrapDirectory
    ? childStores.getBootstrapFailure(failedBootstrapDirectory)
    : undefined;

  const canGrantBootstrapAccess = bootstrapFailure === 'os-permission' && canRequestNativeDirectoryAccess();
  const [isRequestingBootstrapAccess, setIsRequestingBootstrapAccess] = React.useState(false);

  const retryFailedBootstrap = React.useCallback(() => {
    if (!failedBootstrapDirectory) return;
    childStores.requestBootstrap({
      directory: failedBootstrapDirectory,
      priority: isCollapsed ? 'visible' : 'expanded',
      reason: group.isMain ? 'project-expanded' : 'worktree-expanded',
      force: true,
    });
  }, [childStores, failedBootstrapDirectory, group.isMain, isCollapsed]);

  const grantFailedBootstrapAccess = React.useCallback(async () => {
    if (!failedBootstrapDirectory || !canGrantBootstrapAccess || isRequestingBootstrapAccess) return;
    setIsRequestingBootstrapAccess(true);
    try {
      const result = await requestDirectoryAccess(failedBootstrapDirectory);
      if (result.success) retryFailedBootstrap();
    } finally {
      setIsRequestingBootstrapAccess(false);
    }
  }, [canGrantBootstrapAccess, failedBootstrapDirectory, isRequestingBootstrapAccess, retryFailedBootstrap]);

  return {
    bootstrapLoading,
    failedBootstrapDirectory,
    bootstrapFailure,
    canGrantBootstrapAccess,
    isRequestingBootstrapAccess,
    retryFailedBootstrap,
    grantFailedBootstrapAccess,
  };
}
