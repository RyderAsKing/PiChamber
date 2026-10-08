import React from 'react';
import i18n from '@/i18n';
import { toast } from '@/components/ui';

export type CommentPostResult = {
  ok: boolean;
  error?: { kind: string; message?: string } | null;
};

/**
 * Comment post + follow-up state change shared by the PR and issue composers:
 * post → clear the draft (done even when the follow-up fails next) →
 * optional close/reopen → toast/error. The follow-up runs only after the
 * comment posted; busy/error state stays with the hook.
 */
const postCommentThenFollowUp = async <TFollowUp extends string>(options: {
  /** Trimmed comment body (empty bodies never reach here). */
  trimmed: string;
  action: 'comment' | TFollowUp;
  postComment: (body: string) => Promise<CommentPostResult>;
  runFollowUp: (followUp: TFollowUp) => Promise<CommentPostResult>;
  /** Human verbs for toasts/errors, e.g. `{ close: 'close', reopen: 'reopen' }`. */
  verbs: Record<TFollowUp, string>;
  /** Past-tense success labels, e.g. `{ close: 'Closed with comment', reopen: 'Reopened with comment' }`. */
  doneLabels: Record<TFollowUp, string>;
  /** Clears the draft; runs after a successful post even when the follow-up fails. */
  afterPost: () => void;
  notify?: (kind: 'success' | 'error', message: string) => void;
}): Promise<void> => {
  const notify = options.notify ?? ((kind, message) => toast[kind](message));
  const posted = await options.postComment(options.trimmed);
  if (!posted.ok) {
    const message = posted.error?.kind === 'failed' && posted.error.message
      ? posted.error.message
      : i18n.t('Failed to post comment');
    notify('error', message);
    throw new Error(message);
  }
  options.afterPost();
  if (options.action === 'comment') {
    notify('success', i18n.t('Comment posted'));
    return;
  }
  const acted = await options.runFollowUp(options.action);
  if (!acted.ok) {
    const verb = options.verbs[options.action];
    const message = acted.error?.kind === 'failed' && acted.error.message
      ? acted.error.message
      : i18n.t('Failed to {{verb}}', { verb });
    notify('error', message);
    throw new Error(message);
  }
  notify('success', options.doneLabels[options.action]);
};

export const useCommentWithFollowUp = <TFollowUp extends string>(options: {
  postComment: (body: string) => Promise<CommentPostResult>;
  runFollowUp: (followUp: TFollowUp) => Promise<CommentPostResult>;
  verbs: Record<TFollowUp, string>;
  doneLabels: Record<TFollowUp, string>;
  afterPost: () => void;
}): {
  busy: 'comment' | TFollowUp | null;
  error: string | null;
  submit: (action: 'comment' | TFollowUp, body: string) => Promise<void>;
} => {
  const [busy, setBusy] = React.useState<'comment' | TFollowUp | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const stateRef = React.useRef(options);
  stateRef.current = options;

  const submit = React.useCallback(async (action: 'comment' | TFollowUp, body: string) => {
    const trimmed = body.trim();
    const current = stateRef.current;
    if (trimmed.length === 0 || busy !== null) return;
    setBusy(action);
    setError(null);
    try {
      await postCommentThenFollowUp({
        trimmed,
        action,
        postComment: current.postComment,
        runFollowUp: current.runFollowUp,
        verbs: current.verbs,
        doneLabels: current.doneLabels,
        afterPost: current.afterPost,
      });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : i18n.t('Failed to post comment'));
    } finally {
      setBusy(null);
    }
  }, [busy]);

  return { busy, error, submit };
};
