/* eslint-disable react-refresh/only-export-components -- reason mapping colocated with the state component by design */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import type { GitHubErrorBody } from '@/lib/api/types';
import { copyTextToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui';
import { GitHubCenteredState } from './GitHubListPrimitives';

/**
 * Distinct unavailable copy per reason with a concrete fix. A failed
 * section never looks like an empty list.
 */

export type GitHubUnavailableReason =
  | 'gh-missing'
  | 'gh-outdated'
  | 'gh-unauthenticated'
  | 'not-github'
  | 'no-repository'
  | 'no-access'
  | 'scope-missing'
  | 'rate-limited'
  | 'failed';

export type GitHubUnavailableInfo = {
  reason: GitHubUnavailableReason;
  /** Missing scopes for `scope-missing` (e.g. `['repo']`). */
  scopes?: string[];
  /** Epoch ms when a rate limit lifts. */
  retryAt?: number | null;
  /** Human message for `failed`. */
  message?: string | null;
};

export const toUnavailableInfo = (error: GitHubErrorBody | null | undefined): GitHubUnavailableInfo => {
  if (!error) return { reason: 'failed', message: 'GitHub request failed' };
  if (error.kind === 'rate-limited') return { reason: 'rate-limited', retryAt: error.retryAt ?? null };
  if (error.kind === 'failed') return { reason: 'failed', message: error.message };
  return { reason: error.reason, scopes: error.scopes ?? [] };
};

const CopyableCommand: React.FC<{ command: string; label?: string }> = ({ command, label }) => {
  const { t } = useTranslation();
  const handleCopy = React.useCallback(() => {
    void copyTextToClipboard(command).then((result) => {
      toast[result.ok ? 'success' : 'error'](result.ok ? t('Command copied') : t('Failed to copy command'));
    }).catch(() => toast.error(t('Failed to copy command')));
  }, [command, t]);
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <code className="min-w-0 truncate rounded bg-[var(--surface-muted)] px-1.5 py-0.5 font-mono typography-micro text-foreground">
        {command}
      </code>
      <button
        type="button"
        onClick={handleCopy}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
        title={label ?? t('Copy {{command}}', { command })}
        aria-label={label ?? t('Copy {{command}}', { command })}
      >
        <Icon name="file-copy" className="size-3.5" />
      </button>
    </span>
  );
};

const Centered: React.FC<{
  icon: IconName;
  title: string;
  description?: string;
  children?: React.ReactNode;
}> = ({ icon, title, description, children }) => (
  <GitHubCenteredState
    icon={icon}
    title={title}
    description={description}
    action={
      children ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{children}</div>
      ) : undefined
    }
  />
);

export const GitHubUnavailableState: React.FC<{
  info: GitHubUnavailableInfo;
  onRetry?: () => void;
  isRetrying?: boolean;
}> = ({ info, onRetry, isRetrying }) => {
  const { t } = useTranslation();
  const retryButton = onRetry ? (
    <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={isRetrying}>
      <Icon name="refresh" className="size-3.5" />
      {isRetrying ? t('Checking…') : t('Check again')}
    </Button>
  ) : null;

  switch (info.reason) {
    case 'gh-missing':
      return (
        <Centered
          icon="github-fill"
          title={t("GitHub CLI not found")}
          description={t("Install the GitHub CLI on the machine running PiChamber to browse pull requests and issues.")}
        >
          <CopyableCommand command="gh --version" label={t("Copy gh version check")} />
          {retryButton}
        </Centered>
      );
    case 'gh-outdated':
      return (
        <Centered
          icon="github-fill"
          title={t("GitHub CLI too old")}
          description={t("Update gh on the machine running PiChamber, then check again.")}
        >
          <CopyableCommand command="gh upgrade" label={t("Copy gh upgrade command")} />
          {retryButton}
        </Centered>
      );
    case 'gh-unauthenticated':
      return (
        <Centered
          icon="github-fill"
          title={t("Not signed in")}
          description={t("Run gh auth login on the machine running PiChamber, then check again.")}
        >
          <CopyableCommand command="gh auth login" label={t("Copy gh auth login command")} />
          {retryButton}
        </Centered>
      );
    case 'not-github':
      return (
        <Centered
          icon="git-repository"
          title={t("Not a GitHub repository")}
          description={t("This directory is a git repository, but none of its remotes point at GitHub.")}
        />
      );
    case 'no-repository':
      return (
        <Centered
          icon="git-repository"
          title={t("No repository here")}
          description={t("Open a directory inside a git repository to browse pull requests and issues.")}
        />
      );
    case 'no-access':
      return (
        <Centered
          icon="lock"
          title={t("No access")}
          description={t("The signed-in GitHub account cannot access this repository. Check the remote and the account in Settings.")}
        >
          {retryButton}
        </Centered>
      );
    case 'scope-missing': {
      const scopes = (info.scopes ?? []).filter(Boolean);
      const command = scopes.length > 0 ? `gh auth refresh -s ${scopes.join(' ')}` : 'gh auth refresh -s repo';
      return (
        <Centered
          icon="shield-keyhole"
          title={t("Missing token scope")}
          description={t('The GitHub token needs {{scopes}}. Run this on the machine running PiChamber, then check again.', { scopes: scopes.length > 0 ? scopes.join(', ') : t('more scope') })}
        >
          <CopyableCommand command={command} label={t("Copy gh auth refresh command")} />
          {retryButton}
        </Centered>
      );
    }
    case 'rate-limited': {
      const retryLabel = info.retryAt ? new Date(info.retryAt).toLocaleTimeString() : null;
      return (
        <Centered
          icon="hourglass"
          title={t("Rate limited")}
          description={retryLabel ? t('GitHub rate limit reached. Try again after {{time}}.', { time: retryLabel }) : t('GitHub rate limit reached. Try again shortly.')}
        >
          {retryButton}
        </Centered>
      );
    }
    case 'failed':
    default:
      return (
        <Centered
          icon="error-warning"
          title={t("Something went wrong")}
          description={info.message || t('GitHub request failed')}
        >
          {retryButton}
        </Centered>
      );
  }
};
