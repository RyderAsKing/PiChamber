import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useGitBranches, useGitStore } from '@/stores/useGitStore';
import { useGitHubPullRequestsStore } from '@/stores/useGitHubPullRequestsStore';
import { useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { useGitHubSelectedRepo } from '@/stores/useGitHubScopeStore';
import { validateCreatePullRequest } from '../github/pulls/pullLogic';
import { GitHubMarkdownBody } from '../github/GitHubDetailScaffold';
import { openPullRequestInSurface } from '../github/openPullRequestInSurface';
import {
  CREATE_PR_MODES,
  clearCreatePrDraft,
  createPrDraftKey,
  createPrSubmitLabel,
  deriveBaseBranchOptions,
  readCreatePrDraft,
  resolveCreatePrDefaultBase,
  writeCreatePrDraft,
  type CreatePrMode,
} from './createPullRequestLogic';

const DESCRIPTION_MAX_HEIGHT = 320;

/**
 * Expanded create-pull-request form for the Git surface (§6.5).
 *
 * Shown when the current branch has no PR and the collapsed row is
 * expanded. Base defaults to the default branch (upstream parent when the
 * repo is a fork). Title/body/draft-mode are typed by hand — the app has no
 * title/body generation. When the branch has no upstream, push first with
 * the user's normal git credentials via the existing push action (never the
 * gh token), then create. After create: refresh pr-status and open the PR.
 * Typed text survives collapse via the in-memory draft store and is cleared
 * after a successful create.
 */
export const CreatePullRequestForm: React.FC<{
  directory: string;
  headBranch: string;
  defaultBranch: string | null;
  isFork: boolean;
  upstreamDefaultBranch: string | null;
  hasUpstream: boolean;
  onCollapse: () => void;
  onCreated?: (number: number) => void;
}> = ({ directory, headBranch, defaultBranch, isFork, upstreamDefaultBranch, hasUpstream, onCollapse, onCreated }) => {
  const { t } = useTranslation();
  const apis = useRuntimeAPIs();
  const repo = useGitHubSelectedRepo(directory);
  const resolvedDefault = resolveCreatePrDefaultBase({ isFork, upstreamDefaultBranch, defaultBranch });
  const draftKey = createPrDraftKey(directory, headBranch);
  const saved = readCreatePrDraft(draftKey);

  const [base, setBase] = React.useState(saved?.base ?? resolvedDefault);
  const [title, setTitle] = React.useState(saved?.title ?? '');
  const [body, setBody] = React.useState(saved?.body ?? '');
  const [mode, setMode] = React.useState<CreatePrMode>(saved?.mode ?? 'ready');
  const [tab, setTab] = React.useState<'write' | 'preview'>('write');
  const [busy, setBusy] = React.useState(false);
  const [pushing, setPushing] = React.useState(false);
  const [baseMenuOpen, setBaseMenuOpen] = React.useState(false);
  const [baseSearch, setBaseSearch] = React.useState('');
  const [fieldErrors, setFieldErrors] = React.useState<{ title?: string; head?: string; base?: string }>({});
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const baseCustomized = React.useRef(false);
  const fieldRef = React.useRef<HTMLTextAreaElement>(null);

  // Adopt upstream default changes only while the user hasn't picked a base.
  React.useEffect(() => {
    if (!baseCustomized.current) setBase(resolvedDefault);
  }, [resolvedDefault]);

  // Keep typed text across collapse; drop pristine entries so abandoned
  // forms leave nothing behind.
  React.useEffect(() => {
    const pristine = !title.trim() && !body.trim() && mode === 'ready' && base === resolvedDefault;
    if (pristine) {
      if (readCreatePrDraft(draftKey)) clearCreatePrDraft(draftKey);
      return;
    }
    writeCreatePrDraft(draftKey, { title, body, base: base === resolvedDefault ? null : base, mode });
  }, [draftKey, title, body, base, mode, resolvedDefault]);

  const branches = useGitBranches(directory);
  const gitApi = apis.git;
  React.useEffect(() => {
    if (branches !== null || !gitApi) return;
    void useGitStore.getState().fetchBranches(directory, gitApi).catch(() => {});
  }, [branches, directory, gitApi]);

  const baseOptions = React.useMemo(
    () => deriveBaseBranchOptions({ allBranches: branches?.all, headBranch, defaultBranch: resolvedDefault }),
    [branches, headBranch, resolvedDefault],
  );

  // Grow with the draft like the shared comment form, capped then scrolling.
  React.useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = '0px';
    field.style.height = `${Math.min(field.scrollHeight, DESCRIPTION_MAX_HEIGHT)}px`;
  }, [body, tab]);

  const handleSelectBase = React.useCallback((name: string) => {
    baseCustomized.current = true;
    setBase(name);
    setBaseMenuOpen(false);
    setBaseSearch('');
    setFieldErrors((prev) => (prev.base ? { ...prev, base: undefined } : prev));
  }, []);

  const handleCreate = React.useCallback(async () => {
    if (busy || pushing) return;
    if (!repo) {
      setSubmitError(t('Select a repository first'));
      return;
    }
    const validation = validateCreatePullRequest({ title, head: headBranch, base });
    setFieldErrors(validation.errors);
    if (!validation.ok) return;
    const github = apis.github;
    if (!github) {
      setSubmitError(t('GitHub is not available in this runtime'));
      return;
    }
    setSubmitError(null);
    setBusy(true);
    try {
      if (!hasUpstream) {
        // Push first with the user's normal git credentials (never the gh
        // token — §3.4). Uses the existing git push action.
        setPushing(true);
        try {
          await apis.git.gitPush(directory);
        } catch (error) {
          setSubmitError(error instanceof Error ? error.message : t('Push failed. Create the pull request after pushing.'));
          return;
        } finally {
          setPushing(false);
        }
      }
      const result = await useGitHubPullRequestsStore.getState().createPullRequest(
        { directory, repo, title: title.trim(), head: headBranch, base, body: body.trim() || undefined, draft: mode === 'draft' },
        github,
      );
      if (!result.ok || result.number == null) {
        setSubmitError(result.error?.kind === 'failed' ? result.error.message : t('Failed to create pull request'));
        return;
      }
      toast.success(t('Pull request #{{number}} created', { number: result.number }));
      clearCreatePrDraft(draftKey);
      // Refresh pr-status so the existing-PR row appears, then open the PR.
      await useGitHubPrStatusStore.getState().refresh(directory, headBranch, github, { force: true }).catch(() => {});
      openPullRequestInSurface(directory, repo, result.number);
      onCreated?.(result.number);
    } finally {
      setBusy(false);
    }
  }, [busy, pushing, repo, title, body, headBranch, base, mode, hasUpstream, apis, directory, draftKey, onCreated, t]);

  const handleModEnter = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && !event.repeat) {
        event.preventDefault();
        event.stopPropagation();
        void handleCreate();
      }
    },
    [handleCreate],
  );

  return (
    <section aria-label={t("Create pull request")} className="flex min-w-0 flex-col gap-2 py-0.5">
      <div className="flex items-center gap-1.5">
        <Icon name="git-pull-request" className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h3 className="typography-ui-label text-foreground">{t('New pull request')}</h3>
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onCollapse}
          aria-label={t('Cancel')}
          title={t('Cancel')}
          className="size-6 shrink-0"
        >
          <Icon name="close" className="size-4" />
        </Button>
      </div>
      <p className="flex min-w-0 items-center gap-1.5 typography-micro text-muted-foreground">
        <span className="shrink-0">{t('into')}</span>
        {baseOptions.length > 0 ? (
          <DropdownMenu open={baseMenuOpen} onOpenChange={(open) => { setBaseMenuOpen(open); if (!open) setBaseSearch(''); }} modal={false}>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={t('Base branch')} className={cn(dropdownTriggerVariants({ size: 'default' }), 'min-w-28 max-w-56')}>
                <span className="min-w-0 truncate font-mono">{base || t('Select base')}</span>
                <Icon name="arrow-down-s" className="size-3.5 shrink-0 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={6} className="max-h-[min(var(--available-height),24rem)] w-72 max-w-[min(18rem,var(--available-width))] overflow-hidden p-0">
              <Command className="h-full min-h-0">
                <CommandInput
                  placeholder={t("Search branches...")}
                  value={baseSearch}
                  onValueChange={setBaseSearch}
                  onKeyDown={(event) => event.stopPropagation()}
                />
                <CommandList disableHorizontal>
                  <CommandEmpty>{t('No branches found.')}</CommandEmpty>
                  <CommandGroup heading={t('Branches')}>
                    {baseOptions.map((name) => (
                      <CommandItem key={name} value={name} onSelect={() => handleSelectBase(name)}>
                        <span className="min-w-0 flex-1 truncate font-mono typography-ui-label text-foreground">{name}</span>
                        {name === resolvedDefault ? (
                          <span className="shrink-0 typography-micro text-muted-foreground">{t('default')}</span>
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Input
            value={base}
            onChange={(event) => {
              baseCustomized.current = true;
              setBase(event.target.value);
            }}
            aria-label={t('Base branch')}
            className="h-8 w-40"
          />
        )}
        <span className="shrink-0" aria-label={t('receives changes from')} title={t('receives changes from')}>
          ←
        </span>
        <code className="min-w-0 flex-1 truncate font-mono" title={headBranch}>
          {headBranch}
        </code>
      </p>
      {fieldErrors.base ? (
        <p className="typography-micro text-[var(--status-error)]" role="alert">
          {fieldErrors.base}
        </p>
      ) : null}
      {!hasUpstream ? (
        <p className="flex items-start gap-1.5 typography-micro text-muted-foreground">
          <Icon name="information" className="size-3.5 shrink-0 text-[var(--status-info)]" aria-hidden="true" />
          <span>{t("This branch isn't on the remote yet. It will be pushed first.")}</span>
        </p>
      ) : null}
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
          placeholder={t('Title')}
          aria-label={t('Pull request title')}
        onKeyDown={handleModEnter}
        className="h-8"
      />
      {fieldErrors.title ? (
        <p className="typography-micro text-[var(--status-error)]" role="alert">
          {fieldErrors.title}
        </p>
      ) : null}
      <div role="tablist" aria-label={t('Description format')} className="flex items-center gap-4">
        {(['write', 'preview'] as const).map((id) => {
          const selected = tab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setTab(id)}
              className={cn(
                'relative flex h-7 shrink-0 items-center text-xs leading-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                selected ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {id === 'write' ? t('Write') : t('Preview')}
              {selected ? <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-interactive-selection" /> : null}
            </button>
          );
        })}
      </div>
      {tab === 'write' ? (
        <textarea
          ref={fieldRef}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={4}
          placeholder={t('Add a description (markdown supported)')}
          aria-label={t('Pull request description')}
          onKeyDown={handleModEnter}
          className="min-h-20 w-full resize-none overflow-y-auto rounded-md border border-border bg-[var(--surface-elevated)] p-2 typography-ui text-foreground placeholder:text-muted-foreground"
        />
      ) : (
        <div className="min-h-20 w-full min-w-0">
          {body.trim() ? (
            <GitHubMarkdownBody markdown={body} />
          ) : (
            <p className="typography-micro text-muted-foreground">{t('Nothing to preview')}</p>
          )}
        </div>
      )}
      {submitError ? (
        <div
          role="alert"
          className="flex items-start gap-1.5 rounded-md border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-2 py-1.5 text-foreground"
        >
          <Icon name="error-warning" className="size-4 shrink-0 text-[var(--status-error)]" aria-hidden="true" />
          <p className="min-w-0 flex-1 typography-micro">{submitError}</p>
        </div>
      ) : null}
      <div className="flex items-center gap-1.5">
        <span className="flex-1" />
        <span role="group" aria-label={t('Create pull request options')} className="inline-flex shrink-0 items-center gap-1">
          <Button type="button" variant="default" size="sm" onClick={() => void handleCreate()} disabled={busy}>
            {pushing ? t('Pushing…') : busy ? t('Creating…') : t(createPrSubmitLabel(mode))}
          </Button>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="default"
                size="sm"
                className="shrink-0 px-1.5"
                title={t('Create options')}
                aria-label={t('Create options')}
                disabled={busy}
              >
                <Icon name="arrow-down-s" className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuRadioGroup
                value={mode}
                onValueChange={(value) => setMode(value as CreatePrMode)}
              >
                {CREATE_PR_MODES.map((option) => (
                  <DropdownMenuRadioItem key={option.id} value={option.id}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{t(option.label)}</span>
                      <span className="truncate typography-micro text-muted-foreground">{t(option.description)}</span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
    </section>
  );
};
