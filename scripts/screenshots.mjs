#!/usr/bin/env node
// Capture desktop and mobile screenshots of named PiChamber UI states.
// Dependency-free: drives Chrome/Chromium over the DevTools protocol, like
// scripts/profile-browser.mjs. See "Screenshots" in CLAUDE.md for setup.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, rm, utimes, writeFile, mkdtemp } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

import { encodePiSessionCwd } from '../packages/web/server/lib/pi/session-daemon/session-jsonl.js';

const HELP = `Usage: BASE_URL=http://127.0.0.1:5180 bun run screenshots [label] [page...]
       bun run screenshots --seed <dir>

  label   Output subfolder, e.g. before or after (default: current)
  page    One or more page names (default: all)
  --seed  Recreate <dir>/repo (a git repo on a long branch with staged-only,
          staged-then-edited, and staged new files), <dir>/folders (more
          projects: one with a favicon, a monorepo, one without an icon),
          <dir>/data (a PICHAMBER_DATA_DIR that opens them all), and <dir>/home
          (a HOME whose Pi agent dir holds one demo session), with the
          bundled Visuals and Sub-agents plugins turned on

Environment:
  BASE_URL   PiChamber UI origin (default: http://127.0.0.1:5180)
  CHROME     Chrome/Chromium executable (default: system Chrome, then the Playwright cache)
  OUT_DIR    Output root (default: .screenshots)
  OPEN_URL_SOCKET  The server's Open request intake (open-request page), e.g.
             $XDG_RUNTIME_DIR/pichamber/pi-daemons/web-dev-p<api port>/open-url.sock
  THEME      light or dark (default: light)
  DEMO_SITE_PORT  Port of the demo site the browser-page and browser-downloads pages load (default: 4777);
             if it cannot start, that page fails and the others still capture
  DEMO_NPM_PORT   Port of the demo npm registry the marketplace pages read (default: 4778); start the
             dev server with PICHAMBER_NPM_REGISTRY_URL and PICHAMBER_NPM_DOWNLOADS_URL set to
             http://127.0.0.1:<port> and PICHAMBER_FEATURED_URL=off

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

// A stand-in for npm's public registry, so the marketplace pages never reach
// npm and always show the same packages. Every name is made up.
const DEMO_NPM_PORT = Number(process.env.DEMO_NPM_PORT || 4778);
const demoNpmPackage = (name, version, description, keywords, extra = {}) => ({
  name,
  version,
  description,
  keywords: ['pi-package', ...keywords],
  date: '2026-11-02T10:00:00.000Z',
  license: 'MIT',
  maintainers: [{ username: extra.maintainer ?? 'demo-dev' }],
  links: { repository: `https://github.com/demo-dev/${name.replace(/^@[^/]+\//, '')}` },
  pi: extra.pi ?? { extensions: ['./index.ts'] },
  ...(extra.pichamber ? { pichamber: { apiVersion: 1 } } : {}),
  downloads: extra.downloads ?? 120,
});
const DEMO_NPM_PACKAGES = [
  demoNpmPackage('pi-web-reader', '2.4.1', 'Search the web and read pages as clean markdown, with citations the agent can quote.', ['web', 'search', 'fetch'], { downloads: 18_400, maintainer: 'lena-k' }),
  demoNpmPackage('@acme/pi-review-gate', '1.3.0', 'Ask before risky shell commands, with a review panel in PiChamber and a prompt in the terminal.', ['pichamber-plugin', 'review', 'permissions', 'safety'], { downloads: 2_150, maintainer: 'acme-tools', pichamber: true }),
  demoNpmPackage('pi-todo-board', '0.9.3', 'A todo list the agent keeps up to date as it works, with a /todos command.', ['todo', 'tasks', 'planning'], { downloads: 7_830, maintainer: 'mo-ellis' }),
  demoNpmPackage('pi-lint-lens', '1.1.0', 'Runs your linters after each edit and hands the agent the errors it introduced.', ['lint', 'eslint', 'diagnostics'], { downloads: 5_020, pi: { extensions: ['./index.ts'], skills: ['./skills'] } }),
  demoNpmPackage('pi-team-agents', '0.4.2', 'Send tasks to parallel subagents with their own models and context.', ['subagent', 'agents', 'parallel'], { downloads: 1_260, maintainer: 'quill-labs' }),
  demoNpmPackage('pi-commit-coach', '3.0.0', 'Writes commit messages from the staged diff in your project\'s style.', ['git', 'commit'], { downloads: 940 }),
  demoNpmPackage('@acme/pi-theme-dusk', '1.0.2', 'A low-contrast dark theme for Pi in the terminal.', ['theme'], { downloads: 310, maintainer: 'acme-tools', pi: { themes: ['./themes'] } }),
];
const DEMO_FEATURED = {
  version: 1,
  // Newer than any built-in list, so the seeded cache is the one shown.
  updated: '2099-01-01',
  featured: [
    { name: 'pi-web-reader', note: 'Gives the agent the web, with sources.' },
    { name: '@acme/pi-review-gate', note: 'Review risky commands before they run.' },
    { name: 'pi-todo-board' },
  ],
  hidden: [],
};

// npm's search, latest-manifest, and weekly-downloads endpoints over the
// packages above. Search keeps packages with the asked keyword and puts the
// ones that match the text first, as npm does.
const serveDemoNpm = (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const strip = ({ downloads, ...pkg }) => pkg;
  if (url.pathname === '/-/v1/search') {
    const text = url.searchParams.get('text') ?? '';
    const keywords = [...text.matchAll(/keywords:(\S+)/g)].map((match) => match[1]);
    const words = text.replace(/keywords:\S+/g, ' ').toLowerCase().split(/\s+/).filter(Boolean);
    const haystack = (pkg) => [pkg.name, pkg.description, ...pkg.keywords].join(' ').toLowerCase();
    const listed = DEMO_NPM_PACKAGES
      .filter((pkg) => keywords.every((keyword) => pkg.keywords.includes(keyword)))
      .map((pkg) => ({ pkg, hit: words.length === 0 || words.some((word) => haystack(pkg).includes(word)) }))
      .sort((a, b) => Number(b.hit) - Number(a.hit) || b.pkg.downloads - a.pkg.downloads);
    const from = Number(url.searchParams.get('from') ?? 0);
    const size = Number(url.searchParams.get('size') ?? 20);
    return send(200, {
      total: listed.length,
      objects: listed.slice(from, from + size).map(({ pkg }) => ({ package: strip(pkg), downloads: { weekly: pkg.downloads } })),
    });
  }
  const downloads = url.pathname.match(/^\/downloads\/point\/last-week\/(.+)$/);
  if (downloads) {
    const pkg = DEMO_NPM_PACKAGES.find((entry) => entry.name === decodeURIComponent(downloads[1]));
    return pkg ? send(200, { downloads: pkg.downloads, package: pkg.name }) : send(404, { error: 'not found' });
  }
  const latest = url.pathname.match(/^\/(.+)\/latest$/);
  if (latest) {
    const pkg = DEMO_NPM_PACKAGES.find((entry) => entry.name === decodeURIComponent(latest[1]));
    return pkg ? send(200, strip(pkg)) : send(404, { error: 'not found' });
  }
  return send(404, { error: 'not found' });
};
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

// Sessions the seed adds for the Threads and By folder captures (see
// writeShelfSessions): recent ones stay in the list and one is snoozed. Two are
// archived: one by hand a little while ago and an old one by auto-archive, so
// they leave Threads and By folder and show only in search and Timeline.
// Two sessions that show the bundled plugins' results. Backdated so they sit
// below the other demo sessions; the seed turns both plugins on.
const VISUALS_SESSION_ID = '0193f6a0-5b1e-7c2d-9e3f-4a5b6c7d8ea1';
const VISUALS_SESSION_PATH = `/?session=${VISUALS_SESSION_ID}`;
const VISUALS_TITLE = 'Test runs this week';
const VISUALS_REPLY = 'The pass rate climbed from 82% to 96% this week.';
const AGENTS_SESSION_ID = '0193f6a0-5b1e-7c2d-9e3f-4a5b6c7d8ea2';
const AGENTS_SESSION_PATH = `/?session=${AGENTS_SESSION_ID}`;
const AGENTS_REPLY = 'The reviewer found one blocking issue in billing.ts.';
// A finished turn that read, searched, edited, and ran a failing then a
// passing command, for the turn's activity summary and its open rail.
const TOOLS_SESSION_ID = '0193f6a0-5b1e-7c2d-9e3f-4a5b6c7d8eb7';
const TOOLS_SESSION_PATH = `/?session=${TOOLS_SESSION_ID}`;
const TOOLS_REPLY = 'Zero-amount invoices now skip the charge and are still marked paid.';
const VISUALS_HTML = `<style>
.wrap{display:grid;gap:14px}
.head{display:flex;justify-content:space-between;align-items:baseline}
.head h1{font-size:15px;font-weight:600;margin:0}
.head span{color:var(--pc-muted);font-size:12px}
.chart{display:grid;grid-template-columns:repeat(7,1fr);gap:10px;align-items:end;height:150px;padding-bottom:4px;border-bottom:1px solid var(--pc-border)}
.bar{display:grid;gap:6px;justify-items:center;align-self:stretch;align-content:end}
.bar i{display:block;width:100%;max-width:44px;border-radius:6px 6px 2px 2px;background:var(--pc-c1)}
.bar b{font-size:11px;font-weight:500;color:var(--pc-muted);font-variant-numeric:tabular-nums}
.days{display:grid;grid-template-columns:repeat(7,1fr);gap:10px;text-align:center;font-size:11px;color:var(--pc-muted)}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.stat{border:1px solid var(--pc-border);border-radius:var(--pc-radius);padding:12px}
.stat div{font-size:11px;color:var(--pc-muted)}
.stat strong{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
</style>
<div class="wrap">
<div class="head"><h1>Pass rate by day</h1><span>Nov 3 to Nov 9</span></div>
<div class="chart">${[82, 85, 84, 89, 91, 94, 96].map((value) => `<div class="bar"><b>${value}%</b><i style="height:${(value - 70) * 3.6}px"></i></div>`).join('')}</div>
<div class="days"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>
<div class="stats"><div class="stat"><div>Runs</div><strong>148</strong></div><div class="stat"><div>Failures</div><strong style="color:var(--pc-bad)">11</strong></div><div class="stat"><div>Slowest suite</div><strong>4.2 s</strong></div></div>
</div>`;

