import React from 'react';
import { useTranslation } from 'react-i18next';
import { Popover } from '@base-ui/react/popover';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import type {
  GitHubAPI,
  GitHubPullRequestDetail,
  GitHubReviewInlineComment,
} from '@/lib/api/types';
import { useGitHubPullRequestsStore } from '@/stores/useGitHubPullRequestsStore';
import {
  useDebouncedCommentDraft,
  useGitHubPendingReviewStore,
  usePendingReviewComments,
  usePendingReviewSummary,
  usePendingReviewVerdict,
} from '@/stores/github/useGitHubPendingReviewStore';
import {
  allowedReviewVerdicts,
  canSubmitReview,
  gatePullAction,
  gatePullComment,
  type PullReviewVerdict,
  type ViewerAccess,
} from './pullLogic';
import { GitHubCommentForm } from '../GitHubCommentForm';
import { useCommentWithFollowUp } from '../useCommentWithFollowUp';

/**
 * Inline comment form at the end of the Summary tab's Comments section.
 * Drafts live in the pending-review store, so text survives tab switches;
 * Ctrl/⌘+Enter posts.
 */
export const PullCommentForm: React.FC<{
  directory: string;
  repo: string;
  number: number;
  github: GitHubAPI;
  pr: GitHubPullRequestDetail;
  access: ViewerAccess;
  onCommented: () => void;
}> = ({ directory, repo, number, github, pr, access, onCommented }) => {
  const { t } = useTranslation();
  const addComment = useGitHubPullRequestsStore((state) => state.addComment);
  const performAction = useGitHubPullRequestsStore((state) => state.performAction);
  const clearCommentDraft = useGitHubPendingReviewStore((state) => state.clearCommentDraft);
  const { draft, onDraftChange, flushDraft } = useDebouncedCommentDraft(repo, number);
  const { busy, error, submit } = useCommentWithFollowUp({
    postComment: (body) => addComment(directory, repo, number, body, github),
    runFollowUp: (followUp) => performAction(directory, repo, number, followUp, github),
    verbs: { close: t('close'), reopen: t('reopen') },
    doneLabels: { close: t('Closed with comment'), reopen: t('Reopened with comment') },
    afterPost: () => {
      onDraftChange('');
      clearCommentDraft(repo, number);
      onCommented();
    },
  });

  const commentGate = gatePullComment(access);
  const followUpAction =
    pr.state === 'open' ? ('close' as const) : pr.state === 'closed' ? ('reopen' as const) : null;
  const followUpGate = followUpAction ? gatePullAction(followUpAction, pr, access) : null;

  if (!commentGate.allowed) return null;

  return (
    <GitHubCommentForm
      draft={draft}
      onDraftChange={onDraftChange}
      onDraftBlur={flushDraft}
      ariaLabel={t("Leave a comment on this pull request")}
      busy={busy}
      error={error}
      disabledReason={commentGate.reason}
      followUp={
        followUpAction
          ? {
              id: followUpAction,
              label: followUpAction === 'close' ? t('Close with comment') : t('Reopen with comment'),
              busyLabel: followUpAction === 'close' ? t('Closing…') : t('Reopening…'),
              onRun: () => void submit(followUpAction, draft),
              allowed: followUpGate?.allowed === true,
              reason: followUpGate?.reason,
            }
          : null
      }
      onSubmitComment={() => void submit('comment', draft)}
    />
  );
};

const VERDICT_LABELS: Record<PullReviewVerdict, string> = {
  comment: 'Comment',
  approve: 'Approve',
  'request-changes': 'Request changes',
};

