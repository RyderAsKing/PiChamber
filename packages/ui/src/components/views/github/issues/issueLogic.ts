import i18n from '@/i18n';
import type { GitHubIssue } from '@/lib/api/types';
import type { IssueStatePatch } from '@/stores/useGitHubIssuesStore';
import {
  gateCommentAccess,
  requiresPush,
  requiresPushOrAuthor,
  titleValidationError,
  type ViewerAccess,
} from '../githubPermissions';

/**
 * Pure list/detail helpers for the Issues surface.
 * Kept free of React/store imports so unit tests stay self-contained.
 */

export const ISSUE_STATE_TABS = [
  { id: 'open', label: 'Open' },
  { id: 'closed', label: 'Closed' },
  { id: 'all', label: 'All' },
] as const;

export const ISSUE_INVOLVEMENT_TABS = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'Created by me' },
  { id: 'assigned', label: 'Assigned to me' },
  { id: 'mentioned', label: 'Mentioned' },
] as const;

export const ISSUE_SORT_OPTIONS = [
  { id: 'updated', label: 'Recently updated' },
  { id: 'newest', label: 'Newest' },
  { id: 'oldest', label: 'Oldest' },
] as const;

export type IssueCloseReason = 'completed' | 'not_planned';

export const CLOSE_REASON_OPTIONS: Array<{ id: IssueCloseReason; label: string }> = [
  { id: 'completed', label: 'Completed' },
  { id: 'not_planned', label: 'Not planned' },
];

export type IssueActionGate = { allowed: boolean; reason: string | null };

/**
 * Permission gating for issue actions. Close/reopen and title/body edits
 * allow the author on their own issue; labels/assignees require push;
 * comments require read access.
 */
export const gateIssueAction = (
  action: 'close' | 'reopen' | 'edit' | 'labels' | 'assignees' | 'comment',
  issue: Pick<GitHubIssue, 'state'> | null,
  access?: ViewerAccess,
): IssueActionGate => {
  if (!issue && action !== 'comment') return { allowed: false, reason: i18n.t('Issue is still loading') };
  switch (action) {
    case 'close':
      if (issue?.state === 'closed') return { allowed: false, reason: i18n.t('Already closed') };
      if (requiresPushOrAuthor(access)) return { allowed: false, reason: i18n.t('You need write access or be the author to close') };
      return { allowed: true, reason: null };
    case 'reopen':
      if (issue?.state !== 'closed') return { allowed: false, reason: i18n.t('Already open') };
      if (requiresPushOrAuthor(access)) return { allowed: false, reason: i18n.t('You need write access or be the author to reopen') };
      return { allowed: true, reason: null };
    case 'edit':
      if (requiresPushOrAuthor(access)) return { allowed: false, reason: i18n.t('You need write access or be the author to edit') };
      return { allowed: true, reason: null };
    case 'labels':
      if (requiresPush(access)) return { allowed: false, reason: i18n.t('You need write access to change labels') };
      return { allowed: true, reason: null };
    case 'assignees':
      if (requiresPush(access)) return { allowed: false, reason: i18n.t('You need write access to change assignees') };
      return { allowed: true, reason: null };
    case 'comment':
      return gateCommentAccess(access);
    default:
      return { allowed: true, reason: null };
  }
};

/** Confirm-popover copy for issue Close/Reopen (same titles/consequences/progress shape as the PR actions). */
export const issueStateConfirmCopy = (
  action: 'close-completed' | 'close-not-planned' | 'reopen',
  number: number,
): { title: string; detail: string; confirm: string; progress: string } => {
  switch (action) {
    case 'close-not-planned':
      return {
        title: i18n.t('Close issue #{{number}} as not planned?', { number }),
        detail: i18n.t('The issue will close without being completed. You can reopen it later.'),
        confirm: i18n.t('Close as not planned'),
        progress: i18n.t('Closing…'),
      };
    case 'reopen':
      return {
        title: i18n.t('Reopen issue #{{number}}?', { number }),
        detail: i18n.t('The issue will return to its previous open state.'),
        confirm: i18n.t('Reopen issue'),
        progress: i18n.t('Reopening…'),
      };
    case 'close-completed':
    default:
      return {
        title: i18n.t('Close issue #{{number}} as completed?', { number }),
        detail: i18n.t('The issue will be recorded as completed. You can reopen it later.'),
        confirm: i18n.t('Close as completed'),
        progress: i18n.t('Closing…'),
      };
  }
};

