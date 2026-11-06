#!/usr/bin/env node
// Capture desktop and mobile screenshots of named PiChamber UI states.
// Dependency-free: drives Chrome/Chromium over the DevTools protocol, like
// scripts/profile-browser.mjs. See "Screenshots" in CLAUDE.md for setup.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { encodePiSessionCwd } from '../packages/web/server/lib/pi/session-daemon/session-jsonl.js';

const HELP = `Usage: BASE_URL=http://127.0.0.1:5180 bun run screenshots [label] [page...]
       bun run screenshots --seed <dir>

  label   Output subfolder, e.g. before or after (default: current)
  page    One or more page names (default: all)
  --seed  Recreate <dir>/repo (a git repo with staged-only, staged-then-edited,
          and staged new files), <dir>/data (a PICHAMBER_DATA_DIR that opens it),
          and <dir>/home (a HOME whose Pi agent dir holds one demo session)

Environment:
  BASE_URL   PiChamber UI origin (default: http://127.0.0.1:5180)
  CHROME     Chrome/Chromium executable (default: system Chrome, then the Playwright cache)
  OUT_DIR    Output root (default: .screenshots)
  OPEN_URL_SOCKET  The server's Open request intake (open-request page), e.g.
             $XDG_RUNTIME_DIR/pichamber/pi-daemons/web-dev-p<api port>/open-url.sock
  THEME      light or dark (default: light)
  DEMO_SITE_PORT  Port of the demo site the browser-page page loads (default: 4777);
             if it cannot start, that page fails and the others still capture

Pages: ${'%PAGES%'}`;

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, mobile: false, scale: 1 },
  { name: 'mobile', width: 390, height: 844, mobile: true, scale: 2 },
];

// Each page opens a route and waits for text that only appears once real
// content has rendered (not the loading shell).
// The seeded Pi session (see seed): a conversation with recorded `!cmd`
// shell commands. Its id is fixed so pages can open it by URL.
const DEMO_SESSION_ID = '0193f6a0-5b1e-7c2d-9e3f-4a5b6c7d8e9f';
const DEMO_SESSION_PATH = `/?session=${DEMO_SESSION_ID}`;
// Text of the seeded assistant reply; it renders with or without shell rows,
// so before and after captures wait on the same content.
const DEMO_REPLY = 'autosave default changed to true';

