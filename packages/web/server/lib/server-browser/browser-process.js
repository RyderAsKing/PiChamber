import { spawn as nodeSpawn } from 'node:child_process';

import { createCdpConnection } from './cdp.js';

const LAUNCH_TIMEOUT_MS = 20_000;
const STDERR_LIMIT = 16 * 1024;

/**
 * Chrome flags for the server browser. Headless, driven over the private
 * pipe, with a persistent profile so logins survive restarts. Pages keep
 * running while nobody watches them (no background throttling), because a
 * viewer can attach at any time and expects a live page.
 */
const chromeArgs = ({ userDataDir, noSandbox, extraArgs = [] }) => [
  '--headless',
  '--remote-debugging-pipe',
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--password-store=basic',
  '--use-mock-keychain',
  '--mute-audio',
  '--disable-gpu',
  '--hide-crash-restore-bubble',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=Translate,MediaRouter,OptimizationHints',
  ...(noSandbox ? ['--no-sandbox'] : []),
  ...extraArgs,
  'about:blank',
];

/**
 * Turns a failed launch into something the setup message can explain.
 * @returns {{ kind: 'missing-library' | 'sandbox-root' | 'sandbox-namespaces' | 'unknown', library?: string, detail: string }}
 */
const classifyLaunchFailure = (stderr, { isRoot = false } = {}) => {
  const text = String(stderr || '');
  const detail = text.trim().split('\n').slice(-6).join('\n').slice(-1200);
  const library = /error while loading shared libraries: ([^:\s]+)/.exec(text);
  if (library) return { kind: 'missing-library', library: library[1], detail };
  if (/Running as root without --no-sandbox/i.test(text) || (isRoot && /sandbox/i.test(text))) {
    return { kind: 'sandbox-root', detail };
  }
  if (/No usable sandbox|user namespaces|setuid sandbox/i.test(text)) return { kind: 'sandbox-namespaces', detail };
  return { kind: 'unknown', detail };
};

export class ChromeLaunchError extends Error {
  constructor(failure) {
    super(failure.detail || 'Chrome did not start');
    this.name = 'ChromeLaunchError';
    this.failure = failure;
  }
}

/**
 * Starts Chrome and connects over the pipe.
 * Resolves `{ process, cdp, version }` once Chrome answers; rejects with a
 * `ChromeLaunchError` when it exits or does not answer in time.
 */
export const launchChrome = async ({
  executable,
  userDataDir,
  noSandbox = false,
  extraArgs = [],
  isRoot = false,
  env = process.env,
  spawn = nodeSpawn,
  launchTimeoutMs = LAUNCH_TIMEOUT_MS,
}) => {
  const child = spawn(executable, chromeArgs({ userDataDir, noSandbox, extraArgs }), {
    env,
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8');
  });

  const cdp = createCdpConnection({ writable: child.stdio[3], readable: child.stdio[4] });

  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
  });

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timeout: true }), launchTimeoutMs);
    timer.unref?.();
  });

  try {
    const outcome = await Promise.race([
      // A closed pipe means Chrome exited; report the exit, not the pipe.
      cdp.send('Browser.getVersion').then((version) => ({ version }), () => exited.then((exit) => ({ exit }))),
      exited.then((exit) => ({ exit })),
      timeout,
    ]);
    if (outcome.version) {
      child.once('exit', () => cdp.close());
      return { process: child, cdp, version: outcome.version, stderr: () => stderr };
    }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    cdp.close();
    if (outcome.exit?.error) {
      throw new ChromeLaunchError({ kind: 'unknown', detail: outcome.exit.error.message });
    }
    if (outcome.timeout) {
      throw new ChromeLaunchError({ kind: 'unknown', detail: `Chrome did not answer within ${Math.round(launchTimeoutMs / 1000)}s.\n${stderr.trim().slice(-800)}`.trim() });
    }
    // Give stderr a moment to drain after exit.
    await new Promise((resolve) => setImmediate(resolve));
    throw new ChromeLaunchError(classifyLaunchFailure(stderr, { isRoot }));
  } finally {
    clearTimeout(timer);
  }
};