const SHELF_SESSIONS = [
  { id: '0193f6a0-0001-7000-8000-000000000001', folder: 'repo', title: 'Add retry with backoff to the billing client', hoursAgo: 0.3 },
  { id: '0193f6a0-0002-7000-8000-000000000002', folder: 'night-shift', title: 'Fix the dark logo on the dark theme', hoursAgo: 2 },
  { id: '0193f6a0-0003-7000-8000-000000000003', folder: 'chamber-mono', title: 'Plan the docs restructure', hoursAgo: 20, snooze: true },
  { id: '0193f6a0-0004-7000-8000-000000000004', folder: 'acme-web', title: 'Rename the checkout helpers', hoursAgo: 1, archived: true },
  { id: '0193f6a0-0005-7000-8000-000000000005', folder: 'dotfiles', title: 'Draft the release notes', hoursAgo: 5 * 24, archived: true },
];
const SHELF_SESSION_PATH = `/?session=${SHELF_SESSIONS[0].id}`;
// Visuals' render_choices. One session in the demo repo holds an answered
// call. Another, in Acme Web, has nothing but its name: that folder's own
// extension is a scripted model (no provider, no network) that answers any
// message with a render_choices call, so a capture can send one and get a
// question that waits.
const CHOICES_SESSION_ID = '0193f6a0-5b1e-7c2d-9e3f-4a5b6c7d8ea3';
const CHOICES_SESSION_PATH = `/?session=${CHOICES_SESSION_ID}`;
const CHOICES_LIVE_SESSION = { id: '0193f6a0-0006-7000-8000-000000000006', folder: 'acme-web', title: 'Pick a header for the pricing page', hoursAgo: 3 };
const CHOICES_LIVE_SESSION_PATH = `/?session=${CHOICES_LIVE_SESSION.id}`;
const CHOICES_PROMPT = 'Mock up three headers for the pricing page.';
const CHOICES_TITLE = 'Which pricing header?';
const CHOICES_REPLY = 'Going with the split header.';
const CHOICES_NOTE = 'Keep the yearly toggle from A.';
// The same session's scripted model answers this prompt with three
// run_check tool rounds; the extension raises a notice as each check passes,
// and the last check keeps running so the capture shows the turn mid-way.
const NOTICES_PROMPT = 'Run the release checks.';
const NOTICES_CHECKS = [
  { name: 'lint', ms: 300, notice: 'lint passed: 0 warnings' },
  { name: 'unit tests', ms: 300, notice: 'unit tests passed: 214 of 214' },
  { name: 'e2e', ms: 120_000, notice: 'e2e passed' },
];
// The same scripted model answers this prompt at once; its extension raises
// a notice shortly after the turn ends, while nothing runs.
const IDLE_PROMPT = 'Start the nightly backup.';
const IDLE_REPLY = 'Started the nightly backup. I will report when it finishes.';
const IDLE_NOTICE = 'Nightly backup finished: 3 projects, 0 errors';
const NOTICES_RUNNING = `(() => {
  const text = document.body?.innerText ?? '';
  return ${JSON.stringify(NOTICES_CHECKS.slice(0, 2).map((check) => check.notice))}.every((t) => text.includes(t))
    && Boolean(document.querySelector('button[aria-label="Stop generating"]'));
})()`;
const choicePage = (body) => `<style>
.h{display:grid;gap:10px}
.h h1{font-size:17px;font-weight:600;margin:0;letter-spacing:-0.01em}
.h p{margin:0;color:var(--pc-muted);font-size:12px;line-height:1.45}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.btn{font-size:12px;font-weight:500;border-radius:8px;padding:6px 10px;border:1px solid var(--pc-border)}
.btn.main{background:var(--pc-fg);color:var(--pc-bg);border-color:var(--pc-fg)}
.tag{font-size:11px;color:var(--pc-muted);border:1px solid var(--pc-border);border-radius:999px;padding:2px 8px}
.seg{display:inline-flex;border:1px solid var(--pc-border);border-radius:8px;overflow:hidden;font-size:11px}
.seg span{padding:4px 9px}
.seg .on{background:var(--pc-surface);font-weight:500}
.box{border:1px solid var(--pc-border);border-radius:10px;padding:10px 12px;display:grid;gap:4px}
.box strong{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}
.box span{font-size:11px;color:var(--pc-muted)}
</style>
<div class="h">${body}</div>`;
const CHOICES_OPTIONS = [
  {
    label: 'Centered',
    description: 'Headline, billing toggle, one button',
    html: choicePage('<div style="text-align:center;display:grid;gap:10px;justify-items:center"><span class="tag">Pricing</span><h1>Simple plans for every team</h1><p>Start free. Upgrade when you need more seats.</p><div class="seg"><span class="on">Monthly</span><span>Yearly</span></div><span class="btn main">Start free</span></div>'),
  },
  {
    label: 'Split',
    description: 'Copy on the left, the popular plan on the right',
    html: choicePage('<div style="display:grid;grid-template-columns:1.2fr 1fr;gap:12px;align-items:center"><div style="display:grid;gap:8px"><h1>Simple plans for every team</h1><p>Start free. Upgrade when you need more seats.</p><div class="row"><span class="btn main">Start free</span><span class="btn">Compare plans</span></div></div><div class="box"><span>Team, most popular</span><strong>$12</strong><span>per seat, each month</span></div></div>'),
  },
  {
    label: 'Compact',
    description: 'One line, for a page that leads with the table',
    html: choicePage('<div class="row" style="justify-content:space-between"><h1>Pricing</h1><div class="row"><div class="seg"><span class="on">Monthly</span><span>Yearly</span></div><span class="btn main">Start free</span></div></div><p>Every plan includes unlimited projects.</p>'),
  },
];
// The details render_choices records: its options lettered in order.
const CHOICES_DETAILS = {
  title: CHOICES_TITLE,
  options: CHOICES_OPTIONS.map((option, index) => ({ id: String.fromCharCode(97 + index), ...option })),
};
// The options have drawn. They share one cell, so their frames mount
// together once it nears the viewport; each has fitted to its page.
const CHOICES_DRAWN = `(() => {
  const artifacts = document.querySelectorAll('[data-plugin-artifact="visuals-choices"]');
  const pages = [...(artifacts[artifacts.length - 1]?.querySelectorAll('[data-choice-page]') ?? [])].filter((page) => page.querySelector('iframe'));
  return pages.length > 0 && pages.every((page) => page.dataset.choicePage === 'fitted');
})()`;
// The question waits and its options have drawn. On a used seed the session
// has earlier turns and a phone can open above the newest one, so bring that
// one into view first.
const CHOICES_WAITING = `(() => {
  if (!document.querySelector('[role="dialog"][aria-label="${CHOICES_TITLE}"]')) return false;
  const artifacts = document.querySelectorAll('[data-plugin-artifact="visuals-choices"]');
  const last = artifacts[artifacts.length - 1];
  if (!last || !/Choose [A-F]/.test(last.innerText)) return false;
  if (last.getBoundingClientRect().bottom > window.innerHeight) last.scrollIntoView({ block: 'end' });
  return ${CHOICES_DRAWN};
})()`;
// The same waiting question with the second variant switched to.
const CHOICES_SWITCHED = `(() => {
  if (!${CHOICES_WAITING}) return false;
  const artifacts = document.querySelectorAll('[data-plugin-artifact="visuals-choices"]');
  const last = artifacts[artifacts.length - 1];
  const second = last.querySelector('[data-choice-tab="b"]');
  if (second?.getAttribute('aria-pressed') !== 'true') { second?.click(); return false; }
  return last.innerText.includes('Choose B');
})()`;
// Opens the row menu of the 5-day-old archived session, picks Unarchive, and
// settles once the list has had time to regroup.
const TIMELINE_UNARCHIVE = `(() => {
  const title = ${JSON.stringify(SHELF_SESSIONS[4].title)};
  if (window.__unarchivedAt) return Date.now() - window.__unarchivedAt > 1500;
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.trim() === 'Unarchive');
  if (item) {
    item.click();
    window.__unarchivedAt = Date.now();
    return false;
  }
  const label = [...document.querySelectorAll('body *')].find((node) => node.childElementCount === 0 && node.textContent.trim() === title);
  const rect = label?.getBoundingClientRect();
  if (!rect || rect.width === 0) return false;
  label.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: rect.left + 10, clientY: rect.top + rect.height / 2 }));
  return false;
})()`;
const SHELF_SESSION_TEXT = [SHELF_SESSIONS[0].title, SHELF_SESSIONS[1].title];
// Opens the Snoozed shelf (it starts collapsed) and waits for its row, and for the open session's message and model picker so the
// transcript beside the sidebar is not caught loading.
const SHELVES_OPEN = `(() => {
  const closed = document.querySelector('[data-session-shelf] button[aria-expanded="false"]');
  if (closed) { closed.click(); return false; }
  const messageShown = [...document.querySelectorAll('[data-message-id]')]
    .some((node) => node.innerText.includes(${JSON.stringify(SHELF_SESSIONS[0].title)}));
  return messageShown
    && !document.body.innerText.includes('Loading...')
    && document.body.innerText.includes(${JSON.stringify(SHELF_SESSIONS[2].title)});
})()`;

// The branch prefix: a middle-truncated label splits the full name across spans.
const SIDEBAR_PROJECTS_TEXT = ['Acme Web', 'Chamber Mono', 'Dotfiles', 'Night Shift', 'feature/session-sidebar'];
// Four seeded folders ship an icon; wait until each has loaded. A build
// without project icons renders no [data-project-icon], so it settles at once
// and the same page captures a before shot.
const PROJECT_ICONS_SETTLED = `(() => {
  if (!document.querySelector('[data-project-icon]')) return true;
  const icons = [...document.querySelectorAll('img[src^="blob:"]')];
  return icons.length >= 4 && icons.every((icon) => icon.complete && icon.naturalWidth > 0);
})()`;

