import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type {
  GitHubAPI,
  GitHubCapabilities,
  GitHubErrorBody,
  GitHubIssue,
  GitHubIssueSummary,
  GitHubIssueComment,
  GitHubLinkedPullRequest,
  GitHubViewerPermission,
} from '@/lib/api/types';
import { openExternalUrl } from '@/lib/url';
import { toast } from '@/components/ui';
import { useGitHubIssuesStore } from '@/stores/useGitHubIssuesStore';
import { useGitHubScope } from '@/stores/useGitHubScopeStore';
import { openPullRequestInSurface } from '../openPullRequestInSurface';
import {
  GitHubAvatar,
  GitHubBotCommentGroup,
  GitHubCommentOrderToggle,
  GitHubDetailHeader,
  GitHubDetailScaffold,
  GitHubDetailSkeleton,
  GitHubLabelChip,
  GitHubMarkdownBody,
  GitHubMetaRow,
  GitHubSection,
  GitHubStateGlyph,
  GitHubStatePill,
  GitHubThreadComment,
  useCopyGitHubLink,
  useHeaderRepoName,
  formatGitHubRelativeTime,
  gitHubStateTintClass,
} from '../GitHubDetailScaffold';
import { GitHubRow } from '../GitHubRow';
import { GitHubCenteredState, GitHubLoadMore } from '../GitHubListPrimitives';
import { GitHubCommentForm } from '../GitHubCommentForm';
import { GitHubConfirmActionButton } from '../GitHubConfirmActionButton';
import {
  CLOSE_REASON_OPTIONS,
  buildIssueStatePatch,
  gateIssueAction,
  issueStateConfirmCopy,
  type IssueCloseReason,
} from './issueLogic';
import { isAuthorLogin, type ViewerAccess } from '../githubPermissions';
import { isBotLogin, shortRepoRef } from '../githubBody';
import { GitHubAssigneePicker, GitHubLabelPicker, useRepoMeta } from '../GitHubMetaPickers';
import { StartSessionDialog } from './StartSessionDialog';
import { useDebouncedCommentDraft, useGitHubPendingReviewStore } from '@/stores/github/useGitHubPendingReviewStore';
import { useCommentWithFollowUp } from '../useCommentWithFollowUp';
import { useStartSessionFromGitHubItem } from '../agent/useStartSessionFromGitHubItem';
import {
  createInputStoreGitHubComposerActions,
  insertGitHubContextIntoComposer,
} from '../agent/githubLink';

/**
 * Issue detail: header (back + `#N ↗` + state pill, title, author/opened
 * meta), a wrapping action row below it (Close with a completed/not-planned
 * split menu / Reopen via anchored confirm popovers, Ask agent, Open on
 * GitHub, overflow menu), then MetaRows, Description, and Comments cards
 * with the inline comment form at the end — the same language as the
 * pull-request detail.
 *
 * Actions the viewer lacks permission for are disabled with the reason
 * (merge-style push gating, with the author exception for close/reopen and
 * title/body edits; comments need read access). When permission resolution
 * failed, controls stay enabled and the single attempt reports the error.
 *
 * Single Summary content (no tabs): MetaRows for Assignees/Labels/Milestone/
 * Linked PRs (linked PRs as flat rows, the same row component as the lists),
 * then Description and Comments sections. Comment cards sit directly on the
 * tab background. Bot comments collapse into one group toggle; very long
 * bodies collapse behind a "Show more" fade.
 */

/** `author · opened 3h ago · updated 5m ago` line (updated omitted when it matches opened). */
const IssueHeaderMeta: React.FC<{ issue: GitHubIssueSummary }> = ({ issue }) => {
  const { t } = useTranslation();
  return (
  <>
    <span className="inline-flex items-center gap-1">
      <GitHubAvatar login={issue.author?.login} avatarUrl={issue.author?.avatarUrl} size="xs" />
      {issue.author?.login ?? 'ghost'}
    </span>
    {issue.createdAt ? ` · ${t('opened {{time}}', { time: formatGitHubRelativeTime(issue.createdAt) })}` : ''}
    {issue.updatedAt && issue.updatedAt !== issue.createdAt
      ? ` · ${t('updated {{time}}', { time: formatGitHubRelativeTime(issue.updatedAt) })}`
      : ''}
  </>
  );
};