// A stand-in for a project's dev server, served by this script on a fixed
// port while browser pages are captured.
const DEMO_SITE_PORT = Number(process.env.DEMO_SITE_PORT || 4777);
const DEMO_SITE_TITLE = 'Acme dashboard';
const DEMO_SITE_HTML = `<!doctype html><html><head><title>${DEMO_SITE_TITLE}</title>
<style>body{margin:0;font:15px system-ui,sans-serif;color:#1f2933;background:#f5f7fa}
header{padding:16px 24px;background:#1f2933;color:#fff;font-weight:600}
main{padding:24px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px}
section{background:#fff;border:1px solid #d9e2ec;border-radius:8px;padding:16px}
b{display:block;font-size:26px;margin-top:6px}</style></head>
<body><header>Acme dashboard</header><main>
<section>Orders today<b>128</b></section><section>Revenue<b>$9,412</b></section>
<section>Refunds<b>3</b></section><section>Active users<b>1,204</b></section>
</main></body></html>`;

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
    // After expanding: every entry has a body, none is mounting or loading, and
    // git requests are idle. An empty body is a valid result (it is the bug
    // #205 fixed), so this checks that loading finished, not that lines exist.
    settledScript: `(() => {
      const headers = [...document.querySelectorAll('[data-diff-virtual-content] > div > div > div[role="button"]')];
      const panel = document.querySelector('[data-diff-virtual-content]');
      return headers.length === 3
        && headers.every((header) => header.parentElement?.parentElement?.children.length > 1)
        && !panel.innerText.includes('Loading diff')
        && !panel.querySelector('.h-40');
    })()`,
    idleRequestPrefix: '/api/git/',
  },
  'shell-transcript': {
    path: DEMO_SESSION_PATH,
    // Recorded shell commands after the reply: a clean exit, a failing exit
    // code, a command kept out of the model's context, and truncated output.
    // The transcript pins the latest turn to the top, so the rows follow it.
    readyText: [DEMO_REPLY],
    height: 1400,
  },
  'shell-composer': {
    path: DEMO_SESSION_PATH,
    readyText: [DEMO_REPLY],
    // `!` enters shell mode and a second `!` keeps the command out of the
    // model's context; each insert is a separate edit, like typing.
    typeIntoComposer: ['!', '!', 'git diff --stat'],
  },
  'open-request': {
    path: DEMO_SESSION_PATH,
    readyText: [DEMO_REPLY],
    // Sent through the server's intake, as a tool calling $BROWSER would.
    openRequest: `http://localhost:${DEMO_SITE_PORT}/`,
    // Desktop asks; a phone has no PiChamber browser and only informs.
    settledScript: `['Open this page?', 'A page is ready to view'].some((t) => document.body.innerText.includes(t))`,
  },
  'browser-page': {
    path: '/',
    // The right rail's Browser button opens the panel on a new page.
    openSelector: 'nav[aria-label="Panel surfaces"] button[aria-label="Browser"]',
    // Phone layouts have no Browser panel.
    viewports: ['desktop'],
    readyText: [],
    // Typed into the page's address bar: a server-local dev server.
    browserAddress: `http://localhost:${DEMO_SITE_PORT}/`,
    // The Server route draws the page on a canvas named after its title; the
    // This device route, and builds before routes, show an iframe.
    settledScript: `Boolean(document.querySelector('[aria-label="Web page: ${DEMO_SITE_TITLE}"]')
      || [...document.querySelectorAll('iframe')].some((frame) => frame.src.includes(':${DEMO_SITE_PORT}')))`,
  },
};

const COMPOSER_EDITOR_SELECTOR = [
  '[data-testid="chat-input"] [contenteditable="true"]',
  '[data-testid="chat-input"][contenteditable="true"]',
  '[data-testid="chat-input"] textarea',
  'textarea[data-testid="chat-input"]',
].join(', ');

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
    this.listeners = new Map();
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
  }

  async connect() {
    await new Promise((ok, fail) => {
      this.socket.addEventListener('open', ok, { once: true });
      this.socket.addEventListener('error', fail, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
    });
    // If Chrome exits mid-command, fail the run instead of hanging on a reply that never comes.
    const failPending = (error) => {
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    };
    this.socket.addEventListener('close', () => failPending(new Error('DevTools socket closed')));
    this.socket.addEventListener('error', () => failPending(new Error('DevTools socket error')));
  }

  send(method, params = {}) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('DevTools socket is not open'));
    }
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

// Settled = the page's DOM check holds and no matching request has been in
// flight for IDLE_MS. Waiting on the network too matters: an entry can show
// prefetched content while its own request is still pending.
const IDLE_MS = 500;
const waitForSettled = async (client, page, network, label) => {
  let stableSince = null;
  await waitFor(async () => {
    const ok = network.inFlight(page.idleRequestPrefix) === 0 && await client.evaluate(page.settledScript);
    if (!ok) {
      stableSince = null;
      return false;
    }
    stableSince ??= Date.now();
    return Date.now() - stableSince >= IDLE_MS;
  }, 20_000, label);
};

const trackRequests = (client) => {
  const open = new Map();
  client.on('Network.requestWillBeSent', ({ requestId, request }) => open.set(requestId, new URL(request.url).pathname));
  client.on('Network.loadingFinished', ({ requestId }) => open.delete(requestId));
  client.on('Network.loadingFailed', ({ requestId }) => open.delete(requestId));
  return {
    inFlight: (prefix) => (prefix ? [...open.values()].filter((path) => path.startsWith(prefix)).length : 0),
  };
};

