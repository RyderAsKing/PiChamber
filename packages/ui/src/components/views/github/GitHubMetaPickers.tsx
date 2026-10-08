/* eslint-disable react-refresh/only-export-components -- pickers colocated with their repo-meta hook by design */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { GitHubAPI, GitHubIssueLabel, GitHubUserSummary } from '@/lib/api/types';

/**
 * Label/assignee chip pickers shared by the issue detail editor and the new
 * issue form, plus the `repoMeta` fetch backing both. Candidates load once
 * per repo; failure leaves empty lists (and the pickers' "none in this
 * repository" copy) instead of guessing.
 */
export const useRepoMeta = (
  directory: string,
  repo: string,
  github: GitHubAPI | null,
): { labels: GitHubIssueLabel[]; assignees: GitHubUserSummary[]; loading: boolean } => {
  const [labels, setLabels] = React.useState<GitHubIssueLabel[]>([]);
  const [assignees, setAssignees] = React.useState<GitHubUserSummary[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!github) return;
    let cancelled = false;
    setLoading(true);
    github
      .repoMeta(directory, repo)
      .then((meta) => {
        if (cancelled) return;
        setLabels(meta.labels ?? []);
        setAssignees(meta.assignees ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setLabels([]);
          setAssignees([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [github, directory, repo]);

  return { labels, assignees, loading };
};

const toggleInList = (list: string[], value: string): string[] =>
  list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];

export const GitHubLabelPicker: React.FC<{
  candidates: GitHubIssueLabel[];
  loading: boolean;
  selected: string[];
  onChange: (next: string[]) => void;
}> = ({ candidates, loading, selected, onChange }) => {
  const { t } = useTranslation();
  if (loading) return <p className="typography-micro text-muted-foreground">{t('Loading labels…')}</p>;
  if (candidates.length === 0) {
    return <p className="typography-micro text-muted-foreground">{t('No labels in this repository.')}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {candidates.map((label) => {
        const active = selected.includes(label.name);
        return (
          <Button
            key={label.name}
            type="button"
            variant="chip"
            size="xs"
            aria-pressed={active}
            onClick={() => onChange(toggleInList(selected, label.name))}
          >
            {label.name}
          </Button>
        );
      })}
    </div>
  );
};

export const GitHubAssigneePicker: React.FC<{
  candidates: GitHubUserSummary[];
  loading: boolean;
  selected: string[];
  onChange: (next: string[]) => void;
}> = ({ candidates, loading, selected, onChange }) => {
  const { t } = useTranslation();
  if (loading) return <p className="typography-micro text-muted-foreground">{t('Loading assignees…')}</p>;
  if (candidates.length === 0) {
    return <p className="typography-micro text-muted-foreground">{t('No assignable users found.')}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {candidates.map((user) => {
        const login = user.login;
        const active = login ? selected.includes(login) : false;
        return (
          <Button
            key={login}
            type="button"
            variant="chip"
            size="xs"
            aria-pressed={active}
            onClick={() => {
              if (!login) return;
              onChange(toggleInList(selected, login));
            }}
          >
            {login}
          </Button>
        );
      })}
    </div>
  );
};
