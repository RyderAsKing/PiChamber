/* eslint-disable react-refresh/only-export-components -- picker entry mapping colocated with the picker by design */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/icon/Icon';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { GitHubScopedRepository } from '@/lib/api/types';
import { cn } from '@/lib/utils';

export type RepositoryPickerEntry = Pick<
  GitHubScopedRepository,
  'host' | 'owner' | 'repo' | 'relativePath' | 'kind' | 'submodule' | 'disabledReason'
> & { ref: string };

export const toPickerEntries = (repositories: GitHubScopedRepository[]): RepositoryPickerEntry[] => {
  return repositories.map((entry) => ({
    host: entry.host,
    owner: entry.owner,
    repo: entry.repo,
    relativePath: entry.relativePath,
    kind: entry.kind,
    submodule: entry.submodule,
    disabledReason: entry.disabledReason ?? null,
    ref: entry.host && entry.owner && entry.repo ? `${entry.host}/${entry.owner}/${entry.repo}` : '',
  }));
};

const kindTag = (entry: RepositoryPickerEntry): string | null => {
  if (entry.kind === 'enclosing') return 'enclosing';
  if (entry.kind === 'nested') return 'nested';
  if (entry.submodule) return 'submodule';
  return null;
};

/**
 * Repository picker for the GitHub surface header. Entries read
 * `<relative path> · owner/repo` with enclosing/nested/submodule tags;
 * non-GitHub entries render disabled with their reason.
 */
export const RepositoryPicker: React.FC<{
  entries: RepositoryPickerEntry[];
  value: string | null;
  onChange: (ref: string) => void;
  ariaLabel?: string;
}> = ({ entries, value, onChange, ariaLabel }) => {
  const { t } = useTranslation();
  const selected = entries.find((entry) => entry.ref === value) ?? null;
  return (
    <Select value={value ?? ''} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        className="min-w-0 max-w-56"
        aria-label={ariaLabel ?? t('Select repository')}
      >
        <SelectValue placeholder={t("Select repository")}>
          {(current) => {
            const currentEntry = entries.find((entry) => entry.ref === current) ?? selected;
            if (!currentEntry || !currentEntry.ref) return t('Select repository');
            return (
              <span className="block truncate">
                {currentEntry.relativePath} · {currentEntry.owner}/{currentEntry.repo}
              </span>
            );
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {entries.map((entry) => {
          const disabled = !entry.ref || Boolean(entry.disabledReason);
          const tag = kindTag(entry);
          return (
            <SelectItem key={`${entry.ref || entry.relativePath}:${entry.relativePath}`} value={entry.ref} disabled={disabled}>
              <span className={cn('flex min-w-0 items-center gap-1.5', disabled && 'opacity-60')}>
                <Icon name="git-repository" className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">
                  {entry.relativePath} · {entry.owner && entry.repo ? `${entry.owner}/${entry.repo}` : t('not on GitHub')}
                </span>
                {tag ? (
                  <span className="shrink-0 rounded bg-[var(--surface-muted)] px-1 typography-micro text-muted-foreground">
                    {t(tag)}
                  </span>
                ) : null}
                {entry.disabledReason ? (
                  <span className="shrink-0 typography-micro text-muted-foreground">· {entry.disabledReason}</span>
                ) : null}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
};
