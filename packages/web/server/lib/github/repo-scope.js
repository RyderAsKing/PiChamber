/** Repo scope resolution + shared validation/viewer helpers (§4). See DOCUMENTATION.md. */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createTtlCache } from './cache.js';
import { isSupportedHost } from './client.js';
import { failed, inputError } from './errors.js';

const defaultExecFileAsync = promisify(execFile);

export const SCOPE_CACHE_TTL_MS = 30_000;
export const REPO_INFO_TTL_MS = 5 * 60_000;
const GIT_TIMEOUT_MS = 10_000;

const FAIL_CLOSED_GIT_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
});

const NESTED_MAX_DEPTH = 4;
const NESTED_MAX_REPOS = 50;
const NESTED_MAX_DIRS = 5000;
const NESTED_BUDGET_MS = 2000;

const SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  'target', 'vendor', '__pycache__', '.venv', 'venv', '.tox', '.gradle',
  '.idea', '.vscode', 'Pods', 'DerivedData',
]);

export const OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]+$/;
const MAX_OWNER_REPO_LENGTH = 100;

export const isValidOwnerOrRepo = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= MAX_OWNER_REPO_LENGTH
  && OWNER_REPO_PATTERN.test(value);

export const isValidIssueNumber = (value) => {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(number) && number > 0 && number <= 2_147_483_647 && String(value).trim() === String(number);
};

const DEFAULT_PER_PAGE = 30;

/** Shared page-size validation for list routes (400 input error on misuse). */
export const parsePerPage = (value, { defaultValue = DEFAULT_PER_PAGE } = {}) => {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw inputError('perPage must be an integer between 1 and 100.');
  }
  return parsed;
};

/**
 * Allow-list a fixed-set query param. Absent/empty resolves to `fallback`
 * (preserving current defaults); any other unknown value throws the
 * existing 400 input error so it cannot reach the API.
 */
export const parseEnumParam = (value, allowed, fallback, { name = 'parameter' } = {}) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (allowed.includes(value)) return value;
  throw inputError(`Invalid ${name} parameter.`);
};

/**
 * Parse `host/owner/name` repo params. Returns `{ host, owner, repo }` or null.
 */
export const parseRepoRef = (value) => {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split('/');
  if (parts.length !== 3) return null;
  const [host, owner, repo] = parts.map((part) => part.trim());
  if (!host || !owner || !repo) return null;
  if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) return null;
  if (!isValidOwnerOrRepo(owner) || !isValidOwnerOrRepo(repo)) return null;
  return { host: host.toLowerCase(), owner, repo };
};

export const formatRepoRef = ({ host, owner, repo }) => `${host}/${owner}/${repo}`;

/** Strip credentials/userinfo from a remote URL before it leaves the server. */
export const redactRemoteUrl = (url) => {
  if (typeof url !== 'string' || !url) return null;
  if (url.includes('://')) {
    try {
      const parsed = new URL(url);
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    } catch {
      return null;
    }
  }
  // scp-like `[user@]host:path`: strip a `user@` prefix when present.
  if (/^(?:([^@/:]+)@)?([^:/]+):(.*)$/.test(url) && !url.startsWith('git@') && url.includes('@')) {
    return url.slice(url.indexOf('@') + 1);
  }
  return url;
};

/**
 * Parse a git remote URL into `{ host, owner, repo }`. Supports https/http
 * (with optional port, credentials, `.git` suffix), `ssh://` (with optional
 * user/port), and scp-like `git@host:owner/repo(.git)`. Returns null when
 * the URL is not a parseable owner/repo reference.
 */
