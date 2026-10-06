import React from 'react';
import { useTranslation } from 'react-i18next';
import type { DiffLineAnnotation, SelectedLineRange } from '@pierre/diffs';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import type {
  GitHubAPI,
  GitHubPullRequestFile,
  GitHubReviewThread,
} from '@/lib/api/types';
import { GitHubDiffStat, GitHubMarkdownBody } from '../GitHubDetailScaffold';
import { PierreDiffViewer } from '../../PierreDiffViewer';
import { useGitHubPullRequestsStore } from '@/stores/useGitHubPullRequestsStore';
import {
  useGitHubPendingReviewStore,
  usePendingReviewComments,
  type PendingReviewLineComment,
} from '@/stores/github/useGitHubPendingReviewStore';
import { useSendGitHubContextToComposer } from './useSendGitHubContextToComposer';
import {
  gatePullComment,
  gatePullThreadReply,
  gatePullThreadResolve,
  languageForFile,
  mapPatchLinesToSynthetic,
  synthesizeOriginalModifiedFromPatch,
  type ViewerAccess,
} from './pullLogic';
import { cn } from '@/lib/utils';
import {
  changedLinesForFile,
  isLargeFile,
  splitFilePath,
  statusIconForFile,
  statusKindForFile,
  statusLetterForFile,
  statusTintForFile,
} from './pullFilesLogic';

/** One diff line's conversations: server threads, pending comments, and the open draft box. */
type PullLineAnnotationData = {
  threads: GitHubReviewThread[];
  pendings: PendingReviewLineComment[];
  draft: { realLine: number; realSide: 'LEFT' | 'RIGHT' } | null;
};

type PullLineAnnotation = DiffLineAnnotation<PullLineAnnotationData>;

/** A comment waiting to be sent with the rest of the review. */
const PendingReviewCommentCard: React.FC<{
  comment: PendingReviewLineComment;
  onRemove: () => void;
}> = ({ comment, onRemove }) => {
  const { t } = useTranslation();
  return (
  <div
    className="rounded-md border border-dashed border-border p-2.5 typography-ui text-foreground"
    contentEditable={false}
    onPointerDown={(event) => event.stopPropagation()}
  >
    <div className="flex items-center gap-1.5 typography-micro text-muted-foreground">
      <Icon name="chat-1" className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{t('Pending — sent when you submit the review')}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("Discard this comment")}
        title={t("Discard this comment")}
        onClick={onRemove}
        className="ml-auto size-6"
      >
        <Icon name="delete-bin" className="size-3.5" />
      </Button>
    </div>
    <p className="mt-1.5 whitespace-pre-wrap break-words">{comment.body}</p>
  </div>
  );
};

