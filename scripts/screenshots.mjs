#!/usr/bin/env node
// Capture desktop and mobile screenshots of named PiChamber UI states.
// Dependency-free: drives Chrome/Chromium over the DevTools protocol, like
// scripts/profile-browser.mjs. See "Screenshots" in CLAUDE.md for setup.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const HELP = `Usage: BASE_URL=http://127.0.0.1:5180 bun run screenshots [label] [page...]
       bun run screenshots --seed <dir>

  label   Output subfolder, e.g. before or after (default: current)
  page    One or more page names (default: all)
  --seed  Recreate <dir>/repo (a git repo with staged-only, staged-then-edited,
          and staged new files) and <dir>/data, a PICHAMBER_DATA_DIR that opens it

Environment:
  BASE_URL   PiChamber UI origin (default: http://127.0.0.1:5180)
  CHROME     Chrome/Chromium executable (default: system Chrome, then the Playwright cache)
  OUT_DIR    Output root (default: .screenshots)
  THEME      light or dark (default: light)

Pages: ${'%PAGES%'}`;

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false, scale: 1 },
  { name: 'mobile', width: 390, height: 844, mobile: true, scale: 2 },
];

// Each page opens a route and waits for text that only appears once real
// content has rendered (not the loading shell).
const PAGES = {
  'diff-all': {
    path: '/',
    // The right-rail changes button opens the panel's stacked diff in All scope.
    openSelector: '[aria-label$="changed files"]',
    // Stacked entries start collapsed; expand each file header once.
    expandSelector: '[data-diff-virtual-content] > div > div > div[role="button"]',
    // The right rail only exists in the desktop layout.
    viewports: ['desktop'],
    // Tall enough to show every stacked entry without scrolling.
    height: 1300,
    // File headers only: the diff bodies themselves are what before/after compares.
    readyText: ['billing.ts', 'settings.ts', 'retry.ts'],
  },
};

const chromeCandidates = () => {
  const system = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const cache = process.platform === 'darwin'
    ? join(homedir(), 'Library/Caches/ms-playwright')
    : join(homedir(), '.cache/ms-playwright');
  const cached = existsSync(cache)
    ? readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
      .flatMap((name) => [
        join(cache, name, 'chrome-linux64/chrome'),
        join(cache, name, 'chrome-linux/chrome'),
        join(cache, name, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
      ])
    : [];
  return [...system, ...cached];
};

const resolveChrome = () => {
  if (process.env.CHROME) return process.env.CHROME;
  const found = chromeCandidates().find((path) => existsSync(path));
  if (!found) throw new Error('Chrome/Chromium was not found. Set CHROME to its path.');
  return found;
};

const reservePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (check, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await wait(150);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
};

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    await new Promise((ok, fail) => {
      this.socket.addEventListener('open', ok, { once: true });
      this.socket.addEventListener('error', fail, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const pending = message.id ? this.pending.get(message.id) : null;
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((ok, fail) => {
      this.pending.set(id, { resolve: ok, reject: fail });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

const capture = async (client, baseUrl, pageName, page, viewport, theme, outDir) => {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: page.height ?? viewport.height,
    deviceScaleFactor: viewport.scale,
    mobile: viewport.mobile,
  });
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: viewport.mobile });
  await client.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: theme },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
  });
  await client.send('Page.navigate', { url: new URL(page.path, baseUrl).toString() });

  const textChecks = JSON.stringify(page.readyText);
  try {
    if (page.openSelector) {
      const selector = JSON.stringify(page.openSelector);
      await waitFor(
        () => client.evaluate(`(() => {
          const control = document.querySelector(${selector});
          control?.click();
          return Boolean(control);
        })()`),
        45_000,
        `${pageName} open control (${page.openSelector})`,
      );
    }
    await waitFor(
      () => client.evaluate(`document.readyState === 'complete' && ${textChecks}.every((t) => document.body?.innerText.includes(t))`),
      45_000,
      `${pageName} content (${page.readyText.join(', ')})`,
    );
  } catch (error) {
    // Keep what the page showed so a login screen or error page is easy to diagnose.
    const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(outDir, `${pageName}-${viewport.name}-FAILED.png`), Buffer.from(data, 'base64'));
    throw error;
  }
  if (page.expandSelector) {
    await client.evaluate(`document.querySelectorAll(${JSON.stringify(page.expandSelector)}).forEach((el) => el.click())`);
  }
  await client.evaluate(`(async () => {
    const style = document.createElement('style');
    style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
    document.head.appendChild(style);
    await document.fonts.ready;
  })()`);
  // Let pending diff requests settle so a late empty response is captured, not hidden.
  await wait(1500);

  const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
  const file = join(outDir, `${pageName}-${viewport.name}-${theme}.png`);
  await writeFile(file, Buffer.from(data, 'base64'));
  return file;
};

// Synthetic repo: billing.ts staged only (M ), settings.ts staged then edited
// (MM), retry.ts a staged new file (A ). Safe to rerun; it replaces <dir>.
const seed = async (dir) => {
  const root = resolve(dir);
  const repo = join(root, 'repo');
  const data = join(root, 'data');
  await rm(root, { recursive: true, force: true });
  await mkdir(repo, { recursive: true });
  await mkdir(data, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  const write = (name, lines) => writeFile(join(repo, name), `${lines.join('\n')}\n`);

  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'demo@example.com');
  git('config', 'user.name', 'Demo');
  await write('billing.ts', [
    'export interface Invoice {', '  id: string;', '  amount: number;', '}', '',
    'export function total(invoices: Invoice[]): number {',
    '  return invoices.reduce((sum, invoice) => sum + invoice.amount, 0);', '}', '',
    'export function formatAmount(amount: number): string {', '  return `$${amount}`;', '}',
  ]);
  await write('settings.ts', [
    'export const defaults = {', "  theme: 'light',", '  fontSize: 14,', '  autosave: false,', '};', '',
    'export function loadSettings() {', '  return { ...defaults };', '}',
  ]);
  git('add', '.');
  git('commit', '-qm', 'initial');

  await write('billing.ts', [
    'export interface Invoice {', '  id: string;', '  amount: number;', '  paidAt?: string;', '}', '',
    'export function total(invoices: Invoice[]): number {',
    '  return invoices.reduce((sum, invoice) => sum + invoice.amount, 0);', '}', '',
    'export function formatAmount(amount: number): string {',
    "  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);", '}',
  ]);
  git('add', 'billing.ts');
  await write('settings.ts', [
    'export const defaults = {', "  theme: 'system',", '  fontSize: 14,', '  autosave: false,', '};', '',
    'export function loadSettings() {', '  return { ...defaults };', '}',
  ]);
  git('add', 'settings.ts');
  await write('settings.ts', [
    'export const defaults = {', "  theme: 'system',", '  fontSize: 14,', '  autosave: true,', '};', '',
    'export function loadSettings() {', '  return { ...defaults };', '}',
  ]);
  await write('retry.ts', [
    'export function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {',
    '  return fn().catch((error) => (attempts > 1 ? retry(fn, attempts - 1) : Promise.reject(error)));', '}',
  ]);
  git('add', 'retry.ts');

  const id = `path_${Buffer.from(repo).toString('base64url')}`;
  await writeFile(join(data, 'runtime-state.json'), `${JSON.stringify({
    projects: [{ id, path: repo, label: 'demo-repo' }],
    activeProjectId: id,
    lastDirectory: repo,
  }, null, 2)}\n`);
  console.log(`Seeded ${repo}\nStart the dev server with PICHAMBER_DATA_DIR=${data}`);
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--seed') {
    if (!args[1]) throw new Error('Usage: --seed <dir>');
    await seed(args[1]);
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP.replace('%PAGES%', Object.keys(PAGES).join(', ')));
    return;
  }
  const [label = 'current', ...requested] = args;
  const pageNames = requested.length ? requested : Object.keys(PAGES);
  for (const name of pageNames) {
    if (!PAGES[name]) throw new Error(`Unknown page "${name}". Pages: ${Object.keys(PAGES).join(', ')}`);
  }
  const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:5180';
  const theme = process.env.THEME === 'dark' ? 'dark' : 'light';
  const outDir = resolve(process.env.OUT_DIR || '.screenshots', label);
  await mkdir(outDir, { recursive: true });

  const port = await reservePort();
  const profileDir = await mkdtemp(join(tmpdir(), 'pichamber-screenshots-'));
  const chrome = spawn(resolveChrome(), [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: 'ignore' });

  let client;
  try {
    let target;
    await waitFor(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
      return Boolean(target);
    }, 15_000, 'Chrome debugging endpoint');
    client = new Cdp(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    for (const name of pageNames) {
      const viewports = VIEWPORTS.filter((v) => !PAGES[name].viewports || PAGES[name].viewports.includes(v.name));
      for (const viewport of viewports) {
        const file = await capture(client, baseUrl, name, PAGES[name], viewport, theme, outDir);
        console.log(file);
      }
    }
  } finally {
    client?.close();
    chrome.kill('SIGTERM');
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