// Opens the sidebar's Add folder dialog and walks `plan`: pick the source
// titled `plan.source`, then fill each field (named by the dialog's field
// label) and press Continue where asked, one action per poll, until `done`.
// The dialog keeps one field; its label says which step is showing.
const addFolderSettled = (plan, done) => `(() => {
  const dialog = document.querySelector('[data-slot="dialog-content"]');
  if (!dialog) {
    [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Add folder')?.click();
    return false;
  }
  const input = dialog.querySelector('input[role="combobox"]');
  if (!input) return false;
  const plan = ${JSON.stringify(plan)};
  const label = input.getAttribute('aria-label');
  const field = plan.fields.find((entry) => entry.label === label);
  if (plan.source && !field) {
    [...dialog.querySelectorAll('[role="option"]')].find((row) => row.textContent.includes(plan.source))?.click();
    return false;
  }
  if (field && input.value !== field.value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, field.value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return false;
  }
  if (field?.continue) {
    [...dialog.querySelectorAll('button')].find((button) => /continue/i.test(button.textContent))?.click();
    return false;
  }
  return ${done};
})()`;

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
  'sidebar-projects': {
    path: '/',
    // Folder list and session card: project icons (favicon, monorepo favicon,
    // and the fallback mark) plus the middle-truncated branch.
    readyText: SIDEBAR_PROJECTS_TEXT,
    // The mobile layout keeps the sidebar in a drawer; see sidebar-projects-mobile.
    viewports: ['desktop'],
    settledScript: PROJECT_ICONS_SETTLED,
    idleRequestPrefix: '/api/fs/project-icon',
  },
  'sidebar-threads': {
    // The Threads view: recent sessions across folders, then the Snoozed and
    // Archived shelves opened, with the selected title in medium weight.
    path: SHELF_SESSION_PATH,
    sidebarViewMode: 'threads',
    readyText: SHELF_SESSION_TEXT,
    viewports: ['desktop'],
    settledScript: SHELVES_OPEN,
  },
  'sidebar-threads-hover': {
    // Threads with the pointer on an active session: its Archive action takes
    // the timestamp's place.
    path: SHELF_SESSION_PATH,
    sidebarViewMode: 'threads',
    readyText: SHELF_SESSION_TEXT,
    viewports: ['desktop'],
    settledScript: SHELVES_OPEN,
    hoverScript: `(() => {
      const title = [...document.querySelectorAll('aside *, nav *, [class*="sidebar"] *')].find((node) => node.childElementCount === 0 && node.textContent.trim() === ${JSON.stringify(SHELF_SESSIONS[1].title)});
      const rect = title?.getBoundingClientRect();
      return rect ? { x: rect.left + 20, y: rect.top + rect.height / 2 } : null;
    })()`,
  },
  'sidebar-threads-archive': {
    // Threads with the shelves collapsed, just after the open session's Archive
    // button: it leaves the list, and a toast names it with Undo. This archives
    // the session in the data directory, so capture it after the other pages.
    path: SHELF_SESSION_PATH,
    sidebarViewMode: 'threads',
    readyText: SHELF_SESSION_TEXT,
    viewports: ['desktop'],
    settledScript: `(() => {
      const title = ${JSON.stringify(SHELF_SESSIONS[0].title)};
      if ([...document.querySelectorAll('[data-sonner-toast]')].some((toast) => toast.innerText.includes(title))) return true;
      if (window.__archiveClicked) return false;
      const messageShown = [...document.querySelectorAll('[data-message-id]')].some((node) => node.innerText.includes(title));
      if (!messageShown) return false;
      // The row is the widest ancestor holding a single Archive button.
      const button = [...document.querySelectorAll('button[aria-label="Archive"]')].find((candidate) => {
        let row = candidate;
        while (row.parentElement && row.parentElement.querySelectorAll('button[aria-label="Archive"]').length === 1) row = row.parentElement;
        return row.innerText.includes(title);
      });
      if (!button) return false;
      window.__archiveClicked = true;
      button.click();
      return false;
    })()`,
  },
  'sidebar-timeline-unarchive': {
    // Timeline just after Unarchive from the row menu of the 5-day-old archived
    // session: it stays under its own date, since unarchiving is not activity.
    // This unarchives the session in the data directory, so capture it last.
    path: SHELF_SESSION_PATH,
    sidebarViewMode: 'timeline',
    readyText: [SHELF_SESSIONS[0].title, SHELF_SESSIONS[4].title],
    viewports: ['desktop'],
    settledScript: TIMELINE_UNARCHIVE,
  },
  'sidebar-timeline-unarchive-mobile': {
    // The same in the mobile sessions drawer.
    path: SHELF_SESSION_PATH,
    sidebarViewMode: 'timeline',
    openSelector: '[aria-label="Open sessions and projects"]',
    readyText: [SHELF_SESSIONS[4].title],
    viewports: ['mobile'],
    settledScript: TIMELINE_UNARCHIVE,
  },
  'sidebar-search-archived': {
    // A search that matches an archived session: the match shows in place with
    // a muted title, while the same session is absent from the plain list.
    path: SHELF_SESSION_PATH,
    sidebarViewMode: 'threads',
    readyText: SHELF_SESSION_TEXT,
    viewports: ['desktop'],
    settledScript: `(() => {
      const title = ${JSON.stringify(SHELF_SESSIONS[3].title)};
      const input = document.querySelector('input[placeholder="Search sessions..."]');
      if (!input) {
        document.querySelector('button[aria-label="Search sessions"]')?.click();
        return false;
      }
      if (input.value !== 'checkout') {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'checkout');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return false;
      }
      return document.body.innerText.includes(title);
    })()`,
  },
  'sidebar-folder': {
    // By folder: folders with their active sessions; snoozed sessions
    // moved to a shelf under the folder list, archived ones to Archived below it.
    path: SHELF_SESSION_PATH,
    sidebarViewMode: 'folder',
    readyText: SHELF_SESSION_TEXT,
    viewports: ['desktop'],
    settledScript: SHELVES_OPEN,
  },
  'sidebar-folder-actions': {
    // By folder with the pointer on a folder header: its New session and
    // folder menu buttons.
    path: SHELF_SESSION_PATH,
    sidebarViewMode: 'folder',
    readyText: SHELF_SESSION_TEXT,
    viewports: ['desktop'],
    settledScript: SHELVES_OPEN,
    hoverScript: `(() => {
      const label = [...document.querySelectorAll('[aria-expanded] span')].find((node) => node.textContent.trim() === 'Night Shift');
      const row = label?.closest('[data-sidebar-tree-row]');
      if (!row) return null;
      const rect = row.getBoundingClientRect();
      return { x: rect.left + 40, y: rect.top + rect.height / 2 };
    })()`,
  },
  'sidebar-projects-mobile': {
    path: '/',
    // The header button opens the sessions drawer with the same folder list.
    openSelector: '[aria-label="Open sessions and projects"]',
    readyText: SIDEBAR_PROJECTS_TEXT,
    viewports: ['mobile'],
    settledScript: PROJECT_ICONS_SETTLED,
    idleRequestPrefix: '/api/fs/project-icon',
  },
  'shell-composer': {
    path: DEMO_SESSION_PATH,
    readyText: [DEMO_REPLY],
    // `!` enters shell mode and a second `!` keeps the command out of the
    // model's context; each insert is a separate edit, like typing.
    typeIntoComposer: ['!', '!', 'git diff --stat'],
  },
  'extension-dialog': {
    path: DEMO_SESSION_PATH,
    readyText: [DEMO_REPLY],
    // The seed's demo extension answers `!git log` with a select() dialog
    // whose title packs a whole permission request, like permission
    // extensions send.
    typeIntoComposer: ['!', 'git log --oneline && echo hello && ls -la src | head -5'],
    submitComposer: true,
    settledScript: `Boolean(document.querySelector('[role="dialog"][aria-label^="Permission Required"]'))`,
    // The dialog is pending in the daemon and comes back on reload, so later
    // pages on the demo session would show it: answer it once this page's
    // viewports are done.
    dismissAfter: '[role="dialog"] button[aria-label="Dismiss extension dialog"]',
  },
  'extension-surface': {
    focusEvents: true,
    path: DEMO_SESSION_PATH,
    readyText: [DEMO_REPLY],
    // The seed's demo extension answers `!git push` with a ctx.ui.custom()
    // permission prompt; it takes the composer's place with focus on it, so
    // the footer says keys go to the extension. On mobile the key bar
    // takes the footer's place.
    typeIntoComposer: ['!', 'git push --force-with-lease origin feature/session-sidebar'],
    submitComposer: true,
    settledScript: `(() => {
      const surface = document.querySelector('[data-extension-surface]');
      if (!surface || !surface.innerText.includes('Permission required')) return false;
      surface.focus({ preventScroll: true });
      return document.body.innerText.includes('Keys go to the extension.')
        || Boolean(document.querySelector('[role="toolbar"]'));
    })()`,
  },
  'extension-surface-unfocused': {
    focusEvents: true,
    path: DEMO_SESSION_PATH,
    readyText: [DEMO_REPLY],
    // The same prompt after focus has moved to another control: the footer
    // offers to send typing back to it.
    typeIntoComposer: ['!', 'git push --force-with-lease origin feature/session-sidebar'],
    submitComposer: true,
    viewports: ['desktop'],
    settledScript: `(() => {
      const surface = document.querySelector('[data-extension-surface]');
      if (!surface || !surface.innerText.includes('Permission required')) return false;
      // Focus left on nothing returns to the surface, so move it somewhere,
      // the way clicking another control would.
      const elsewhere = [...document.querySelectorAll('button')]
        .find((button) => button.offsetParent && !button.closest('[data-composer-bound]'));
      if (!elsewhere) return false;
      if (document.activeElement !== elsewhere) elsewhere.focus({ preventScroll: true });
      return document.body.innerText.includes('Click here to type to the extension.');
    })()`,
  },
  'extension-surface-keys': {
    focusEvents: true,
    path: DEMO_SESSION_PATH,
    readyText: [DEMO_REPLY],
    // The same prompt after its footer's Show key buttons: Esc, Tab, the arrows
    // and Enter as buttons, for a mouse. Captured last of the three: its
    // Esc button answers the prompt.
    typeIntoComposer: ['!', 'git push --force-with-lease origin feature/session-sidebar'],
    submitComposer: true,
    viewports: ['desktop'],
    settledScript: `(() => {
      const surface = document.querySelector('[data-extension-surface]');
      if (!surface || !surface.innerText.includes('Permission required')) return false;
      const toggle = [...document.querySelectorAll('button[aria-expanded]')]
        .find((button) => /key buttons$/.test(button.textContent.trim()));
      if (!toggle) return false;
      if (toggle.getAttribute('aria-expanded') !== 'true') { toggle.click(); return false; }
      surface.focus({ preventScroll: true });
      return Boolean(document.querySelector('[data-extension-keybar]'));
    })()`,
    dismissAfter: 'button[aria-label^="Press Esc in"]',
  },
  'files-panel': {
    path: DEMO_SESSION_PATH,
    // The right rail's Files button opens the tree beside the session.
    openSelector: 'nav[aria-label="Panel surfaces"] button[aria-label="Files"]',
    viewports: ['desktop'],
    readyText: [DEMO_REPLY],
    // The panel can close again while the app finishes starting; press its
    // rail button until the tree's toolbar shows.
    settledScript: `(() => {
      const control = document.querySelector('nav[aria-label="Panel surfaces"] button[aria-label="Files"]');
      if (control?.getAttribute('aria-pressed') !== 'true') { control?.click(); return false; }
      return Boolean(document.querySelector('input[aria-label="Search files"]'));
    })()`,
  },
  'files-panel-file': {
    // The same panel with billing.ts open. The panel is narrow, so the tree
    // folds away and the file gets the width.
    path: DEMO_SESSION_PATH,
    openSelector: 'nav[aria-label="Panel surfaces"] button[aria-label="Files"]',
    viewports: ['desktop'],
    readyText: [DEMO_REPLY],
    settledScript: `(() => {
      const control = document.querySelector('nav[aria-label="Panel surfaces"] button[aria-label="Files"]');
      if (control?.getAttribute('aria-pressed') !== 'true') { control?.click(); return false; }
      // Syntax colors come from a worker after the text shows; wait for them.
      if (document.body.innerText.includes('Intl.NumberFormat')) return Boolean(document.querySelector('.cm-content [style*="color"]'));
      document.querySelector('span[title$="/billing.ts"]')?.closest('button')?.click();
      return false;
    })()`,
  },
  'files-panel-menu': {
    // billing.ts open with its File actions menu: each action written out.
    path: DEMO_SESSION_PATH,
    openSelector: 'nav[aria-label="Panel surfaces"] button[aria-label="Files"]',
    viewports: ['desktop'],
    readyText: [DEMO_REPLY],
    settledScript: `(() => {
      if (document.querySelector('[data-slot="dropdown-menu-content"]')) return document.body.innerText.includes('Copy path');
      const control = document.querySelector('nav[aria-label="Panel surfaces"] button[aria-label="Files"]');
      if (control?.getAttribute('aria-pressed') !== 'true') { control?.click(); return false; }
      if (document.body.innerText.includes('Intl.NumberFormat') && document.querySelector('.cm-content [style*="color"]')) {
        document.querySelector('button[aria-label="File actions"]')?.click();
        return false;
      }
      document.querySelector('span[title$="/billing.ts"]')?.closest('button')?.click();
      return false;
    })()`,
  },
  'files-panel-crumb': {
    // src/lib/dates.ts open, then the src step of its path bar: the tree opens
    // over the file to src, with Back to file.
    path: DEMO_SESSION_PATH,
    openSelector: 'nav[aria-label="Panel surfaces"] button[aria-label="Files"]',
    viewports: ['desktop'],
    readyText: [DEMO_REPLY],
    settledScript: `(() => {
      const control = document.querySelector('nav[aria-label="Panel surfaces"] button[aria-label="Files"]');
      if (control?.getAttribute('aria-pressed') !== 'true') { control?.click(); return false; }
      const crumb = document.querySelector('button[title="Show src in the tree"]');
      // The folded tree stays mounted under aria-hidden, Back to file included.
      const back = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('Back to file') && !node.closest('[aria-hidden="true"]'));
      if (crumb && !back) { crumb.click(); return false; }
      if (crumb) return Boolean(document.querySelector('[data-tree-path$="/src/lib"]'));
      const input = document.querySelector('input[aria-label="Search files"]');
      if (!input) return false;
      const hit = document.querySelector('button[title="src/lib/dates.ts"]');
      if (hit) { hit.click(); return false; }
      if (input.value !== 'dates') {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'dates');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return false;
    })()`,
  },
  'files-panel-search': {
    // A search in the Files tree: hits show name, folder, and change mark.
    path: DEMO_SESSION_PATH,
    openSelector: 'nav[aria-label="Panel surfaces"] button[aria-label="Files"]',
    viewports: ['desktop'],
    readyText: [DEMO_REPLY],
    settledScript: `(() => {
      const control = document.querySelector('nav[aria-label="Panel surfaces"] button[aria-label="Files"]');
      if (control?.getAttribute('aria-pressed') !== 'true') { control?.click(); return false; }
      // A file left open by an earlier capture folds the tree in a narrow panel.
      const treeToggle = document.querySelector('button[aria-label="Toggle file tree"]');
      if (treeToggle && treeToggle.getAttribute('aria-pressed') !== 'true') { treeToggle.click(); return false; }
      const input = document.querySelector('input[aria-label="Search files"]');
      if (!input) return false;
      if (input.value !== '.ts') {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '.ts');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return false;
      }
      return Boolean(document.querySelector('button[title="src/lib/dates.ts"]'));
    })()`,
  },
  'files-panel-nested': {
    // src/lib/dates.ts opened from a search, the folded tree shown again, and
    // the search cleared: the path bar shows its folder and the tree has
    // opened src/lib to it.
    path: DEMO_SESSION_PATH,
    openSelector: 'nav[aria-label="Panel surfaces"] button[aria-label="Files"]',
    viewports: ['desktop'],
    readyText: [DEMO_REPLY],
    settledScript: `(() => {
      const control = document.querySelector('nav[aria-label="Panel surfaces"] button[aria-label="Files"]');
      if (control?.getAttribute('aria-pressed') !== 'true') { control?.click(); return false; }
      const input = document.querySelector('input[aria-label="Search files"]');
      if (!input) return false;
      const type = (value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const opened = document.body.innerText.includes('isoDate');
      if (!opened) {
        const hit = document.querySelector('button[title="src/lib/dates.ts"]');
        if (hit) hit.click();
        else if (input.value !== 'dates') type('dates');
        return false;
      }
      // A narrow panel folds the tree when a file opens; bring it back.
      const treeToggle = document.querySelector('button[aria-label="Toggle file tree"]');
      if (treeToggle && treeToggle.getAttribute('aria-pressed') !== 'true') { treeToggle.click(); return false; }
      if (input.value) { type(''); return false; }
      return Boolean(document.querySelector('[data-tree-path$="/src/lib/dates.ts"]'))
        && Boolean(document.querySelector('.cm-content [style*="color"]'));
    })()`,
  },
  'files-panel-changes': {
    // billing.ts opened in the Files panel, then its path bar's Changes
    // button: the Git panel opens on the file's scope with it expanded.
    path: DEMO_SESSION_PATH,
    openSelector: 'nav[aria-label="Panel surfaces"] button[aria-label="Files"]',
    viewports: ['desktop'],
    readyText: [DEMO_REPLY],
    settledScript: `(() => {
      const panel = document.querySelector('[data-diff-virtual-content]');
      if (panel) {
        const header = [...panel.querySelectorAll('div[role="button"]')]
          .find((node) => node.textContent.includes('billing.ts'));
        return Boolean(header && header.parentElement?.parentElement?.children.length > 1)
          && !panel.innerText.includes('Loading diff')
          && !panel.querySelector('.h-40');
      }
      const control = document.querySelector('nav[aria-label="Panel surfaces"] button[aria-label="Files"]');
      if (control?.getAttribute('aria-pressed') !== 'true') { control?.click(); return false; }
      const changes = document.querySelector('button[title="Show this file\\'s changes"]');
      if (changes) { changes.click(); return false; }
      document.querySelector('span[title$="/billing.ts"]')?.closest('button')?.click();
      return false;
    })()`,
    idleRequestPrefix: '/api/git/',
  },
  'add-folder': {
    // The Add folder dialog's first step: where the project comes from.
    path: '/',
    viewports: ['desktop'],
    readyText: ['Add folder'],
    settledScript: addFolderSettled({ fields: [] }, `dialog.innerText.includes('New project')`),
  },
  'add-folder-browse': {
    // Folder on this server, browsing ~/code: the path field, its folders,
    // and the key hints.
    path: '/',
    viewports: ['desktop'],
    readyText: ['Add folder'],
    settledScript: addFolderSettled(
      { source: 'Folder on this server', fields: [{ label: 'Folder path', value: '~/code/' }] },
      `dialog.innerText.includes('design-notes')`,
    ),
  },
  'add-folder-clone': {
    // Clone a repository: the URL, then the location ~/code and the folder it makes.
    path: '/',
    viewports: ['desktop'],
    readyText: ['Add folder'],
    settledScript: addFolderSettled({
      source: 'Clone a repository',
      fields: [
        { label: 'Repository URL', value: 'https://github.com/acme/billing-service.git', continue: true },
        { label: 'Location', value: '~/code/' },
      ],
    }, `dialog.innerText.includes('design-notes') && dialog.innerText.includes('Clones into')`),
  },
  'add-folder-new': {
    // New project: the name, then the Git option, the location, and what it creates.
    path: '/',
    viewports: ['desktop'],
    readyText: ['Add folder'],
    settledScript: addFolderSettled({
      source: 'New project',
      fields: [
        { label: 'Project name', value: 'invoice-worker', continue: true },
        { label: 'Location', value: '~/code/' },
      ],
    }, `dialog.innerText.includes('design-notes') && dialog.innerText.includes('Creates')`),
  },
  'settings-appearance': {
    // A dense settings page: navigation, section titles, field labels,
    // descriptions, and every control type.
    path: '/?settings=appearance',
    readyText: ['Appearance'],
    viewports: ['desktop'],
  },
  'settings-snippets': {
    // The snippet cards, and the header's search, copy-path, and refresh actions.
    path: '/?settings=snippets',
    readyText: ['ask-questions'],
    viewports: ['desktop'],
  },
  'settings-projects': {
    // Project rows with icons, paths, and actions.
    path: '/?settings=projects',
    readyText: ['Acme Web', 'Night Shift'],
    // The mobile app does not open settings from the URL.
    viewports: ['desktop'],
    // The sidebar lists the same projects, so wait for the settings page's
    // own project grid before checking the icons.
    settledScript: `(() => {
      const grid = document.querySelector('[data-settings-item="projects.browse"]');
      if (!grid || !grid.innerText.includes('Night Shift')) return false;
      return ${PROJECT_ICONS_SETTLED};
    })()`,
    idleRequestPrefix: '/api/fs/project-icon',
  },
  'settings-sandboxing': {
    // Projects settings scrolled to Sandboxing: whether nono can run on the
    // server machine (a reason when it cannot) and Check again; the seeded
    // Night Shift card is labelled as sandboxed or unavailable.
    path: '/?settings=projects',
    readyText: ['Acme Web', 'Night Shift'],
    viewports: ['desktop'],
    settledScript: `(() => {
      const section = document.querySelector('[data-settings-item="projects.sandboxing"]');
      if (!section || !section.innerText.includes('Check again')) return false;
      const grid = document.querySelector('[data-settings-item="projects.browse"]');
      if (!grid || !/Sandbox/.test(grid.innerText)) return false;
      section.scrollIntoView({ block: 'end' });
      return true;
    })()`,
  },
  'settings-project': {
    // The seeded Night Shift project's settings page from the top: name,
    // default model, actions and the start of its Sandbox section.
    path: '/?settings=projects',
    readyText: ['Night Shift'],
    viewports: ['desktop'],
    settledScript: `(() => {
      const section = document.querySelector('[data-settings-item="projects.sandbox"]');
      if (!section) {
        document.querySelector('button[aria-label^="Night Shift project"]')?.click();
        return false;
      }
      return section.innerText.includes('Default');
    })()`,
  },
  'settings-project-sandbox': {
    // The seeded Night Shift project's Sandbox section: nono with an allowed
    // host, a local port and an extra folder, or why it cannot run.
    path: '/?settings=projects',
    readyText: ['Night Shift'],
    viewports: ['desktop'],
    settledScript: `(() => {
      const section = document.querySelector('[data-settings-item="projects.sandbox"]');
      if (!section) {
        document.querySelector('button[aria-label^="Night Shift project"]')?.click();
        return false;
      }
      if (!section.innerText.includes('Allowed hosts')) return false;
      section.scrollIntoView({ block: 'start' });
      return true;
    })()`,
  },
  'session-sandboxed': {
    // A session in the sandboxed Night Shift project: the chat header and its
    // sidebar row show a lock named Sandboxed. Its transcript shows even when the sandbox
    // cannot run (read from disk), so wait for the message bubble too.
    path: `/?session=${SHELF_SESSIONS[1].id}`,
    readyText: [SHELF_SESSIONS[1].title],
    settledScript: `(() => {
      const text = document.body.innerText;
      return document.querySelector('[role="img"][aria-label="Sandboxed"]') && text.split(${JSON.stringify(SHELF_SESSIONS[1].title)}).length > 3;
    })()`,
  },
  'terminal-sandboxed': {
    // The terminal beside a sandboxed session says it runs outside the sandbox.
    path: `/?session=${SHELF_SESSIONS[1].id}`,
    readyText: [SHELF_SESSIONS[1].title],
    viewports: ['desktop'],
    settledScript: `(() => {
      if (document.body.innerText.includes('runs outside the sandbox')) return true;
      const control = document.querySelector('nav[aria-label="Panel surfaces"] button[aria-label^="Terminal"]');
      if (control?.getAttribute('aria-pressed') !== 'true') control?.click();
      return false;
    })()`,
  },
  'settings-archive': {
    // Sessions settings scrolled to Archive and delete: the two day settings
    // and the suggestion that shows while auto-archive is off.
    path: '/?settings=sessions',
    readyText: ['Archive and delete'],
    viewports: ['desktop'],
    settledScript: `(() => {
      const row = document.querySelector('[data-settings-item="sessions.auto-archive"]');
      if (!row) return false;
      row.closest('section')?.scrollIntoView({ block: 'start' });
      return true;
    })()`,
  },
  'settings-extension-interface': {
    // Sessions settings at Extension interface, with the pointer on its info
    // icon so the explanation of the two choices shows.
    path: '/?settings=sessions',
    readyText: ['Extension interface'],
    viewports: ['desktop'],
    settledScript: `(() => {
      const row = document.querySelector('[data-settings-item="sessions.extension-interface"]');
      if (!row) return false;
      row.scrollIntoView({ block: 'center' });
      return true;
    })()`,
    hoverScript: `(() => {
      const row = document.querySelector('[data-settings-item="sessions.extension-interface"]');
      const icon = row?.querySelector('svg');
      if (!icon) return null;
      const box = icon.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`,
  },
  'settings-sidebar-view': {
    // Appearance scrolled to Sidebar view with Legacy views open, so Timeline shows.
    path: '/?settings=appearance',
    readyText: ['Legacy views'],
    viewports: ['desktop'],
    settledScript: `(() => {
      const group = document.querySelector('[data-settings-item="appearance.sidebar-view"]');
      const legacy = group?.querySelector('details');
      if (!group || !legacy) return false;
      legacy.open = true;
      group.scrollIntoView({ block: 'start' });
      return true;
    })()`,
  },
  'settings-plugins': {
    // Settings → Extensions & Plugins with both bundled plugins on: a row per
    // plugin with its switch and what it adds to the agent, then the start of
    // Pi's extensions.
    path: '/?settings=plugins',
    readyText: ['Visuals', 'Sub-agents', 'Native'],
    viewports: ['desktop'],
  },
  'settings-marketplace': {
    // Browse from the Extensions & Plugins header: the featured picks, then
    // popular Pi packages, from the demo npm registry.
    path: '/?settings=plugins',
    readyText: ['Visuals'],
    demoNpm: true,
    viewports: ['desktop'],
    settledScript: `(() => {
      if (!document.body.innerText.includes('Popular')) {
        if (!window.__browseAsked) {
          window.__browseAsked = true;
          document.querySelector('[data-settings-item="plugins.browse"]')?.click();
        }
        return false;
      }
      return ['Featured', 'pi-web-reader', 'pi-commit-coach'].every((t) => document.body.innerText.includes(t));
    })()`,
  },
  'settings-marketplace-search': {
    // A search for "subagent": Sub-agents ships with PiChamber, so it shows
    // first with its switch, above the npm results.
    path: '/?settings=plugins',
    readyText: ['Visuals'],
    demoNpm: true,
    viewports: ['desktop'],
    settledScript: `(() => {
      const input = document.querySelector('input[aria-label="Search Pi packages"]');
      if (!input) {
        if (!window.__browseAsked) {
          window.__browseAsked = true;
          document.querySelector('[data-settings-item="plugins.browse"]')?.click();
        }
        return false;
      }
      if (input.value !== 'subagent') {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'subagent');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return false;
      }
      return ['Built into PiChamber', 'pi-team-agents'].every((t) => document.body.innerText.includes(t));
    })()`,
  },
  'settings-marketplace-package': {
    // A package's page, opened from its name under Packages: the seeded
    // npm package, enhanced for PiChamber and one release behind, with
    // Update, what it adds, About, and Links.
    path: '/?settings=plugins',
    readyText: ['Visuals'],
    demoNpm: true,
    viewports: ['desktop'],
    settledScript: `(() => {
      if (document.body.innerText.includes('What it adds to Pi')) {
        return ['Maintainer', 'acme-tools', 'Source code'].every((t) => document.body.innerText.includes(t));
      }
      const open = document.querySelector('button[aria-label="@acme/pi-review-gate details"]');
      if (open) {
        if (!window.__packageAsked) {
          window.__packageAsked = true;
          open.click();
        }
        return false;
      }
      if (!window.__browseAsked) {
        window.__browseAsked = true;
        document.querySelector('[data-settings-item="plugins.browse"]')?.click();
      }
      return false;
    })()`,
  },
  'settings-marketplace-mobile': {
    // Browse on a phone, searching "subagent": reached from the composer
    // sheet's Plugin settings, since a phone has no settings link to open.
    path: VISUALS_SESSION_PATH,
    readyText: [VISUALS_REPLY],
    viewports: ['mobile'],
    demoNpm: true,
    settledScript: `(() => {
      const input = document.querySelector('input[aria-label="Search Pi packages"]');
      if (input) {
        if (input.value !== 'subagent') {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'subagent');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.blur();
          return false;
        }
        return ['Built into PiChamber', 'pi-team-agents'].every((t) => document.body.innerText.includes(t));
      }
      const browse = document.querySelector('[data-settings-item="plugins.browse"]');
      if (browse) {
        if (!window.__browseAsked) {
          window.__browseAsked = true;
          browse.click();
        }
        return false;
      }
      // One press each: the sheet's button, then its settings link.
      const link = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Plugin settings');
      if (link && !window.__settingsAsked) {
        window.__settingsAsked = true;
        link.click();
      } else if (!link && !window.__sheetAsked) {
        window.__sheetAsked = true;
        document.querySelector('button[aria-label^="Composer controls"]')?.click();
      }
      return false;
    })()`,
  },
  'settings-marketplace-install': {
    // Install on a package page: the dialog says what installing means and
    // asks where to load it. Nothing is installed.
    path: '/?settings=plugins',
    readyText: ['Visuals'],
    demoNpm: true,
    viewports: ['desktop'],
    settledScript: `(() => {
      // The settings window is a dialog too: wait for the install one's title.
      if (document.body.innerText.includes('Install pi-web-reader?')) return true;
      const install = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Install'
        && document.body.innerText.includes('What it adds to Pi'));
      if (install) {
        if (!window.__installAsked) {
          window.__installAsked = true;
          install.click();
        }
        return false;
      }
      const open = document.querySelector('button[aria-label="pi-web-reader details"]');
      if (open && !window.__packageAsked) {
        window.__packageAsked = true;
        open.click();
      } else if (!open && !window.__browseAsked) {
        window.__browseAsked = true;
        document.querySelector('[data-settings-item="plugins.browse"]')?.click();
      }
      return false;
    })()`,
  },
  'settings-extensions': {
    // The same page at Pi extensions, Global: the seed's local package with
    // one extension off, the demo extensions, and Pi's built-ins.
    path: '/?settings=plugins',
    readyText: ['Pi extensions', 'review-kit', 'Built into Pi'],
    viewports: ['desktop'],
    settledScript: `(() => {
      const section = document.querySelector('[data-settings-item="plugins.extensions"]');
      if (!section) return false;
      section.scrollIntoView({ block: 'start' });
      return true;
    })()`,
  },
  'settings-extensions-project': {
    // Pi extensions on This project: each extension has the project's own
    // choice (the global setting, on, off) as three chips in place of a switch.
    path: '/?settings=plugins',
    readyText: ['Pi extensions', 'review-kit', 'Built into Pi'],
    expandSelector: '[aria-label="Extension settings for"] button:nth-of-type(2)',
    viewports: ['desktop'],
    settledScript: `(() => {
      const section = document.querySelector('[data-settings-item="plugins.extensions"]');
      if (!section || !section.querySelector('[aria-label$=" in this project"]')) return false;
      section.scrollIntoView({ block: 'start' });
      return true;
    })()`,
  },
  'settings-extensions-mobile': {
    // Pi extensions on a phone, This project: reached from the composer
    // sheet's Plugin settings, since a phone has no settings link to open.
    path: VISUALS_SESSION_PATH,
    readyText: [VISUALS_REPLY],
    viewports: ['mobile'],
    settledScript: `(() => {
      const section = document.querySelector('[data-settings-item="plugins.extensions"]');
      if (!section) {
        // One press each: the sheet's button, then its settings link.
        const link = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Plugin settings');
        if (link && !window.__settingsAsked) {
          window.__settingsAsked = true;
          link.click();
        } else if (!link && !window.__sheetAsked) {
          window.__sheetAsked = true;
          document.querySelector('button[aria-label^="Composer controls"]')?.click();
        }
        return false;
      }
      const project = section.querySelector('[aria-label="Extension settings for"] button:nth-of-type(2)');
      if (project?.getAttribute('aria-pressed') !== 'true') {
        project?.click();
        return false;
      }
      if (!section.querySelector('[aria-label$=" in this project"]')) return false;
      section.scrollIntoView({ block: 'start' });
      return true;
    })()`,
  },
  'settings-extensions-remove': {
    // The package's Remove action: a dialog that names the package and where
    // it stops loading. Nothing is removed.
    path: '/?settings=plugins',
    readyText: ['Pi extensions', 'review-kit', 'Built into Pi'],
    expandSelector: '[data-settings-item="plugins.extensions"] button[aria-label^="Remove "]',
    settledScript: `Boolean(document.querySelector('[role="dialog"]')) && document.body.innerText.includes('Remove package?')`,
    viewports: ['desktop'],
  },
  'settings-plugin-detail': {
    // Visuals' own page, opened from its row: what it adds to the agent and
    // to PiChamber, its options, and About.
    path: '/?settings=plugins',
    readyText: ['Visuals', 'Sub-agents', 'Built in'],
    expandSelector: 'button[aria-label="Visuals settings"]',
    settledScript: `document.body.innerText.includes('What it adds to the agent')`,
    viewports: ['desktop'],
  },
  'settings-plugin-replaced': {
    // Sub-agents' own page from the Night Shift session. That folder has its
    // own `subagent` extension, so Pi loads it and not the plugin: the page
    // opens with a warning that names the extension and a button that turns
    // it off in that project. Opening the session starts the folder's runtime,
    // which is what the server reads the replacement from.
    path: `/?session=${SHELF_SESSIONS[1].id}&settings=plugins`,
    readyText: ['Sub-agents', 'Built in', 'takes its place'],
    expandSelector: 'button[aria-label="Sub-agents settings"]',
    settledScript: `document.body.innerText.includes('Pi is not loading this plugin') && document.body.innerText.includes('What it adds to the agent')`,
    viewports: ['desktop'],
  },
  'visuals-page': {
    // A render_html page drawn in the reply column under the turn's
    // activity, with no frame of its own, and the Sub-agents composer toggle
    // below (Visuals has none).
    path: VISUALS_SESSION_PATH,
    readyText: [VISUALS_REPLY],
    // The page has drawn and the frame has fitted to it.
    settledScript: `(() => {
      const frame = document.querySelector('[data-plugin-artifact="visuals"] iframe');
      return Boolean(frame) && frame.getBoundingClientRect().height > 0 && frame.getBoundingClientRect().height !== 240;
    })()`,
  },
  'visuals-page-hover': {
    // The same page with the pointer on it: its More and Expand buttons show
    // at its top right (on touch screens they sit under the page). Desktop only.
    path: VISUALS_SESSION_PATH,
    readyText: [VISUALS_REPLY],
    settledScript: `(() => {
      const frame = document.querySelector('[data-plugin-artifact="visuals"] iframe');
      return Boolean(frame) && frame.getBoundingClientRect().height > 0 && frame.getBoundingClientRect().height !== 240;
    })()`,
    hoverScript: `(() => {
      // Rest on the buttons' corner of the page.
      const rect = document.querySelector('[data-plugin-artifact="visuals"] [aria-label="Expand page"]')?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    })()`,
    viewports: ['desktop'],
  },
  'visuals-choices': {
    // An answered render_choices call: one variant at a time at full width,
    // opened on the chosen one, the note under the frame.
    path: CHOICES_SESSION_PATH,
    readyText: [CHOICES_TITLE, CHOICES_REPLY, 'You chose B'],
    settledScript: CHOICES_DRAWN,
  },
  'visuals-choices-pending': {
    // A render_choices call that waits. Acme Web's scripted model answers the
    // message with the call; the shown variant has a Choose button and the
    // same question sits above the composer. The question stays open for the next
    // viewport and theme, then this page closes it, which adds a turn to the
    // session: re-seed for a clean capture.
    path: CHOICES_LIVE_SESSION_PATH,
    readyText: [CHOICES_LIVE_SESSION.title],
    typeIntoComposer: [CHOICES_PROMPT],
    submitComposer: true,
    settledScript: CHOICES_WAITING,
    dismissAfter: '[role="dialog"] button[aria-label="Dismiss extension dialog"]',
  },
  'visuals-choices-switch': {
    // The same waiting question after its second switcher button: variant B
    // is in the frame with its own Choose button. When done, this page
    // presses Choose B, which answers the question and adds a turn.
    path: CHOICES_LIVE_SESSION_PATH,
    readyText: [CHOICES_LIVE_SESSION.title],
    typeIntoComposer: [CHOICES_PROMPT],
    submitComposer: true,
    settledScript: CHOICES_SWITCHED,
    dismissAfter: '[data-plugin-artifact="visuals-choices"] figcaption button',
  },
  'notices-mid-turn': {
    // Notices raised between tool rounds of a running turn (Acme Web's
    // scripted model and run_check tool): each sits where it arrived, with
    // later rounds below it. Notices are live-only, so a reload drops them:
    // each viewport is its own page and stops its turn when done, which adds
    // a turn to the session. Desktop only.
    path: CHOICES_LIVE_SESSION_PATH,
    readyText: [CHOICES_LIVE_SESSION.title],
    typeIntoComposer: [NOTICES_PROMPT],
    submitComposer: true,
    settledScript: NOTICES_RUNNING,
    dismissAfter: 'button[aria-label="Stop generating"]',
    viewports: ['desktop'],
  },
  'notices-idle': {
    // A notice raised after the turn ended (Acme Web's scripted model and
    // extension): its own row below the finished turn. Each capture adds a
    // turn to the session.
    path: CHOICES_LIVE_SESSION_PATH,
    readyText: [CHOICES_LIVE_SESSION.title],
    typeIntoComposer: [IDLE_PROMPT],
    submitComposer: true,
    settledScript: `(() => {
      const text = document.body?.innerText ?? '';
      return text.includes(${JSON.stringify(IDLE_NOTICE)}) && text.includes(${JSON.stringify(IDLE_REPLY)})
        && !document.querySelector('button[aria-label="Stop generating"]');
    })()`,
  },
  'notices-mid-turn-mobile': {
    // The same on a phone, mobile only.
    path: CHOICES_LIVE_SESSION_PATH,
    readyText: [CHOICES_LIVE_SESSION.title],
    typeIntoComposer: [NOTICES_PROMPT],
    submitComposer: true,
    settledScript: NOTICES_RUNNING,
    dismissAfter: 'button[aria-label="Stop generating"]',
    viewports: ['mobile'],
  },
  'composer-plugin-sheet': {
    // Phones: the plugin button beside Send pressed, opening the sheet with a
    // switch per composer toggle (only Sub-agents declares one).
    path: VISUALS_SESSION_PATH,
    readyText: [VISUALS_REPLY],
    expandSelector: 'button[aria-label^="Composer controls"]',
    settledScript: `document.body.innerText.includes('Plugin settings')`,
    viewports: ['mobile'],
  },
  'composer-controls': {
    // The seed's demo extension declares a Mode cycle and a Plan toggle with
    // `pichamber:composer`; they follow the plugin toggles in the footer.
    path: DEMO_SESSION_PATH,
    readyText: [DEMO_REPLY],
    settledScript: `Boolean(document.querySelector('[data-extension-control="mode"]'))`,
    viewports: ['desktop'],
  },
  'composer-controls-draft': {
    // A new-session draft: its draft session (a runtime started for the
    // draft, never listed) reports the demo extension's controls before
    // anything is sent.
    path: '/',
    readyText: ['Add folder'],
    settledScript: `Boolean(document.querySelector('[data-extension-control="mode"]'))`,
    viewports: ['desktop'],
  },
  'draft-wallpaper-dither': {
    // The new-session screen with the Dither wallpaper: a still ordered
    // dither in the theme's ink, emptied around the title and composer.
    path: '/',
    readyText: ['Add folder'],
    draftWallpaper: 'dither',
    settledScript: `Boolean(document.querySelector('[data-draft-wallpaper="dither"]'))`,
    viewports: ['desktop'],
  },
  'draft-wallpaper-ascii': {
    // The same screen with the ASCII wallpaper.
    path: '/',
    readyText: ['Add folder'],
    draftWallpaper: 'ascii',
    settledScript: `Boolean(document.querySelector('[data-draft-wallpaper="ascii"]'))`,
    viewports: ['desktop'],
  },
  // The same screen with each of the other patterns.
  ...Object.fromEntries(['halftone', 'strands', 'grain'].map((wallpaper) => [`draft-wallpaper-${wallpaper}`, {
    path: '/',
    readyText: ['Add folder'],
    draftWallpaper: wallpaper,
    settledScript: `Boolean(document.querySelector('[data-draft-wallpaper="${wallpaper}"]'))`,
    viewports: ['desktop'],
  }])),
  'session-wallpaper': {
    // The demo session with Show in open sessions on: the Halftone
    // wallpaper, still and faint, at the top, faded out above the messages.
    path: DEMO_SESSION_PATH,
    readyText: [DEMO_REPLY],
    draftWallpaper: 'halftone',
    draftWallpaperInSessions: true,
    settledScript: `Boolean(document.querySelector('[data-draft-wallpaper="halftone"] canvas'))`,
    viewports: ['desktop'],
  },
  'settings-themes-all': {
    // Appearance with the theme list opened by Show all: one tile per
    // built-in theme family, in the mode's half, the one in use marked.
    path: '/?settings=appearance',
    readyText: ['Show all'],
    expandSelector: '[data-settings-item="appearance.theme"] button[aria-expanded]',
    settledScript: `document.body.innerText.includes('Show fewer')`,
    viewports: ['desktop'],
  },
  'settings-wallpaper': {
    // Appearance at Wallpaper: a still swatch per pattern, and the picture
    // and motion rows under them; the seed has no picture, so only Choose works.
    path: '/?settings=appearance',
    readyText: ['Moving wallpaper'],
    draftWallpaper: 'halftone',
    viewports: ['desktop'],
    settledScript: `(() => {
      const group = document.querySelector('[data-settings-item="appearance.wallpaper"]');
      if (!group || group.querySelectorAll('img').length < 5) return false;
      group.scrollIntoView({ block: 'start' });
      return true;
    })()`,
  },
  'composer-controls-sheet': {
    // Phones: the composer controls sheet from the button beside Send, with
    // a chip for every mode and a switch for Plan.
    path: DEMO_SESSION_PATH,
    readyText: [DEMO_REPLY],
    expandSelector: 'button[aria-label^="Composer controls"]',
    settledScript: `document.body.innerText.includes('From your Pi extensions')`,
    viewports: ['mobile'],
  },
  'visuals-expanded': {
    // The same page opened full window from its Expand action.
    path: VISUALS_SESSION_PATH,
    readyText: [VISUALS_REPLY],
    // Pressed until it exists: the reply can show before the page does.
    openSelector: '[data-plugin-artifact="visuals"] [aria-label="Expand page"]',
    settledScript: `Boolean(document.querySelector('[role="dialog"] iframe'))`,
    viewports: ['desktop'],
  },
  'subagents-turn': {
    // A finished sub-agent chain in its turn: a card per run with its model's
    // logo, task, and status.
    path: AGENTS_SESSION_PATH,
    readyText: [AGENTS_REPLY, 'Sub-agent chain'],
    settledScript: `document.querySelectorAll('[data-plugin-artifact="subagents"] button[aria-label*=": Done"]').length === 2`,
  },
  'turn-activity': {
    // A settled turn's one line: its duration and what its tools did, with
    // the failed command counted.
    path: TOOLS_SESSION_PATH,
    readyText: [TOOLS_REPLY],
    settledScript: `Boolean(document.querySelector('[data-turn-activity-summary]'))`,
  },
  'turn-activity-open': {
    // The same line pressed: the turn's reads, edits and commands in order.
    path: TOOLS_SESSION_PATH,
    readyText: [TOOLS_REPLY],
    expandSelector: '[data-turn-activity-toggle]',
    settledScript: `document.querySelector('[data-turn-activity-toggle]')?.getAttribute('aria-expanded') === 'true'`,
  },
  'subagents-run': {
    // The reviewer's card pressed: the run on its own, in the Agents panel on
    // desktop and in a sheet on phones.
    path: AGENTS_SESSION_PATH,
    readyText: [AGENTS_REPLY, 'Sub-agent chain'],
    expandSelector: '[data-plugin-artifact="subagents"] button[aria-label^="reviewer"]',
    settledScript: `document.body.innerText.includes('Answer') && document.body.innerText.includes('Task')`,
  },
  'subagents-panel': {
    // The same chain in the Agents panel, opened from the turn's Open in panel.
    path: AGENTS_SESSION_PATH,
    readyText: [AGENTS_REPLY, 'Sub-agent chain'],
    expandSelector: '[data-plugin-artifact="subagents"] header button',
    settledScript: `Boolean(document.querySelector('[data-testid="agents-surface"]'))`,
    viewports: ['desktop'],
  },
  'command-palette': {
    path: DEMO_SESSION_PATH,
    readyText: [DEMO_REPLY],
    // Ctrl+P (the default palette shortcut on Linux and Windows), pressed once the page is ready.
    shortcut: { key: 'p', code: 'KeyP', modifiers: 2 },
    // Phones open the palette from a button, not a shortcut.
    viewports: ['desktop'],
    settledScript: `Boolean(document.querySelector('input[placeholder^="Search files, sessions"]'))`,
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
  'browser-downloads': {
    path: '/',
    openSelector: 'nav[aria-label="Panel surfaces"] button[aria-label="Browser"]',
    viewports: ['desktop'],
    readyText: [],
    // On the Server route: the page downloads a finished report and a
    // dataset still in progress, listed under the page.
    browserAddress: `http://localhost:${DEMO_SITE_PORT}/exports`,
    thenBrowserAddresses: [`http://localhost:${DEMO_SITE_PORT}/files/acme-dataset.zip`],
    // Typed once the report has downloaded (the toast or the list names it).
    thenWhenScript: `document.body.innerText.includes('acme-report.pdf')`,
    settledScript: `(() => {
      const list = document.querySelector('section[aria-label="Downloads"]');
      return Boolean(list && list.innerText.includes('acme-dataset.zip') && list.innerText.includes('42 MB of 180 MB') && list.innerText.includes('Save to server'));
    })()`,
  },
};