const ReviewForm: React.FC<{
  repo: string;
  number: number;
  verdicts: PullReviewVerdict[];
  summary: string;
  verdict: PullReviewVerdict;
  pendingCount: number;
  busy: boolean;
  textareaRef: React.Ref<HTMLTextAreaElement>;
  onSubmit: () => void;
}> = ({ repo, number, verdicts, summary, verdict, pendingCount, busy, textareaRef, onSubmit }) => {
  const { t } = useTranslation();
  const setSummary = useGitHubPendingReviewStore((state) => state.setSummary);
  const setVerdict = useGitHubPendingReviewStore((state) => state.setVerdict);
  const selected = verdicts.includes(verdict) ? verdict : verdicts[0] ?? 'comment';
  const submittable = canSubmitReview({ verdict: selected, summary, pendingCount });

  return (
    <div>
      <Textarea
        ref={textareaRef}
        rows={3}
        value={summary}
        placeholder={t("Summarize your review (optional)")}
        aria-label={t("Review summary")}
        disabled={busy}
        onChange={(event) => setSummary(repo, number, event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (
            event.key === 'Enter' &&
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey &&
            !event.altKey &&
            !event.repeat
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (submittable && !busy) onSubmit();
          }
        }}
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <label className="inline-flex min-w-0 items-center gap-1.5">
          <span className="sr-only">{t('Review verdict')}</span>
          <select
            value={selected}
            disabled={busy}
            onChange={(event) => setVerdict(repo, number, event.target.value as PullReviewVerdict)}
            aria-label={t("Review verdict")}
            className="h-7 max-w-40 truncate rounded-md border border-border bg-[var(--surface-elevated)] px-1.5 typography-micro text-foreground"
          >
            {verdicts.map((option) => (
              <option key={option} value={option}>
                {t(VERDICT_LABELS[option])}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          variant="default"
          size="xs"
          disabled={busy || !submittable}
          title={
            submittable
              ? pendingCount > 0
                ? pendingCount === 1
                  ? t('Submit review with {{count}} line comment', { count: pendingCount })
                  : t('Submit review with {{count}} line comments', { count: pendingCount })
                : t('Submit review')
              : t('Add a summary or a line comment first')
          }
          onClick={onSubmit}
        >
          {busy ? t('Submitting…') : t('Submit review')}
        </Button>
      </div>
    </div>
  );
};

/**
 * Review submission where line comments are authored: the Code tab's summary
 * bar (and the Summary comments header when the Files tab is hidden).
 * Submits the summary, verdict, and every pending line comment together;
 * drafts survive popover close. Renders nothing when the viewer cannot review.
 */
export const PullReviewControl: React.FC<{
  directory: string;
  repo: string;
  number: number;
  github: GitHubAPI;
  access: ViewerAccess;
  size?: 'xs' | 'sm';
  onReviewSubmitted?: () => void;
}> = ({ directory, repo, number, github, access, size = 'sm', onReviewSubmitted }) => {
  const { t } = useTranslation();
  const submitReviewAction = useGitHubPullRequestsStore((state) => state.submitReview);
  const removeComments = useGitHubPendingReviewStore((state) => state.removeComments);
  const clearSummary = useGitHubPendingReviewStore((state) => state.clearSummary);
  const clearComments = useGitHubPendingReviewStore((state) => state.clearComments);
  const pendingComments = usePendingReviewComments(repo, number);
  const summary = usePendingReviewSummary(repo, number);
  const verdict = usePendingReviewVerdict(repo, number);
  const [open, setOpen] = React.useState(false);
  const [reviewBusy, setReviewBusy] = React.useState(false);
  const reviewRef = React.useRef<HTMLTextAreaElement | null>(null);

  const verdicts = React.useMemo(() => allowedReviewVerdicts(access), [access]);
  // The effective verdict is what ReviewForm shows: fall back to the first
  // allowed verdict when the stored one is no longer permitted.
  const effectiveVerdict = verdicts.includes(verdict) ? verdict : verdicts[0] ?? 'comment';
  const pendingCount = pendingComments.length;
  const reviewStarted = pendingCount > 0 || summary.trim().length > 0;

  React.useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => reviewRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [open ]);

  if (verdicts.length === 0) return null;

  const submitReview = async () => {
    if (reviewBusy) return;
    const submittedSummary = summary;
    const submittedComments = [...pendingComments];
    setReviewBusy(true);
    try {
      const comments: GitHubReviewInlineComment[] = submittedComments.map((comment) => ({
        path: comment.path,
        body: comment.body,
        ...(comment.line != null ? { line: comment.line } : {}),
        ...(comment.side ? { side: comment.side } : {}),
      }));
      const result = await submitReviewAction(
        directory,
        repo,
        number,
        { event: effectiveVerdict, body: submittedSummary.trim() ? submittedSummary : undefined, comments },
        github,
      );
      if (!result.ok) {
        // Keep everything: retyping the review is not the answer to a failed submit.
        toast.error(result.error?.kind === 'failed' ? result.error.message : t('Failed to submit review'));
        return;
      }
      // More remarks may have arrived while the host accepted this snapshot:
      // remove only the submitted comments, and the summary only when it is
      // still the submitted text.
      removeComments(
        repo,
        number,
        submittedComments.map((comment) => comment.id),
      );
      clearSummary(repo, number, submittedSummary);
      toast.success(effectiveVerdict === 'approve' ? t('Pull request approved') : effectiveVerdict === 'request-changes' ? t('Changes requested') : t('Review submitted'));
      setOpen(false);
      onReviewSubmitted?.();
    } finally {
      setReviewBusy(false);
    }
  };

  const reviewLabel = pendingCount > 0 ? t('Review · {{count}}', { count: pendingCount }) : t('Review');

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <Button
            type="button"
            variant={pendingCount > 0 ? 'default' : 'outline'}
            size={size}
            className="shrink-0"
            aria-label={
              pendingCount > 0
                ? pendingCount === 1
                  ? t('Review pull request, {{count}} line comment pending', { count: pendingCount })
                  : t('Review pull request, {{count}} line comments pending', { count: pendingCount })
                : t('Review pull request')
            }
            title={reviewStarted ? t('Finish your review') : t('Approve, request changes, or comment with a review')}
          />
        }
      >
        <Icon name="file-check" className="size-3.5" aria-hidden="true" />
        {reviewLabel}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="z-50" side="top" align="end" sideOffset={8} collisionPadding={8}>
          <Popover.Popup
            aria-label={t("Review pull request")}
            className="w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-border/60 bg-[var(--surface-elevated)] p-3 shadow-lg"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="min-w-0 truncate typography-ui-label text-foreground">
                {pendingCount > 0
                  ? pendingCount === 1
                    ? t('Review · {{count}} line comment', { count: pendingCount })
                    : t('Review · {{count}} line comments', { count: pendingCount })
                  : t('Review pull request')}
              </p>
              <div className="flex shrink-0 items-center gap-1">
                {pendingCount > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("Discard pending line comments")}
                    title={t("Discard pending line comments")}
                    disabled={reviewBusy}
                    onClick={() => clearComments(repo, number)}
                    className="size-6"
                  >
                    <Icon name="delete-bin" className="size-3.5" />
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("Close review")}
                  onClick={() => setOpen(false)}
                  className="size-6"
                >
                  <Icon name="close" className="size-3.5" />
                </Button>
              </div>
            </div>
            <ReviewForm
              repo={repo}
              number={number}
              verdicts={verdicts}
              summary={summary}
              verdict={effectiveVerdict}
              pendingCount={pendingCount}
              busy={reviewBusy}
              textareaRef={reviewRef}
              onSubmit={() => void submitReview()}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
