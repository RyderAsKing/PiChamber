import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useGitHubScopeStore, useGitHubSelectedRepo } from '@/stores/useGitHubScopeStore';
import { toast } from '@/components/ui';
import { GitHubFilterTabBar, GitHubSearchInput } from '../GitHubListPrimitives';
import { GitHubStateGlyph } from '../GitHubDetailScaffold';
import { parseGitHubLinkInput } from '../issues/issueLogic';
import { createInputStoreGitHubComposerActions, insertGitHubContextIntoComposer } from './githubLink';

/**
 * Composer "Link issue / pull request" picker.
 *
 * Accepts free search ( qualifier passthrough to the server list endpoints,
 * 250 ms debounce), `#123` in the selected repository, `owner/repo#123`, or
 * a GitHub URL for a repository in scope. Out-of-scope repositories are
 * rejected with an explanation — the server allow-list can never be probed
 * with an arbitrary value. Picking inserts the transcript chip link plus the
 * full quoted context payload via `insertGitHubContextIntoComposer`, so the
 * agent receives it on the next send. The user reviews the composer before
 * sending; nothing auto-sends.
 */

type PickTarget = {
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  url: string;
  repo: string;
};

export const GitHubLinkPicker: React.FC<{
  directory: string;
  open: boolean;
  onClose: () => void;
}> = ({ directory, open, onClose }) => {
  const { t } = useTranslation();
  const apis = useRuntimeAPIs();
  const github = apis.github ?? null;
  const scopeEntry = useGitHubScopeStore((state) => state.entriesByDirectory[directory] ?? null);
  const ensureScope = useGitHubScopeStore((state) => state.ensureScope);
  const selectedRepo = useGitHubSelectedRepo(directory || null);

  const [kind, setKind] = React.useState<'issue' | 'pr'>('issue');
  const [repo, setRepo] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<PickTarget[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [searchError, setSearchError] = React.useState<string | null>(null);
  const [resolving, setResolving] = React.useState(false);
  const [attachingKey, setAttachingKey] = React.useState<string | null>(null);
  // Sequence guard: only the latest search may update state, so a slower
  // earlier response never overwrites newer results.

  React.useEffect(() => {
    if (!open || !github) return;
    void ensureScope(directory, github);
  }, [open, directory, github, ensureScope]);

  const scopeRepos = React.useMemo(() => {
    const repositories = scopeEntry?.scope?.repositories ?? [];
    return repositories
      .filter((entry) => entry.host && entry.owner && entry.repo && !entry.disabledReason)
      .map((entry) => ({
        owner: entry.owner,
        repo: entry.repo,
        ref: `${entry.host}/${entry.owner}/${entry.repo}`,
      }));
  }, [scopeEntry]);

  React.useEffect(() => {
    if (!open) return;
    setRepo(selectedRepo ?? scopeRepos[0]?.ref ?? null);
  }, [open, selectedRepo, scopeRepos]);

  // Direct `#123` / `owner/repo#123` / URL resolution against the scope.
  const direct = React.useMemo(() => parseGitHubLinkInput(query, scopeRepos), [query, scopeRepos]);

  const searchSeqRef = React.useRef(0);

  const runSearch = React.useCallback(
    async (search: string, searchRepo: string, searchKind: 'issue' | 'pr') => {
      if (!github) return;
      const seq = (searchSeqRef.current += 1);
      const trimmed = search.trim();
      const parsed = parseGitHubLinkInput(trimmed, scopeRepos);
      if (!trimmed || parsed.link || parsed.outOfScope) {
        setResults([]);
        setSearchError(null);
        setSearching(false);
        return;
      }
      setSearching(true);
      setSearchError(null);
      try {
        if (searchKind === 'issue') {
          const page = await github.issuesList(directory, searchRepo, { state: 'all', q: trimmed });
          if (searchSeqRef.current !== seq) return;
          setResults(
            page.items.slice(0, 60).map((item) => ({
              kind: 'issue' as const,
              number: item.number,
              title: item.title,
              url: item.url,
              repo: searchRepo,
            })),
          );
        } else {
          const page = await github.pullsList(directory, searchRepo, { state: 'all', q: trimmed });
          if (searchSeqRef.current !== seq) return;
          setResults(
            page.items.slice(0, 60).map((item) => ({
              kind: 'pr' as const,
              number: item.number,
              title: item.title,
              url: item.url,
              repo: searchRepo,
            })),
          );
        }
      } catch (error) {
        if (searchSeqRef.current !== seq) return;
        setResults([]);
        setSearchError(error instanceof Error ? error.message : t('Search failed'));
      } finally {
        if (searchSeqRef.current === seq) setSearching(false);
      }
    },
    [github, directory, scopeRepos, t],
  );

  // Debounced (250 ms) so keystrokes never fetch per character.
  React.useEffect(() => {
    if (!open || !repo) return;
    const timer = setTimeout(() => {
      void runSearch(query, repo, kind);
    }, 250);
    return () => clearTimeout(timer);
  }, [open, query, repo, kind, runSearch]);

  const resolveDirect = React.useCallback(async (): Promise<PickTarget | null> => {
    if (!github || !direct.link) return null;
    const { kind: linkKind, number, owner, repo: linkRepo } = direct.link;
    // `#123` resolves in the picked repository; qualified/URL forms resolve
    // in their own repository (already scope-checked by the parser).
    const targetRepo = owner && linkRepo
      ? scopeRepos.find(
          (entry) => entry.owner?.toLowerCase() === owner.toLowerCase()
            && entry.repo?.toLowerCase() === linkRepo.toLowerCase(),
        )?.ref ?? null
      : repo;
    if (!targetRepo) return null;
    // URL forms carry their own kind (`/issues/N` vs `/pull/N`); shorthand
    // (`#123`, `owner/repo#123`) always parses as `issue`, so the tab decides.
    const isUrl = /^https?:\/\//i.test(query.trim());
    const effectiveKind = isUrl ? linkKind : kind;
    setResolving(true);
    try {
      if (effectiveKind === 'pr') {
        const detail = await github.pullGet(directory, targetRepo, number);
        if (!detail.pr) return null;
        return { kind: 'pr', number, title: detail.pr.title, url: detail.pr.url, repo: targetRepo };
      }
      const detail = await github.issueGet(directory, targetRepo, number);
      if (!detail.issue) return null;
      return { kind: 'issue', number, title: detail.issue.title, url: detail.issue.url, repo: targetRepo };
    } finally {
      setResolving(false);
    }
  }, [github, direct.link, directory, kind, query, repo, scopeRepos]);

  const attach = React.useCallback(
    async (target: PickTarget) => {
      if (!github) return;
      const key = `${target.repo}#${target.number}`;
      setAttachingKey(key);
      try {
        const context = await github.agentContext(
          directory,
          target.repo,
          target.kind === 'pr' ? 'pr' : 'issue',
          target.number,
        );
        insertGitHubContextIntoComposer(
          { kind: target.kind, number: target.number, title: target.title, url: target.url, contextText: context.text },
          createInputStoreGitHubComposerActions(),
        );
        toast.success(target.kind === 'pr' ? t('Pull request linked') : t('Issue linked'));
        onClose();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t('Failed to link'));
      } finally {
        setAttachingKey(null);
      }
    },
    [github, directory, onClose, t],
  );

  const attachDirect = React.useCallback(async () => {
    const target = await resolveDirect();
    if (!target) {
      toast.error(t('Not found in this repository'));
      return;
    }
    await attach(target);
  }, [resolveDirect, attach, t]);

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-md w-[calc(100vw-2rem)]">
        <DialogHeader>
          <DialogTitle>{t('Link issue or pull request')}</DialogTitle>
          <DialogDescription>{t('Search, type #123, or paste a GitHub URL for a repository in scope.')}</DialogDescription>
        </DialogHeader>
        {!github ? (
          <p className="typography-ui text-muted-foreground">{t('GitHub is not available in this runtime.')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <GitHubFilterTabBar
              ariaLabel={t("Link kind")}
              value={kind}
              onChange={(id) => setKind(id as 'issue' | 'pr')}
              options={[{ id: 'issue', label: t('Issues') }, { id: 'pr', label: t('Pull requests') }]}
            />
            {scopeRepos.length > 1 ? (
              <label className="flex items-center gap-2">
                <span className="sr-only">{t('Repository')}</span>
                <select
                  aria-label={t("Repository")}
                  value={repo ?? ''}
                  onChange={(event) => setRepo(event.target.value || null)}
                  className="h-8 min-w-0 flex-1 rounded-md border border-border bg-[var(--surface-elevated)] px-2 typography-micro text-foreground"
                >
                  {scopeRepos.map((entry) => (
                    <option key={entry.ref} value={entry.ref}>
                      {entry.owner}/{entry.repo}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <GitHubSearchInput
              value={query}
              onChange={setQuery}
              placeholder={kind === 'issue' ? t('Search issues, #123, or paste a URL') : t('Search pull requests, #123, or paste a URL')}
              ariaLabel={kind === 'issue' ? t('Search issues') : t('Search pull requests')}
            />
            {direct.outOfScope ? (
              <p className="typography-micro text-muted-foreground" role="note">
                {t("That repository is outside this session's scope. Pick a repository listed above.")}
              </p>
            ) : null}
            {direct.link ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={attachDirect}
                disabled={resolving || attachingKey !== null || (!repo && !(direct.link.owner && direct.link.repo))}
                aria-label={t('Link {{kind}} number {{number}}', { kind: kind === 'pr' ? t('pull request') : t('issue'), number: direct.link.number })}
              >
                {resolving || attachingKey ? t('Working…') : t('Link #{{number}}', { number: direct.link.number })}
              </Button>
            ) : null}
            {searchError ? (
              <p className="typography-micro text-[var(--status-error)]" role="alert">{searchError}</p>
            ) : null}
            <div className="max-h-64 min-h-0 overflow-y-auto" role="list" aria-label={t("Matches")}>
              {searching ? (
                <p className="flex items-center gap-2 p-2 typography-ui text-muted-foreground">
                  <Icon name="loader-4" className="size-4 animate-spin" /> {t('Searching…')}
                </p>
              ) : results.length === 0 && query.trim() && !direct.link ? (
                <p className="p-2 typography-ui text-muted-foreground">{t('No matches. Try #123 or a GitHub URL.')}</p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {results.map((item) => {
                    const key = `${item.repo}#${item.number}`;
                    return (
                      <li key={key} role="listitem">
                        <button
                          type="button"
                          onClick={() => void attach(item)}
                          disabled={attachingKey !== null}
                          aria-label={t('Link {{kind}} #{{number}} {{title}}', { kind: item.kind === 'pr' ? t('pull request') : t('issue'), number: item.number, title: item.title })}
                          className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-interactive-hover disabled:opacity-60"
                        >
                          <span className="mt-0.5 shrink-0">
                            <GitHubStateGlyph kind={item.kind} state="open" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="shrink-0 font-mono typography-micro text-muted-foreground">#{item.number}</span>
                              <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground" title={item.title}>
                                {attachingKey === key ? t('Linking…') : item.title}
                              </span>
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
