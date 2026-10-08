import React from 'react';
import i18n from '@/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { toast } from '@/components/ui';
import type { GitAPI, GitHubAPI } from '@/lib/api/types';
import { buildIssueAgentPromptText, issueWorktreeBranchName, slugifyIssueBranchPart } from '../issues/issueLogic';
import { buildGitHubLinkSyntheticText } from './githubLink';
import { refreshWorktreeTopology } from './refreshWorktreeTopology';

/**
 * Start a session from a GitHub issue or pull request.
 *
 * - `current`: opens a new-session draft in the current checkout whose
 *   composer is pre-filled (never sent) with the issue context.
 * - `worktree`: creates `issue-<n>-<slug>` (or `pr-<n>-<slug>`) through the
 *   existing worktree service (`RuntimeAPIs.git.createGitWorktree` — the same
 *   server `createWorktree` the composer worktree flow uses), then opens the
 *   draft targeted at the new checkout. A leftover local branch for the same
 *   item is reused (attaching via `mode: 'existing'`, or reusing the live
 *   worktree path when the branch is still checked out), never recreated.
 *
 * Both paths seed `initialPrompt` (visible, editable) plus `syntheticParts`
 * (the transcript chip link + the full quoted server `context` payload, so
 * the agent receives it on send). The draft is never sent automatically.
 *
 * Reusable across surfaces: the PR surface calls the same
 * `startSessionFromGitHubItem` with `kind: 'pr'`.
 *
 * Session-metadata gap: `openNewSessionDraft` carries no metadata channel and
 * `createSession` metadata has no clean linked-issue key, so the link is
 * recorded in the draft title plus the synthetic chip part — not in session
 * metadata. Session rows therefore do not show a linked-issue badge.
 */

export type StartSessionTarget = 'current' | 'worktree';

export type StartSessionItemInput = {
  directory: string;
  repo: string;
  number: number;
  kind: 'issue' | 'pr';
  title: string;
  url: string;
  target: StartSessionTarget;
};

export type StartSessionDeps = {
  github: GitHubAPI;
  git?: Partial<Pick<GitAPI, 'getGitBranches' | 'createGitWorktree' | 'listGitWorktrees'>> | null;
  /** Re-lists the owning project's worktrees so the sidebar shows a new one immediately. */
  refreshWorktrees?: (directory: string) => Promise<void>;
  openDraft?: (options: {
    directoryOverride?: string | null;
    title?: string;
    initialPrompt?: string;
    syntheticParts?: Array<{ text: string; synthetic?: boolean }>;
  }) => void;
};

export const branchNameForGitHubItem = (input: {
  kind: 'issue' | 'pr';
  number: number;
  title: string;
}): string => {
  const slug = slugifyIssueBranchPart(input.title);
  return input.kind === 'pr' ? `pr-${input.number}-${slug}` : issueWorktreeBranchName(input.number, input.title);
};

/** Core sequencing, dependency-injected for tests. Never sends. */
export const startSessionFromGitHubItem = async (
  input: StartSessionItemInput,
  deps: StartSessionDeps,
): Promise<{ ok: true; directory: string } | { ok: false; error: string }> => {
  const { github, git, openDraft, refreshWorktrees } = deps;
  if (!openDraft) return { ok: false, error: i18n.t('Sessions are not available in this runtime') };

  let contextText: string;
  try {
    const context = await github.agentContext(
      input.directory,
      input.repo,
      input.kind === 'pr' ? 'pr' : 'issue',
      input.number,
    );
    contextText = context.text;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : i18n.t('Failed to load issue context') };
  }

  const kindLabel = input.kind === 'pr' ? 'PR' : 'Issue';
  const title = `${kindLabel} #${input.number}: ${input.title.trim() || '(untitled)'}`;
  const initialPrompt = input.kind === 'pr'
    ? `Work on this GitHub pull request. Read the quoted context below, then propose a plan and wait for confirmation before changing code.\n\nPR #${input.number}: ${input.title}\n${input.url}\n\n${contextText}`
    : buildIssueAgentPromptText({
        repo: input.repo,
        number: input.number,
        title: input.title,
        url: input.url,
        contextText,
      });
  const syntheticParts = [
    {
      text: buildGitHubLinkSyntheticText({
        kind: input.kind,
        number: input.number,
        title: input.title,
        url: input.url,
      }),
      synthetic: true,
    },
    { text: contextText, synthetic: true },
  ];

  if (input.target === 'current') {
    openDraft({ directoryOverride: input.directory, title, initialPrompt, syntheticParts });
    return { ok: true, directory: input.directory };
  }

  // New worktree through the existing worktree service — no duplicated flow.
  if (!git?.getGitBranches || !git?.createGitWorktree) {
    return { ok: false, error: i18n.t('Worktree creation is not available in this runtime') };
  }
  let startRef: string;
  let hasLocalBranch = false;
  try {
    const branches = await git.getGitBranches(input.directory);
    startRef = branches.current?.trim() ?? '';
    if (!startRef) throw new Error('no current branch');
    hasLocalBranch = Array.isArray(branches.all) && branches.all.includes(branchNameForGitHubItem(input));
  } catch {
    return { ok: false, error: i18n.t('Could not determine the current branch to start the worktree from') };
  }
  const branchName = branchNameForGitHubItem(input);
  let path: string;
  try {
    if (hasLocalBranch) {
      let reusedPath: string | null = null;
      if (git.listGitWorktrees) {
        try {
          const worktrees = await git.listGitWorktrees(input.directory);
          reusedPath = Array.isArray(worktrees)
            ? (worktrees.find((entry) => !entry?.prunable && entry?.branch === branchName)?.path ?? null)
            : null;
        } catch {
          reusedPath = null;
        }
      }
      if (reusedPath) {
        path = reusedPath;
      } else {
        const created = await git.createGitWorktree(input.directory, { mode: 'existing', existingBranch: branchName });
        path = created.path;
        if (!path) throw new Error('worktree path missing');
      }
    } else {
      const created = await git.createGitWorktree(input.directory, { mode: 'new', startRef, branchName });
      path = created.path;
      if (!path) throw new Error('worktree path missing');
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : i18n.t('Worktree creation failed') };
  }
  // Register the new worktree in the sidebar before the draft opens there.
  await refreshWorktrees?.(input.directory);
  openDraft({ directoryOverride: path, title, initialPrompt, syntheticParts });
  return { ok: true, directory: path };
};

export const useStartSessionFromGitHubItem = () => {
  const apis = useRuntimeAPIs();
  const openDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const [startingKey, setStartingKey] = React.useState<string | null>(null);

  const start = React.useCallback(
    async (input: Omit<StartSessionItemInput, 'target'> & { target: StartSessionTarget }): Promise<boolean> => {
      const github = apis.github;
      if (!github) {
        toast.error(i18n.t('GitHub is not available in this runtime'));
        return false;
      }
      const key = `${input.repo}#${input.number}:${input.target}`;
      setStartingKey(key);
      try {
        const result = await startSessionFromGitHubItem(input, {
          github,
          git: apis.git ?? null,
          refreshWorktrees: (directory) => refreshWorktreeTopology(directory, apis.git),
          openDraft: (options) => openDraft(options),
        });
        if (!result.ok) {
          toast.error(result.error);
          return false;
        }
        toast.success(input.target === 'worktree' ? i18n.t('Worktree ready — session draft opened') : i18n.t('Session draft opened'));
        return true;
      } finally {
        setStartingKey(null);
      }
    },
    [apis.github, apis.git, openDraft],
  );

  return { start, startingKey };
};