export const parseRemoteUrl = (url) => {
  if (typeof url !== 'string') return null;
  let text = url.trim();
  if (!text) return null;

  const cleanPath = (pathname) => {
    let cleaned = decodeURIComponentSafe(pathname).replace(/^\/+/, '').replace(/\/+$/, '');
    if (cleaned.toLowerCase().endsWith('.git')) cleaned = cleaned.slice(0, -4);
    return cleaned;
  };

  if (/^(https?|ssh|git):\/\//i.test(text)) {
    let parsed = null;
    try {
      parsed = new URL(text);
    } catch {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (!host) return null;
    const segments = cleanPath(parsed.pathname).split('/').filter(Boolean);
    if (segments.length !== 2) return null;
    const [owner, repo] = segments;
    if (!isValidOwnerOrRepo(owner) || !isValidOwnerOrRepo(repo)) return null;
    return { host, owner, repo };
  }

  // scp-like syntax: [user@]host:owner/repo(.git)
  const scpMatch = /^(?:[^@/:\s]+@)?([^@:/\s]+):(.*)$/.exec(text);
  if (scpMatch) {
    const host = scpMatch[1].toLowerCase();
    const segments = cleanPath(scpMatch[2]).split('/').filter(Boolean);
    if (segments.length !== 2) return null;
    const [owner, repo] = segments;
    if (!isValidOwnerOrRepo(owner) || !isValidOwnerOrRepo(repo)) return null;
    return { host, owner, repo };
  }
  return null;
};

const decodeURIComponentSafe = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const createDefaultGitRunner = ({ execFileAsync = defaultExecFileAsync, env = process.env } = {}) => async (cwd, args) => {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      env: { ...env, ...FAIL_CLOSED_GIT_ENV },
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { success: true, exitCode: 0, stdout: String(result?.stdout || ''), stderr: String(result?.stderr || '') };
  } catch (error) {
    return {
      success: false,
      exitCode: typeof error?.code === 'number' ? error.code : 1,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || ''),
    };
  }
};

const parseRemoteVerbose = (stdout) => {
  const remotes = new Map();
  for (const line of String(stdout || '').split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)\s*$/.exec(line.trim());
    if (!match) continue;
    const [, name, remoteUrl, direction] = match;
    if (!remotes.has(name)) remotes.set(name, { name, fetchUrl: null, pushUrl: null });
    const entry = remotes.get(name);
    if (direction === 'fetch' && !entry.fetchUrl) entry.fetchUrl = remoteUrl;
    if (direction === 'push' && !entry.pushUrl) entry.pushUrl = remoteUrl;
  }
  return [...remotes.values()];
};

const parseGitmodules = (text) => {
  const submodulePaths = new Set();
  for (const line of String(text || '').split('\n')) {
    const match = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    if (match) submodulePaths.add(match[1].trim());
  }
  return submodulePaths;
};

const pathExists = async (fsPromises, candidate) => {
  try {
    await fsPromises.stat(candidate);
    return true;
  } catch {
    return false;
  }
};