const sendOpenRequest = (url) => new Promise((resolveSent, reject) => {
  const socketPath = process.env.OPEN_URL_SOCKET;
  if (!socketPath) {
    reject(new Error('Set OPEN_URL_SOCKET to capture the open-request page.'));
    return;
  }
  const req = httpRequest({ socketPath, path: '/open', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    res.resume();
    res.on('end', resolveSent);
  });
  req.on('error', reject);
  req.end(JSON.stringify({ url, sessionId: DEMO_SESSION_ID }));
});

const capture = async (client, network, baseUrl, pageName, page, viewport, theme, outDir) => {
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
    if (page.expandSelector) {
      await client.evaluate(`document.querySelectorAll(${JSON.stringify(page.expandSelector)}).forEach((el) => el.click())`);
    }
    if (page.browserAddress) {
      // The panel can close again while the app finishes starting; press its
      // rail button until the address bar shows.
      const opener = JSON.stringify(page.openSelector);
      await waitFor(
        () => client.evaluate(`(() => {
          const input = document.querySelector('[aria-label="Browser address"]');
          if (!input?.offsetParent) {
            const control = document.querySelector(${opener});
            if (control?.getAttribute('aria-pressed') !== 'true') control?.click();
            return false;
          }
          input.focus();
          input.select();
          return document.activeElement === input;
        })()`),
        15_000,
        `${pageName} address bar`,
      );
      await client.send('Input.insertText', { text: page.browserAddress });
      for (const type of ['keyDown', 'keyUp']) {
        await client.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
      }
    }
    if (page.openRequest) await sendOpenRequest(page.openRequest);
    if (page.settledScript) {
      await waitForSettled(client, page, network, `${pageName} settled`);
    }
    if (page.typeIntoComposer) {
      const selector = JSON.stringify(COMPOSER_EDITOR_SELECTOR);
      await waitFor(
        () => client.evaluate(`(() => {
          const editor = document.querySelector(${selector});
          editor?.focus();
          return Boolean(editor) && editor.contains(document.activeElement);
        })()`),
        15_000,
        `${pageName} composer focus`,
      );
      for (const text of page.typeIntoComposer) {
        await client.send('Input.insertText', { text });
        await wait(100);
      }
    }
  } catch (error) {
    // Keep what the page showed so a login screen or error page is easy to diagnose.
    const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(outDir, `${pageName}-${viewport.name}-FAILED.png`), Buffer.from(data, 'base64'));
    throw error;
  }
  await client.evaluate(`(async () => {
    const style = document.createElement('style');
    style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
    document.head.appendChild(style);
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  })()`);

  const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
  const file = join(outDir, `${pageName}-${viewport.name}-${theme}.png`);
  await writeFile(file, Buffer.from(data, 'base64'));
  return file;
};

