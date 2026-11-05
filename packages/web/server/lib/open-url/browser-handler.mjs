// PiChamber's `$BROWSER` handler, run as `<launcher> <url>...`.
//
// Each http(s) argument goes to the PiChamber server's Open request intake
// (a Unix socket only processes of this user can reach). When no device is
// connected, the intake is unreachable, or the argument is not an http(s)
// URL (some tools pass a file path), it falls back to the opener the server
// machine had before PiChamber set `$BROWSER`.
//
// Kept dependency-free and side-effect free on import so it can be tested.

import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';

const OPEN_URL_SOCKET_ENV = 'PICHAMBER_OPEN_URL_SOCKET';
const ORIGINAL_BROWSER_ENV = 'PICHAMBER_ORIGINAL_BROWSER';
const REQUEST_TIMEOUT_MS = 5_000;

export const isHttpUrl = (value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

/** Resolves `true` only when the server confirmed a device received it. */
export const sendToIntake = ({ socketPath, url, sessionId, timeoutMs = REQUEST_TIMEOUT_MS }) => new Promise((resolve) => {
  if (!socketPath) {
    resolve(false);
    return;
  }
  const body = JSON.stringify({ url, ...(sessionId ? { sessionId } : {}) });
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    resolve(value);
  };
  const req = request({
    socketPath,
    path: '/open',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    timeout: timeoutMs,
  }, (res) => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4096) req.destroy();
    });
    res.on('end', () => {
      try {
        finish(res.statusCode === 200 && JSON.parse(raw)?.delivered === true);
      } catch {
        finish(false);
      }
    });
    res.on('error', () => finish(false));
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => finish(false));
  req.end(body);
});

/**
 * The commands to try for the fallback, in order: the user's original
 * `$BROWSER` list (colon-separated, `%s` marks the URL), then the platform
 * opener. Each entry is a shell snippet run with the target as `$1`.
 */
export const resolveFallbackCommands = ({ originalBrowser, platform }) => {
  const commands = [];
  for (const entry of String(originalBrowser || '').split(':')) {
    const command = entry.trim();
    if (!command) continue;
    commands.push(command.includes('%s') ? command.replaceAll('%s', '"$1"') : `${command} "$1"`);
  }
  commands.push(platform === 'darwin' ? 'open "$1"' : 'xdg-open "$1"');
  return commands;
};

/**
 * The environment for the fallback opener: our own variables removed and
 * `$BROWSER` restored, so `xdg-open` in generic mode cannot loop back here.
 */
export const buildFallbackEnv = (env) => {
  const next = { ...env };
  const original = typeof env[ORIGINAL_BROWSER_ENV] === 'string' ? env[ORIGINAL_BROWSER_ENV] : '';
  delete next[OPEN_URL_SOCKET_ENV];
  delete next[ORIGINAL_BROWSER_ENV];
  if (original) next.BROWSER = original;
  else delete next.BROWSER;
  return next;
};

const runShell = (command, target, env) => new Promise((resolve) => {
  let child;
  try {
    child = spawn('/bin/sh', ['-c', command, 'sh', target], { env, stdio: 'ignore', detached: true });
  } catch {
    resolve(false);
    return;
  }
  // A browser started this way may run for as long as it stays open, so
  // only wait long enough to see whether the command exists at all.
  const timer = setTimeout(() => {
    child.unref();
    resolve(true);
  }, 1_000);
  child.once('error', () => {
    clearTimeout(timer);
    resolve(false);
  });
  child.once('exit', (code) => {
    clearTimeout(timer);
    resolve(code === 0);
  });
});

export const openWithFallback = async ({ target, env, platform, run = runShell }) => {
  const childEnv = buildFallbackEnv(env);
  for (const command of resolveFallbackCommands({ originalBrowser: env[ORIGINAL_BROWSER_ENV], platform })) {
    if (await run(command, target, childEnv)) return true;
  }
  return false;
};

export const handleBrowserArguments = async ({
  args,
  env = process.env,
  platform = process.platform,
  send = sendToIntake,
  fallback = openWithFallback,
}) => {
  let failures = 0;
  for (const target of args) {
    if (typeof target !== 'string' || target.length === 0) continue;
    const delivered = isHttpUrl(target)
      ? await send({ socketPath: env[OPEN_URL_SOCKET_ENV], url: target, sessionId: env.PI_SESSION_ID })
      : false;
    if (delivered) continue;
    if (!(await fallback({ target, env, platform }))) failures += 1;
  }
  return failures === 0 ? 0 : 1;
};

const isMain = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  handleBrowserArguments({ args: process.argv.slice(2) })
    .then((code) => process.exit(code))
    .catch(() => process.exit(1));
}