/** Build the state patch the store sends for Close/Reopen. */
export const buildIssueStatePatch = (
  action: 'close-completed' | 'close-not-planned' | 'reopen',
): IssueStatePatch => {
  if (action === 'reopen') return { state: 'open' };
  return { state: 'closed', stateReason: action === 'close-not-planned' ? 'not_planned' : 'completed' };
};

export type CreateIssueValidation = {
  ok: boolean;
  errors: Partial<Record<'title' | 'body', string>>;
};

export const validateCreateIssue = (input: { title: string; body?: string }): CreateIssueValidation => {
  const errors: CreateIssueValidation['errors'] = {};
  const titleError = titleValidationError(input.title, 300);
  if (titleError) errors.title = titleError;
  if (input.body !== undefined && input.body.length > 200_000) errors.body = i18n.t('Body is too long');
  return { ok: Object.keys(errors).length === 0, errors };
};

/** Apply a repository template body to the new-issue draft. The server
 * already strips front matter; a template never overwrites text the user
 * already typed — it fills an empty body or appends after a blank line. */
export const applyIssueTemplateBody = (currentBody: string, templateBody: string): string => {
  if (!currentBody.trim()) return templateBody;
  if (!templateBody.trim()) return currentBody;
  return `${currentBody.replace(/\s+$/, '')}\n\n${templateBody}`;
};

/** Branch slug for "start session from issue": `issue-<n>-<slug>`. */
export const slugifyIssueBranchPart = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'issue';

export const issueWorktreeBranchName = (number: number, title: string): string =>
  `issue-${number}-${slugifyIssueBranchPart(title)}`;

export type ParsedGitHubLink =
  | { kind: 'issue'; number: number; owner: string; repo: string }
  | { kind: 'pr'; number: number; owner: string; repo: string };

/**
 * Parse composer link input: `#123`, `owner/repo#123`, or a GitHub URL for a
 * repository in scope. Returns null for anything else; out-of-scope
 * repositories are reported through `outOfScope` so the picker can explain
 * instead of guessing.
 */
export const parseGitHubLinkInput = (
  raw: string,
  scopeRepos: Array<{ owner: string | null; repo: string | null; ref: string }>,
): { link: ParsedGitHubLink | null; outOfScope: boolean } => {
  const input = raw.trim();
  if (!input) return { link: null, outOfScope: false };

  const shortMatch = input.match(/^#(\d{1,7})$/);
  if (shortMatch) {
    return { link: { kind: 'issue', number: Number(shortMatch[1]), owner: '', repo: '' }, outOfScope: false };
  }

  const qualifiedMatch = input.match(/^([\w.-]+)\/([\w.-]+)#(\d{1,7})$/);
  if (qualifiedMatch) {
    const owner = qualifiedMatch[1].toLowerCase();
    const repo = qualifiedMatch[2].toLowerCase();
    const number = Number(qualifiedMatch[3]);
    const inScope = scopeRepos.some(
      (entry) => entry.owner?.toLowerCase() === owner && entry.repo?.toLowerCase() === repo,
    );
    if (!inScope) return { link: null, outOfScope: true };
    return { link: { kind: 'issue', number, owner, repo }, outOfScope: false };
  }

  const urlMatch = input.match(
    /^https?:\/\/([^/]+)\/([\w.-]+)\/([\w.-]+)\/(issues|pull)\/(\d{1,7})(?:[/?#].*)?$/i,
  );
  if (urlMatch) {
    const host = urlMatch[1].toLowerCase();
    const owner = urlMatch[2].toLowerCase();
    const repo = urlMatch[3].toLowerCase().replace(/\.git$/, '');
    const kind = urlMatch[4].toLowerCase() === 'pull' ? 'pr' : 'issue';
    const number = Number(urlMatch[5]);
    const inScope = scopeRepos.some(
      (entry) => entry.ref.toLowerCase() === `${host}/${owner}/${repo}`,
    );
    if (!inScope) return { link: null, outOfScope: true };
    return { link: { kind, number, owner, repo }, outOfScope: false };
  }

  return { link: null, outOfScope: false };
};

export const buildIssueAgentPromptText = (input: {
  repo: string;
  number: number;
  title: string;
  url: string;
  contextText: string;
}): string => {
  return `Work on this GitHub issue. Read the quoted context below, then propose a plan and wait for confirmation before changing code.\n\nIssue #${input.number}: ${input.title}\n${input.url}\n\n${input.contextText}`;
};

