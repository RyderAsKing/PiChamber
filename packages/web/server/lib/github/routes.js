/** Thin Express adapter for `/api/github/*` (§5.3). See DOCUMENTATION.md. */

import { createChecksService } from './checks.js';
import { createGitHubClient } from './client.js';
import { createContextBuilder } from './context.js';
import { createCredentialStore } from './credential.js';
import {
  failed,
  inputError,
  isGitHubIntegrationError,
  toErrorBody,
  toHttpStatus,
  unavailable,
} from './errors.js';
import { createGhCli, formatVersion } from './gh-cli.js';
import { createIssuesService } from './issues.js';
import { createPullsService } from './pulls.js';
import { getViewerPermission } from './repo-scope.js';
import { createTemplatesService } from './templates.js';
import { createRepoInfoLoader, createRepoScopeResolver, isValidIssueNumber, parseRepoRef } from './repo-scope.js';

const readTrimmedParam = (req, name) => {
  const fromQuery = Array.isArray(req.query?.[name]) ? req.query[name][0] : req.query?.[name];
  const fromBody = typeof req.body?.[name] === 'string' ? req.body[name] : null;
  const value = typeof fromQuery === 'string' && fromQuery.trim() ? fromQuery : fromBody;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const readDirectory = (req) => readTrimmedParam(req, 'directory');

const readRepoParam = (req) => readTrimmedParam(req, 'repo');

// Fork enrichment fan-out is paced so a large scope cannot burst dozens of
// concurrent API calls on first load (repeat loads hit the repo-info cache).
const SCOPE_ENRICH_CONCURRENCY = 4;

const readNumberParam = (req, name = 'number') => {
  const raw = req.params?.[name] ?? req.query?.[name] ?? req.body?.[name];
  return raw;
};

const sendIntegrationError = (res, error) => {
  if (isGitHubIntegrationError(error)) {
    return res.status(toHttpStatus(error)).json(toErrorBody(error));
  }
  console.error('GitHub route failed:', error?.message || error);
  return res.status(502).json({ error: { kind: 'failed', message: 'GitHub request failed unexpectedly.' } });
};

const PR_ACTIONS = new Set(['merge', 'squash', 'rebase', 'ready', 'draft', 'close', 'reopen', 'update-branch']);
const THREAD_ACTIONS = new Set(['reply', 'resolve', 'unresolve']);
const CONTEXT_TYPES = new Set(['issue', 'pr', 'checks', 'threads']);

const slugifyBranchPart = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40) || 'pr';

const loadGitService = async () => {
  try {
    const service = await import('../git/service.js');
    if (typeof service.validateWorktreeCreate === 'function' && typeof service.createWorktree === 'function') {
      return service;
    }
    return null;
  } catch {
    return null;
  }
};