export const createRepoScopeResolver = ({
  runGit = null,
  fsPromises = fs.promises,
  pathApi = path,
  osApi = os,
  now = Date.now,
  scopeTtlMs = SCOPE_CACHE_TTL_MS,
} = {}) => {
  const git = runGit || createDefaultGitRunner();
  const scopeCache = createTtlCache({ ttlMs: scopeTtlMs, maxEntries: 200, now });

  const normalizeDirectory = (directory) => {
    if (typeof directory !== 'string' || !directory.trim()) return '';
    const trimmed = directory.trim();
    if (trimmed === '~') return osApi.homedir();
    if (trimmed.startsWith('~/')) return pathApi.join(osApi.homedir(), trimmed.slice(2));
    return pathApi.resolve(trimmed);
  };

  const readTopLevel = async (directory) => {
    const result = await git(directory, ['rev-parse', '--show-toplevel']);
    if (!result.success) return null;
    const topLevel = result.stdout.trim().split('\n')[0]?.trim();
    return topLevel || null;
  };

  const readBranch = async (directory) => {
    const result = await git(directory, ['branch', '--show-current']);
    if (!result.success) return null;
    return result.stdout.trim() || null;
  };

  const readTrackingRemote = async (directory) => {
    const result = await git(directory, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (!result.success) return null;
    const ref = result.stdout.trim();
    const slash = ref.indexOf('/');
    if (slash <= 0) return null;
    return ref.slice(0, slash);
  };

  const readRemotes = async (directory) => {
    const result = await git(directory, ['remote', '-v']);
    if (!result.success) return [];
    return parseRemoteVerbose(result.stdout);
  };

  const findEnclosingRepo = async (topLevel) => {
    const home = pathApi.resolve(osApi.homedir());
    let cursor = pathApi.dirname(topLevel);
    let guard = 0;
    while (cursor && guard < 64) {
      guard += 1;
      if (await pathExists(fsPromises, pathApi.join(cursor, '.git'))) {
        return cursor;
      }
      if (cursor === home || cursor === pathApi.dirname(cursor)) break;
      cursor = pathApi.dirname(cursor);
    }
    return null;
  };

  const findNestedRepos = async (root, { isRepoRoot }) => {
    const nested = [];
    let truncated = false;
    let dirsVisited = 0;
    const deadline = now() + NESTED_BUDGET_MS;
    const queue = [{ dir: root, depth: 0 }];
    const seen = new Set([pathApi.resolve(root)]);

    while (queue.length > 0) {
      if (now() > deadline) {
        truncated = true;
        break;
      }
      if (dirsVisited >= NESTED_MAX_DIRS) {
        truncated = true;
        break;
      }
      if (nested.length >= NESTED_MAX_REPOS) {
        truncated = true;
        break;
      }
      const { dir, depth } = queue.shift();
      dirsVisited += 1;
      let entries = null;
      try {
        entries = await fsPromises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      let hasGit = false;
      for (const entry of entries) {
        if (entry.name === '.git') {
          hasGit = true;
          break;
        }
      }
      const isRoot = pathApi.resolve(dir) === pathApi.resolve(root);
      if (hasGit && !(isRoot && isRepoRoot)) {
        nested.push(dir);
        if (nested.length >= NESTED_MAX_REPOS) {
          truncated = true;
          break;
        }
        continue;
      }
      if (depth >= NESTED_MAX_DEPTH) continue;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        const child = pathApi.join(dir, entry.name);
        const resolved = pathApi.resolve(child);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        queue.push({ dir: child, depth: depth + 1 });
      }
    }

    // Honor submodule membership and git-ignored paths.
    let submodulePaths = new Set();
    try {
      const gitmodules = await fsPromises.readFile(pathApi.join(root, '.gitmodules'), 'utf8');
      submodulePaths = parseGitmodules(gitmodules);
    } catch {
      submodulePaths = new Set();
    }
    // Batch ignore filtering in a single git spawn (best-effort: on failure keep all).
    let ignored = new Set();
    if (isRepoRoot && nested.length > 0) {
      ignored = await filterIgnoredPaths(root, nested);
    }
    const filtered = nested.filter((repoPath) => !ignored.has(repoPath));
    return {
      repos: filtered.map((repoPath) => ({
        path: repoPath,
        submodule: [...submodulePaths].some((submodulePath) => pathApi.resolve(root, submodulePath) === pathApi.resolve(repoPath)),
      })),
      truncated,
    };
  };

  const filterIgnoredPaths = async (root, repoPaths) => {
    try {
      const { spawn } = await import('node:child_process');
      const relative = repoPaths.map((repoPath) => pathApi.relative(root, repoPath)).filter(Boolean);
      if (relative.length === 0) return new Set();
      const ignored = await new Promise((resolve) => {
        const child = spawn('git', ['-C', root, 'check-ignore', '--stdin'], {
          env: { ...process.env, ...FAIL_CLOSED_GIT_ENV },
          windowsHide: true,
          timeout: 5000,
        });
        let stdout = '';
        let settled = false;
        const done = (value) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        child.stdout?.on('data', (chunk) => {
          stdout += String(chunk);
        });
        child.on('error', () => done(new Set()));
        child.on('close', () => {
          const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
          done(new Set(lines.map((line) => pathApi.resolve(root, line))));
        });
        try {
          child.stdin?.write(`${relative.join('\n')}\n`);
          child.stdin?.end();
        } catch {
          done(new Set());
        }
        setTimeout(() => done(new Set()), 5500).unref?.();
      });
      return ignored;
    } catch {
      return new Set();
    }
  };

  const mapLocalRepo = async (repoPath, kind, { rootForRelative, trackingRemote }) => {
    const remotes = await readRemotes(repoPath);
    const githubRemotes = [];
    for (const remote of remotes) {
      const parsed = parseRemoteUrl(remote.fetchUrl || remote.pushUrl || '');
      if (parsed && isSupportedHost(parsed.host)) {
        githubRemotes.push({ ...remote, ...parsed });
      }
    }
    const relativePath = rootForRelative ? (pathApi.relative(rootForRelative, repoPath) || '.') : repoPath;
    const base = {
      kind,
      path: repoPath,
      relativePath,
      submodule: false,
      fork: null,
      disabledReason: null,
    };
    if (remotes.length === 0) {
      return { ...base, host: null, owner: null, repo: null, remote: null, remoteUrl: null, disabledReason: 'no-remote' };
    }
    const pickDefault = () => {
      if (trackingRemote) {
        const tracked = githubRemotes.find((remote) => remote.name === trackingRemote);
        if (tracked) return tracked;
      }
      for (const name of ['origin', 'upstream']) {
        const named = githubRemotes.find((remote) => remote.name === name);
        if (named) return named;
      }
      return githubRemotes[0] || null;
    };
    const chosen = pickDefault();
    if (!chosen) {
      const firstRemote = remotes[0];
      const parsed = parseRemoteUrl(firstRemote.fetchUrl || firstRemote.pushUrl || '');
      if (parsed && !isSupportedHost(parsed.host)) {
        return { ...base, host: parsed.host, owner: parsed.owner, repo: parsed.repo, remote: firstRemote.name, remoteUrl: redactRemoteUrl(firstRemote.fetchUrl), disabledReason: 'not-github' };
      }
      return { ...base, host: null, owner: null, repo: null, remote: firstRemote.name, remoteUrl: redactRemoteUrl(firstRemote.fetchUrl), disabledReason: 'not-github' };
    }
    return {
      ...base,
      host: chosen.host,
      owner: chosen.owner,
      repo: chosen.repo,
      remote: chosen.name,
      remoteUrl: redactRemoteUrl(chosen.fetchUrl || chosen.pushUrl),
      remotes: remotes.map((remote) => remote.name),
    };
  };

  const resolveScopeUncached = async (directory) => {
    const normalized = normalizeDirectory(directory);
    if (!normalized) {
      throw failed('Directory parameter is required.');
    }
    let stats = null;
    try {
      stats = await fsPromises.stat(normalized);
    } catch {
      throw failed('Directory not found.');
    }
    if (!stats.isDirectory()) {
      throw failed('Specified path is not a directory.');
    }
    const topLevel = await readTopLevel(normalized);
    const branch = await readBranch(topLevel || normalized);
    const repositories = [];
    let truncated = false;
    if (topLevel) {
      const trackingRemote = await readTrackingRemote(topLevel);
      const containing = await mapLocalRepo(topLevel, 'containing', { rootForRelative: topLevel, trackingRemote });
      repositories.push(containing);
      const enclosingPath = await findEnclosingRepo(topLevel);
      if (enclosingPath) {
        const enclosing = await mapLocalRepo(enclosingPath, 'enclosing', { rootForRelative: topLevel, trackingRemote });
        repositories.push(enclosing);
      }
      const nestedResult = await findNestedRepos(topLevel, { isRepoRoot: true });
      truncated = nestedResult.truncated;
      for (const nestedRepo of nestedResult.repos) {
        if (pathApi.resolve(nestedRepo.path) === pathApi.resolve(topLevel)) continue;
        const entry = await mapLocalRepo(nestedRepo.path, 'nested', { rootForRelative: topLevel, trackingRemote });
        entry.submodule = nestedRepo.submodule;
        repositories.push(entry);
      }
    } else {
      const nestedResult = await findNestedRepos(normalized, { isRepoRoot: false });
      truncated = nestedResult.truncated;
      for (const nestedRepo of nestedResult.repos) {
        const entry = await mapLocalRepo(nestedRepo.path, 'nested', { rootForRelative: normalized, trackingRemote: null });
        entry.submodule = nestedRepo.submodule;
        repositories.push(entry);
      }
    }
    const containing = repositories.find((entry) => entry.kind === 'containing' && entry.host && isSupportedHost(entry.host));
    return {
      directory: normalized,
      topLevel,
      branch,
      repositories,
      truncated,
      defaultSelection: containing ? formatRepoRef(containing) : null,
      fetchedAt: now(),
    };
  };

  const resolveScope = async (directory) => {
    const normalized = normalizeDirectory(directory);
    const key = `scope:${normalized}`;
    const record = await scopeCache.getOrLoad(key, () => resolveScopeUncached(normalized));
    return record.value;
  };

  const invalidate = (directory = null) => {
    if (!directory) {
      scopeCache.clear();
      return;
    }
    const normalized = normalizeDirectory(directory);
    scopeCache.invalidate((key) => key === `scope:${normalized}`);
  };

  /**
   * Allow-list check: `repo` (`host/owner/name`) must equal a repository the
   * resolver returned for this directory. Returns the matching entry or null.
   */
  const matchAllowedRepo = (scope, repoParam) => {
    const parsed = parseRepoRef(repoParam);
    if (!parsed || !scope || !Array.isArray(scope.repositories)) return null;
    const match = scope.repositories.find((entry) => entry.host
      && entry.host.toLowerCase() === parsed.host
      && entry.owner.toLowerCase() === parsed.owner.toLowerCase()
      && entry.repo.toLowerCase() === parsed.repo.toLowerCase());
    return match || null;
  };

  return {
    resolveScope,
    invalidate,
    matchAllowedRepo,
    parseRemoteUrl,
    parseRepoRef,
    normalizeDirectory,
    _internals: { mapLocalRepo, findNestedRepos, filterIgnoredPaths, parseRemoteVerbose },
  };
};

/**
 * Lazy fork/repository metadata via the API (`GET /repos/{owner}/{repo}`).
 * Called only when a credential is available; results cached per fingerprint.
 */
export const createRepoInfoLoader = ({ client, now = Date.now } = {}) => {
  if (!client || typeof client.request !== 'function') {
    throw new Error('createRepoInfoLoader requires client.request');
  }
  const infoCache = createTtlCache({ ttlMs: REPO_INFO_TTL_MS, maxEntries: 200, now });

  const getRepoInfo = async (credential, { host, owner, repo }) => {
    const key = `repoinfo:${credential.fingerprint}:${String(host).toLowerCase()}/${String(owner).toLowerCase()}/${String(repo).toLowerCase()}`;
    const record = await infoCache.getOrLoad(key, async () => {
      const response = await client.request({
        credential,
        host,
        method: 'GET',
        path: `/repos/${owner}/${repo}`,
        operation: 'repository lookup',
      });
      const body = response.body || {};
      return {
        defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : null,
        isFork: body.fork === true,
        parent: body.parent && typeof body.parent.full_name === 'string'
          ? parseParentFullName(body.parent.full_name)
          : null,
        permissions: body.permissions && typeof body.permissions === 'object' ? { ...body.permissions } : null,
        private: body.private === true,
      };
    });
    return record.value;
  };

  const invalidate = (credential = null, repoRef = null) => {
    if (!credential && !repoRef) {
      infoCache.clear();
      return;
    }
    infoCache.invalidate((key) => {
      if (credential && !key.includes(credential.fingerprint)) return false;
      if (repoRef) {
        const normalized = `${String(repoRef.host).toLowerCase()}/${String(repoRef.owner).toLowerCase()}/${String(repoRef.repo).toLowerCase()}`;
        if (!key.endsWith(normalized)) return false;
      }
      return true;
    });
  };

  return { getRepoInfo, invalidate };
};

/**
 * Viewer repository permission derived from `GET /repos/{owner}/{repo}`.
 *
 * The repository lookup returns `permissions` (`admin`, `maintain`, `push`,
 * `triage`, `pull`) for the authenticated user. Resolution reuses
 * `getRepoInfo`, so it is cached per token fingerprint + repo with the
 * same ~5 min TTL and keyed so an account switch naturally partitions it.
 * Only successes are cached; a failed lookup resolves to
 * `{ level: null, fallback: true }` so callers keep the current
 * attempt-and-surface behavior and mark it instead of hiding controls.
 */
export const PERMISSION_LEVELS = ['admin', 'maintain', 'push', 'triage', 'pull'];

export const normalizePermissionLevel = (permissions) => {
  if (!permissions || typeof permissions !== 'object') return null;
  for (const level of PERMISSION_LEVELS) {
    if (permissions[level] === true) return level;
  }
  return null;
};

/**
 * Rank-ordered capabilities derived from a permission level. `canComment`
 * follows read (`pull`) access on public or accessible repositories — the
 * server only resolves permissions for allow-listed repos the viewer can
 * reach, so any resolved level implies read.
 */
export const deriveCapabilities = (level) => {
  const rank = PERMISSION_LEVELS.indexOf(level);
  if (rank === -1) return { canPush: false, canTriage: false, canPull: false, canComment: false };
  return {
    canPush: rank <= PERMISSION_LEVELS.indexOf('push'),
    canTriage: rank <= PERMISSION_LEVELS.indexOf('triage'),
    canPull: true,
    canComment: true,
  };
};

/** Permissive capabilities used when permission resolution failed: every
 * action stays enabled and the single attempt reports the server error. */
export const FALLBACK_CAPABILITIES = { canPush: true, canTriage: true, canPull: true, canComment: true };

export const getViewerPermission = async (getRepoInfo, credential, repoRef) => {
  try {
    const info = await getRepoInfo(credential, repoRef);
    const level = normalizePermissionLevel(info?.permissions);
    if (!level) return { level: null, fallback: true, capabilities: { ...FALLBACK_CAPABILITIES } };
    return { level, fallback: false, capabilities: deriveCapabilities(level) };
  } catch {
    return { level: null, fallback: true, capabilities: { ...FALLBACK_CAPABILITIES } };
  }
};

/**
 * Shared viewer-context loader (permission + login) for detail readers.
 * `getPermissions` maps `(credential, repoRef)` to `{ permissions }` —
 * domain services pass a direct repo lookup, the route layer passes the
 * cached repo-info loader. An explicit `resolvePermission` override wins
 * over the default; viewer-login failures resolve to null, never throw.
 */
export const buildViewerContextLoader = ({ getPermissions, resolveViewer = null, resolvePermission = null } = {}) => {
  if (typeof getPermissions !== 'function' && typeof resolvePermission !== 'function') {
    throw new Error('buildViewerContextLoader requires getPermissions or resolvePermission');
  }
  const fallbackResolvePermission = (credential, repoRef) => getViewerPermission(getPermissions, credential, repoRef);
  return async (credential, repo) => {
    const permissionLoader = typeof resolvePermission === 'function' ? resolvePermission : fallbackResolvePermission;
    const [permission, viewerLogin] = await Promise.all([
      permissionLoader(credential, repo),
      (async () => {
        if (typeof resolveViewer !== 'function') return null;
        try {
          return await resolveViewer(credential);
        } catch {
          return null;
        }
      })(),
    ]);
    return {
      viewerPermission: { level: permission?.level ?? null, fallback: permission?.fallback !== false },
      capabilities: permission?.capabilities ?? { ...FALLBACK_CAPABILITIES },
      viewerLogin: typeof viewerLogin === 'string' ? viewerLogin : null,
    };
  };
};

const parseParentFullName = (fullName) => {
  const parts = String(fullName || '').split('/');
  if (parts.length !== 2 || !isValidOwnerOrRepo(parts[0]) || !isValidOwnerOrRepo(parts[1])) return null;
  return { owner: parts[0], repo: parts[1] };
};
