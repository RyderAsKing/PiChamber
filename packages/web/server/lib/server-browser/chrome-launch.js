import { execFile } from 'node:child_process';

import { chromium } from 'playwright-core';

// Chrome's first start on a fresh machine has taken 13 to 30 seconds.
const LAUNCH_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 10_000;

/**
 * Flags added to Playwright's own. Pages keep running while nobody watches
 * them (Playwright already turns off background throttling), because a viewer
 * can attach at any time and expects a live page. Screencasts ignore the
 * emulated device scale, so Chrome draws at 2x and each viewer's stream is
 * scaled down to its own pixel ratio.
 */
/**
 * The device scale factor Chrome draws at. Its screencast ignores an emulated
 * scale, so Chrome starts at this one and pages are emulated at it too: while
 * the two differ (when Chrome takes a screenshot, or while a page swaps
 * renderers), input lands at scaled coordinates. Viewers with a lower pixel
 * ratio get a scaled-down stream.
 */
export const CHROME_SCALE_FACTOR = 2;

const chromeArgs = (extraArgs = []) => [
  '--disable-gpu',
  `--force-device-scale-factor=${CHROME_SCALE_FACTOR}`,
  '--hide-crash-restore-bubble',
  // Without this, `navigator.webdriver` is true and sign-in pages refuse.
  '--disable-blink-features=AutomationControlled',
  ...extraArgs,
];

// Playwright defaults the server browser must not have: the automation
// banner and flag, popups without a click, and hidden scrollbars (people
// scroll with them).
const IGNORED_DEFAULT_ARGS = ['--enable-automation', '--disable-popup-blocking', '--hide-scrollbars'];

/**
 * Turns a failed launch into something the setup message can explain.
 * `text` is Chrome's stderr, or Playwright's launch error, which quotes it.
 * @returns {{ kind: 'missing-library' | 'sandbox-root' | 'sandbox-namespaces' | 'unknown', library?: string, detail: string }}
 */
export const classifyLaunchFailure = (text, { isRoot = false } = {}) => {
  // The command line Playwright quotes names flags such as `--no-sandbox`.
  const raw = String(text || '').split('\n').filter((line) => !line.includes('<launching>')).join('\n');
  // Playwright prefixes each stderr line with `[pid=N][err]`.
  const stderr = [...raw.matchAll(/\[pid=\d+\]\[err\] ?(.*)/g)].map((match) => match[1]);
  const lines = stderr.length > 0 ? [...new Set(stderr)] : raw.trim().split('\n');
  const detail = lines.slice(-6).join('\n').slice(-1200);
  const library = /error while loading shared libraries: ([^:\s]+)/.exec(raw);
  if (library) return { kind: 'missing-library', library: library[1], detail };
  const sandbox = /sandbox/i.test(raw);
  if (/Running as root without --no-sandbox/i.test(raw) || (isRoot && sandbox)) return { kind: 'sandbox-root', detail };
  if (/No usable sandbox|user namespaces|setuid sandbox|sandboxing failed/i.test(raw)) return { kind: 'sandbox-namespaces', detail };
  return { kind: 'unknown', detail };
};

export class ChromeLaunchError extends Error {
  constructor(failure) {
    super(failure.detail || 'Chrome did not start');
    this.name = 'ChromeLaunchError';
    this.failure = failure;
  }
}

const UA_PLATFORMS = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
  linux: 'X11; Linux x86_64',
};

/**
 * The user agent pages see: a regular Chrome of the running version, without
 * the `HeadlessChrome` marker many sites refuse. Like Chrome itself, it
 * reports only the major version. `null` when the version is unknown.
 */
export const pageUserAgent = (version, platform = process.platform) => {
  const major = /(\d+)\.\d+\.\d+\.\d+/.exec(String(version || ''))?.[1];
  if (!major) return null;
  return `Mozilla/5.0 (${UA_PLATFORMS[platform] || UA_PLATFORMS.linux}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
};

/** The executable's version from `--version`, or `null` (Chrome on Windows prints none). */
export const chromeVersion = (executable, { env = process.env } = {}) => new Promise((resolve) => {
  execFile(executable, ['--version'], { env, timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
    resolve(error ? null : (/\d+\.\d+\.\d+\.\d+/.exec(String(stdout))?.[0] ?? null));
  });
});

/**
 * Starts Chrome on a persistent profile and returns its Playwright context.
 * Rejects with a `ChromeLaunchError` when Chrome exits or does not answer.
 */
export const launchChrome = async ({
  executable,
  userDataDir,
  noSandbox = false,
  extraArgs = [],
  isRoot = false,
  env = process.env,
  userAgent = null,
  launchTimeoutMs = LAUNCH_TIMEOUT_MS,
}) => {
  try {
    return await chromium.launchPersistentContext(userDataDir, {
      executablePath: executable,
      headless: true,
      chromiumSandbox: !noSandbox,
      // The viewer sets the page size; Playwright must not.
      viewport: null,
      ...(userAgent ? { userAgent } : {}),
      acceptDownloads: true,
      args: chromeArgs(extraArgs),
      ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
      env,
      timeout: launchTimeoutMs,
      // PiChamber stops Chrome on its own shutdown.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      throw new ChromeLaunchError({ kind: 'unknown', detail: `Chrome did not answer within ${Math.round(launchTimeoutMs / 1000)}s.` });
    }
    throw new ChromeLaunchError(classifyLaunchFailure(error?.message || String(error), { isRoot }));
  }
};
