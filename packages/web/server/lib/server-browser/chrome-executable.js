import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getExecutableSearchDirectories } from '../tunnels/executable-search.js';

// Environment variables that name a Chrome or Chromium executable, in order.
// `CHROME` matches the screenshot script.
const CHROME_ENV_KEYS = ['PICHAMBER_BROWSER_CHROME', 'CHROME'];

const LINUX_COMMANDS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'];

const macCandidates = (homedir) => [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  path.join(homedir, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  path.join(homedir, 'Applications/Chromium.app/Contents/MacOS/Chromium'),
];

const windowsCandidates = (env) => {
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  return roots.flatMap((root) => [
    path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.win32.join(root, 'Chromium', 'Application', 'chrome.exe'),
    path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]);
};

const playwrightCacheDir = ({ env, platform, homedir }) => {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform === 'darwin') return path.join(homedir, 'Library', 'Caches', 'ms-playwright');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local'), 'ms-playwright');
  return path.join(homedir, '.cache', 'ms-playwright');
};

// Playwright's full Chromium builds, newest first. The headless shell builds
// are skipped: they lack the PDF viewer and other parts of a real browser.
const playwrightCandidates = ({ env, platform, homedir, readdir }) => {
  const cache = playwrightCacheDir({ env, platform, homedir });
  let entries;
  try {
    entries = readdir(cache);
  } catch {
    return [];
  }
  const builds = entries
    .map((name) => /^chromium-(\d+)$/.exec(name))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map((match) => path.join(cache, match[0]));
  return builds.flatMap((build) => {
    if (platform === 'darwin') {
      return [
        path.join(build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(build, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      ];
    }
    if (platform === 'win32') return [path.join(build, 'chrome-win64', 'chrome.exe'), path.join(build, 'chrome-win', 'chrome.exe')];
    return [path.join(build, 'chrome-linux64', 'chrome'), path.join(build, 'chrome-linux', 'chrome')];
  });
};

/**
 * Finds a Chrome or Chromium executable for the server browser.
 *
 * Order: an executable named by `PICHAMBER_BROWSER_CHROME` or `CHROME`, an
 * installed Chrome, Chromium, or Edge, then Playwright's browser cache.
 * Returns `{ path, source }`, or `null` when none exists. A variable that
 * names a missing file is reported as `{ path: null, source: 'env', envKey }`
 * so the setup message can point at it instead of silently using another
 * browser.
 */
export const findChromeExecutable = ({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  exists = (file) => fs.existsSync(file),
  readdir = (dir) => fs.readdirSync(dir),
} = {}) => {
  for (const key of CHROME_ENV_KEYS) {
    const value = typeof env[key] === 'string' ? env[key].trim() : '';
    if (!value) continue;
    return exists(value) ? { path: value, source: 'env', envKey: key } : { path: null, source: 'env', envKey: key };
  }

  const installed = platform === 'darwin'
    ? macCandidates(homedir)
    : platform === 'win32'
      ? windowsCandidates(env)
      : getExecutableSearchDirectories({ env, platform }).flatMap((dir) => LINUX_COMMANDS.map((name) => path.join(dir, name)))
        .concat(['/snap/bin/chromium']);
  const system = installed.find((candidate) => exists(candidate));
  if (system) return { path: system, source: 'system' };

  const cached = playwrightCandidates({ env, platform, homedir, readdir }).find((candidate) => exists(candidate));
  if (cached) return { path: cached, source: 'playwright' };
  return null;
};

const readOsRelease = (readFile) => {
  try {
    const text = readFile('/etc/os-release');
    const values = {};
    for (const line of text.split('\n')) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (match) values[match[1]] = match[2].replace(/^"|"$/g, '');
    }
    return values;
  } catch {
    return {};
  }
};

/**
 * The commands that install a browser the server browser can use, for the
 * server's operating system. PiChamber never runs them itself.
 */
export const chromeInstallCommands = ({
  platform = process.platform,
  readFile = (file) => fs.readFileSync(file, 'utf8'),
} = {}) => {
  if (platform === 'darwin') return ['brew install --cask google-chrome'];
  if (platform === 'win32') return ['winget install Google.Chrome'];
  const release = readOsRelease(readFile);
  const family = `${release.ID || ''} ${release.ID_LIKE || ''}`;
  const playwright = 'npx playwright install --with-deps chromium';
  if (/\b(ubuntu|debian)\b/.test(family)) {
    // Ubuntu's chromium package is a snap; Playwright's build avoids that.
    return /\bubuntu\b/.test(release.ID || '')
      ? [playwright, 'sudo snap install chromium']
      : ['sudo apt-get install -y chromium', playwright];
  }
  if (/\b(fedora|rhel|centos)\b/.test(family)) return ['sudo dnf install -y chromium', playwright];
  if (/\barch\b/.test(family)) return ['sudo pacman -S chromium', playwright];
  if (/\balpine\b/.test(release.ID || '')) return ['sudo apk add chromium'];
  return [playwright];
};