export const createGitHubRoutes = (overrides = {}) => {
  const ghCli = overrides.ghCli || createGhCli();
  const credential = overrides.credential || createCredentialStore({ ghCli });
  const client = overrides.client || createGitHubClient();
  const scopeResolver = overrides.scopeResolver || createRepoScopeResolver();
  const repoInfo = overrides.repoInfo || createRepoInfoLoader({ client });
  const resolveViewer = async (cred) => credential.getViewer(cred, async () => {
    const response = await client.request({ credential: cred, host: cred.host, method: 'GET', path: '/user', operation: 'viewer lookup' });
    const login = response.body?.login;
    if (typeof login !== 'string' || !login) throw failed('Could not resolve the signed-in GitHub user.');
    return login;
  }).catch(() => null);
  const resolvePermission = (cred, repo) => getViewerPermission(
    (credential, repoRef) => repoInfo.getRepoInfo(credential, repoRef),
    cred,
    repo,
  );
  const pulls = overrides.pulls || createPullsService({ client, resolveViewer, resolvePermission });
  const issues = overrides.issues || createIssuesService({ client, resolveViewer, resolvePermission });
  const checks = overrides.checks || createChecksService({ client });
  const templates = overrides.templates || createTemplatesService({ client });
  const contextBuilder = overrides.contextBuilder || createContextBuilder();
  const gitRunner = overrides.gitRunner || null;

  const runGitForCheckout = async (cwd, args) => {
    if (gitRunner) return gitRunner(cwd, args);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    try {
      const result = await execFileAsync('git', args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' },
        timeout: 60_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { success: true, stdout: String(result?.stdout || '') };
    } catch (error) {
      return { success: false, stdout: String(error?.stdout || ''), message: String(error?.message || 'Git command failed') };
    }
  };

  // Best-effort safe fast-forward of a leftover local branch to the fetched
  // PR head: only moves when the branch is an ancestor of the head, so local
  // commits or divergence are never discarded.
  const fastForwardBranchToHeadIfSafe = async (cwd, branch, head) => {
    const ancestor = await runGitForCheckout(cwd, ['merge-base', '--is-ancestor', branch, head]);
    if (!ancestor.success) return;
    await runGitForCheckout(cwd, ['branch', '-f', branch, head]);
  };

  /**
   * Resolve directory → scope → allow-listed repo → pinned credential, then
   * run the handler. Rejects unknown repos with `no-access`.
   */
  const withRepoContext = async (req, res, handler) => {
    try {
      const directory = readDirectory(req);
      if (!directory) {
        return res.status(400).json({ error: { kind: 'failed', message: 'directory parameter is required.' } });
      }
      const repoParam = readRepoParam(req);
      if (!repoParam) {
        return res.status(400).json({ error: { kind: 'failed', message: 'repo parameter is required (host/owner/name).' } });
      }
      if (!parseRepoRef(repoParam)) {
        return res.status(400).json({ error: { kind: 'failed', message: 'repo must be host/owner/name with valid owner and repo names.' } });
      }
      const scope = await scopeResolver.resolveScope(directory);
      const entry = scopeResolver.matchAllowedRepo(scope, repoParam);
      if (!entry) {
        return res.status(403).json({ error: { kind: 'unavailable', reason: 'no-access' } });
      }
      const repo = { host: entry.host, owner: entry.owner, repo: entry.repo };
      const payload = await credential.withPinnedCredential(repo.host, (cred) => handler({ scope, entry, repo, credential: cred }));
      return res.json(payload);
    } catch (error) {
      return sendIntegrationError(res, error);
    }
  };

  const withNumber = async (req, res, handler) => withRepoContext(req, res, async (context) => {
    const raw = readNumberParam(req);
    if (!isValidIssueNumber(raw)) {
      throw inputError('Invalid number parameter.');
    }
    return handler({ ...context, number: Number(raw) });
  });

  const handlers = {
    getStatus: async (req, res) => {
      try {
        const binary = await ghCli.resolveGhBinary();
        if (!binary) {
          throw unavailable('gh-missing');
        }
        const version = await ghCli.getVersion().catch(() => null);
        const { hosts } = await ghCli.getAuthState();
        return res.json({
          installed: true,
          version: version ? formatVersion(version) : null,
          hosts: hosts.map((host) => ({
            host: host.host,
            authenticated: host.authenticated === true,
            login: host.login || null,
            scopes: host.scopes || [],
          })),
          fetchedAt: Date.now(),
        });
      } catch (error) {
        return sendIntegrationError(res, error);
      }
    },

    getScope: async (req, res) => {
      try {
        const directory = readDirectory(req);
        if (!directory) {
          return res.status(400).json({ error: { kind: 'failed', message: 'directory parameter is required.' } });
        }
        const scope = await scopeResolver.resolveScope(directory);
        // Best-effort fork enrichment: needs a credential, never fails scope.
        // Every entry is enriched (the UI reads fork/parent/defaultBranch for
        // whichever repository is selected), paced to bound burst load.
        const byHost = new Map();
        for (const entry of scope.repositories) {
          if (!entry.host) continue;
          if (!byHost.has(entry.host)) byHost.set(entry.host, []);
          byHost.get(entry.host).push(entry);
        }
        await Promise.all([...byHost.entries()].map(async ([host, entries]) => {
          try {
            await credential.withPinnedCredential(host, async (cred) => {
              for (let start = 0; start < entries.length; start += SCOPE_ENRICH_CONCURRENCY) {
                await Promise.all(entries.slice(start, start + SCOPE_ENRICH_CONCURRENCY).map(async (entry) => {
                  try {
                    const info = await repoInfo.getRepoInfo(cred, { host: entry.host, owner: entry.owner, repo: entry.repo });
                    entry.fork = info.isFork;
                    entry.parent = info.parent;
                    entry.defaultBranch = info.defaultBranch;
                  } catch {
                    entry.fork = null;
                  }
                }));
              }
            });
          } catch {
            // Unauthenticated: fork stays null, scope still succeeds.
          }
        }));
        return res.json(scope);
      } catch (error) {
        return sendIntegrationError(res, error);
      }
    },

    listPulls: (req, res) => withRepoContext(req, res, ({ repo, credential: cred }) => pulls.listPulls(cred, repo, {
      state: req.query.state || 'open',
      filter: req.query.filter || 'all',
      q: req.query.q || '',
      cursor: req.query.cursor || null,
      sort: req.query.sort || 'updated',
      perPage: req.query.perPage ?? undefined,
    })),

    getPull: (req, res) => withNumber(req, res, ({ repo, credential: cred, number }) => pulls.getPull(cred, repo, number)),

    listPullFiles: (req, res) => withNumber(req, res, ({ repo, credential: cred, number }) => pulls.listFiles(cred, repo, number, {
      cursor: req.query.cursor || null,
    })),

    // Head SHA comes from one single-resource read, not the detail fan-out.
    getPullChecks: (req, res) => withNumber(req, res, async ({ repo, credential: cred, number }) => {
      const headSha = await pulls.getPullHeadSha(cred, repo, number);
      return checks.getChecks(cred, repo, headSha, { details: req.query.details === 'full' });
    }),

    getPrStatus: async (req, res) => {
      try {
        const directory = readDirectory(req);
        if (!directory) {
          return res.status(400).json({ error: { kind: 'failed', message: 'directory parameter is required.' } });
        }
        const requestedBranch = typeof req.query.branch === 'string' && req.query.branch.trim() ? req.query.branch.trim() : null;
        const scope = await scopeResolver.resolveScope(directory);
        const branch = requestedBranch || scope.branch;
        if (!branch) {
          return res.json({ branch: null, pr: null, checks: null, fetchedAt: Date.now() });
        }
        const containing = scope.repositories.find((entry) => entry.kind === 'containing' && entry.host);
        if (!containing) {
          throw unavailable(scope.topLevel ? 'not-github' : 'no-repository');
        }
        const repo = { host: containing.host, owner: containing.owner, repo: containing.repo };
        const payload = await credential.withPinnedCredential(repo.host, async (cred) => {
          let defaultBranch = containing.defaultBranch || null;
          if (!defaultBranch) {
            try {
              const info = await repoInfo.getRepoInfo(cred, repo);
              defaultBranch = info.defaultBranch;
            } catch {
              defaultBranch = null;
            }
          }
          if (defaultBranch && branch === defaultBranch) {
            return { repo, branch, pr: null, skippedDefaultBranch: true, defaultBranch, fetchedAt: Date.now() };
          }
          const found = await pulls.findPullForBranch(cred, repo, { branch, headOwner: repo.owner, defaultBranch });
          if (!found.pr || found.pr.state !== 'open' || !found.pr.headSha) {
            return { repo, branch, pr: found.pr, defaultBranch, fetchedAt: found.fetchedAt };
          }
          const checkResult = await checks.getChecks(cred, repo, found.pr.headSha, { details: false }).catch(() => null);
          return {
            repo, branch, pr: found.pr,
            checks: checkResult?.summary || null,
            defaultBranch,
            fetchedAt: Date.now(),
            ...(checkResult?.stale ? { checksStale: true } : {}),
          };
        });
        return res.json(payload);
      } catch (error) {
        return sendIntegrationError(res, error);
      }
    },

    createPull: (req, res) => withRepoContext(req, res, ({ repo, credential: cred }) => pulls.createPull(cred, repo, {
      title: req.body?.title,
      head: req.body?.head,
      base: req.body?.base,
      body: req.body?.body,
      draft: req.body?.draft,
    })),

    runPullAction: (req, res) => withNumber(req, res, ({ repo, credential: cred, number }) => {
      const action = String(req.body?.action || '').trim();
      if (!PR_ACTIONS.has(action)) {
        throw inputError('Unknown pull request action.');
      }
      return pulls.runAction(cred, repo, number, action, { expectedHeadSha: req.body?.expectedHeadSha });
    }),

    listPullComments: (req, res) => withNumber(req, res, ({ repo, credential: cred, number }) => pulls.listPullComments(cred, repo, number, {
      cursor: req.query.cursor || null,
    })),

    commentOnPull: (req, res) => withNumber(req, res, ({ repo, credential: cred, number }) => pulls.postComment(cred, repo, number, {
      body: req.body?.body,
    })),

    reviewPull: (req, res) => withNumber(req, res, ({ repo, credential: cred, number }) => pulls.submitReview(cred, repo, number, {
      event: req.body?.event,
      body: req.body?.body,
      comments: req.body?.comments,
      commitId: req.body?.commitId,
    })),

    threadAction: async (req, res) => {
      const threadId = req.params.threadId;
      const action = String(req.body?.action || '').trim();
      if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 200 || !THREAD_ACTIONS.has(action)) {
        return res.status(400).json({ error: { kind: 'failed', message: 'A valid thread id and action (reply|resolve|unresolve) are required.' } });
      }
      return withNumber(req, res, ({ repo, credential: cred, number }) => {
        if (action === 'reply') {
          const commentId = Number(req.body?.commentId ?? threadId);
          if (!isValidIssueNumber(commentId)) throw inputError('A numeric comment id is required to reply.');
          return pulls.replyToThread(cred, repo, number, commentId, { body: req.body?.body });
        }
        return pulls.setThreadResolved(cred, repo, number, threadId, action === 'resolve');
      });
    },

    updatePull: (req, res) => withNumber(req, res, ({ repo, credential: cred, number }) => pulls.updatePull(cred, repo, number, {
      title: req.body?.title,
      body: req.body?.body,
    })),

    checkoutPull: (req, res) => withNumber(req, res, async ({ scope, entry, repo, credential: cred, number }) => {
      const mode = req.body?.mode === 'current' ? 'current' : 'worktree';
      const detail = await pulls.getPull(cred, repo, number);
      const headRef = detail.pr?.head;
      if (!headRef) throw failed('Pull request has no head branch.');
      const branchName = `pr-${number}-${slugifyBranchPart(headRef)}`;
      const remoteName = entry.remote || 'origin';
      const fetchResult = await runGitForCheckout(scope.topLevel || scope.directory, ['fetch', remoteName, `refs/pull/${number}/head`]);
      if (!fetchResult.success) {
        throw failed('Could not fetch the pull request head from the remote.');
      }
      const shaResult = await runGitForCheckout(scope.topLevel || scope.directory, ['rev-parse', 'FETCH_HEAD']);
      const headSha = shaResult.success ? shaResult.stdout.trim().split('\n')[0]?.trim() : null;
      if (!headSha) throw failed('Could not resolve the fetched pull request head.');
      const gitService = await loadGitService();
      if (!gitService) {
        throw failed('Pull request checkout is temporarily unavailable while the worktree service is being refactored. The branch fetch succeeded; create the worktree manually from the fetched head.');
      }
      if (mode === 'current') {
        if (typeof gitService.checkoutBranch === 'function') {
          const cwd = scope.topLevel || scope.directory;
          const existing = await runGitForCheckout(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
          if (!existing.success) {
            const create = await runGitForCheckout(cwd, ['branch', branchName, headSha]);
            if (!create.success) throw failed('Could not create the local pull request branch.');
          } else if (typeof gitService.getWorktrees === 'function') {
            try {
              const worktrees = await gitService.getWorktrees(scope.directory);
              const checkedOut = Array.isArray(worktrees) && worktrees.some((entry) => !entry?.prunable && entry?.branch === branchName);
              if (!checkedOut) {
                await fastForwardBranchToHeadIfSafe(cwd, branchName, headSha);
              }
            } catch {
              // Best-effort: checkout still proceeds on the existing branch.
            }
          }
          await gitService.checkoutBranch(scope.directory, branchName, {});
          return { ok: true, mode, branch: branchName, headSha, path: scope.directory, fetchedAt: Date.now() };
        }
        throw failed('Checking out into the current directory is not supported by the worktree service build.');
      }
      const cwd = scope.topLevel || scope.directory;
      const branchExists = await runGitForCheckout(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
      if (branchExists.success) {
        if (typeof gitService.getWorktrees === 'function') {
          try {
            const worktrees = await gitService.getWorktrees(scope.directory);
            const reused = Array.isArray(worktrees)
              ? worktrees.find((entry) => !entry?.prunable && entry?.branch === branchName)
              : null;
            if (reused) {
              return { ok: true, mode, branch: branchName, headSha, path: reused.path, worktree: reused, reused: true, fetchedAt: Date.now() };
            }
          } catch {
            // Fall through to the existing-branch attach below.
          }
        }
        await fastForwardBranchToHeadIfSafe(cwd, branchName, headSha);
        const existingValidation = await gitService.validateWorktreeCreate(scope.directory, { mode: 'existing', existingBranch: branchName });
        if (!existingValidation?.ok) {
          throw failed(existingValidation?.errors?.[0]?.message || 'Worktree creation failed validation.');
        }
        const existingCreated = await gitService.createWorktree(scope.directory, { mode: 'existing', existingBranch: branchName });
        pulls.invalidate(cred, repo, number);
        return { ok: true, mode, branch: branchName, headSha, path: existingCreated?.path || null, worktree: existingCreated || null, fetchedAt: Date.now() };
      }
      const validation = await gitService.validateWorktreeCreate(scope.directory, { mode: 'new', branchName, startRef: headSha });
      if (!validation?.ok) {
        throw failed(validation?.errors?.[0]?.message || 'Worktree creation failed validation.');
      }
      const created = await gitService.createWorktree(scope.directory, { mode: 'new', branchName, startRef: headSha });
      pulls.invalidate(cred, repo, number);
      return { ok: true, mode, branch: branchName, headSha, path: created?.path || null, worktree: created || null, fetchedAt: Date.now() };
    }),

    listIssues: (req, res) => withRepoContext(req, res, ({ repo, credential: cred }) => issues.listIssues(cred, repo, {
      state: req.query.state || 'open',
      filter: req.query.filter || 'all',
      q: req.query.q || '',
      labels: req.query.labels || '',
      cursor: req.query.cursor || null,
      sort: req.query.sort || 'updated',
      perPage: req.query.perPage ?? undefined,
    })),

    getIssue: (req, res) => withNumber(req, res, ({ repo, credential: cred, number }) => issues.getIssue(cred, repo, number)),

    listIssueComments: (req, res) => withNumber(req, res, ({ repo, credential: cred, number }) => issues.listComments(cred, repo, number, {
      cursor: req.query.cursor || null,
    })),

    createIssue: (req, res) => withRepoContext(req, res, ({ repo, credential: cred }) => issues.createIssue(cred, repo, {
      title: req.body?.title,
      body: req.body?.body,
      labels: req.body?.labels,
      assignees: req.body?.assignees,
      milestone: req.body?.milestone,
    })),

    updateIssue: (req, res) => withNumber(req, res, ({ repo, credential: cred, number }) => issues.updateIssue(cred, repo, number, {
      title: req.body?.title,
      body: req.body?.body,
      state: req.body?.state,
      stateReason: req.body?.stateReason,
      labels: req.body?.labels,
      assignees: req.body?.assignees,
      milestone: req.body?.milestone,
    })),

    commentOnIssue: (req, res) => withNumber(req, res, ({ repo, credential: cred, number }) => issues.postComment(cred, repo, number, {
      body: req.body?.body,
    })),

    getTemplates: (req, res) => withRepoContext(req, res, ({ repo, credential: cred }) => templates.listIssueTemplates(cred, repo)),

    getMeta: (req, res) => withRepoContext(req, res, ({ repo, credential: cred }) => {
      const kinds = typeof req.query.kinds === 'string' && req.query.kinds
        ? req.query.kinds.split(',').map((kind) => kind.trim()).filter(Boolean)
        : ['labels', 'assignees'];
      return issues.listMeta(cred, repo, { kinds });
    }),

    getJobSteps: (req, res) => withRepoContext(req, res, ({ repo, credential: cred }) => checks.getJobSteps(cred, repo, {
      runId: req.query.runId,
      jobId: req.query.jobId ?? null,
    })),

    getAnnotations: (req, res) => withRepoContext(req, res, ({ repo, credential: cred }) => checks.getAnnotations(cred, repo, {
      checkRunId: req.query.checkRunId,
    })),

    rerunFailed: (req, res) => withRepoContext(req, res, ({ repo, credential: cred }) => checks.rerunFailed(cred, repo, {
      runId: req.body?.runId,
    })),

    getContext: (req, res) => withRepoContext(req, res, async ({ repo, credential: cred }) => {
      const type = String(req.query.type || '').trim();
      if (!CONTEXT_TYPES.has(type)) {
        throw inputError('Context type must be issue, pr, checks, or threads.');
      }
      const rawNumber = req.query.number;
      if (!isValidIssueNumber(rawNumber)) throw inputError('A valid number is required.');
      const number = Number(rawNumber);
      // Partial reads stay partial: a failed comments/files fetch is marked
      // in the context text, never silently rendered as "no comments".
      const withWarning = (promise, label) => promise.then(
        (page) => ({ page, warning: null }),
        (error) => ({ page: null, warning: `${label} could not be loaded (${error?.message || 'GitHub request failed'})` }),
      );
      if (type === 'issue') {
        const [detail, commentsResult] = await Promise.all([
          issues.getIssue(cred, repo, number),
          withWarning(issues.listComments(cred, repo, number, {}), 'Comments'),
        ]);
        const warnings = commentsResult.warning ? [commentsResult.warning] : [];
        return { ...contextBuilder.buildIssueContext({ repo, issue: detail.issue, comments: commentsResult.page?.comments || [], warnings }), repo, number, fetchedAt: Date.now() };
      }
      if (type === 'pr') {
        const includeDiff = req.query.includeDiff === 'true' || req.query.includeDiff === '1';
        const [detail, filesResult] = await Promise.all([
          pulls.getPull(cred, repo, number),
          withWarning(pulls.listFiles(cred, repo, number, {}), 'Changed files'),
        ]);
        const warnings = filesResult.warning ? [filesResult.warning] : [];
        return { ...contextBuilder.buildPullContext({ repo, pr: detail.pr, files: filesResult.page?.files || [], threads: detail.threads || [], includeDiff, warnings }), repo, number, fetchedAt: Date.now() };
      }
      if (type === 'threads') {
        const detail = await pulls.getPull(cred, repo, number);
        return { ...contextBuilder.buildReviewThreadsContext({ repo, number, threads: detail.threads || [] }), repo, number, fetchedAt: Date.now() };
      }
      const ref = typeof req.query.ref === 'string' && req.query.ref.trim() ? req.query.ref.trim() : null;
      let checkData = null;
      if (type === 'checks') {
        if (ref) {
          checkData = await checks.getChecks(cred, repo, ref, { details: true });
        } else {
          const detail = await pulls.getPull(cred, repo, number);
          if (!detail.pr?.headSha) throw failed('Pull request has no head commit to check.');
          checkData = await checks.getChecks(cred, repo, detail.pr.headSha, { details: true });
        }
        return { ...contextBuilder.buildFailedChecksContext({ repo, ref: checkData.ref, checks: checkData }), repo, number, fetchedAt: Date.now() };
      }
      throw failed('Unknown context type.');
    }),

    invalidate: async (req, res) => {
      try {
        const directory = readDirectory(req);
        const repoParam = readRepoParam(req);
        const kind = typeof req.body?.kind === 'string' ? req.body.kind : (typeof req.query?.kind === 'string' ? req.query.kind : null);
        const rawNumber = req.body?.number ?? req.query?.number;
        const number = rawNumber !== undefined && rawNumber !== null ? Number(rawNumber) : null;
        if (directory) scopeResolver.invalidate(directory);
        else scopeResolver.invalidate();
        const parsed = repoParam ? parseRepoRef(repoParam) : null;
        const repo = parsed ? { host: parsed.host, owner: parsed.owner, repo: parsed.repo } : null;
        if (!kind || kind === 'pulls' || kind === 'all') pulls.invalidate(null, repo, Number.isInteger(number) ? number : null);
        if (!kind || kind === 'issues' || kind === 'all') issues.invalidate(null, repo, Number.isInteger(number) ? number : null);
        if (!kind || kind === 'checks' || kind === 'all') checks.invalidate(null, repo);
        if (!kind || kind === 'repo' || kind === 'all') repoInfo.invalidate(null, repo);
        if (!kind || kind === 'repo' || kind === 'all') templates.invalidate(null, repo);
        credential.invalidateViewer();
        return res.json({ ok: true, fetchedAt: Date.now() });
      } catch (error) {
        return sendIntegrationError(res, error);
      }
    },
  };

  return {
    ...handlers,
    _internals: { withRepoContext, ghCli, credential, client, scopeResolver, repoInfo, pulls, issues, checks },
  };
};

export const registerGitHubRoutes = (app, dependencies = {}) => {
  const routes = createGitHubRoutes(dependencies);

  app.get('/api/github/status', routes.getStatus);
  app.get('/api/github/scope', routes.getScope);
  app.get('/api/github/pulls', routes.listPulls);
  app.get('/api/github/pulls/:number', routes.getPull);
  app.get('/api/github/pulls/:number/files', routes.listPullFiles);
  app.get('/api/github/pulls/:number/checks', routes.getPullChecks);
  app.get('/api/github/pr-status', routes.getPrStatus);
  app.post('/api/github/pulls', routes.createPull);
  app.post('/api/github/pulls/:number/actions', routes.runPullAction);
  app.get('/api/github/pulls/:number/comments', routes.listPullComments);
  app.post('/api/github/pulls/:number/comments', routes.commentOnPull);
  app.post('/api/github/pulls/:number/reviews', routes.reviewPull);
  app.post('/api/github/pulls/:number/threads/:threadId', routes.threadAction);
  app.patch('/api/github/pulls/:number', routes.updatePull);
  app.post('/api/github/pulls/:number/checkout', routes.checkoutPull);
  app.get('/api/github/issues', routes.listIssues);
  app.get('/api/github/issues/:number', routes.getIssue);
  app.get('/api/github/issues/:number/comments', routes.listIssueComments);
  app.post('/api/github/issues', routes.createIssue);
  app.patch('/api/github/issues/:number', routes.updateIssue);
  app.post('/api/github/issues/:number/comments', routes.commentOnIssue);
  app.get('/api/github/meta', routes.getMeta);
  app.get('/api/github/templates', routes.getTemplates);
  app.get('/api/github/checks/jobs', routes.getJobSteps);
  app.get('/api/github/checks/annotations', routes.getAnnotations);
  app.post('/api/github/checks/rerun', routes.rerunFailed);
  app.get('/api/github/context', routes.getContext);
  app.post('/api/github/invalidate', routes.invalidate);

  return routes;
};
