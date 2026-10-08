import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { openExternalUrl } from '@/lib/url';
import type {
  GitHubAPI,
  GitHubChecksResult,
  GitHubErrorBody,
  GitHubIssueComment,
  GitHubPullRequestAction,
  GitHubPullRequestDetail,
  GitHubPullRequestDetailResult,
  GitHubPullRequestFilesResult,
  GitHubPullRequestSummary,
  GitHubReview,
  GitHubReviewThread,
} from '@/lib/api/types';
import {
  GitHubAvatar,
  GitHubBotCommentGroup,
  GitHubChecksGlyph,
  GitHubCollapsibleBody,
  GitHubCommentOrderToggle,
  GitHubDetailHeader,
  GitHubDetailScaffold,
  GitHubDetailSkeleton,
  GitHubDiffStat,
  GitHubLabelChip,
  GitHubMetaRow,
  GitHubSection,
  GitHubStatePill,
  GitHubThreadComment,
  formatGitHubRelativeTime,
  gitHubStateTintClass,
  useCopyGitHubLink,
  useHeaderRepoName,
} from '../GitHubDetailScaffold';
import { GitHubConfirmActionButton } from '../GitHubConfirmActionButton';
import { isBotLogin } from '../githubBody';
import { refreshWorktreeTopology } from '../agent/refreshWorktreeTopology';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { GitHubUnavailableState, toUnavailableInfo } from '../GitHubUnavailableState';
import { useUIStore } from '@/stores/useUIStore';
import { useGitHubPullRequestsStore, readMergeMethod, type PullMergeMethod } from '@/stores/useGitHubPullRequestsStore';
import { useSendGitHubContextToComposer } from './useSendGitHubContextToComposer';
import { usePendingReviewCount } from '@/stores/github/useGitHubPendingReviewStore';
import { PullFilesTab } from './PullFilesTab';
import { PullChecksTab } from './PullChecksTab';
import { SectionError } from '../GitHubListPrimitives';
import { PullCommentForm, PullReviewControl } from './PullComposer';
import {
  PULL_MERGE_METHODS,
  describeBranchStatus,
  gatePullAction,
  gatePullEdit,
  isAuthorLogin,
  pullActionConfirmCopy,
  type ViewerAccess,
} from './pullLogic';

type PullHeaderSource = Pick<
  GitHubPullRequestSummary,
  'author' | 'updatedAt' | 'draft' | 'base' | 'head' | 'additions' | 'deletions'
>;

/** `author · updated 3h ago` line, shared by the seeded and loaded header. */
const PullHeaderMeta: React.FC<{ pr: PullHeaderSource }> = ({ pr }) => {
  const { t } = useTranslation();
  return (
  <>
    <span className="inline-flex items-center gap-1">
      <GitHubAvatar login={pr.author?.login} avatarUrl={pr.author?.avatarUrl} size="xs" />
      {pr.author?.login ?? 'ghost'}
    </span>
    {pr.updatedAt ? ` · ${t('updated {{time}}', { time: formatGitHubRelativeTime(pr.updatedAt) })}` : ''}
    {pr.draft ? ` · ${t('Draft')}` : ''}
  </>
  );
};

/** `base ← head` + files count + colored diff stat. A null count is unknown and hidden. */
const PullHeaderBranches: React.FC<{ pr: PullHeaderSource; filesCount: number | null }> = ({ pr, filesCount }) => {
  const { t } = useTranslation();
  return (
  <>
    <code className="shrink-0 truncate" title={pr.base}>{pr.base}</code>
    <span className="shrink-0" aria-label={t("receives changes from")}>←</span>
    <code className="min-w-0 flex-1 truncate" title={pr.head}>{pr.head}</code>
    {typeof filesCount === 'number' ? (
      <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
        <Icon name="file-code" className="size-3 shrink-0" aria-hidden="true" />
        {filesCount} {filesCount === 1 ? t('file') : t('files')}
      </span>
    ) : null}
    <GitHubDiffStat additions={pr.additions} deletions={pr.deletions} />
  </>
  );
};


/**
 * Visible action row below the header (wraps on narrow widths): split merge
 * button with a merge-method radio menu, Ready for review / Convert to
 * draft, Close / Reopen, Check out, Ask agent,
 * Review on GitHub, and a trailing overflow menu for the quieter items.
 * (Update branch lives in the branch-status strip below this row.)
 * Every gated action carries its disabled reason via `title`.
 */
