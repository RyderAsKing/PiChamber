/** gh CLI discovery, version gate, auth status, token reads (§3.1). See DOCUMENTATION.md. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findExecutableOnPath, getExecutableSearchDirectories } from '../tunnels/executable-search.js';
import { unavailable } from './errors.js';

/** Floor based on the flags used: `gh auth token --hostname` + plain `gh auth status`. */
export const MIN_GH_VERSION = '2.4.0';
export const TOKEN_CACHE_TTL_MS = 30_000;
const LOGIN_SHELL_PATH_TIMEOUT_MS = 2500;
const LOGIN_SHELL_PATH_TTL_MS = 5 * 60_000;
const VERSION_TIMEOUT_MS = 8000;
const STATUS_TIMEOUT_MS = 8000;
const TOKEN_TIMEOUT_MS = 5000;

const defaultExecFileAsync = promisify(execFile);

const parseVersion = (text) => {
  const match = /gh version (\d+)\.(\d+)\.(\d+)/i.exec(String(text || ''));
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
};

export const formatVersion = (version) => (version ? `${version.major}.${version.minor}.${version.patch}` : 'unknown');

export const compareVersions = (left, right) => {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
};

export const parseMinVersion = (text = MIN_GH_VERSION) => {
  const [major = 0, minor = 0, patch = 0] = String(text).split('.').map((part) => Number.parseInt(part, 10) || 0);
  return { major, minor, patch };
};

const isUnknownFlagFailure = (error) => /unknown flag/i.test(String(error?.stderr || error?.message || ''));

