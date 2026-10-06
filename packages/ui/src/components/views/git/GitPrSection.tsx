import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useGitHubSelectedRepo, useGitHubScopeStore } from '@/stores/useGitHubScopeStore';
import { getGitHubPrStatusKey, useEnsureGitHubPrStatus, useGitHubPrStatusStore, usePrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { GitHubChecksGlyph, GitHubStateGlyph } from '../github/GitHubDetailScaffold';
import { openPullRequestInSurface } from '../github/openPullRequestInSurface';
import { CreatePullRequestForm } from './CreatePullRequestForm';
import { clearCreatePrDraft } from './createPullRequestLogic';
import { createPrDraftKey } from './createPullRequestLogic';

/**
 * Compact existing-PR row for the Git surface (§6.5): state glyph, `#N`,
 * truncated title, checks glyph, and an Open action. The whole row opens
 * the PR in the Pull requests surface via the `openPullRequestInSurface`
 * selection handoff.
 */
const GitExistingPrRow: React.FC<{
  directory: string;
  branch: string;
  repo: string;
}> = ({ directory, branch, repo }) => {
  const { t } = useTranslation();
  const key = React.useMemo(() => getGitHubPrStatusKey(directory, branch), [directory, branch]);
  const entry = useGitHubPrStatusStore((state) => (key ? state.results[key] ?? null : null));
  const summary = usePrVisualSummary(key);
  const pr = entry?.pr;

  if (!pr) return null;
  const label = summary
    ? summary.visualState === 'merged'
      ? t('Pull request #{{number}}, merged', { number: summary.number })
      : summary.visualState === 'draft'
        ? t('Draft pull request #{{number}}', { number: summary.number })
        : summary.visualState === 'blocked'
          ? t('Pull request #{{number}}, checks failing', { number: summary.number })
          : summary.visualState === 'closed'
            ? t('Pull request #{{number}}, closed', { number: summary.number })
            : t('Pull request #{{number}}, open', { number: summary.number })
    : t('Pull request #{{number}}, open', { number: pr.number });
  const open = () => openPullRequestInSurface(directory, repo, pr.number);

  return (
    <div className="relative flex min-w-0 items-center gap-2 rounded-md px-2 py-1">
      <button
        type="button"
        onClick={open}
        aria-label={t('Open {{label}} in Pull requests', { label })}
        title={label}
        className="absolute inset-0 rounded-md hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      />
      <span className="pointer-events-none flex min-w-0 flex-1 items-center gap-1.5">
        <GitHubStateGlyph kind="pr" state={pr.state} draft={pr.draft} />
        <span className="shrink-0 font-mono typography-micro tabular-nums text-muted-foreground">#{pr.number}</span>
        <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground" title={pr.title || t('Pull request #{{number}}', { number: pr.number })}>
          {pr.title || t('Pull request #{{number}}', { number: pr.number })}
        </span>
        <GitHubChecksGlyph state={entry?.checks?.state ?? null} />
      </span>
      <Button type="button" variant="ghost" size="xs" onClick={open} className="relative shrink-0">
        {t('Open')}
      </Button>
    </div>
  );
};

/** Collapsed no-PR row: subscription-free so the idle section stays cheap. */
const GitNoPrRow: React.FC<{
  headBranch: string;
  onExpand: () => void;
}> = ({ headBranch, onExpand }) => {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-center gap-2 py-1">
      <Icon name="git-pull-request" className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="flex min-w-0 flex-1 items-center gap-1.5 typography-micro text-muted-foreground">
        <span className="shrink-0">{t('No pull request for')}</span>
        <code
          className="min-w-0 max-w-44 truncate rounded bg-[var(--surface-muted)] px-1 py-px font-mono text-foreground"
          title={headBranch}
        >
          {headBranch}
        </code>
      </p>
      <Button type="button" variant="default" size="xs" onClick={onExpand} className="shrink-0">
        {t('Create pull request')}
      </Button>
    </div>
  );
};

/**
 * Git-surface PR section (§6.5): the existing-PR row when a PR exists,
 * otherwise a collapsed row that expands into the create pull request form.
 * Rendered below the unified header in GitView; no changes to header layout
 * or branch workflows.
 */
export const GitPrSection: React.FC<{
  directory: string;
  branch: string | null;
  hasUpstream: boolean;
}> = ({ directory, branch, hasUpstream }) => {
  const apis = useRuntimeAPIs();
  const repo = useGitHubSelectedRepo(directory || null);
  const scope = useGitHubScopeStore((state) => (directory ? state.entriesByDirectory[directory]?.scope ?? null : null));
  useEnsureGitHubPrStatus(directory, branch, apis.github ?? null);
  const key = React.useMemo(() => getGitHubPrStatusKey(directory, branch), [directory, branch]);
  const entry = useGitHubPrStatusStore((state) => (key ? state.results[key] ?? null : null));
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    setExpanded(false);
  }, [directory, branch]);

  const selectedEntry = React.useMemo(() => {
    if (!scope || !repo) return null;
    return scope.repositories.find((candidate) =>
      candidate.host && candidate.owner && candidate.repo &&
      `${candidate.host}/${candidate.owner}/${candidate.repo}` === repo,
    ) ?? null;
  }, [scope, repo]);

  if (!directory || !branch || !repo) return null;
  // Default branch has no PR by definition; pr-status reports
  // skippedDefaultBranch — show nothing instead of a create form.
  if (entry?.skippedDefaultBranch) return null;
  if (entry?.pr) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-1 py-1.5">
        <GitExistingPrRow directory={directory} branch={branch} repo={repo} />
      </div>
    );
  }
  // Only offer creation once pr-status authoritatively reports no PR (a
  // missing entry means still loading — render nothing, not a form).
  if (!entry || !entry.fetchedAt) return null;
  return (
    <div className="shrink-0 border-b border-border px-3 py-1.5">
      {expanded ? (
        <CreatePullRequestForm
          key={createPrDraftKey(directory, branch)}
          directory={directory}
          headBranch={branch}
          defaultBranch={entry.defaultBranch ?? selectedEntry?.defaultBranch ?? null}
          isFork={(selectedEntry?.fork ?? false) === true}
          // The scope entry's `parent` is `{ owner, repo }` only (see
          // `GitHubScopedRepository` / `parseParentFullName`) — the parent's
          // default branch is not sent, so there is nothing better to offer
          // than the fork default until the server enriches it.
          upstreamDefaultBranch={null}
          hasUpstream={hasUpstream}
          onCollapse={() => setExpanded(false)}
          onCreated={() => {
            clearCreatePrDraft(createPrDraftKey(directory, branch));
            setExpanded(false);
          }}
        />
      ) : (
        <GitNoPrRow headBranch={branch} onExpand={() => setExpanded(true)} />
      )}
    </div>
  );
};
