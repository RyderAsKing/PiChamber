import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Points `$BROWSER` in the session daemon's environment at PiChamber's
// handler, so tools that honor it (extensions launching a review page, `gh`,
// Python's `webbrowser`, `xdg-open` on a headless machine) hand their URL to
// PiChamber instead of opening a browser on the server. Every bash command and
// extension the daemon runs inherits this environment.

export const OPEN_URL_SOCKET_ENV = 'PICHAMBER_OPEN_URL_SOCKET';
export const ORIGINAL_BROWSER_ENV = 'PICHAMBER_ORIGINAL_BROWSER';
const OPEN_URL_LAUNCHER_NAME = 'pichamber-open-url';

const BROWSER_HANDLER_ENTRYPOINT = join(dirname(fileURLToPath(import.meta.url)), 'browser-handler.mjs');

// Many tools split `$BROWSER` on whitespace or `:` (the BROWSER list
// convention), so the launcher path must contain neither.
export const isSafeBrowserCommandPath = (value) => typeof value === 'string'
  && value.length > 0
  && !/[\s:'"\\$`]/.test(value);

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

export const buildLauncherScript = ({ execPath, handlerPath, runAsNode }) => [
  '#!/bin/sh',
  '# PiChamber $BROWSER handler: hands URLs to the PiChamber server.',
  `exec ${runAsNode ? 'env ELECTRON_RUN_AS_NODE=1 ' : ''}${shellQuote(execPath)} ${shellQuote(handlerPath)} "$@"`,
  '',
].join('\n');

const WATCHDOG_INTERVAL_MS = 60_000;

/**
 * Directories that may hold the launcher, in order: next to the intake
 * socket, then the daemon's private profile directory, then the system temp
 * directory (macOS data directories sit under "Application Support", which
 * `$BROWSER` cannot hold). A temp candidate is created fresh with `mkdtemp`,
 * so its name cannot be predicted and claimed by another user first.
 */
export const listLauncherDirectories = ({ socketPath, privateDir, tmpdir }) => {
  const candidates = [dirname(socketPath), ...(privateDir ? [privateDir] : [])]
    .filter((dir) => isSafeBrowserCommandPath(join(dir, OPEN_URL_LAUNCHER_NAME)))
    .map((dir) => ({ dir, temporary: false }));
  if (tmpdir && isSafeBrowserCommandPath(join(tmpdir, 'pichamber-open-url-XXXXXX', OPEN_URL_LAUNCHER_NAME))) {
    candidates.push({ dir: tmpdir, temporary: true });
  }
  return candidates;
};

const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : undefined);

// Owned by this user, not a symlink, and writable by nobody else. A launcher
// in a directory someone else controls could be swapped for their own script
// and run as this user.
const isPrivateEntry = (info, uid, isExpectedType) => isExpectedType(info)
  && !info.isSymbolicLink()
  && (uid === undefined || info.uid === uid)
  && (info.mode & 0o022) === 0;

const isPrivateDirectory = async (dir, uid) => {
  try {
    return isPrivateEntry(await lstat(dir), uid, (info) => info.isDirectory());
  } catch {
    return false;
  }
};

const prepareLauncherDirectory = async ({ dir, temporary }, uid) => {
  const target = temporary
    ? await mkdtemp(join(dir, 'pichamber-open-url-'))
    : (await mkdir(dir, { recursive: true, mode: 0o700 }), dir);
  return await isPrivateDirectory(target, uid) ? target : null;
};

const writeLauncher = async (launcherPath, script) => {
  const temporaryPath = `${launcherPath}.${process.pid}.tmp`;
  await rm(temporaryPath, { force: true });
  // `wx`: never write through a file or link that appeared in the meantime.
  await writeFile(temporaryPath, script, { mode: 0o700, flag: 'wx' });
  await chmod(temporaryPath, 0o700);
  await rename(temporaryPath, launcherPath);
};

/**
 * Whether the launcher at `launcherPath` is still the one PiChamber wrote: a
 * private regular file with the expected script, in a private directory.
 */