/** A conversation already on the host, with reply and resolve controls. */
const ReviewThreadCard: React.FC<{
  thread: GitHubReviewThread;
  replyAllowed: boolean;
  replyDisabledReason: string | null;
  resolveAllowed: boolean;
  resolveDisabledReason: string | null;
  busy: boolean;
  /** Resolves to whether the host took the reply, so a failed reply keeps its text. */
  onReply: (body: string) => Promise<boolean>;
  onToggleResolved: () => void;
}> = ({ thread, replyAllowed, replyDisabledReason, resolveAllowed, resolveDisabledReason, busy, onReply, onToggleResolved }) => {
  const { t } = useTranslation();
  // A resolved thread is finished work: it opens collapsed and stays one line until asked for.
  const [expanded, setExpanded] = React.useState(!thread.resolved);
  const [replying, setReplying] = React.useState(false);
  const [reply, setReply] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const commentCount = thread.comments.length;

  const send = async () => {
    const trimmed = reply.trim();
    if (trimmed.length === 0 || sending || busy) return;
    setSending(true);
    try {
      // Cleared only once the host has it; otherwise a failed reply leaves an
      // error toast and an empty box, and the words must be written again.
      if (await onReply(trimmed)) {
        setReply('');
        setReplying(false);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="rounded-md border border-border/60 bg-[var(--surface-elevated)] p-2.5 typography-ui text-foreground"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center gap-1.5 typography-micro text-muted-foreground">
        <Icon
          name={thread.resolved ? 'check' : 'chat-1'}
          className={cn('size-3.5 shrink-0', thread.resolved ? 'text-[var(--status-success)]' : '')}
          aria-hidden="true"
        />
        <button
          type="button"
          className="hover:text-foreground"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {thread.resolved ? t('Resolved') : t('Open')} · {commentCount} {commentCount === 1 ? t('comment') : t('comments')}
        </button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ml-auto"
          disabled={!resolveAllowed || busy}
          title={resolveDisabledReason ?? (thread.resolved ? t('Reopen this conversation') : t('Resolve this conversation'))}
          aria-label={thread.resolved ? t('Reopen conversation') : t('Resolve conversation')}
          onClick={onToggleResolved}
        >
          {thread.resolved ? t('Unresolve') : t('Resolve')}
        </Button>
      </div>

      {expanded ? (
        <>
          <div className="mt-2 flex flex-col gap-2">
            {thread.comments.map((comment, index) => (
              <div key={comment.id ?? `${thread.id}-${index}`} className="min-w-0">
                <p className="typography-micro text-muted-foreground">{comment.author?.login ?? 'ghost'}</p>
                <GitHubMarkdownBody markdown={comment.body} html={comment.bodyHtml ?? null} fallbackUrl={comment.url} />
              </div>
            ))}
          </div>
          {replyAllowed ? (
            replying ? (
              <div className="mt-2">
                <textarea
                  autoFocus
                  value={reply}
                  rows={2}
                  placeholder={t("Reply")}
                  aria-label={t("Reply to this conversation")}
                  disabled={sending || busy}
                  onChange={(event) => setReply(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      setReplying(false);
                    }
                    if (
                      event.key === 'Enter' &&
                      (event.metaKey || event.ctrlKey) &&
                      !event.shiftKey &&
                      !event.altKey &&
                      !event.repeat
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      void send();
                    }
                  }}
                  className="min-h-12 w-full rounded-md border border-border bg-[var(--surface-elevated)] p-2 typography-ui text-foreground"
                />
                <div className="mt-1.5 flex justify-end gap-1.5">
                  <Button type="button" variant="ghost" size="xs" onClick={() => setReplying(false)}>
                    {t('Cancel')}
                  </Button>
                  <Button type="button" variant="default" size="xs" disabled={sending || busy || reply.trim().length === 0} onClick={() => void send()}>
                    {sending ? t('Replying…') : t('Reply')}
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="button" variant="ghost" size="xs" className="mt-2" onClick={() => setReplying(true)}>
                {t('Reply')}
              </Button>
            )
          ) : replyDisabledReason ? (
            <p className="mt-2 typography-micro text-muted-foreground" title={replyDisabledReason}>
              {t('Reply unavailable — {{reason}}', { reason: replyDisabledReason.charAt(0).toLowerCase() + replyDisabledReason.slice(1) })}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
};

/** The inline draft box opened from a diff line's gutter control. */
const InlineDraftBox: React.FC<{
  path: string;
  line: number;
  sendingToAgent: boolean;
  onCancel: () => void;
  onAddToReview: (body: string) => void;
  onSendToAgent: (body: string) => void;
}> = ({ path, line, sendingToAgent, onCancel, onAddToReview, onSendToAgent }) => {
  const { t } = useTranslation();
  const [text, setText] = React.useState('');
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const trimmed = text.trim();

  React.useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const submit = () => {
    if (!trimmed) return;
    onAddToReview(trimmed);
  };

  return (
    <div
      className="rounded-md border border-border/60 bg-[var(--surface-elevated)] p-2.5"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <p className="truncate font-mono typography-micro text-muted-foreground" title={`${path}:${line}`}>
        {path}:{line}
      </p>
      <textarea
        ref={textareaRef}
        value={text}
        rows={3}
        placeholder={t("Add a comment…")}
        aria-label={t('Comment on {{path}} line {{line}}', { path, line })}
        onChange={(event) => setText(event.target.value)}
        onFocus={(event) => {
          const end = event.currentTarget.value.length;
          event.currentTarget.setSelectionRange(end, end);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
          if (
            event.key === 'Enter' &&
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey &&
            !event.altKey &&
            !event.repeat
          ) {
            event.preventDefault();
            event.stopPropagation();
            submit();
          }
        }}
        className="mt-1.5 min-h-16 w-full rounded-md border border-border bg-[var(--surface-elevated)] p-2 typography-ui text-foreground"
      />
      <div className="mt-1.5 flex items-center gap-1.5">
        <span className="mr-auto typography-micro text-muted-foreground">{t('Ctrl/Cmd+Enter to add')}</span>
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={!trimmed || sendingToAgent}
          title={t("Send this line to the agent")}
          onClick={() => onSendToAgent(trimmed)}
        >
          {sendingToAgent ? t('Sending…') : t('Send to agent')}
        </Button>
        <Button type="button" variant="default" size="xs" disabled={!trimmed} onClick={submit}>
          {t('Add to review')}
        </Button>
      </div>
    </div>
  );
};

type DraftAnchor = {
  synthLine: number;
  side: 'additions' | 'deletions';
  realLine: number;
  realSide: 'LEFT' | 'RIGHT';
};

const FileCardInner: React.FC<{
  file: GitHubPullRequestFile;
  collapsed: boolean;
  onToggleCollapse: (filename: string) => void;
  viewed: boolean;
  onToggleViewed: (filename: string, viewed: boolean) => void;
  blobUrl?: string | null;
  threads: GitHubReviewThread[];
  directory: string;
  repo: string;
  number: number;
  github: GitHubAPI;
  access: ViewerAccess;
  onThreadsChanged: () => void;
}> = ({ file, collapsed, onToggleCollapse, viewed, onToggleViewed, blobUrl, threads, directory, repo, number, github, access, onThreadsChanged }) => {
  const { t } = useTranslation();
  const threadAction = useGitHubPullRequestsStore((state) => state.threadAction);
  // Actions only (stable references): subscribing to the whole store would
  // re-render every FileCard on each keystroke/draft change elsewhere.
  const removePendingComment = useGitHubPendingReviewStore((state) => state.removeComment);
  const addPendingComment = useGitHubPendingReviewStore((state) => state.addComment);
  const pendingComments = usePendingReviewComments(repo, number);
  const [draft, setDraft] = React.useState<DraftAnchor | null>(null);
  const [threadBusy, setThreadBusy] = React.useState(false);
  const { send, sendingKey } = useSendGitHubContextToComposer();
  const { original, modified } = React.useMemo(() => synthesizeOriginalModifiedFromPatch(file.patch), [file.patch]);
  const lineMaps = React.useMemo(() => mapPatchLinesToSynthetic(file.patch), [file.patch]);
  const fileKey = `pr-${number}-file-${file.filename}`;

  const commentGate = gatePullComment(access);
  const replyGate = gatePullThreadReply(access);
  const resolveGate = gatePullThreadResolve(access);
  // A range collapses to its last line: the review API takes one line per
  // comment, so a multi-line selection anchors to where it ends.
  const beginCommentFromRange = React.useCallback(
    (range: SelectedLineRange | null) => {
      if (!range || !commentGate.allowed) return;
      const side = range.endSide ?? range.side ?? 'additions';
      const anchorSide: 'additions' | 'deletions' = side === 'deletions' ? 'deletions' : 'additions';
      const realLine =
        anchorSide === 'deletions' ? lineMaps.syntheticToOld.get(range.end) : lineMaps.syntheticToNew.get(range.end);
      if (realLine == null) {
        toast.error(t('That line is outside the rendered hunks'));
        return;
      }
      setDraft({
        synthLine: range.end,
        side: anchorSide,
        realLine,
        realSide: anchorSide === 'deletions' ? 'LEFT' : 'RIGHT',
      });
    },
    [commentGate.allowed, lineMaps, t],
  );

  const statusKind = statusKindForFile(file.status);
  const { dir, base } = splitFilePath(file.filename);
  const large = isLargeFile(file);
  const [largeLoaded, setLargeLoaded] = React.useState(false);
  // A file marked viewed after its large diff loaded keeps the diff visible
  // until the next collapse toggle; fresh large files gate behind the loader.
  const showLargeGate = large && !largeLoaded && !viewed && file.patch != null;
  const openThreadCount = threads.filter((thread) => !thread.resolved).length;

  const filePendings = React.useMemo(
    () => pendingComments.filter((comment) => comment.path === file.filename),
    [pendingComments, file.filename],
  );

  const { annotations, orphans } = React.useMemo(() => {
    const groups = new Map<string, { side: 'additions' | 'deletions'; synthLine: number; threads: GitHubReviewThread[]; pendings: PendingReviewLineComment[] }>();
    const orphans: GitHubReviewThread[] = [];
    const groupFor = (side: 'additions' | 'deletions', synthLine: number) => {
      const key = `${side}:${synthLine}`;
      let group = groups.get(key);
      if (!group) {
        group = { side, synthLine, threads: [], pendings: [] };
        groups.set(key, group);
      }
      return group;
    };
    for (const thread of threads) {
      const line = thread.line ?? thread.originalLine ?? null;
      if (line == null) {
        orphans.push(thread);
        continue;
      }
      // Threads whose line cannot be located in the rendered hunks (outdated
      // or unanchored) surface in Other conversations instead of a line.
      let synth: number | undefined;
      let side: 'additions' | 'deletions';
      if (thread.diffSide === 'LEFT') {
        side = 'deletions';
        synth = lineMaps.oldToSynthetic.get(line);
      } else if (thread.diffSide === 'RIGHT') {
        side = 'additions';
        synth = lineMaps.newToSynthetic.get(line);
      } else {
        synth = lineMaps.newToSynthetic.get(line);
        side = 'additions';
        if (synth == null) {
          synth = lineMaps.oldToSynthetic.get(line);
          side = 'deletions';
        }
      }
      if (synth == null) {
        orphans.push(thread);
        continue;
      }
      groupFor(side, synth).threads.push(thread);
    }
    for (const pending of filePendings) {
      if (pending.line == null) continue;
      const side: 'additions' | 'deletions' = pending.side === 'LEFT' ? 'deletions' : 'additions';
      const synth = side === 'deletions' ? lineMaps.oldToSynthetic.get(pending.line) : lineMaps.newToSynthetic.get(pending.line);
      if (synth == null) continue;
      groupFor(side, synth).pendings.push(pending);
    }
    if (draft) {
      groupFor(draft.side, draft.synthLine);
    }
    const annotations: PullLineAnnotation[] = [...groups.values()]
      .sort((a, b) => a.synthLine - b.synthLine)
      .map((group) => ({
        side: group.side,
        lineNumber: group.synthLine,
        metadata: {
          threads: group.threads,
          pendings: group.pendings,
          draft:
            draft && draft.side === group.side && draft.synthLine === group.synthLine
              ? { realLine: draft.realLine, realSide: draft.realSide }
              : null,
        },
      }));
    return { annotations, orphans };
  }, [threads, filePendings, draft, lineMaps]);

  const handleReply = React.useCallback(
    async (thread: GitHubReviewThread, body: string): Promise<boolean> => {
      const commentId = thread.comments[thread.comments.length - 1]?.id ?? null;
      if (typeof commentId !== 'number') {
        toast.error(t('Cannot reply to this thread yet'));
        return false;
      }
      if (threadBusy) return false;
      setThreadBusy(true);
      try {
        const result = await threadAction(directory, repo, number, thread.id, { action: 'reply', body, commentId }, github);
        if (!result.ok) {
          toast.error(t('Failed to post reply'));
          return false;
        }
        toast.success(t('Reply posted'));
        onThreadsChanged();
        return true;
      } finally {
        setThreadBusy(false);
      }
    },
    [directory, repo, number, github, threadAction, threadBusy, onThreadsChanged, t],
  );

  const handleToggleResolved = React.useCallback(
    (thread: GitHubReviewThread) => {
      if (threadBusy) return;
      setThreadBusy(true);
      void threadAction(directory, repo, number, thread.id, thread.resolved ? { action: 'unresolve' } : { action: 'resolve' }, github)
        .then((result) => {
          if (!result.ok) toast.error(t('Failed to update thread'));
          else {
            toast.success(thread.resolved ? t('Thread reopened') : t('Thread resolved'));
            onThreadsChanged();
          }
        })
        .finally(() => setThreadBusy(false));
    },
    [directory, repo, number, github, threadAction, threadBusy, onThreadsChanged, t],
  );

  const renderAnnotation = React.useCallback(
    (annotation: PullLineAnnotation): React.ReactNode => (
      <div className="flex flex-col gap-1.5 px-3 py-2" contentEditable={false} onPointerDown={(event) => event.stopPropagation()}>
        {annotation.metadata.threads.map((thread) => (
          <ReviewThreadCard
            key={thread.id}
            thread={thread}
            replyAllowed={replyGate.allowed}
            replyDisabledReason={replyGate.reason}
            resolveAllowed={resolveGate.allowed}
            resolveDisabledReason={resolveGate.reason}
            busy={threadBusy}
            onReply={(body) => handleReply(thread, body)}
            onToggleResolved={() => handleToggleResolved(thread)}
          />
        ))}
        {annotation.metadata.pendings.map((pending) => (
          <PendingReviewCommentCard
            key={pending.id}
            comment={pending}
            onRemove={() => removePendingComment(repo, number, pending.id)}
          />
        ))}
        {annotation.metadata.draft ? (
          <InlineDraftBox
            path={file.filename}
            line={annotation.metadata.draft.realLine}
            sendingToAgent={sendingKey === `${fileKey}-draft-agent`}
            onCancel={() => setDraft(null)}
            onAddToReview={(body) => {
              const target = annotation.metadata.draft;
              if (!target) return;
              addPendingComment(repo, number, {
                path: file.filename,
                body,
                line: target.realLine,
                side: target.realSide,
              });
              setDraft(null);
              toast.success(t('Added to review'));
            }}
            onSendToAgent={(body) => {
              const target = annotation.metadata.draft;
              if (!target) return;
              void send({
                key: `${fileKey}-draft-agent`,
                kind: 'lines',
                directory,
                repo,
                number,
                contextType: 'pr',
                contextOptions: { includeDiff: true },
                detail: `${file.filename} line ${target.realLine} ("${body.trim()}")`,
              });
            }}
          />
        ) : null}
      </div>
    ),
    [replyGate.allowed, replyGate.reason, resolveGate.allowed, resolveGate.reason, threadBusy, handleReply, handleToggleResolved, removePendingComment, addPendingComment, repo, number, file.filename, fileKey, sendingKey, directory, send, t],
  );

  return (
    <article className="overflow-hidden rounded-md border border-border/60">
      <div className="sticky top-8 z-[5] flex items-center gap-1.5 bg-[var(--surface-muted)] px-2 py-1.5">
        <Button type="button" variant="ghost" size="icon" onClick={() => onToggleCollapse(file.filename)} aria-label={collapsed ? t('Expand {{path}}', { path: file.filename }) : t('Collapse {{path}}', { path: file.filename })} title={collapsed ? t('Expand') : t('Collapse')} className="size-6">
          <Icon name={collapsed ? 'arrow-right-s' : 'arrow-down-s'} className="size-4" />
        </Button>
        <Icon name={statusIconForFile(statusKind)} className={cn('size-3.5 shrink-0', statusTintForFile(statusKind))} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-mono typography-micro" title={file.filename}>
          {dir ? <span className="text-muted-foreground">{dir}/</span> : null}
          <span className="text-foreground">{base}</span>
        </span>
        {statusKind !== 'other' ? (
          <span className={cn('shrink-0 rounded px-1 font-mono typography-micro', statusTintForFile(statusKind))} title={file.status ?? undefined}>
            {statusLetterForFile(statusKind)}
          </span>
        ) : null}
        <GitHubDiffStat additions={file.additions} deletions={file.deletions} className="typography-micro" />
        {threads.length > 0 || filePendings.length > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1 typography-micro text-muted-foreground" title={(threads.length === 1 ? t('{{count}} conversation', { count: threads.length }) : t('{{count}} conversations', { count: threads.length })) + (filePendings.length > 0 ? ', ' + t('{{count}} pending', { count: filePendings.length }) : '')}>
            <Icon name="chat-1" className="size-3.5" aria-hidden="true" />
            {threads.length > 0 ? <span className="tabular-nums">{openThreadCount > 0 ? openThreadCount : threads.length}</span> : null}
            {filePendings.length > 0 ? <span className="tabular-nums">+{filePendings.length}</span> : null}
          </span>
        ) : null}
        <span className="inline-flex shrink-0 items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
          <Checkbox
            checked={viewed}
            onChange={(next) => onToggleViewed(file.filename, next)}
            ariaLabel={viewed ? t('Mark {{path}} as not viewed', { path: file.filename }) : t('Mark {{path}} as viewed', { path: file.filename })}
          />
          <span className="typography-micro text-muted-foreground">{t('Viewed')}</span>
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() =>
            void send({ key: `${fileKey}-agent`, kind: 'file', directory, repo, number, contextType: 'pr', contextOptions: { includeDiff: true }, detail: file.filename })
          }
          disabled={sendingKey === `${fileKey}-agent`}
          aria-label={t('Send {{path}} to agent', { path: file.filename })}
        >
          {t('Send to agent')}
        </Button>
      </div>
      {!collapsed ? (
        <div className="flex flex-col gap-2 p-2">
          {orphans.length > 0 ? (
            <div className="flex flex-col gap-1.5 rounded-md bg-[var(--surface-muted)] px-2 py-2">
              <p className="typography-micro text-muted-foreground">
                {orphans.length === 1 ? t('Other conversations ({{count}}) — this line is no longer in the diff', { count: orphans.length }) : t('Other conversations ({{count}}) — these lines are no longer in the diff', { count: orphans.length })}
              </p>
              {orphans.map((thread) => (
                <ReviewThreadCard
                  key={thread.id}
                  thread={thread}
                  replyAllowed={replyGate.allowed}
                  replyDisabledReason={replyGate.reason}
                  resolveAllowed={resolveGate.allowed}
                  resolveDisabledReason={resolveGate.reason}
                  busy={threadBusy}
                  onReply={(body) => handleReply(thread, body)}
                  onToggleResolved={() => handleToggleResolved(thread)}
                />
              ))}
            </div>
          ) : null}
          {showLargeGate ? (
            <div className="flex items-center gap-2 rounded-md bg-[var(--surface-muted)] px-3 py-3 typography-ui">
              <Icon name="file" className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <p className="min-w-0 flex-1 truncate text-muted-foreground">
                {t('Large diff — {{count}} changed lines', { count: changedLinesForFile(file) })}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => setLargeLoaded(true)}>
                {t('Load diff')}
              </Button>
            </div>
          ) : file.patch ? (
            <div className="min-h-24 overflow-hidden">
              <PierreDiffViewer
                original={original}
                modified={modified}
                language={languageForFile(file.filename)}
                fileName={file.filename}
                renderSideBySide={false}
                layout="inline"
                enableGutterUtility={commentGate.allowed && draft === null}
                enableLineSelection={commentGate.allowed && draft === null}
                onGutterUtilityClick={beginCommentFromRange}
                onLineSelectionEnd={beginCommentFromRange}
                lineAnnotations={annotations as unknown as DiffLineAnnotation<React.ReactNode>[]}
                renderAnnotation={(annotation) => renderAnnotation(annotation as unknown as PullLineAnnotation)}
              />
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-md bg-[var(--surface-muted)] px-3 py-3 typography-ui">
              <Icon name="file" className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <p className="min-w-0 flex-1 text-muted-foreground">{t('Diff not available for this file.')}</p>
              {blobUrl ? (
                <Button type="button" variant="link" size="sm" asChild>
                  <a href={blobUrl} target="_blank" rel="noreferrer">
                    {t('Open on GitHub')}
                  </a>
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </article>
  );
};

/**
 * Memoized so toggling one file's collapse/viewed state (or typing in the
 * jump-list filter) does not re-render every other file's diff card. Props
 * are per-file values plus stable parent callbacks; `threads` arrays keep
 * their reference from the parent's memoized path map.
 */
export const FileCard = React.memo(FileCardInner);