// The demo site's exports page downloads a report that finishes at once;
// the dataset (typed afterwards: Chrome blocks a page's second automatic
// download) stops partway, so the Downloads list shows a finished file and
// one in progress.
const DEMO_EXPORTS_HTML = `<!doctype html><html><head><title>Acme exports</title></head>
<body style="margin:0;font:15px system-ui,sans-serif;padding:24px">Your exports are downloading.
<script>
const a = document.createElement('a'); a.href = '/files/acme-report.pdf'; a.download = 'acme-report.pdf'; document.body.append(a); a.click();
</script></body></html>`;

const serveDemoDownload = (req, res) => {
  if (req.url === '/files/acme-report.pdf') {
    const body = Buffer.alloc(Math.round(2.4 * 1024 * 1024), 1);
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': body.length, 'content-disposition': 'attachment; filename="acme-report.pdf"' });
    res.end(body);
    return true;
  }
  if (req.url === '/files/acme-dataset.zip') {
    // 180 MB promised, 42 MB sent, then the connection stays open.
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': 180 * 1024 * 1024, 'content-disposition': 'attachment; filename="acme-dataset.zip"' });
    res.write(Buffer.alloc(42 * 1024 * 1024, 2));
    return true;
  }
  return false;
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

// Close what a page left open, then wait until its settled state is gone.
const dismissAfterPage = async (client, pageName, page) => {
  const selector = JSON.stringify(page.dismissAfter);
  await client.evaluate(`document.querySelector(${selector})?.click()`);
  await waitFor(
    async () => !(await client.evaluate(page.settledScript)),
    10_000,
    `${pageName} dismissed`,
  );
};

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
  // A headless page has no window focus, so moving focus fires no focus
  // events; pages that show what focus does ask for them.
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: Boolean(page.focusEvents) });
  await client.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: theme },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
  });
  // The sidebar view and the new-session wallpaper are server settings;
  // pages without them use Workspace and no wallpaper.
  const settings = await fetch(new URL('/api/pi/ui-settings', baseUrl), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sidebarViewMode: page.sidebarViewMode ?? 'workspace',
      draftWallpaper: page.draftWallpaper ?? 'none',
      draftWallpaperPicture: false,
      draftWallpaperInSessions: page.draftWallpaperInSessions ?? false,
      // Kept still so each capture shows the same frame.
      draftWallpaperMotion: false,
    }),
  });
  if (!settings.ok) throw new Error(`${pageName}: could not set the sidebar view (${settings.status})`);
  if (page.typeIntoComposer) {
    // Viewports share one browser profile, so the previous capture's typed
    // draft would be restored into this composer. Leave the page first so its
    // last draft write lands, then drop the origin's local storage.
    await client.send('Page.navigate', { url: 'about:blank' });
    await wait(300);
    await client.send('Storage.clearDataForOrigin', { origin: new URL(baseUrl).origin, storageTypes: 'local_storage' });
  }
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
      // More addresses typed after it, as a person would.
      for (const address of page.thenBrowserAddresses ?? []) {
        if (page.thenWhenScript) await waitFor(() => client.evaluate(page.thenWhenScript), 30_000, `${pageName} ready for the next address`);
        await client.evaluate(`(() => { const input = document.querySelector('[aria-label="Browser address"]'); input.focus(); input.select(); })()`);
        await client.send('Input.insertText', { text: address });
        for (const type of ['keyDown', 'keyUp']) {
          await client.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
        }
      }
    }
    if (page.openRequest) await sendOpenRequest(page.openRequest);
    if (page.shortcut) {
      const { key, code, modifiers } = page.shortcut;
      const keyCode = key.toUpperCase().charCodeAt(0);
      for (const type of ['rawKeyDown', 'keyUp']) {
        await client.send('Input.dispatchKeyEvent', { type, key, code, modifiers, windowsVirtualKeyCode: keyCode });
      }
    }
    // A page that sends from the composer settles on what the send opens.
    if (page.settledScript && !page.submitComposer) {
      await waitForSettled(client, page, network, `${pageName} settled`);
    }
    if (page.hoverScript) {
      // Hover-only controls: move the pointer to the point the script returns.
      const point = await client.evaluate(page.hoverScript);
      if (!point) throw new Error(`${pageName}: nothing to hover`);
      await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
      await wait(150);
    }
    // A send that opened something blocking (a dialog) leaves it open for
    // the next viewport and theme; sending again would only fail as busy.
    const alreadySettled = page.submitComposer && page.settledScript
      ? await waitFor(() => client.evaluate(page.settledScript), 3_000, 'open dialog').then(() => true, () => false)
      : false;
    if (page.typeIntoComposer && !alreadySettled) {
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
      if (page.submitComposer) {
        for (const type of ['keyDown', 'keyUp']) {
          await client.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
        }
        // A phone composer takes Enter as a new line; send with its button.
        if (viewport.mobile) {
          await wait(300);
          await client.evaluate(`document.querySelector('button[aria-label="Send message"]')?.click()`);
        }
        if (page.settledScript) await waitForSettled(client, page, network, `${pageName} settled after send`);
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

// A Pi extension that gates `!git log` behind a select() dialog the way
// permission extensions do: a heading line, then the request, in one title.
const writeDemoExtension = async (home) => {
  const dir = join(home, '.pi', 'agent', 'extensions');
  await mkdir(dir, { recursive: true });
  const title = [
    'Permission Required',
    "Requested bash command 'git log --oneline && echo hello && ls -la src | head -5' (matched 'git log *').",
    'Allow this command?',
  ].join('\n');
  await writeFile(join(dir, 'demo-dialog.ts'), `export default function (pi) {
  pi.on('user_bash', async (event, ctx) => {
    if (!event.command.startsWith('git log')) return;
    await ctx.ui.select(${JSON.stringify(title)}, ['Allow Once', 'Allow Always', 'Reject', 'Reject with Reason']);
  });
}
`);
  await writeFile(join(dir, 'demo-surface.ts'), DEMO_SURFACE_EXTENSION);
  await writeFile(join(dir, 'demo-controls.ts'), DEMO_CONTROLS_EXTENSION);
  await writeDemoPackage(home);
};

// A project's own extension with the tool name of the bundled Sub-agents
// plugin. It is never called: the captures only open the folder's session.
const PROJECT_SUBAGENT_EXTENSION = `export default function (pi) {
  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: 'Hand a task to a sub-agent.',
    parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
    execute: async () => ({ content: [{ type: 'text', text: 'done' }], details: {} }),
  });
}
`;

// Acme Web's own extension: a model that runs in the daemon and answers from
// this script, so the pending render_choices capture needs no provider. A
// message gets the call; its result gets one line back.
const PROJECT_SCRIPTED_MODEL_EXTENSION = `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';

const CALL = ${JSON.stringify({ title: CHOICES_TITLE, options: CHOICES_OPTIONS })};
const CHECKS = ${JSON.stringify(NOTICES_CHECKS)};
const textOf = (message) => (typeof message.content === 'string'
  ? message.content
  : (message.content ?? []).map((part) => part.text ?? '').join(''));

export default function (pi) {
  pi.on('agent_end', async (event, ctx) => {
    const prompt = (event.messages ?? []).find((message) => message.role === 'user');
    if (!prompt || !textOf(prompt).includes(${JSON.stringify(IDLE_PROMPT)})) return;
    setTimeout(() => ctx.ui.notify(${JSON.stringify(IDLE_NOTICE)}, 'info'), 1500);
  });
  pi.registerTool({
    name: 'run_check',
    label: 'Run check',
    description: 'Run one release check.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const check = CHECKS.find((candidate) => candidate.name === params.name) ?? CHECKS[0];
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, check.ms);
        signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (!signal?.aborted) ctx.ui.notify(check.notice, 'info');
      return { content: [{ type: 'text', text: check.notice }], details: {} };
    },
  });
  const faux = fauxProvider({
    provider: 'demo',
    models: [{ id: 'demo-model', name: 'Demo Model', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }],
    tokensPerSecond: 400,
  });
  const respond = (context) => {
    const last = context.messages.at(-1);
    const userIndex = context.messages.findLastIndex((message) => message.role === 'user');
    if (userIndex >= 0 && textOf(context.messages[userIndex]).includes(${JSON.stringify(NOTICES_PROMPT)})) {
      const done = context.messages.slice(userIndex).filter((message) => message.role === 'toolResult').length;
      if (done < CHECKS.length) {
        return fauxAssistantMessage([fauxToolCall('run_check', { name: CHECKS[done].name })], { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage('All release checks passed.');
    }
    if (userIndex >= 0 && textOf(context.messages[userIndex]).includes(${JSON.stringify(IDLE_PROMPT)})) {
      return fauxAssistantMessage(${JSON.stringify(IDLE_REPLY)});
    }
    if (last?.role !== 'toolResult') {
      return fauxAssistantMessage([fauxToolCall('render_choices', CALL)], { stopReason: 'toolUse' });
    }
    const text = (last.content ?? []).map((part) => part.text ?? '').join('');
    return fauxAssistantMessage(text.includes('chose') ? ${JSON.stringify(CHOICES_REPLY)} : 'No problem. Tell me which one you want when you are ready.');
  };
  faux.setResponses(Array.from({ length: 200 }, () => respond));
  pi.registerProvider(faux.provider);
}
`;

// A local Pi package for Settings → Extensions & Plugins to list: two
// extensions that do nothing, one turned off in Pi's settings. It sits in a
// hidden folder so the Add folder dialog's view of home stays the same.
const writeDemoPackage = async (home) => {
  const root = join(home, '.pi-packages', 'review-kit');
  await mkdir(join(root, 'extensions'), { recursive: true });
  await writeFile(join(root, 'package.json'), `${JSON.stringify({
    name: 'review-kit', version: '1.0.0', keywords: ['pi-package'],
  }, null, 2)}\n`);
  for (const name of ['checklist.ts', 'release-notes.ts']) {
    await writeFile(join(root, 'extensions', name), 'export default function () {}\n');
  }
  // An npm package one release behind the demo registry, as if `pi install`
  // had put it in Pi's npm folder: Packages shows it with Update to 1.3.0 and
  // the Enhanced tag. Its extension does nothing.
  const gate = join(home, '.pi', 'agent', 'npm', 'node_modules', '@acme', 'pi-review-gate');
  await mkdir(gate, { recursive: true });
  await writeFile(join(gate, 'package.json'), `${JSON.stringify({
    name: '@acme/pi-review-gate', version: '1.2.0', keywords: ['pi-package', 'pichamber-plugin'],
    pi: { extensions: ['./index.ts'] }, pichamber: { apiVersion: 1 },
  }, null, 2)}\n`);
  await writeFile(join(gate, 'index.ts'), 'export default function () {}\n');
  await writeFile(join(home, '.pi', 'agent', 'settings.json'), `${JSON.stringify({
    packages: [
      'npm:@acme/pi-review-gate',
      { source: '../../.pi-packages/review-kit', extensions: ['-extensions/release-notes.ts'] },
    ],
  }, null, 2)}\n`);
};

// Composer controls a plain Pi extension declares with `pichamber:composer`:
// a mode picker that cycles through its own `/demo-mode <name>` command and a
// plan toggle. A mode switches model and thinking, as a real mode extension
// does, so the composer can be seen following it: the cheapest, middle, or
// priciest model of the session's provider (by input price), and low, medium,
// or high thinking. Switching sends nothing to a model.
const DEMO_CONTROLS_EXTENSION = `const MODES = ['economy', 'balance', 'premium'];
const THINKING = { economy: 'low', balance: 'medium', premium: 'high' };
const pickModel = (ctx, name) => {
  const available = ctx.modelRegistry.getAvailable();
  const sameProvider = available.filter((model) => model.provider === ctx.model?.provider);
  const models = (sameProvider.length > 1 ? sameProvider : available)
    .slice()
    .sort((a, b) => (a.cost?.input ?? 0) - (b.cost?.input ?? 0) || a.id.localeCompare(b.id));
  if (models.length < 2) return undefined;
  if (name === 'economy') return models[0];
  if (name === 'premium') return models[models.length - 1];
  return models[Math.floor(models.length / 2)];
};
const label = (name) => name[0].toUpperCase() + name.slice(1);

export default function (pi) {
  let mode = 'balance';
  let plan = false;
  const publish = () => {
    pi.events.emit('pichamber:composer', {
      id: 'mode', kind: 'cycle', label: 'Mode', description: 'Model and thinking presets', value: mode,
      options: MODES.map((name) => ({ value: name, label: label(name), command: 'demo-mode ' + name })),
    });
    pi.events.emit('pichamber:composer', {
      id: 'plan', kind: 'toggle', label: 'Plan', description: 'Read-only planning before edits', value: plan, command: 'demo-plan',
    });
  };
  pi.registerCommand('demo-mode', {
    description: 'Switch the demo mode',
    handler: async (args, ctx) => {
      if (!MODES.includes(args.trim())) return;
      mode = args.trim();
      const model = pickModel(ctx, mode);
      if (model) await pi.setModel(model);
      pi.setThinkingLevel(THINKING[mode]);
      publish();
    },
  });
  pi.registerCommand('demo-plan', {
    description: 'Toggle demo plan mode',
    handler: async () => { plan = !plan; publish(); },
  });
  pi.on('session_start', async () => publish());
}
`;

// A permission prompt drawn the way terminal-first extensions draw theirs:
// with ctx.ui.custom() under the terminal UI, and select() otherwise, which
// is what Settings > Sessions > Extension interface > Standard dialogs gets.
const DEMO_SURFACE_EXTENSION = `const OPTIONS = ['Allow once', 'Allow for this session', 'Deny', 'Deny with feedback'];

export default function (pi) {
  pi.on('user_bash', async (event, ctx) => {
    if (!event.command.startsWith('git push')) return;
    if (ctx.mode !== 'tui') {
      await ctx.ui.select('Permission required\\nbash: ' + event.command, OPTIONS);
      return;
    }
    await ctx.ui.custom((tui, theme, keybindings, done) => {
      let selected = 0;
      // Colours come from Pi's theme, as extensions use them; the branch name
      // is plain SGR green, as a command's own output would be.
      const branch = event.command.split(' ').pop();
      const command = event.command.slice(0, event.command.length - branch.length) + '\\x1b[32m' + branch + '\\x1b[39m';
      return {
        render(width) {
          const rule = theme.fg('border', '─'.repeat(Math.max(0, width)));
          return [
            rule,
            ' ' + theme.bold(theme.fg('warning', 'Permission required')) + theme.fg('dim', '  bash'),
            '',
            '   ' + theme.bold(command),
            '',
            ' ' + theme.fg('muted', 'Rule  ') + theme.fg('text', "bash 'git push *' asks before it runs"),
            '',
            ...OPTIONS.map((option, index) => (index === selected
              ? theme.bg('selectedBg', ' ' + theme.fg('accent', '› ' + (index + 1) + '. ' + option) + ' '.repeat(Math.max(0, width - option.length - 6)))
              : '   ' + theme.fg('dim', (index + 1) + '. ') + (index >= 2 ? theme.fg('error', option) : option))),
            '',
            ' ' + theme.fg('dim', '↑↓ choose · enter confirm · 1-4 quick pick · esc deny'),
            rule,
          ];
        },
        handleInput(data) {
          if (data === '\\x1b') return done(undefined);
          if (data === '\\r') return done(OPTIONS[selected]);
          if (data === '\\x1b[A') selected = (selected + OPTIONS.length - 1) % OPTIONS.length;
          else if (data === '\\x1b[B') selected = (selected + 1) % OPTIONS.length;
          else if (/^[1-4]$/.test(data)) return done(OPTIONS[Number(data) - 1]);
          else return;
          tui.requestRender();
        },
        invalidate() {},
      };
    });
  });
}
`;

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

const writeSessionFile = async (home, cwd, id, start, messages) => {
  const sessionDir = join(home, '.pi', 'agent', 'sessions', encodePiSessionCwd(cwd));
  await mkdir(sessionDir, { recursive: true });
  const lines = [{ type: 'session', version: 3, id, timestamp: new Date(start).toISOString(), cwd }];
  let parentId = null;
  messages.forEach((message, index) => {
    const timestamp = start + (index + 1) * 1000;
    const entryId = `${id.slice(-4)}${String(index).padStart(4, '0')}`;
    lines.push({ type: 'message', id: entryId, parentId, timestamp: new Date(timestamp).toISOString(), message: { ...message, timestamp } });
    parentId = entryId;
  });
  const file = join(sessionDir, `${new Date(start).toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`);
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  // The session list dates a session by its file's modification time.
  const end = new Date(start + messages.length * 1000);
  await utimes(file, end, end);
};

// A render_html page and a sub-agent chain, as the bundled plugins record
// them, plus the data-dir file that turns both plugins on.
const writePluginSessions = async (home, data, repo) => {
  const usage = {
    input: 2400, output: 160, cacheRead: 0, cacheWrite: 0, totalTokens: 2560,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistant = (content) => ({
    role: 'assistant', content, api: 'anthropic-messages', provider: 'demo', model: 'demo-model', usage,
    stopReason: content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop',
  });
  const result = (toolCallId, toolName, text, details) => ({
    role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], details, isError: false,
  });

  const page = { title: VISUALS_TITLE, html: VISUALS_HTML };
  await writeSessionFile(home, repo, VISUALS_SESSION_ID, Date.parse('2026-10-20T09:00:00.000Z'), [
    { role: 'user', content: 'Chart this week\'s test runs.' },
    assistant([{ type: 'toolCall', id: 'call_visual_1', name: 'render_html', arguments: page }]),
    result('call_visual_1', 'render_html', `Rendered "${VISUALS_TITLE}".`, page),
    assistant([{ type: 'text', text: `${VISUALS_REPLY} Most of the early failures were the settings test, fixed on Thursday.` }]),
  ]);

  const answered = { ...CHOICES_DETAILS, answer: { id: 'b', note: CHOICES_NOTE } };
  await writeSessionFile(home, repo, CHOICES_SESSION_ID, Date.parse('2026-10-20T09:30:00.000Z'), [
    { role: 'user', content: CHOICES_PROMPT },
    assistant([{ type: 'toolCall', id: 'call_choices_1', name: 'render_choices', arguments: { title: CHOICES_TITLE, options: CHOICES_OPTIONS } }]),
    result('call_choices_1', 'render_choices', `The user chose B: "Split". Their note: ${JSON.stringify(CHOICES_NOTE)}`, answered),
    assistant([{ type: 'text', text: `${CHOICES_REPLY} I will carry the yearly toggle over from the centered one.` }]),
  ]);

  // Each run names its provider so its card shows that provider's logo.
  const run = (agent, task, step, activity, output, turns, input, out, model) => ({
    agent, agentSource: 'bundled', task, step, status: 'done', model,
    usage: { input, output: out, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: input, turns },
    activity, output,
  });
  const chain = [
    { agent: 'scout', task: 'Find the code the billing change touches and how it is tested.' },
    { agent: 'reviewer', task: 'Review the billing change using this context: {previous}' },
  ];
  const details = {
    mode: 'chain',
    agentScope: 'user',
    results: [
      run('scout', chain[0].task, 1, [
        { kind: 'tool', name: 'bash', text: '$ git diff --stat main' },
        { kind: 'tool', name: 'read', text: 'read billing.ts' },
        { kind: 'tool', name: 'grep', text: 'grep /formatAmount/ in src' },
        { kind: 'text', text: 'billing.ts adds paidAt and formats amounts with Intl.NumberFormat. src/index.ts re-exports both helpers; no test covers formatAmount.' },
      ], 'billing.ts adds `paidAt` and formats amounts with `Intl.NumberFormat`. `src/index.ts` re-exports both helpers. No test covers `formatAmount`.', 3, 8200, 410, 'openai/gpt-5-mini'),
      run('reviewer', 'Review the billing change using the scout\'s findings.', 2, [
        { kind: 'tool', name: 'read', text: 'read billing.ts' },
        { kind: 'tool', name: 'read', text: 'read src/index.ts' },
        { kind: 'text', text: 'One blocking issue and one suggestion.' },
      ], [
        '**Blocking:** `formatAmount` now returns `$1,234.00` where callers expected `$1234`. Check the invoice email template before merging.',
        '',
        '**Suggestion:** add a test for `formatAmount` with a zero and a negative amount.',
      ].join('\n'), 2, 6100, 380, 'anthropic/claude-sonnet-4-5'),
    ],
  };
  await writeSessionFile(home, repo, AGENTS_SESSION_ID, Date.parse('2026-10-20T10:00:00.000Z'), [
    { role: 'user', content: 'Review the billing change before I merge it.' },
    assistant([{ type: 'toolCall', id: 'call_agents_1', name: 'subagent', arguments: { chain } }]),
    result('call_agents_1', 'subagent', details.results[1].output, details),
    assistant([{ type: 'text', text: `${AGENTS_REPLY} \`formatAmount\` changed its output format, which the invoice email depends on.` }]),
  ]);

  const failing = { ...result('call_tools_5', 'bash', 'billing.test.ts:\n✓ charges a positive invoice\n✗ skips zero-amount invoices\n  Error: amount must be positive\n\n1 pass\n1 fail\nExit code 1'), isError: true };
  await writeSessionFile(home, repo, TOOLS_SESSION_ID, Date.parse('2026-10-20T11:00:00.000Z'), [
    { role: 'user', content: 'Invoices with a zero total fail to charge. Find why and fix it.' },
    assistant([
      { type: 'toolCall', id: 'call_tools_1', name: 'grep', arguments: { pattern: 'charge(', path: 'src' } },
      { type: 'toolCall', id: 'call_tools_2', name: 'read', arguments: { path: 'billing.ts' } },
    ]),
    result('call_tools_1', 'grep', 'billing.ts:12: export async function charge(customerId, cents) {'),
    result('call_tools_2', 'read', 'export async function charge(customerId, cents) {\n  if (cents <= 0) throw new Error(\'amount must be positive\');\n}'),
    assistant([
      { type: 'text', text: 'charge() throws on a zero amount, and the invoice job calls it for every invoice. I will skip the charge when the total is zero.' },
      { type: 'toolCall', id: 'call_tools_3', name: 'read', arguments: { path: 'billing.test.ts' } },
      { type: 'toolCall', id: 'call_tools_4', name: 'edit', arguments: { path: 'billing.ts', oldText: '  await charge(invoice.customerId, total);', newText: '  if (total > 0) await charge(invoice.customerId, total);' } },
    ]),
    result('call_tools_3', 'read', 'test(\'skips zero-amount invoices\', ...)'),
    result('call_tools_4', 'edit', 'Edited billing.ts', { diff: '-  await charge(invoice.customerId, total);\n+  if (total > 0) await charge(invoice.customerId, total);' }),
    assistant([{ type: 'toolCall', id: 'call_tools_5', name: 'bash', arguments: { command: 'node --test billing.test.ts' } }]),
    failing,
    assistant([
      { type: 'text', text: 'The test still imports the old helper. Updating the import and running it again.' },
      { type: 'toolCall', id: 'call_tools_6', name: 'edit', arguments: { path: 'billing.test.ts', oldText: "import { chargeAll } from './billing';", newText: "import { chargeInvoices } from './billing';" } },
      { type: 'toolCall', id: 'call_tools_7', name: 'bash', arguments: { command: 'node --test billing.test.ts' } },
    ]),
    result('call_tools_6', 'edit', 'Edited billing.test.ts', { diff: "-import { chargeAll } from './billing';\n+import { chargeInvoices } from './billing';" }),
    result('call_tools_7', 'bash', 'billing.test.ts:\n✓ charges a positive invoice\n✓ skips zero-amount invoices\n\n2 pass\n0 fail'),
    assistant([{ type: 'text', text: `${TOOLS_REPLY} The test for a zero invoice passes.` }]),
  ]);

  await mkdir(join(data, 'pi'), { recursive: true });
  await writeFile(join(data, 'pi', 'plugins.json'), `${JSON.stringify({
    version: 1,
    enabled: { visuals: true, subagents: true },
    state: {},
  }, null, 2)}\n`);
};

// Short sessions across the seeded folders, timed relative to the seed, plus
// the shelf sidecar that snoozes one and the archive sidecar that archives two.
const writeShelfSessions = async (home, data, folderPath) => {
  const now = Date.now();
  const shelf = {};
  const archive = {};
  for (const session of [...SHELF_SESSIONS, CHOICES_LIVE_SESSION]) {
    const cwd = folderPath(session.folder);
    const sessionDir = join(home, '.pi', 'agent', 'sessions', encodePiSessionCwd(cwd));
    await mkdir(sessionDir, { recursive: true });
    const start = Math.round(now - session.hoursAgo * 60 * 60 * 1000);
    const lines = [
      { type: 'session', version: 3, id: session.id, timestamp: new Date(start).toISOString(), cwd },
      { type: 'message', id: `${session.id.slice(-4)}0`, parentId: null, timestamp: new Date(start).toISOString(), message: { role: 'user', content: session.title, timestamp: start } },
      { type: 'session_info', id: `${session.id.slice(-4)}1`, parentId: `${session.id.slice(-4)}0`, timestamp: new Date(start).toISOString(), name: session.title },
    ];
    const file = join(sessionDir, `${new Date(start).toISOString().replace(/[:.]/g, '-')}_${session.id}.jsonl`);
    await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    // The session list dates a session by its file's modification time.
    await utimes(file, new Date(start), new Date(start));
    if (session.snooze) shelf[session.id] = { snoozedUntil: now + 24 * 60 * 60 * 1000, snoozedAt: now };
    if (session.archived) archive[session.id] = now - 30 * 60 * 1000;
  }
  await mkdir(join(data, 'pi'), { recursive: true });
  await writeFile(join(data, 'pi', 'session-shelf.json'), JSON.stringify(shelf));
  await writeFile(join(data, 'pi', 'session-archive.json'), JSON.stringify(archive));
  // A few global snippets for the Snippets settings page.
  const snippets = [
    ['ask-questions', 'Ask questions to reach a shared understanding.', 'Before you start, ask me the questions you need answered.'],
    ['delegate-exploration', 'Keep context lean. Subagents explore, you verify critical parts.', 'Delegate broad exploration to subagents and verify the critical parts yourself.'],
    ['review-diff', 'Review the current diff before committing.', 'Review the staged diff for bugs, missing tests, and unclear names.'],
  ].map(([name, description, content], index) => ({
    id: `demo-snippet-${index + 1}`, name, description, content, aliases: [], scope: 'global', createdAt: now, updatedAt: now,
  }));
  await writeFile(join(data, 'pi', 'snippets.json'), JSON.stringify({ version: 1, snippets }));
};

// A flat square favicon with one white glyph.
const demoIcon = (fill, glyph) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${fill}"/><path d="${glyph}" fill="#fff"/></svg>`;

// Synthetic repo: billing.ts staged only (M ), settings.ts staged then edited
// (MM), retry.ts a staged new file (A ), plus one Pi session in that repo.
// Extra folders give the sidebar a favicon, a monorepo, and no icon at all.
// Safe to rerun; it replaces only <dir>/repo, <dir>/folders, <dir>/data, and
// <dir>/home and leaves anything else in <dir> alone.
const seed = async (dir) => {
  const root = resolve(dir);
  const repo = join(root, 'repo');
  const data = join(root, 'data');
  const home = join(root, 'home');
  const folders = join(root, 'folders');
  await rm(repo, { recursive: true, force: true });
  await rm(folders, { recursive: true, force: true });
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
  await mkdir(join(repo, 'src/lib'), { recursive: true });
  await write('src/index.ts', ["export { total, formatAmount } from '../billing';", "export { loadSettings } from '../settings';"]);
  await write('src/lib/dates.ts', ['export const isoDate = (date: Date) => date.toISOString().slice(0, 10);']);
  await write('README.md', ['# demo-repo', '', 'Billing and settings helpers.']);
  await mkdir(join(repo, 'public'), { recursive: true });
  await write('public/favicon.svg', [demoIcon('#2f6fde', 'M10 22V10h7a6 6 0 0 1 0 12z')]);
  git('add', '.');
  git('commit', '-qm', 'initial');
  // Long enough that the session card has to shorten it.
  git('checkout', '-q', '-b', 'feature/session-sidebar-branch-labels');

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

  const extraFolders = [
    // Its own extension is the scripted model behind the pending
    // render_choices capture; only this folder's sessions have a model.
    { name: 'acme-web', label: 'Acme Web', files: {
      'public/favicon.svg': demoIcon('#e5484d', 'M9 22V10h8a4 4 0 0 1 0 8h-4v4z'),
      '.pi/extensions/scripted-model.ts': PROJECT_SCRIPTED_MODEL_EXTENSION,
    } },
    { name: 'chamber-mono', label: 'Chamber Mono', files: {
      'packages/docs/README.md': '# docs\n',
      'packages/web/public/favicon.svg': demoIcon('#30a46c', 'M16 8l8 8-8 8-8-8z'),
    } },
    { name: 'dotfiles', label: 'Dotfiles', files: { 'README.md': '# dotfiles\n' } },
    // A dark logo on a transparent background: the case a dark theme must keep visible.
    // Its own `subagent` extension registers the tool the Sub-agents plugin
    // registers, so in this folder Pi loads the extension and not the plugin.
    { name: 'night-shift', label: 'Night Shift', files: {
      'public/favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M20 4a12 12 0 1 0 8 20A10 10 0 0 1 20 4z" fill="#14141a"/></svg>',
      '.pi/extensions/subagent.ts': PROJECT_SUBAGENT_EXTENSION,
    } },
  ];
  for (const folder of extraFolders) {
    for (const [file, content] of Object.entries(folder.files)) {
      const target = join(folders, folder.name, file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }

  const projectId = (path) => `path_${Buffer.from(path).toString('base64url')}`;
  const id = projectId(repo);
  await writeFile(join(data, 'runtime-state.json'), `${JSON.stringify({
    projects: [
      { id, path: repo, label: 'demo-repo' },
      ...extraFolders.map((folder) => {
        const path = join(folders, folder.name);
        // Night Shift is sandboxed with nono (settings-sandboxing,
        // settings-project-sandbox, session-sandboxed, terminal-sandboxed).
        const sandbox = folder.name === 'night-shift'
          ? { mode: 'nono', allowHosts: ['registry.npmjs.org'], allowLocalPorts: [8080], extraFolders: [{ path: join(home, 'code', 'design-notes'), access: 'read' }] }
          : undefined;
        return { id: projectId(path), path, label: folder.label, ...(sandbox ? { sandbox } : {}) };
      }),
    ],
    activeProjectId: id,
    lastDirectory: repo,
  }, null, 2)}\n`);
  // The marketplace's featured list, as if just fetched from the repository.
  await mkdir(join(data, 'pi'), { recursive: true });
  await writeFile(join(data, 'pi', 'featured.json'), JSON.stringify({ fetchedAt: Date.now(), list: DEMO_FEATURED }));
  await writeDemoSession(home, repo);
  await writeDemoExtension(home);
  await writePluginSessions(home, data, repo);
  await writeShelfSessions(home, data, (name) => (name === 'repo' ? repo : join(folders, name)));
  // Folders for the Add folder dialog to list; home holds nothing else visible.
  for (const name of ['api-gateway', 'design-notes', 'sandbox']) {
    await mkdir(join(home, 'code', name), { recursive: true });
  }
  console.log(`Seeded ${repo}\nStart the dev server with HOME=${home} PICHAMBER_DATA_DIR=${data}`
    + `\nFor the marketplace pages add PICHAMBER_NPM_REGISTRY_URL=http://127.0.0.1:${DEMO_NPM_PORT}`
    + ` PICHAMBER_NPM_DOWNLOADS_URL=http://127.0.0.1:${DEMO_NPM_PORT} PICHAMBER_FEATURED_URL=off`);
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
    // Headless Chrome reports no pointer, so hover styles never apply; report a
    // mouse (mobile pages switch to touch through touch emulation).
    '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: 'ignore' });

  let client;
  let demoSite;
  let demoNpm;
  const failed = [];
  try {
    let target;
    await waitFor(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
      return Boolean(target);
    }, 60_000, 'Chrome debugging endpoint');
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
      demoSite = createHttpServer((req, res) => {
        if (serveDemoDownload(req, res)) return;
        res.setHeader('content-type', 'text/html');
        res.end(req.url === '/exports' ? DEMO_EXPORTS_HTML : DEMO_SITE_HTML);
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

    let demoNpmError = null;
    if (pageNames.some((name) => PAGES[name].demoNpm)) {
      demoNpm = createHttpServer(serveDemoNpm);
      try {
        await new Promise((resolveListen, reject) => {
          demoNpm.once('error', reject);
          demoNpm.listen(DEMO_NPM_PORT, '127.0.0.1', resolveListen);
        });
      } catch (error) {
        demoNpm = null;
        demoNpmError = `the demo npm registry could not start on port ${DEMO_NPM_PORT} (${error instanceof Error ? error.message : error}); set DEMO_NPM_PORT to a free port`;
      }
    }

    for (const name of pageNames) {
      if (PAGES[name].demoNpm && demoNpmError) {
        console.error(`${name}: ${demoNpmError}`);
        failed.push(name);
        continue;
      }
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
      if (PAGES[name].dismissAfter) await dismissAfterPage(client, name, PAGES[name]);
    }
  } finally {
    client?.close();
    // The server browser keeps its page, and so its connection, open.
    demoSite?.closeAllConnections();
    demoSite?.close();
    demoNpm?.close();
    chrome.kill('SIGTERM');
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
  if (failed.length) throw new Error(`Not captured: ${failed.join(', ')}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