const isLauncherIntact = async ({ launcherPath, script, uid = currentUid() }) => {
  if (!await isPrivateDirectory(dirname(launcherPath), uid)) return false;
  try {
    if (!isPrivateEntry(await lstat(launcherPath), uid, (info) => info.isFile())) return false;
    return await readFile(launcherPath, 'utf8') === script;
  } catch {
    return false;
  }
};

const launcherScriptFor = ({ execPath, handlerPath, runAsNode }) => buildLauncherScript({ execPath, handlerPath, runAsNode });

/**
 * Install the launcher and point `$BROWSER` at it. Returns the launcher path,
 * or null when the platform or paths cannot support it (Windows does not use
 * `$BROWSER`); in that case the environment is left untouched.
 */
export const installOpenUrlBrowser = async ({
  socketPath,
  env = process.env,
  execPath = process.execPath,
  runAsNode = Boolean(process.versions?.electron),
  platform = process.platform,
  privateDir,
  tmpdir,
  uid = currentUid(),
  handlerPath = BROWSER_HANDLER_ENTRYPOINT,
}) => {
  if (platform === 'win32' || typeof socketPath !== 'string' || socketPath.length === 0) return null;
  const script = launcherScriptFor({ execPath, handlerPath, runAsNode });

  let launcherPath = null;
  for (const candidate of listLauncherDirectories({ socketPath, privateDir, tmpdir })) {
    try {
      const dir = await prepareLauncherDirectory(candidate, uid);
      if (!dir) continue;
      const path = join(dir, OPEN_URL_LAUNCHER_NAME);
      await writeLauncher(path, script);
      if (!await isLauncherIntact({ launcherPath: path, script, uid })) continue;
      launcherPath = path;
      break;
    } catch {
      // Try the next directory.
    }
  }
  if (!launcherPath) return null;

  // Keep the user's own choice for the fallback path; never record ourselves
  // as the original, or the fallback would loop back into PiChamber.
  const previous = typeof env.BROWSER === 'string' ? env.BROWSER : '';
  if (previous !== launcherPath && !(ORIGINAL_BROWSER_ENV in env)) {
    env[ORIGINAL_BROWSER_ENV] = previous;
  }
  env[OPEN_URL_SOCKET_ENV] = socketPath;
  env.BROWSER = launcherPath;
  return launcherPath;
};

/** Undo `installOpenUrlBrowser` in `env`: give `$BROWSER` back to the user. */
const restoreOriginalBrowser = (env = process.env) => {
  if (!(OPEN_URL_SOCKET_ENV in env)) return;
  const original = env[ORIGINAL_BROWSER_ENV];
  if (typeof original === 'string' && original.length > 0) env.BROWSER = original;
  else delete env.BROWSER;
  delete env[ORIGINAL_BROWSER_ENV];
  delete env[OPEN_URL_SOCKET_ENV];
};

/**
 * Keep the launcher in place, reinstalling it when it disappeared or changed.
 * If no private directory can hold it, `$BROWSER` goes back to the user's
 * own value. Resolves the launcher path in use, or null.
 */
export const ensureOpenUrlBrowser = async (options) => {
  const env = options.env ?? process.env;
  const script = launcherScriptFor({
    execPath: options.execPath ?? process.execPath,
    handlerPath: options.handlerPath ?? BROWSER_HANDLER_ENTRYPOINT,
    runAsNode: options.runAsNode ?? Boolean(process.versions?.electron),
  });
  const current = env[OPEN_URL_SOCKET_ENV] === options.socketPath ? env.BROWSER : undefined;
  if (typeof current === 'string' && await isLauncherIntact({ launcherPath: current, script, uid: options.uid ?? currentUid() })) {
    return current;
  }
  let installed = null;
  try {
    installed = await installOpenUrlBrowser(options);
  } catch {
    installed = null;
  }
  if (!installed) restoreOriginalBrowser(env);
  return installed;
};

/**
 * Re-check the launcher every minute for the life of the daemon. Temp
 * cleaners and logout can remove its directory while the daemon keeps
 * running; a reboot ends the daemon, and the next one installs afresh.
 */
export const watchOpenUrlBrowser = (options, { intervalMs = WATCHDOG_INTERVAL_MS } = {}) => {
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void ensureOpenUrlBrowser(options).finally(() => {
      checking = false;
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
};