const parseScopesLine = (line) => {
  const match = /token scopes?:\s*(.*)$/i.exec(line);
  if (!match) return null;
  const raw = match[1].trim().replace(/^['"]|['"]$/g, '');
  if (!raw || /none/i.test(raw)) return [];
  return raw.split(',').map((scope) => scope.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
};

/**
 * Parse plain `gh auth status` output into per-host entries. Handles both the
 * all-hosts shape and the `--hostname <host>` shape (identical block).
 */
export const parsePlainAuthStatus = (text) => {
  const hosts = [];
  let current = null;
  const flush = () => {
    if (current) hosts.push(current);
    current = null;
  };
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (/^[^\s]/.test(line)) {
      // A non-indented line starts a host block (`github.com`).
      flush();
      const host = line.trim();
      if (/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) {
        current = { host: host.toLowerCase(), authenticated: false, login: null, scopes: [] };
      }
      continue;
    }
    if (!current) continue;
    const trimmed = line.trim();
    if (/you are not logged in/i.test(trimmed)) {
      current.authenticated = false;
      continue;
    }
    const loggedIn = /logged in to \S+ account (\S+)/i.exec(trimmed);
    if (loggedIn || /^[✓✔]/.test(trimmed)) {
      current.authenticated = true;
      if (loggedIn) current.login = loggedIn[1].trim() || null;
      continue;
    }
    const scopes = parseScopesLine(trimmed);
    if (scopes) {
      current.scopes = scopes;
      continue;
    }
  }
  flush();
  return hosts;
};

const parseJsonAuthStatus = (text) => {
  // `gh auth status --json hosts` shapes seen in the wild:
  // `{ "hosts": { "github.com": [ { "login": "...", "state": "success", ... } ] } }`
  // (current gh), a flat `{ "hosts": { "github.com": { ... } } }`, and
  // `{ "hosts": [ { "hostname": "...", "user": "..." } ] }`.
  const parsed = JSON.parse(String(text || ''));
  const raw = parsed?.hosts;
  const entries = [];
  const push = (hostname, info) => {
    // A host maps to a list of accounts; each becomes its own entry.
    const accounts = Array.isArray(info) ? info : [info];
    for (const account of accounts) {
      if (account && typeof account === 'object') entries.push({ hostname, ...account });
    }
  };
  if (Array.isArray(raw)) {
    for (const info of raw) push(info?.hostname || info?.host, info);
  } else if (raw && typeof raw === 'object') {
    for (const [hostname, info] of Object.entries(raw)) push(hostname, info);
  }
  const hosts = [];
  for (const entry of entries) {
    const host = String(entry.hostname || entry.host || '').trim().toLowerCase();
    if (!host) continue;
    const login = [entry.login, entry.user].find((value) => typeof value === 'string' && value) || null;
    // `scopes` is a comma-separated string on current gh; older shapes used an array.
    const rawScopes = entry.tokenScopes ?? entry.scopes;
    const scopes = Array.isArray(rawScopes)
      ? rawScopes.filter((scope) => typeof scope === 'string')
      : (typeof rawScopes === 'string'
        ? rawScopes.split(',').map((scope) => scope.trim()).filter(Boolean)
        : []);
    // `state` is the verdict. A record for a rejected token still carries
    // `active: true` (and can carry a login), so neither proves the token
    // works: `gh` exits successfully in JSON mode and the error is only in
    // `state`. Shapes without `state` fall back to the legacy predicate.
    const authenticated = typeof entry.state === 'string'
      ? entry.state === 'success'
      : Boolean(login || entry.active === true);
    hosts.push({
      host,
      authenticated,
      login,
      scopes,
    });
  }
  return hosts;
};

export const createGhCli = ({
  execFileAsync = defaultExecFileAsync,
  env = process.env,
  platform = process.platform,
  now = Date.now,
  minVersion = MIN_GH_VERSION,
} = {}) => {
  let cachedBinary = null;
  let cachedLoginPath = null;
  let loginPathExpiresAt = 0;
  // Process-lifetime: the gh binary and its version cannot change under us.
  let cachedVersion = null;
  // Which `gh auth status` flavor works: null = unprobed, true = --json,
  // false = plain text (older gh, e.g. 2.46, rejects --json). Remembering
  // avoids paying one failed spawn on every status call.
  let jsonFlavorWorks = null;
  const tokenCache = new Map();

  const runGh = async (args, { timeout }) => {
    const binary = await resolveGhBinary();
    if (!binary) {
      throw unavailable('gh-missing');
    }
    try {
      const result = await execFileAsync(binary, args, {
        timeout,
        windowsHide: true,
        maxBuffer: 256 * 1024,
        env: { ...env },
      });
      return String(result?.stdout || '');
    } catch (error) {
      if (error?.killed) {
        throw unavailable('gh-unauthenticated', { message: 'GitHub CLI timed out. Check that gh works on the server machine.' });
      }
      throw error;
    }
  };

  const resolveLoginShellPath = async () => {
    const at = now();
    if (cachedLoginPath && loginPathExpiresAt > at) return cachedLoginPath;
    const shell = typeof env.SHELL === 'string' && env.SHELL.trim()
      ? env.SHELL.trim()
      : (platform === 'win32' ? null : '/bin/sh');
    if (!shell) return '';
    try {
      const result = await execFileAsync(shell, ['-l', '-c', 'printf %s "$PATH"'], {
        timeout: LOGIN_SHELL_PATH_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024,
        env: { ...env },
      });
      const probed = String(result?.stdout || '').trim();
      // Sanity: a PATH is a delimiter-joined list of absolute dirs.
      if (probed && /[/\\]/.test(probed) && probed.length < 32768) {
        cachedLoginPath = probed;
        loginPathExpiresAt = at + LOGIN_SHELL_PATH_TTL_MS;
        return probed;
      }
    } catch {
      // Fall through to the process PATH.
    }
    return '';
  };

  const resolveGhBinary = async () => {
    if (cachedBinary) return cachedBinary;
    const explicit = [env.GH_BINARY, env.PICHAMBER_GH_BINARY]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);
    for (const candidate of explicit) {
      try {
        const probe = await execFileAsync(candidate, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 });
        // The probe already ran `gh --version`: keep its output so the
        // version gate below does not pay for a second spawn.
        cachedVersion = parseVersion(probe?.stdout) || cachedVersion;
        cachedBinary = candidate;
        return cachedBinary;
      } catch {
        continue;
      }
    }
    const command = platform === 'win32' ? 'gh.exe' : 'gh';
    const loginPath = platform === 'win32' ? '' : await resolveLoginShellPath();
    if (loginPath) {
      const delimiter = platform === 'win32' ? ';' : ':';
      const loginEnv = { ...env, PATH: loginPath, Path: loginPath };
      const found = findExecutableOnPath(command, { env: loginEnv, platform });
      if (found) {
        cachedBinary = found;
        return cachedBinary;
      }
    }
    const searchDirs = getExecutableSearchDirectories({ env, platform });
    if (searchDirs.length > 0) {
      const found = findExecutableOnPath(command, { env, platform });
      if (found) {
        cachedBinary = found;
        return cachedBinary;
      }
    }
    return null;
  };

  const getVersion = async () => {
    if (cachedVersion) return cachedVersion;
    // Resolving the binary first lets the explicit-binary probe (which
    // already runs `gh --version`) satisfy the version read with no spawn.
    await resolveGhBinary();
    if (cachedVersion) return cachedVersion;
    const stdout = await runGh(['--version'], { timeout: VERSION_TIMEOUT_MS });
    const version = parseVersion(stdout);
    if (!version) {
      throw unavailable('gh-missing', { message: 'GitHub CLI (gh) did not report a version.' });
    }
    cachedVersion = version;
    return version;
  };

  const assertVersion = async () => {
    const version = await getVersion();
    if (compareVersions(version, parseMinVersion(minVersion)) < 0) {
      throw unavailable('gh-outdated', { version: formatVersion(version) });
    }
    return version;
  };

  const getAuthState = async ({ hostname = null } = {}) => {
    await assertVersion();
    const binary = await resolveGhBinary();
    // Prefer machine-readable output on CLIs that support it. Once the
    // flavor is known, go straight to it instead of paying a failed spawn.
    if (jsonFlavorWorks !== false) {
      try {
        const args = hostname ? ['auth', 'status', '--json', 'hosts', '--hostname', hostname] : ['auth', 'status', '--json', 'hosts'];
        const result = await execFileAsync(binary, args, {
          timeout: STATUS_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 256 * 1024,
          env: { ...env },
        });
        jsonFlavorWorks = true;
        return { hosts: parseJsonAuthStatus(result?.stdout), source: 'json' };
      } catch (error) {
        if (isUnknownFlagFailure(error)) {
          jsonFlavorWorks = false;
        } else {
          // `gh auth status` exits non-zero when not logged in; the plain text
          // still describes state, so fall through to plain parsing.
          if (error?.killed) {
            throw unavailable('gh-unauthenticated', { message: 'GitHub CLI timed out. Check that gh works on the server machine.' });
          }
        }
      }
    }
    try {
      const args = hostname ? ['auth', 'status', '--hostname', hostname] : ['auth', 'status'];
      const result = await execFileAsync(binary, args, {
        timeout: STATUS_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 256 * 1024,
        env: { ...env },
      });
      const combined = `${result?.stdout || ''}\n${result?.stderr || ''}`;
      return { hosts: parsePlainAuthStatus(combined), source: 'text' };
    } catch (error) {
      if (error?.killed) {
        throw unavailable('gh-unauthenticated', { message: 'GitHub CLI timed out. Check that gh works on the server machine.' });
      }
      const combined = `${error?.stdout || ''}\n${error?.stderr || ''}`;
      const hosts = parsePlainAuthStatus(combined);
      if (hosts.length > 0) return { hosts, source: 'text' };
      throw unavailable('gh-unauthenticated');
    }
  };

  const getToken = async (host) => {
    const normalizedHost = String(host || '').trim().toLowerCase();
    if (!normalizedHost) throw unavailable('not-github');
    const cached = tokenCache.get(normalizedHost);
    if (cached && cached.expiresAt > now()) return cached.token;
    await assertVersion();
    let stdout = '';
    try {
      stdout = await runGh(['auth', 'token', '--hostname', normalizedHost], { timeout: TOKEN_TIMEOUT_MS });
    } catch (error) {
      if (error?.kind === 'unavailable') throw error;
      throw unavailable('gh-unauthenticated');
    }
    const token = stdout.trim().split(/\s+/)[0] || '';
    if (!token) {
      throw unavailable('gh-unauthenticated');
    }
    tokenCache.set(normalizedHost, { token, expiresAt: now() + TOKEN_CACHE_TTL_MS });
    // Bound the host-keyed cache.
    while (tokenCache.size > 50) {
      const oldest = tokenCache.keys().next();
      if (oldest.done) break;
      tokenCache.delete(oldest.value);
    }
    return token;
  };

  const clearTokenCache = (host = null) => {
    if (host) tokenCache.delete(String(host).trim().toLowerCase());
    else tokenCache.clear();
  };

  return {
    resolveGhBinary,
    getVersion,
    assertVersion,
    getAuthState,
    getToken,
    clearTokenCache,
    _internals: { parsePlainAuthStatus, parseJsonAuthStatus, parseVersion, compareVersions },
  };
};