const PullActionBar: React.FC<{
  directory: string;
  repo: string;
  number: number;
  github: GitHubAPI;
  pr: GitHubPullRequestDetail;
  access: ViewerAccess;
  acting: boolean;
  mergeMethod: PullMergeMethod;
  onMergeMethodChange: (method: PullMergeMethod) => void;
  onRun: (action: GitHubPullRequestAction) => void;
  checkingOut: boolean;
  onCheckout: (mode: 'worktree' | 'current') => void;
  onCopyLink: () => void;
  askSending: boolean;
  onAskAgent: () => void;
}> = ({
  repo,
  pr,
  access,
  acting,
  mergeMethod,
  onMergeMethodChange,
  onRun,
  checkingOut,
  onCheckout,
  onCopyLink,
  askSending,
  onAskAgent,
}) => {
  const { t } = useTranslation();
  const setMergeMethod = useGitHubPullRequestsStore((state) => state.setMergeMethod);
  const isOpen = pr.state === 'open';
  // The persisted method may be disallowed for this repo; fall back to the
  // first allowed one so the user can still merge another way.
  const allowedMergeMethods = PULL_MERGE_METHODS.filter((option) => gatePullAction(option.id, pr, access).allowed);
  const effectiveMergeMethod = allowedMergeMethods.some((option) => option.id === mergeMethod)
    ? mergeMethod
    : (allowedMergeMethods[0]?.id ?? mergeMethod);
  const mergeGate = gatePullAction(effectiveMergeMethod, pr, access);
  const readyGate = gatePullAction('ready', pr, access);
  const draftGate = gatePullAction('draft', pr, access);
  const closeGate = gatePullAction('close', pr, access);
  const reopenGate = gatePullAction('reopen', pr, access);
  const selectedMerge = PULL_MERGE_METHODS.find((option) => option.id === effectiveMergeMethod) ?? PULL_MERGE_METHODS[0];
  // The options trigger stays usable while any method is allowed.
  const mergeMenuDisabled = allowedMergeMethods.length === 0 || acting;

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pt-1 pb-2" aria-label={t("Pull request actions")}>
      {isOpen && !pr.draft ? (
        <span role="group" aria-label={t("Merge pull request")} className="inline-flex shrink-0 items-center gap-1">
          <GitHubConfirmActionButton
            copy={pullActionConfirmCopy(effectiveMergeMethod, pr.base, pr.head)}
            busy={acting}
            disabled={!mergeGate.allowed}
            disabledReason={mergeGate.reason ?? t('Merge via {{method}}', { method: t(selectedMerge.label) })}
            label={effectiveMergeMethod === 'merge' ? t('Merge pull request') : t(selectedMerge.label)}
            icon={<Icon name="git-merge" className="size-3.5" aria-hidden="true" />}
            onConfirm={() => onRun(effectiveMergeMethod)}
          />
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="default"
                size="xs"
                className="shrink-0 px-1.5"
                title={t("Merge options")}
                aria-label={t("Merge options")}
                disabled={mergeMenuDisabled}
              >
                <Icon name="arrow-down-s" className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuRadioGroup
                value={effectiveMergeMethod}
                onValueChange={(value) => {
                  const method = value as PullMergeMethod;
                  onMergeMethodChange(method);
                  setMergeMethod(repo, method);
                }}
              >
                {PULL_MERGE_METHODS.map((option) => {
                  const gate = gatePullAction(option.id, pr, access);
                  return (
                    <DropdownMenuRadioItem key={option.id} value={option.id} disabled={!gate.allowed} title={gate.reason ?? t(option.description)}>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{t(option.label)}</span>
                        <span className="truncate typography-micro text-muted-foreground">{t(option.description)}</span>
                      </span>
                    </DropdownMenuRadioItem>
                  );
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      ) : null}
      {isOpen && pr.draft ? (
        <GitHubConfirmActionButton
          copy={pullActionConfirmCopy('ready', pr.base, pr.head)}
          busy={acting}
          disabled={!readyGate.allowed}
          disabledReason={readyGate.reason ?? t('Ready for review')}
          label={t("Ready for review")}
          icon={<Icon name="git-pull-request" className="size-3.5" aria-hidden="true" />}
          onConfirm={() => onRun('ready')}
        />
      ) : null}
      {isOpen && !pr.draft ? (
        <GitHubConfirmActionButton
          copy={pullActionConfirmCopy('draft', pr.base, pr.head)}
          busy={acting}
          variant="outline"
          disabled={!draftGate.allowed}
          disabledReason={draftGate.reason ?? t('Convert to draft')}
          label={t("Convert to draft")}
          icon={<Icon name="pencil" className="size-3.5" aria-hidden="true" />}
          onConfirm={() => onRun('draft')}
        />
      ) : null}
      {isOpen ? (
        <GitHubConfirmActionButton
          copy={pullActionConfirmCopy('close', pr.base, pr.head)}
          busy={acting}
          destructive
          variant="outline"
          disabled={!closeGate.allowed}
          disabledReason={closeGate.reason ?? t('Close pull request')}
          label={t("Close")}
          icon={<Icon name="close" className="size-3.5" aria-hidden="true" />}
          onConfirm={() => onRun('close')}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="shrink-0"
          onClick={() => onRun('reopen')}
          disabled={!reopenGate.allowed || acting}
          title={reopenGate.reason ?? t('Reopen pull request')}
          aria-label={t("Reopen pull request")}
        >
          <Icon name="history" className="size-3.5" aria-hidden="true" />
          {t('Reopen')}
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="shrink-0"
        onClick={() => onCheckout('worktree')}
        disabled={checkingOut}
        title={t("Check out in a new worktree")}
        aria-label={t("Check out in a new worktree")}
      >
        <Icon name="git-branch" className="size-3.5" aria-hidden="true" />
        {checkingOut ? t('Checking out…') : t('Check out')}
      </Button>
      <GitHubConfirmActionButton
        copy={{
          title: t('Check out this branch here?'),
          detail: t('This switches your current checkout to the PR branch. Uncommitted work may be disrupted.'),
          confirm: t('Check out here'),
          progress: t('Checking out…'),
        }}
        busy={checkingOut}
        variant="outline"
        label={t("Check out here")}
        icon={<Icon name="git-branch" className="size-3.5" aria-hidden="true" />}
        onConfirm={() => onCheckout('current')}
      />
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="shrink-0"
        onClick={onAskAgent}
        disabled={askSending}
        title={t("Send pull request context to the agent composer")}
        aria-label={t("Ask agent about this pull request")}
      >
        <Icon name="send-plane-2" className="size-3.5" aria-hidden="true" />
        {askSending ? t('Asking…') : t('Ask agent')}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="shrink-0"
        onClick={() => void openExternalUrl(pr.url)}
        title={t("Review on GitHub")}
        aria-label={t("Review on GitHub")}
      >
        <Icon name="external-link" className="size-3.5" aria-hidden="true" />
        {t('Review on GitHub')}
      </Button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="xs" className="shrink-0 px-1.5" aria-label={t("More pull request actions")} title={t("More pull request actions")}>
            <Icon name="more-2" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuItem onClick={() => void openExternalUrl(pr.url)}>
            <Icon name="external-link" className="size-3.5" />
            {t('Open on GitHub')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onCopyLink}>
            <Icon name="file-copy" className="size-3.5" />
            {t('Copy link')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onCheckout('worktree')} disabled={checkingOut}>
            <Icon name="git-branch" className="size-3.5" />
            {t('Check out in new worktree')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

/**
 * Inline branch-status strip below the action row (never in the title
 * block): `behind` offers the update-branch confirm action, `dirty`
 * (merge conflicts) offers a Resolve on GitHub link instead. Wraps cleanly
 * at narrow widths via `flex-wrap`.
 */
const BranchStatusStrip: React.FC<{
  pr: GitHubPullRequestDetail;
  access: ViewerAccess;
  acting: boolean;
  onRun: (action: GitHubPullRequestAction) => void;
}> = ({ pr, access, acting, onRun }) => {
  const { t } = useTranslation();
  const status = describeBranchStatus(pr);
  if (!status) return null;
  const updateGate = gatePullAction('update-branch', pr, access);
  // Tinted surface with normal text: `--status-*-foreground` is the ink for
  // a solid status fill and turns near-black on the tinted background in many
  // themes. The status color marks only the icon.
  const toneClass =
    status.tone === 'error'
      ? 'border-[var(--status-error-border)] bg-[var(--status-error-background)] text-foreground'
      : 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)] text-foreground';
  const iconClass = status.tone === 'error' ? 'text-[var(--status-error)]' : 'text-[var(--status-warning)]';
  return (
    <div
      className={`mx-3 mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border px-2.5 py-2 ${toneClass}`}
      role="status"
    >
      <Icon name={status.icon} className={`size-4 shrink-0 ${iconClass}`} aria-hidden="true" />
      <p className="min-w-0 flex-1 basis-48">
        <span className="typography-ui-label font-medium">
          {status.title} <code className="font-mono">{pr.base}</code>
        </span>
        <span className="block typography-micro text-muted-foreground">{status.detail}</span>
      </p>
      {status.canUpdate ? (
        <GitHubConfirmActionButton
          copy={pullActionConfirmCopy('update-branch', pr.base, pr.head)}
          busy={acting}
          variant="outline"
          disabled={!updateGate.allowed}
          disabledReason={updateGate.reason ?? t('Update branch')}
          label={t("Update branch")}
          icon={<Icon name="refresh" className="size-3.5" aria-hidden="true" />}
          onConfirm={() => onRun('update-branch')}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="shrink-0"
          onClick={() => void openExternalUrl(pr.url)}
          title={t("Resolve conflicts on GitHub")}
          aria-label={t("Resolve conflicts on GitHub")}
        >
          <Icon name="external-link" className="size-3.5" aria-hidden="true" />
          {t('Resolve on GitHub')}
        </Button>
      )}
    </div>
  );
};

export const PullDetail: React.FC<{
  directory: string;
  repo: string;
  number: number;
  github: GitHubAPI;
  detail: GitHubPullRequestDetailResult | null;
  detailError: GitHubErrorBody | null;
  detailStale: boolean;
  files: GitHubPullRequestFilesResult | null;
  filesError: GitHubErrorBody | null;
  filesLoading: boolean;
  filesHasMore: boolean;
  onLoadMoreFiles: () => void;
  checks: GitHubChecksResult | null;
  checksError: GitHubErrorBody | null;
  checksLoading: boolean;
  reviews: GitHubReview[];
  threads: GitHubReviewThread[];
  comments: GitHubIssueComment[];
  commentsError: GitHubErrorBody | null;
  commentsLoading: boolean;
  commentsHasMore: boolean;
  onLoadMoreComments: () => void;
  onRetryComments: () => void;
  onBack: () => void;
  onRetryDetail: () => void;
  onRetryFiles: () => void;
  onRetryChecks: () => void;
  onOpenFilesAtLine?: (path: string, line: number) => void;
  /** Mobile v1: omit the Files tab (and its inline review). */
  hideFilesTab?: boolean;
  /** List row for this PR, if loaded: renders the header while the detail read is in flight. */
  seed?: GitHubPullRequestSummary | null;
}> = (props) => {
  const { directory, repo, number, github, detail } = props;
  const { t } = useTranslation();
  const performAction = useGitHubPullRequestsStore((state) => state.performAction);
  const updateTitleBody = useGitHubPullRequestsStore((state) => state.updateTitleBody);
  const checkout = useGitHubPullRequestsStore((state) => state.checkout);
  const [tab, setTab] = React.useState<'summary' | 'files' | 'checks'>('summary');
  const [acting, setActing] = React.useState(false);
  const [mergeMethod, setMergeMethod] = React.useState<PullMergeMethod>(() => readMergeMethod(repo) ?? 'merge');
  const [editingTitle, setEditingTitle] = React.useState(false);
  const [titleDraft, setTitleDraft] = React.useState('');
  const [editingBody, setEditingBody] = React.useState(false);
  const [bodyDraft, setBodyDraft] = React.useState('');
  const [commentOrder, setCommentOrder] = React.useState<'newest' | 'oldest'>('newest');
  const [commentsPage, setCommentsPage] = React.useState(1);
  const [checkingOut, setCheckingOut] = React.useState(false);
  const [checkoutResult, setCheckoutResult] = React.useState<{ path: string | null; branch: string } | null>(null);
  const pendingReviewCount = usePendingReviewCount(repo, number);
  const { send, sendingKey } = useSendGitHubContextToComposer();
  const headerRepoName = useHeaderRepoName(directory, repo);

  const pr: GitHubPullRequestDetail | null = detail?.pr ?? null;
  const sectionErrors = detail?.sectionErrors ?? null;
  // Permission gating: server capabilities plus the author exception (GitHub
  // lets authors edit/close/reopen their own PRs). On fallback every action
  // stays enabled and the single attempt reports the server error.
  const access: ViewerAccess = React.useMemo(
    () => ({
      capabilities: detail?.capabilities ?? null,
      isAuthor: isAuthorLogin(pr?.author?.login, detail?.viewerLogin),
      permissionFallback: detail?.viewerPermission?.fallback === true,
    }),
    [detail?.capabilities, detail?.viewerLogin, detail?.viewerPermission?.fallback, pr?.author?.login],
  );
  const editGate = gatePullEdit(pr, access);

  React.useEffect(() => {
    setTab('summary');
    setEditingTitle(false);
    setEditingBody(false);
    setCommentsPage(1);
    setCheckoutResult(null);
  }, [repo, number]);

  const runAction = React.useCallback(
    async (action: GitHubPullRequestAction) => {
      setActing(true);
      try {
        const result = await performAction(directory, repo, number, action, github);
        if (!result.ok) {
          toast.error(result.error?.kind === 'failed' ? result.error.message : t('Action failed'));
          return;
        }
        if (action === 'close') toast.success(t('Pull request closed'));
        else if (action === 'reopen') toast.success(t('Pull request reopened'));
        else if (action === 'update-branch') toast.success(t('Branch update requested'));
        else if (action === 'ready') toast.success(t('Marked as ready for review'));
        else if (action === 'draft') toast.success(t('Converted to draft'));
        else toast.success(t('Pull request merged'));
      } finally {
        setActing(false);
      }
    },
    [directory, repo, number, github, performAction, t],
  );

  const handleAskAgent = React.useCallback(() => {
    void send({
      key: `pr-${number}-ask`,
      kind: 'pr',
      directory,
      repo,
      number,
      contextType: 'pr',
    });
  }, [send, directory, repo, number]);

  const handleSaveTitle = React.useCallback(async () => {
    if (!titleDraft.trim()) {
      toast.error(t('Enter a title'));
      return;
    }
    const result = await updateTitleBody(directory, repo, number, { title: titleDraft.trim() }, github);
    if (!result.ok) toast.error(result.error?.kind === 'failed' ? result.error.message : t('Failed to update title'));
    else {
      toast.success(t('Title updated'));
      setEditingTitle(false);
    }
  }, [titleDraft, directory, repo, number, github, updateTitleBody, t]);

  const handleSaveBody = React.useCallback(async () => {
    const result = await updateTitleBody(directory, repo, number, { body: bodyDraft }, github);
    if (!result.ok) toast.error(result.error?.kind === 'failed' ? result.error.message : t('Failed to update description'));
    else {
      toast.success(t('Description updated'));
      setEditingBody(false);
    }
  }, [bodyDraft, directory, repo, number, github, updateTitleBody, t]);

  const gitApi = useRuntimeAPIs().git;
  const handleCheckout = React.useCallback(async (mode: 'worktree' | 'current') => {
    if (mode === 'current') {
      const gitStatus = await import('@/stores/useGitStore').then((m) => m.useGitStore.getState().directories.get(directory)?.status ?? null).catch(() => null);
      const dirty = gitStatus && !gitStatus.isClean;
      if (dirty) {
        toast.error(t('Working tree has uncommitted changes. Commit or stash first, or use New worktree.'));
        return;
      }
      // Destructive choice is confirmed via the anchored popover on the
      // action row (no `window.confirm`), so reaching here means confirmed.
    }
    setCheckingOut(true);
    try {
      const result = await checkout(directory, repo, number, mode, github);
      if (!result.ok) toast.error(result.error?.kind === 'failed' ? result.error.message : t('Checkout failed'));
      else {
        // The server created the worktree (or switched the branch); re-list
        // the project's worktrees so the sidebar shows it immediately.
        await refreshWorktreeTopology(directory, gitApi);
        setCheckoutResult({ path: result.path ?? null, branch: result.branch ?? '' });
        toast.success(mode === 'worktree' ? t('Worktree created') : t('Branch checked out'));
      }
    } finally {
      setCheckingOut(false);
    }
  }, [directory, repo, number, github, gitApi, checkout, t]);

  const handleOpenSessionInWorktree = React.useCallback(() => {
    if (!checkoutResult?.path) return;
    void import('@/sync/session-ui-store').then(({ useSessionUIStore }) => {
      useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: checkoutResult.path });
      useUIStore.getState().setActiveMainTab('chat');
    });
  }, [checkoutResult]);

  const handleCopyLink = useCopyGitHubLink(pr?.url);

  const orderedComments = React.useMemo(() => {
    const copy = [...props.comments];
    copy.sort((a, b) => {
      const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
      const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
      return commentOrder === 'newest' ? tb - ta : ta - tb;
    });
    return copy;
  }, [props.comments, commentOrder]);

  const pageSize = 20;
  const visibleComments = orderedComments.slice(0, commentsPage * pageSize);
  const humanComments = visibleComments.filter((c) => !isBotLogin(c.author?.login));
  const botComments = visibleComments.filter((c) => isBotLogin(c.author?.login));


  if (props.detailError && !detail) {
    return (
      <GitHubDetailScaffold
        header={
          <GitHubDetailHeader
            onBack={props.onBack}
            backLabel={t("Back to pull requests")}
            repoName={headerRepoName}
            number={number}
            openLabel={t('Open pull request #{{number}} on GitHub', { number })}
            title={t('Pull request #{{number}}', { number })}
          />
        }
        tabs={[]}
        activeTab=""
        onTabChange={() => {}}
      >
        <GitHubUnavailableState info={toUnavailableInfo(props.detailError)} onRetry={props.onRetryDetail} />
      </GitHubDetailScaffold>
    );
  }

  if (!pr) {
    // Detail not read yet: render the header from the list row (when there is
    // one) and a placeholder body, so opening a PR shows it immediately. The
    // seed only fills the header; actions, reviewers, and labels wait for the
    // authoritative detail read.
    const seed = props.seed && props.seed.number === number ? props.seed : null;
    return (
      <GitHubDetailScaffold
        header={
          <GitHubDetailHeader
            onBack={props.onBack}
            backLabel={t("Back to pull requests")}
            repoName={headerRepoName}
            number={number}
            url={seed?.url ?? null}
            numberTintClass={seed ? gitHubStateTintClass('pr', seed.state, seed.draft) : undefined}
            statePill={seed ? <GitHubStatePill kind="pr" state={seed.state} draft={seed.draft} /> : undefined}
            openLabel={t('Open pull request #{{number}} on GitHub', { number })}
            title={seed?.title ?? null}
            meta={seed ? <PullHeaderMeta pr={seed} /> : undefined}
            branches={seed ? <PullHeaderBranches pr={seed} filesCount={seed.changedFiles ?? null} /> : undefined}
          />
        }
        tabs={[]}
        activeTab=""
        onTabChange={() => {}}
      >
        {/* No error and no detail yet means the read is still pending. */}
        <GitHubDetailSkeleton label={t("Loading pull request")} />
      </GitHubDetailScaffold>
    );
  }

  const checksSummary = props.checks?.summary ?? null;
  const filesCount = props.files?.files.length ?? pr.changedFiles ?? 0;
  const filesHint =
    pendingReviewCount > 0 && !props.hideFilesTab
      ? t('{{files}} · {{count}} pending', { files: filesCount, count: pendingReviewCount })
      : String(filesCount);

  return (
      <GitHubDetailScaffold
      header={
        <>
          <GitHubDetailHeader
            onBack={props.onBack}
            backLabel={t("Back to pull requests")}
            repoName={headerRepoName}
            number={pr.number}
            url={pr.url}
            numberTintClass={gitHubStateTintClass('pr', pr.state, pr.draft)}
            statePill={<GitHubStatePill kind="pr" state={pr.state} draft={pr.draft} />}
            openLabel={t('Open pull request #{{number}} on GitHub', { number: pr.number })}
            title={pr.title}
            onEditTitle={() => {
              setTitleDraft(pr.title);
              setEditingTitle(true);
            }}
            editTitleLabel={t("Edit pull request title")}
            editTitleDisabledReason={editGate.allowed ? null : editGate.reason}
            meta={<PullHeaderMeta pr={pr} />}
            branches={<PullHeaderBranches pr={pr} filesCount={filesCount} />}
          />
          <PullActionBar
            directory={directory}
            repo={repo}
            number={number}
            github={github}
            pr={pr}
            access={access}
            acting={acting}
            mergeMethod={mergeMethod}
            onMergeMethodChange={setMergeMethod}
            onRun={(action) => void runAction(action)}
            checkingOut={checkingOut}
            onCheckout={(mode) => void handleCheckout(mode)}
            onCopyLink={handleCopyLink}
            askSending={sendingKey === `pr-${number}-ask`}
            onAskAgent={handleAskAgent}
          />
          <BranchStatusStrip pr={pr} access={access} acting={acting} onRun={(action) => void runAction(action)} />
        </>
      }
      tabs={[
        { id: 'summary', label: t('Summary') },
        ...(props.hideFilesTab ? [] : [{ id: 'files', label: t('Code'), hint: filesHint }]),
        {
          id: 'checks',
          label: t('Checks'),
          hint: checksSummary ? `${checksSummary.success}/${checksSummary.total}` : undefined,
          glyph: checksSummary ? <GitHubChecksGlyph state={checksSummary.state} /> : undefined,
        },
      ]}
      activeTab={tab}
      onTabChange={(id) => setTab(id as typeof tab)}
    >
      <div className="flex flex-col gap-1 px-3 py-2">
        {props.detailStale ? (
          <p className="typography-micro text-muted-foreground" role="note">
            {t('Showing saved details — last refresh failed.')}{' '}
            <button type="button" className="underline" onClick={props.onRetryDetail}>
              {t('Retry')}
            </button>
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
              aria-label={t("Pull request title")}
              className="h-7"
            />
            <Button type="button" variant="default" size="xs" onClick={() => void handleSaveTitle()}>
              {t('Save')}
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => setEditingTitle(false)}>
              {t('Cancel')}
            </Button>
          </div>
        ) : null}
        {checkoutResult ? (
          <p className="flex flex-wrap items-center gap-1.5 typography-micro text-muted-foreground">
            <Icon name="check" className="size-3.5 shrink-0 text-[var(--status-success)]" />
            <span>
              {checkoutResult.path
                ? t('Ready on {{branch}} at {{path}}.', { branch: checkoutResult.branch, path: checkoutResult.path })
                : t('Ready on {{branch}}.', { branch: checkoutResult.branch })}
            </span>
            {checkoutResult.path ? (
              <Button type="button" variant="default" size="xs" onClick={handleOpenSessionInWorktree}>
                {t('Open session here')}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="xs" onClick={() => setCheckoutResult(null)} aria-label={t("Dismiss checkout result")}>
              {t('Dismiss')}
            </Button>
          </p>
        ) : null}

        {tab === 'summary' ? (
          <>
            <div className="flex flex-col gap-1.5 py-1">
              <GitHubMetaRow icon="user" label={t("Reviewers")}>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                  {pr.requestedReviewers.length === 0 ? (
                    <span className="typography-micro text-muted-foreground">{t('None')}</span>
                  ) : (
                    pr.requestedReviewers.map((reviewer) => (
                      <span key={reviewer.login} className="inline-flex min-w-0 items-center gap-1 typography-micro text-muted-foreground">
                        <GitHubAvatar login={reviewer.login} avatarUrl={reviewer.avatarUrl} size="xs" />
                        <span className="truncate">{reviewer.login}</span>
                      </span>
                    ))
                  )}
                  <span className="typography-micro tabular-nums text-muted-foreground">
                    {t('{{approvals}} approvals · {{requested}} changes requested · {{commented}} commented', { approvals: pr.reviewSummary.approvals, requested: pr.reviewSummary.changesRequested, commented: pr.reviewSummary.commented })}
                  </span>
                </span>
              </GitHubMetaRow>
              <GitHubMetaRow icon="list-unordered" label={t("Labels")}>
                <span className="flex min-w-0 flex-wrap items-center gap-1">
                  {pr.labels.length === 0 ? (
                    <span className="typography-micro text-muted-foreground">{t('None')}</span>
                  ) : (
                    pr.labels.map((label) => (
                      <GitHubLabelChip key={label.name} name={label.name} color={label.color} />
                    ))
                  )}
                </span>
              </GitHubMetaRow>
            </div>

            <GitHubSection
              id={`pr-${number}-description`}
              title={t("Description")}
              action={
                !editingBody ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setBodyDraft(pr.body ?? '');
                      setEditingBody(true);
                    }}
                    aria-label={t("Edit description")}
                    title={editGate.reason ?? t('Edit description')}
                    disabled={!editGate.allowed}
                  >
                    {t('Edit')}
                  </Button>
                ) : undefined
              }
            >
              {editingBody ? (
                <div className="flex flex-col gap-1.5">
                  <textarea
                    value={bodyDraft}
                    onChange={(event) => setBodyDraft(event.target.value)}
                    rows={6}
                    aria-label={t("Pull request description")}
                    className="min-h-24 w-full rounded-md border border-border bg-[var(--surface-elevated)] p-2 typography-ui text-foreground"
                  />
                  <div className="flex gap-1.5">
                    <Button type="button" variant="default" size="sm" onClick={() => void handleSaveBody()}>
                      {t('Save')}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setEditingBody(false)}>
                      {t('Cancel')}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <GitHubCollapsibleBody markdown={pr.body ?? ''} html={pr.bodyHtml ?? null} fallbackUrl={pr.url} label={t("pull request description")} />
                  {!pr.body?.trim() ? (
                    <p className="typography-micro text-muted-foreground">{t('No description provided.')}</p>
                  ) : null}
                </>
              )}
            </GitHubSection>

            <GitHubSection
              id={`pr-${number}-comments`}
              title={`${t('Comments')}${orderedComments.length ? ` (${orderedComments.length})` : ''}`}
              action={
                <span className="inline-flex shrink-0 items-center gap-1">
                  {props.hideFilesTab ? (
                    <PullReviewControl
                      directory={directory}
                      repo={repo}
                      number={number}
                      github={github}
                      access={access}
                      size="xs"
                      onReviewSubmitted={props.onRetryDetail}
                    />
                  ) : null}
                  <GitHubCommentOrderToggle order={commentOrder} onToggle={() => setCommentOrder(commentOrder === 'newest' ? 'oldest' : 'newest')} />
                </span>
              }
            >
              <div className="flex flex-col gap-2">
                <SectionError error={props.commentsError} onRetry={props.onRetryComments} label={t("Comments")} />
                {humanComments.map((comment) => (
                  <GitHubThreadComment key={comment.id} comment={comment} />
                ))}
                <GitHubBotCommentGroup comments={botComments} />
                {props.commentsLoading && orderedComments.length === 0 && !props.commentsError ? (
                  <p className="typography-micro text-muted-foreground">{t('Loading comments…')}</p>
                ) : null}
                {orderedComments.length === 0 && !props.commentsLoading && !props.commentsError ? (
                  <p className="typography-micro text-muted-foreground">{t('No comments yet.')}</p>
                ) : null}
                {orderedComments.length > visibleComments.length ? (
                  <div>
                    <Button type="button" variant="outline" size="sm" onClick={() => setCommentsPage(commentsPage + 1)}>
                      {t('Show older comments')}
                    </Button>
                  </div>
                ) : props.commentsHasMore ? (
                  <div>
                    <Button type="button" variant="outline" size="sm" onClick={props.onLoadMoreComments} disabled={props.commentsLoading}>
                      {props.commentsLoading ? t('Loading…') : t('Load older comments')}
                    </Button>
                  </div>
                ) : null}
                <PullCommentForm
                  directory={directory}
                  repo={repo}
                  number={number}
                  github={github}
                  pr={pr}
                  access={access}
                  onCommented={() => {
                    props.onRetryComments();
                    props.onRetryDetail();
                  }}
                />
              </div>
            </GitHubSection>
          </>
        ) : null}

        {tab === 'files' && !props.hideFilesTab ? (
          <PullFilesTab
            key={`${repo}#${number}`}
            files={props.files}
            filesLoading={props.filesLoading}
            filesError={props.filesError}
            filesHasMore={props.filesHasMore}
            onLoadMoreFiles={props.onLoadMoreFiles}
            onRetryFiles={props.onRetryFiles}
            threads={props.threads}
            threadsError={sectionErrors?.threads ?? null}
            onRetryDetail={props.onRetryDetail}
            directory={directory}
            repo={repo}
            number={number}
            github={github}
            access={access}
            headSha={pr.headSha ?? null}
            onReviewSubmitted={props.onRetryDetail}
          />
        ) : null}

        {tab === 'checks' ? (
          <PullChecksTab
            directory={directory}
            repo={repo}
            number={number}
            github={github}
            checks={props.checks}
            checksError={props.checksError}
            checksLoading={props.checksLoading}
            onRetryChecks={props.onRetryChecks}
            onOpenFilesAtLine={props.onOpenFilesAtLine}
          />
        ) : null}
      </div>
      </GitHubDetailScaffold>
  );
};