/**
 * Visible action row below the header (wraps on narrow widths): split Close
 * issue (completed / not planned reason menu) or Reopen, Ask agent, Open on
 * GitHub, and a trailing overflow menu. State changes confirm via a small
 * popover anchored to the button; every gated action carries its disabled
 * reason via `title`.
 */
const IssueActionBar: React.FC<{
  number: number;
  closed: boolean;
  closeReason: IssueCloseReason;
  onCloseReasonChange: (reason: IssueCloseReason) => void;
  closeAllowed: boolean;
  closeReasonText: string | null;
  reopenAllowed: boolean;
  reopenReasonText: string | null;
  acting: boolean;
  onStateAction: (action: 'close-completed' | 'close-not-planned' | 'reopen') => Promise<boolean>;
  askSending: boolean;
  onAskAgent: () => void;
  onEditTitle: () => void;
  editAllowed: boolean;
  editReasonText: string | null;
  onCopyLink: () => void;
  url: string;
}> = ({
  number,
  closed,
  closeReason,
  onCloseReasonChange,
  closeAllowed,
  closeReasonText,
  reopenAllowed,
  reopenReasonText,
  acting,
  onStateAction,
  askSending,
  onAskAgent,
  onEditTitle,
  editAllowed,
  editReasonText,
  onCopyLink,
  url,
}) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pt-1 pb-2" aria-label={t("Issue actions")}>
      {closed ? (
        <GitHubConfirmActionButton
          copy={issueStateConfirmCopy('reopen', number)}
          busy={acting}
          variant="outline"
          disabled={!reopenAllowed}
          disabledReason={reopenReasonText ?? t('Reopen issue')}
          label={t("Reopen issue")}
          icon={<Icon name="history" className="size-3.5" aria-hidden="true" />}
          onConfirm={() => {
            void onStateAction('reopen');
          }}
        />
      ) : (
        <span role="group" aria-label={t("Close issue")} className="inline-flex shrink-0 items-center gap-1">
          <GitHubConfirmActionButton
            copy={issueStateConfirmCopy(
              closeReason === 'not_planned' ? 'close-not-planned' : 'close-completed',
              number,
            )}
            busy={acting}
            destructive
            variant="outline"
            disabled={!closeAllowed}
            disabledReason={closeReasonText ?? t('Close issue')}
            label={t("Close issue")}
            icon={<Icon name="close" className="size-3.5" aria-hidden="true" />}
            onConfirm={() => {
              void onStateAction(closeReason === 'not_planned' ? 'close-not-planned' : 'close-completed');
            }}
          />
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0 px-1.5"
                title={t("Close options")}
                aria-label={t("Close options")}
                disabled={!closeAllowed || acting}
              >
                <Icon name="arrow-down-s" className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
              <DropdownMenuRadioGroup
                value={closeReason}
                onValueChange={(value) => onCloseReasonChange(value as IssueCloseReason)}
              >
                {CLOSE_REASON_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem key={option.id} value={option.id}>
                    {option.id === 'completed' ? t('Close as completed') : t('Close as not planned')}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="shrink-0"
        onClick={onAskAgent}
        disabled={askSending}
        title={t("Send issue context to the agent composer")}
        aria-label={t("Ask agent about this issue")}
      >
        <Icon name="send-plane-2" className="size-3.5" aria-hidden="true" />
        {askSending ? t('Asking…') : t('Ask agent')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="shrink-0"
        onClick={() => void openExternalUrl(url)}
        title={t("Open on GitHub")}
        aria-label={t("Open on GitHub")}
      >
        <Icon name="external-link" className="size-3.5" aria-hidden="true" />
        {t('Open on GitHub')}
      </Button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="xs" className="shrink-0 px-1.5" aria-label={t("More issue actions")} title={t("More issue actions")}>
            <Icon name="more-2" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onClick={onEditTitle} disabled={!editAllowed} title={editReasonText ?? t('Edit title')}>
            <Icon name="pencil" className="size-3.5" />
            {t('Edit title')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void openExternalUrl(url)}>
            <Icon name="external-link" className="size-3.5" />
            {t('Open on GitHub')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onCopyLink}>
            <Icon name="file-copy" className="size-3.5" />
            {t('Copy link')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

export const IssueDetail: React.FC<{
  directory: string;
  repo: string;
  number: number;
  github: GitHubAPI;
  issue: GitHubIssue | null;
  /** List row for this issue, if loaded: renders the header while the detail read is in flight. */
  seed?: GitHubIssueSummary | null;
  detailError: GitHubErrorBody | null;
  detailStale: boolean;
  detailLoading: boolean;
  comments: GitHubIssueComment[];
  commentsHasMore: boolean;
  commentsLoading: boolean;
  onLoadMoreComments: () => void;
  onBack: () => void;
  onRetryDetail: () => void;
  onRetryComments: () => void;
  linkedPullRequests?: GitHubLinkedPullRequest[];
  linkedPullRequestsError?: GitHubErrorBody | null;
  capabilities?: GitHubCapabilities | null;
  viewerLogin?: string | null;
  viewerPermission?: GitHubViewerPermission | null;
}> = (props) => {
  const { directory, repo, number, github, issue } = props;
  const { t } = useTranslation();
  const updateIssue = useGitHubIssuesStore((state) => state.updateIssue);
  const addComment = useGitHubIssuesStore((state) => state.addComment);
  const actionError = useGitHubIssuesStore((state) => state.actionErrorByDetail[`${repo}#${number}`] ?? null);
  const acting = useGitHubIssuesStore((state) => state.actingActions[`${repo}#${number}`] ?? false);
  const { start: startSession, startingKey } = useStartSessionFromGitHubItem();
  const headerRepoName = useHeaderRepoName(directory, repo);

  const [closeReason, setCloseReason] = React.useState<IssueCloseReason>('completed');
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState('');
  const [editingBody, setEditingBody] = React.useState(false);
  const [bodyDraft, setBodyDraft] = React.useState('');
  const [editingMeta, setEditingMeta] = React.useState(false);
  const [labelDraft, setLabelDraft] = React.useState<string[]>([]);
  const [assigneeDraft, setAssigneeDraft] = React.useState<string[]>([]);
  // Unposted comment text survives leaving and reopening the issue: keystrokes
  // stay local and persist debounced, like PR comments.
  const { draft: commentDraft, onDraftChange: onCommentDraftChange, flushDraft: flushCommentDraft } = useDebouncedCommentDraft(repo, number);
  const { busy: commentBusy, error: commentError, submit: submitIssueComment } = useCommentWithFollowUp({
    postComment: (body) => addComment(directory, repo, number, body, github),
    runFollowUp: (followUp) => updateIssue(directory, repo, number, buildIssueStatePatch(
      followUp === 'reopen' ? 'reopen' : closeReason === 'not_planned' ? 'close-not-planned' : 'close-completed',
    ), github),
    verbs: { close: t('close'), reopen: t('reopen') },
    doneLabels: { close: t('Closed with comment'), reopen: t('Reopened with comment') },
    afterPost: () => {
      onCommentDraftChange('');
      useGitHubPendingReviewStore.getState().clearCommentDraft(repo, number);
    },
  });
  const [commentOrder, setCommentOrder] = React.useState<'newest' | 'oldest'>('newest');
  const [startOpen, setStartOpen] = React.useState(false);
  const [sending, setSending] = React.useState(false);

  // Permission gating: server capabilities plus the author exception (GitHub
  // lets authors edit/close/reopen their own issues). On fallback every
  // action stays enabled and the single attempt reports the server error.
  const access: ViewerAccess = React.useMemo(
    () => ({
      capabilities: props.capabilities ?? null,
      isAuthor: isAuthorLogin(issue?.author?.login, props.viewerLogin),
      permissionFallback: props.viewerPermission?.fallback === true,
    }),
    [props.capabilities, props.viewerLogin, props.viewerPermission?.fallback, issue?.author?.login],
  );
  const stateGate = gateIssueAction(issue?.state === 'closed' ? 'reopen' : 'close', issue, access);
  const editGate = gateIssueAction('edit', issue, access);
  const labelsGate = gateIssueAction('labels', issue, access);
  const commentGate = gateIssueAction('comment', issue, access);

  // Repositories in scope for the linked-PR handoff: a linked PR whose repo
  // is in scope opens in the Pull requests surface, otherwise on GitHub.
  const scopeEntry = useGitHubScope(directory);
  const inScopeRefs = React.useMemo(() => {
    const refs = new Set<string>();
    for (const entry of scopeEntry.scope?.repositories ?? []) {
      if (entry.host && entry.owner && entry.repo) {
        refs.add(`${entry.host}/${entry.owner}/${entry.repo}`.toLowerCase());
      }
    }
    refs.add(repo.toLowerCase());
    return refs;
  }, [scopeEntry.scope, repo]);

  const openLinkedPullRequest = React.useCallback(
    (linked: GitHubLinkedPullRequest) => {
      if (inScopeRefs.has(linked.repoRef.toLowerCase())) {
        openPullRequestInSurface(directory, linked.repoRef, linked.number);
      } else {
        void openExternalUrl(linked.url);
      }
    },
    [directory, inScopeRefs],
  );

  // Label/assignee candidates for the pickers (shared fetch; empty on failure).
  const { labels: metaLabels, assignees: metaAssignees, loading: metaLoading } = useRepoMeta(directory, repo, github);

  const openEditor = (kind: 'title' | 'body' | 'meta') => {
    if (!issue) return;
    if (kind === 'title') {
      setTitleDraft(issue.title);
      setEditingTitle(true);
    } else if (kind === 'body') {
      setBodyDraft(issue.body ?? '');
      setEditingBody(true);
    } else {
      setLabelDraft((issue.labels ?? []).map((label) => label.name));
      setAssigneeDraft((issue.assignees ?? []).map((user) => user.login).filter(Boolean) as string[]);
      setEditingMeta(true);
    }
  };

  const runUpdate = React.useCallback(
    async (patch: { title?: string; body?: string; labels?: string[]; assignees?: string[] }) => {
      const result = await updateIssue(directory, repo, number, patch, github);
      if (!result.ok) {
        toast.error(result.error?.kind === 'failed' ? result.error.message : t('Update failed'));
        return false;
      }
      setEditingTitle(false);
      setEditingBody(false);
      setEditingMeta(false);
      return true;
    },
    [updateIssue, directory, repo, number, github, t],
  );

  const runStateAction = React.useCallback(
    async (action: 'close-completed' | 'close-not-planned' | 'reopen') => {
      const patch = buildIssueStatePatch(action);
      const result = await updateIssue(directory, repo, number, patch, github);
      if (!result.ok) {
        toast.error(result.error?.kind === 'failed' ? result.error.message : t('State change failed'));
        return false;
      }
      return true;
    },
    [updateIssue, directory, repo, number, github, t],
  );

  const handleCopyLink = useCopyGitHubLink(issue?.url);

  const handleSendToAgent = React.useCallback(async () => {
    if (!issue || sending) return;
    setSending(true);
    try {
      const context = await github.agentContext(directory, repo, 'issue', number);
      insertGitHubContextIntoComposer(
        { kind: 'issue', number, title: issue.title, url: issue.url, contextText: context.text },
        createInputStoreGitHubComposerActions(),
      );
      toast.success(t('Added to composer'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('Failed to fetch GitHub context'));
    } finally {
      setSending(false);
    }
  }, [issue, sending, github, directory, repo, number, t]);

  const orderedComments = React.useMemo(() => {
    const copy = [...props.comments];
    // The comments endpoint returns oldest-first pages; the toggle only
    // changes display order, never refetches.
    if (commentOrder === 'newest') copy.reverse();
    return copy;
  }, [props.comments, commentOrder]);

  const humanComments = React.useMemo(
    () => orderedComments.filter((comment) => !isBotLogin(comment.author?.login)),
    [orderedComments],
  );
  const botComments = React.useMemo(
    () => orderedComments.filter((comment) => isBotLogin(comment.author?.login)),
    [orderedComments],
  );

  const closed = issue?.state === 'closed';
  const starting = startingKey !== null;

  // Header fields come from the authoritative issue once read, else from the
  // list row the user opened; actions stay gated on the real read.
  const headerIssue: GitHubIssueSummary | null =
    issue ?? (props.seed && props.seed.number === number ? props.seed : null);

  const header = (
    <>
      <GitHubDetailHeader
        onBack={props.onBack}
        backLabel={t("Back to issues")}
        repoName={headerRepoName}
        number={number}
        url={headerIssue?.url}
        numberTintClass={gitHubStateTintClass('issue', headerIssue?.state ?? 'open', false, issue?.stateReason)}
        statePill={
          headerIssue ? (
            <GitHubStatePill kind="issue" state={headerIssue.state} stateReason={issue?.stateReason} />
          ) : undefined
        }
        openLabel={t('Open issue #{{number}} on GitHub', { number })}
        title={headerIssue?.title ?? null}
        onEditTitle={issue ? () => openEditor('title') : undefined}
        editTitleLabel={t("Edit issue title")}
        editTitleDisabledReason={editGate.allowed ? null : editGate.reason}
        meta={headerIssue ? <IssueHeaderMeta issue={headerIssue} /> : undefined}
        primary={
          issue ? (
            <Button
              type="button"
              variant="default"
              size="xs"
              onClick={() => setStartOpen(true)}
              disabled={starting}
              aria-label={t("Start session from issue")}
            >
              <Icon name="add-circle" className="size-3.5" />
              {t('Start session')}
            </Button>
          ) : undefined
        }
      />
      {issue ? (
        <IssueActionBar
          number={number}
          closed={closed}
          closeReason={closeReason}
          onCloseReasonChange={setCloseReason}
          closeAllowed={issue.state !== 'closed' ? stateGate.allowed : false}
          closeReasonText={issue.state !== 'closed' ? stateGate.reason : t('Already closed')}
          reopenAllowed={issue.state === 'closed' ? stateGate.allowed : false}
          reopenReasonText={issue.state === 'closed' ? stateGate.reason : t('Already open')}
          acting={acting}
          onStateAction={(action) => runStateAction(action)}
          askSending={sending}
          onAskAgent={() => void handleSendToAgent()}
          onEditTitle={() => openEditor('title')}
          editAllowed={editGate.allowed}
          editReasonText={editGate.reason}
          onCopyLink={handleCopyLink}
          url={issue.url}
        />
      ) : null}
    </>
  );

  if (!issue && props.detailError) {
    return (
      <GitHubDetailScaffold header={header} tabs={[]} activeTab="" onTabChange={() => {}}>
        <GitHubCenteredState
          icon="error-warning"
          title={t("Could not load this issue")}
          action={
            <Button type="button" variant="outline" size="sm" onClick={props.onRetryDetail} disabled={props.detailLoading}>
              {t('Retry')}
            </Button>
          }
        />
      </GitHubDetailScaffold>
    );
  }

  if (!issue) {
    return (
      <GitHubDetailScaffold header={header} tabs={[]} activeTab="" onTabChange={() => {}}>
        {/* No error and no issue yet means the read is still pending. */}
        <GitHubDetailSkeleton label={t("Loading issue")} />
      </GitHubDetailScaffold>
    );
  }

  const followUpAction = closed ? ('reopen' as const) : ('close' as const);

  return (
    <GitHubDetailScaffold header={header} tabs={[]} activeTab="" onTabChange={() => {}}>
      <div className="flex flex-col gap-1 px-3 py-2">
        {props.detailStale ? (
          <p className="typography-micro text-muted-foreground" role="note">
            {t('Showing saved issue — last refresh failed.')}{' '}
            <button type="button" className="underline" onClick={props.onRetryDetail}>{t('Retry')}</button>
          </p>
        ) : null}
        {actionError ? (
          <p
            className="flex items-start gap-2 rounded-md border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-3 py-2 typography-micro text-foreground"
            role="alert"
          >
            <Icon name="error-warning" className="size-4 shrink-0 text-[var(--status-error)]" aria-hidden="true" />
            <span className="min-w-0">
              {actionError.kind === 'failed' ? actionError.message : t('Action failed')}
            </span>
          </p>
        ) : null}
        {access.permissionFallback ? (
          <p className="typography-micro text-muted-foreground" role="note">
            {t('Permissions could not be loaded — actions stay enabled and any failure will be shown after you act.')}
          </p>
        ) : null}

        {editingTitle ? (
          <div className="flex min-w-0 flex-1 items-center gap-1 py-1">
            <Input
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              aria-label={t("Issue title")}
              className="h-7"
            />
            <Button type="button" variant="default" size="xs" onClick={() => void runUpdate({ title: titleDraft })} disabled={acting || !titleDraft.trim()}>
              {t('Save')}
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => setEditingTitle(false)} disabled={acting}>
              {t('Cancel')}
            </Button>
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5 py-1">
          <GitHubMetaRow icon="user" label={t("Assignees")}>
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              {(issue.assignees ?? []).length === 0 ? (
                <span className="typography-micro text-muted-foreground">{t('Unassigned')}</span>
              ) : (
                (issue.assignees ?? []).map((user) => (
                  <span key={user.login} className="inline-flex min-w-0 items-center gap-1 typography-micro text-muted-foreground">
                    <GitHubAvatar login={user.login} avatarUrl={user.avatarUrl} size="xs" />
                    <span className="truncate">{user.login}</span>
                  </span>
                ))
              )}
            </span>
          </GitHubMetaRow>
          <GitHubMetaRow icon="list-unordered" label={t("Labels")}>
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {(issue.labels ?? []).length === 0 ? (
                <span className="typography-micro text-muted-foreground">{t('None')}</span>
              ) : (
                (issue.labels ?? []).map((label) => (
                  <GitHubLabelChip key={label.name} name={label.name} color={label.color} />
                ))
              )}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => openEditor('meta')}
                aria-label={t("Edit labels and assignees")}
                title={labelsGate.reason ?? t('Edit labels and assignees')}
                disabled={!labelsGate.allowed}
              >
                {t('Edit')}
              </Button>
            </span>
          </GitHubMetaRow>
          {issue.milestone ? (
            <GitHubMetaRow icon="time" label={t("Milestone")}>
              <span className="truncate typography-micro text-muted-foreground">{issue.milestone.title}</span>
            </GitHubMetaRow>
          ) : null}
          <GitHubMetaRow icon="git-pull-request" label={t("Linked PRs")}>
            <span className="min-w-0 flex-1">
              {props.linkedPullRequestsError ? (
                <span className="flex items-center gap-2 typography-micro text-[var(--status-error)]" role="alert">
                  <span className="min-w-0 flex-1 truncate">{t('Linked pull requests failed to load')}</span>
                  <Button type="button" variant="outline" size="xs" onClick={props.onRetryDetail}>
                    {t('Retry')}
                  </Button>
                </span>
              ) : (props.linkedPullRequests ?? []).length === 0 ? (
                <span className="typography-micro text-muted-foreground">{t('None')}</span>
              ) : (
                <ul className="flex min-w-0 flex-col">
                  {(props.linkedPullRequests ?? []).map((linked) => {
                    const inScope = inScopeRefs.has(linked.repoRef.toLowerCase());
                    return (
                      <li key={`${linked.repoRef}#${linked.number}`}>
                        <GitHubRow
                          glyph={<GitHubStateGlyph kind="pr" state={linked.state} draft={linked.draft} />}
                          number={`#${linked.number}`}
                          title={linked.title || t('(no title)')}
                          meta={
                            <span className="truncate">
                              {shortRepoRef(linked.repoRef)}
                              {inScope ? '' : ' · GitHub'}
                            </span>
                          }
                          onOpen={() => openLinkedPullRequest(linked)}
                          ariaLabel={t('Open linked pull request #{{number}}: {{title}}', { number: linked.number, title: linked.title })}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            </span>
          </GitHubMetaRow>
          {editingMeta ? (
            <div className="flex flex-col gap-2 py-1">
              <p className="typography-micro font-medium text-muted-foreground">{t('Labels')}</p>
              <GitHubLabelPicker candidates={metaLabels} loading={metaLoading} selected={labelDraft} onChange={setLabelDraft} />
              <p className="typography-micro font-medium text-muted-foreground">{t('Assignees')}</p>
              <GitHubAssigneePicker candidates={metaAssignees} loading={metaLoading} selected={assigneeDraft} onChange={setAssigneeDraft} />
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void runUpdate({ labels: labelDraft, assignees: assigneeDraft })}
                  disabled={acting}
                >
                  {t('Save')}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setEditingMeta(false)} disabled={acting}>
                  {t('Cancel')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <GitHubSection
          id={`issue-${number}-description`}
          title={t("Description")}
          action={
            !editingBody ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => openEditor('body')}
                aria-label={t("Edit issue body")}
                title={editGate.reason ?? t('Edit issue body')}
                disabled={!editGate.allowed}
              >
                {t('Edit')}
              </Button>
            ) : undefined
          }
        >
          {editingBody ? (
            <div className="flex flex-col gap-2">
              <Textarea value={bodyDraft} onChange={(event) => setBodyDraft(event.target.value)} aria-label={t("Issue body")} rows={6} />
              <div className="flex gap-2">
                <Button type="button" size="sm" onClick={() => void runUpdate({ body: bodyDraft })} disabled={acting}>
                  {t('Save')}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setEditingBody(false)} disabled={acting}>
                  {t('Cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <GitHubMarkdownBody markdown={issue.body ?? ''} html={issue.bodyHtml ?? null} fallbackUrl={issue.url} />
              {!issue.body?.trim() ? <p className="typography-micro text-muted-foreground">{t('No description.')}</p> : null}
            </>
          )}
        </GitHubSection>

        <GitHubSection
          id={`issue-${number}-comments`}
          title={`${t('Comments')}${orderedComments.length ? ` (${orderedComments.length})` : ''}`}
          action={
            <GitHubCommentOrderToggle order={commentOrder} onToggle={() => setCommentOrder((order) => (order === 'newest' ? 'oldest' : 'newest'))} />
          }
        >
          <div className="flex flex-col gap-2">
            {orderedComments.length === 0 && !props.commentsLoading ? (
              <p className="typography-micro text-muted-foreground">{t('No comments yet.')}</p>
            ) : (
              humanComments.map((comment) => (
                <GitHubThreadComment key={comment.id} comment={comment} />
              ))
            )}
            <GitHubBotCommentGroup comments={botComments} />
            {props.commentsLoading && orderedComments.length === 0 ? (
              <p className="typography-micro text-muted-foreground">{t('Loading comments…')}</p>
            ) : null}
            <GitHubLoadMore hasMore={props.commentsHasMore} isLoading={props.commentsLoading} onLoadMore={props.onLoadMoreComments} label={t("Load older comments")} />
            {commentGate.allowed ? (
              <GitHubCommentForm
                draft={commentDraft}
                onDraftChange={onCommentDraftChange}
                onDraftBlur={flushCommentDraft}
                ariaLabel={t('Leave a comment on issue #{{number}}', { number })}
                busy={commentBusy}
                error={commentError}
                disabledReason={commentGate.reason}
                followUp={{
                  id: followUpAction,
                  label: followUpAction === 'close' ? t('Close with comment') : t('Reopen with comment'),
                  busyLabel: followUpAction === 'close' ? t('Closing…') : t('Reopening…'),
                  onRun: () => void submitIssueComment(followUpAction, commentDraft),
                  allowed: stateGate.allowed,
                  reason: stateGate.reason,
                }}
                onSubmitComment={() => void submitIssueComment('comment', commentDraft)}
              />
            ) : null}
          </div>
        </GitHubSection>
      </div>

      {issue ? (
        <StartSessionDialog
          open={startOpen}
          onOpenChange={setStartOpen}
          issueNumber={number}
          issueTitle={issue.title}
          busy={starting}
          onChoose={(target) => {
            setStartOpen(false);
            void startSession({ directory, repo, number, kind: 'issue', title: issue.title, url: issue.url, target });
          }}
        />
      ) : null}
    </GitHubDetailScaffold>
  );
};
