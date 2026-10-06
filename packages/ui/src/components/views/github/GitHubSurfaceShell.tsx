import React from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeDirectoryPathKey } from '@/lib/directoryPathKey';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useGitHubScopeStore, useGitHubSelectedRepo } from '@/stores/useGitHubScopeStore';
import { useGitHubStatusStore } from '@/stores/useGitHubStatusStore';
import { GitHubUnavailableState, toUnavailableInfo } from './GitHubUnavailableState';
import { GitHubListSkeleton } from './GitHubListPrimitives';
import { RepositoryPicker, toPickerEntries } from './RepositoryPicker';

/**
 * Shared shell for the Pull requests and Issues rail surfaces.
 *
 * The shell owns scope/status bootstrap only — it renders no title (the rail
 * header already names the surface), no acting account, and no stale banner
 * (lists render the single stale banner for their own entries). The
 * repository picker renders as a compact row only when several repositories
 * are in scope; single-repo scope shows no repo chrome at all. Body renders
 * through `children` once a repository is selected; unavailable states
 * (gh-missing, unauthenticated, not-github, no access, scope errors, rate
 * limits, failures) render here so surfaces only handle the happy path plus
 * their own list/detail errors.
 */
export const GitHubSurfaceShell: React.FC<{
  directory: string;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  children: (ctx: { repo: string; directory: string }) => React.ReactNode;
}> = ({ directory, isRefreshing, onRefresh, children }) => {
  const { t } = useTranslation();
  const apis = useRuntimeAPIs();
  const github = apis.github ?? null;

  // The store keys entries by the normalized directory; read with the same key.
  const scopeEntry = useGitHubScopeStore((state) => state.entriesByDirectory[normalizeDirectoryPathKey(directory.trim())] ?? null);
  const ensureScope = useGitHubScopeStore((state) => state.ensureScope);
  const refreshScope = useGitHubScopeStore((state) => state.refreshScope);
  const setSelectedRepo = useGitHubScopeStore((state) => state.setSelectedRepo);
  const selectedRepo = useGitHubSelectedRepo(directory || null);

  const status = useGitHubStatusStore((state) => state.status);
  const refreshStatus = useGitHubStatusStore((state) => state.refresh);

  React.useEffect(() => {
    if (!directory || !github) return;
    void ensureScope(directory, github);
    void refreshStatus(github);
  }, [directory, github, ensureScope, refreshStatus]);

  const handleRefresh = React.useCallback(() => {
    if (onRefresh) {
      onRefresh();
      return;
    }
    if (!github) return;
    void refreshScope(directory, github, { force: true });
    void refreshStatus(github, { force: true });
  }, [onRefresh, github, refreshScope, refreshStatus, directory]);

  if (!github) {
    return (
      <div className="flex h-full flex-col">
        <GitHubUnavailableState info={{ reason: 'failed', message: t('GitHub is not available in this runtime.') }} />
      </div>
    );
  }

  if (scopeEntry?.isLoading && !scopeEntry.scope && !scopeEntry.error) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <GitHubListSkeleton label={t("Finding GitHub repositories")} />
      </div>
    );
  }

  if (scopeEntry?.error && !scopeEntry.scope) {
    return (
      <div className="flex h-full flex-col">
        <GitHubUnavailableState
          info={toUnavailableInfo(scopeEntry.error)}
          onRetry={handleRefresh}
          isRetrying={isRefreshing || scopeEntry.isLoading}
        />
      </div>
    );
  }

  const scope = scopeEntry?.scope ?? null;
  if (scope && !status?.installed) {
    return (
      <div className="flex h-full flex-col">
        <GitHubUnavailableState info={{ reason: 'gh-missing' }} onRetry={handleRefresh} isRetrying={isRefreshing} />
      </div>
    );
  }

  const entries = scope ? toPickerEntries(scope.repositories) : [];
  const selectable = entries.filter((entry) => Boolean(entry.ref && !entry.disabledReason));

  if (scope && selectable.length === 0) {
    const reason = scope.topLevel ? 'not-github' : 'no-repository';
    return (
      <div className="flex h-full flex-col">
        <GitHubUnavailableState info={{ reason }} />
      </div>
    );
  }

  if (!selectedRepo) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <RepositoryPicker
            entries={entries}
            value={selectedRepo}
            onChange={(ref) => setSelectedRepo(directory, ref)}
          />
        </div>
        <div className="flex flex-col items-start gap-2 p-4">
          <div className="typography-ui-header text-foreground">{t('Select a repository')}</div>
          <p className="typography-ui text-muted-foreground">{t('Several repositories are in scope. Pick one to browse.')}</p>
        </div>
      </div>
    );
  }

  const multiRepo = selectable.length > 1;
  return (
    <div className="flex h-full flex-col">
      {multiRepo ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <RepositoryPicker
            entries={entries}
            value={selectedRepo}
            onChange={(ref) => setSelectedRepo(directory, ref)}
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1">{children({ repo: selectedRepo, directory })}</div>
    </div>
  );
};