// One Pi session in the repo, in Pi's JSONL format: a prompt, the reply, and
// shell commands the user then ran with `!cmd` (bashExecution entries).
const writeDemoSession = async (home, repo) => {
  const sessionDir = join(home, '.pi', 'agent', 'sessions', encodePiSessionCwd(repo));
  await mkdir(sessionDir, { recursive: true });
  const start = Date.parse('2026-11-01T10:00:00.000Z');
  const usage = {
    input: 1200, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 1280,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const bash = (command, output, extra = {}) => ({
    role: 'bashExecution', command, output, exitCode: 0, cancelled: false, truncated: false, ...extra,
  });
  const messages = [
    { role: 'user', content: 'Why does the settings test fail?' },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'The test expects the old value: the autosave default changed to true in settings.ts. Update the expectation or revert the default.' }],
      api: 'anthropic-messages', provider: 'demo', model: 'demo-model', usage, stopReason: 'stop',
    },
    bash('git status --short', 'M  billing.ts\nMM settings.ts\nA  retry.ts\n'),
    bash('node --test settings.test.js', [
      '✖ loadSettings returns the defaults (1.2ms)',
      '  AssertionError: expected autosave to be false',
      '    at settings.test.js:8:10',
      '',
      'ℹ tests 3',
      'ℹ pass 2',
      'ℹ fail 1',
      '',
    ].join('\n'), { exitCode: 1 }),
    bash('cat notes/scratch.md', 'Check the autosave default before the release.\n', { excludeFromContext: true }),
    bash('git log --stat', [
      ' settings.ts | 2 +-',
      ' 1 file changed, 1 insertion(+), 1 deletion(-)',
      '',
      'commit 4f2a9c1',
      'Author: Demo <demo@example.com>',
      '',
      '    initial',
      '',
      ' billing.ts  | 12 ++++++++++++',
      ' settings.ts |  9 +++++++++',
      ' 2 files changed, 21 insertions(+)',
      '',
    ].join('\n'), { truncated: true, fullOutputPath: '/tmp/pi-bash-demo.log' }),
  ];
  const lines = [{ type: 'session', version: 3, id: DEMO_SESSION_ID, timestamp: new Date(start).toISOString(), cwd: repo }];
  let parentId = null;
  messages.forEach((message, index) => {
    const timestamp = start + (index + 1) * 1000;
    const id = `demo${String(index).padStart(4, '0')}`;
    lines.push({ type: 'message', id, parentId, timestamp: new Date(timestamp).toISOString(), message: { ...message, timestamp } });
    parentId = id;
  });
  const file = join(sessionDir, `${new Date(start).toISOString().replace(/[:.]/g, '-')}_${DEMO_SESSION_ID}.jsonl`);
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
};

// Synthetic repo: billing.ts staged only (M ), settings.ts staged then edited
// (MM), retry.ts a staged new file (A ), plus one Pi session in that repo.
// Safe to rerun; it replaces only <dir>/repo, <dir>/data, and <dir>/home and
// leaves anything else in <dir> alone.
const seed = async (dir) => {
  const root = resolve(dir);
  const repo = join(root, 'repo');
  const data = join(root, 'data');
  const home = join(root, 'home');
  await rm(repo, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
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
  await writeDemoSession(home, repo);
  console.log(`Seeded ${repo}\nStart the dev server with HOME=${home} PICHAMBER_DATA_DIR=${data}`);
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
  let demoSite;
  const failed = [];
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
    await client.send('Network.enable');
    const network = trackRequests(client);
    // Only the pages that load the demo site need it; when it cannot start
    // (its port is taken), those pages fail and the others still capture.
    let demoSiteError = null;
    if (pageNames.some((name) => PAGES[name].browserAddress)) {
      demoSite = createHttpServer((_req, res) => {
        res.setHeader('content-type', 'text/html');
        res.end(DEMO_SITE_HTML);
      });
      try {
        await new Promise((resolveListen, reject) => {
          demoSite.once('error', reject);
          demoSite.listen(DEMO_SITE_PORT, '127.0.0.1', resolveListen);
        });
      } catch (error) {
        demoSite = null;
        demoSiteError = `the demo site could not start on port ${DEMO_SITE_PORT} (${error instanceof Error ? error.message : error}); set DEMO_SITE_PORT to a free port`;
      }
    }

    for (const name of pageNames) {
      if (PAGES[name].browserAddress && demoSiteError) {
        console.error(`${name}: ${demoSiteError}`);
        failed.push(name);
        continue;
      }
      const viewports = VIEWPORTS.filter((v) => !PAGES[name].viewports || PAGES[name].viewports.includes(v.name));
      for (const viewport of viewports) {
        const file = await capture(client, network, baseUrl, name, PAGES[name], viewport, theme, outDir);
        console.log(file);
      }
    }
  } finally {
    client?.close();
    // The server browser keeps its page, and so its connection, open.
    demoSite?.closeAllConnections();
    demoSite?.close();
    chrome.kill('SIGTERM');
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
  if (failed.length) throw new Error(`Not captured: ${failed.join(', ')}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
