import fs from 'node:fs';
import path from 'node:path';

import { createServerBrowserTab, normalizeServerBrowserUrl } from './browser-tab.js';
import { chromeInstallCommands, findChromeExecutable } from './chrome-executable.js';
import { ChromeLaunchError, chromeVersion, launchChrome as defaultLaunchChrome, pageUserAgent } from './chrome-launch.js';
import { createDownloadStore } from './downloads.js';
import { createNetworkGuard } from './network-guard.js';
import { createUploadStore } from './uploads.js';

// A tab nobody watches keeps running this long, then its page closes. Its
// address is remembered, so opening it again reloads that address.
const TAB_IDLE_MS = 10 * 60 * 1000;
// Chrome exits this long after its last page closes.
const BROWSER_IDLE_MS = 5 * 60 * 1000;
// Pages kept open without viewers before the least recently viewed closes.
const MAX_IDLE_TABS = 6;
const MAX_TABS = 16;
const MAX_REMEMBERED_URLS = 200;
const POPUP_URL_WAIT_MS = 3_000;
const CLOSE_TIMEOUT_MS = 5_000;
// Playwright closes every page before it reports that Chrome exited; a page
// that closed itself is told apart once Chrome had time to report that.
const SELF_CLOSE_SETTLE_MS = 250;
const TAB_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;

export const isValidTabKey = (value) => typeof value === 'string' && TAB_KEY_PATTERN.test(value);

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * The server browser: one headless Chrome on the server (driven through
 * Playwright), with a page per PiChamber browser tab. People watch and drive
 * pages through viewers; see `DOCUMENTATION.md`.
 */
export const createServerBrowser = ({
  dataDir,
  env = process.env,
  platform = process.platform,
  isRoot = typeof process.getuid === 'function' && process.getuid() === 0,
  findExecutable = () => findChromeExecutable({ env, platform }),
  installCommands = () => chromeInstallCommands({ platform }),
  launchChrome = defaultLaunchChrome,
  readChromeVersion = (executable) => chromeVersion(executable, { env }),
  createGuard = createNetworkGuard,
  // Extra Chrome flags, for tests (such as `--host-resolver-rules`).
  extraChromeArgs = [],
  log = (message) => console.warn(message),
}) => {
  const root = path.join(dataDir, 'server-browser');
  const profileDir = path.join(root, 'profile');
  const settingsFile = path.join(root, 'settings.json');
  const downloads = createDownloadStore({ dir: path.join(root, 'downloads'), log });
  const uploads = createUploadStore({ dir: path.join(root, 'uploads') });

  let settings = { allowNoSandbox: false, ...(readJson(settingsFile) || {}) };
  const envNoSandbox = env.PICHAMBER_BROWSER_NO_SANDBOX === '1';
  let browser = null;
  let launching = null;
  let clearing = null;
  let lastFailure = null;
  let browserIdleTimer = null;
  // Open tabs by key, each with its idle timer.
  const tabs = new Map();
  const opening = new Map();
  const lastUrls = new Map();
  // Versions of executables that print none (Chrome on Windows), learned on
  // their first launch.
  const learnedVersions = new Map();

  // Root needs it (Chrome refuses its sandbox as root); elsewhere it is for
  // servers where Chrome cannot create the sandbox (no user namespaces).
  const noSandbox = () => settings.allowNoSandbox === true || envNoSandbox;

  const status = () => {
    const executable = findExecutable();
    const base = {
      running: Boolean(browser),
      isRoot,
      platform,
      allowNoSandbox: noSandbox(),
      allowNoSandboxFromEnv: envNoSandbox,
      installCommands: installCommands(),
      executable: executable?.path ? { path: executable.path, source: executable.source } : null,
      version: browser?.version || null,
    };
    if (!executable) return { ...base, available: false, problem: { kind: 'missing' } };
    if (!executable.path) return { ...base, available: false, problem: { kind: 'missing-env', envKey: executable.envKey } };
    if (isRoot && !noSandbox()) return { ...base, available: false, problem: { kind: 'sandbox-root' } };
    if (lastFailure) return { ...base, available: false, problem: lastFailure };
    return { ...base, available: true, problem: null };
  };

  const saveSettings = async (next) => {
    settings = { ...settings, allowNoSandbox: next.allowNoSandbox === true };
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
    lastFailure = null;
    return status();
  };

  const rememberUrl = (key, url) => {
    if (!url || url === 'about:blank') return;
    lastUrls.delete(key);
    lastUrls.set(key, url);
    if (lastUrls.size > MAX_REMEMBERED_URLS) lastUrls.delete(lastUrls.keys().next().value);
  };

  const forgetTab = (entry, reason) => {
    rememberUrl(entry.tab.key, entry.tab.state.url);
    if (tabs.get(entry.tab.key) === entry) tabs.delete(entry.tab.key);
    clearTimeout(entry.idleTimer);
    entry.tab.detachAll(reason);
  };

  const scheduleBrowserIdle = () => {
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
    if (!browser || tabs.size > 0) return;
    browserIdleTimer = setTimeout(() => {
      if (tabs.size === 0) void stopBrowser();
    }, BROWSER_IDLE_MS);
    browserIdleTimer.unref?.();
  };

  const closeTabEntry = async (entry, reason) => {
    forgetTab(entry, reason);
    await entry.tab.close(reason);
    scheduleBrowserIdle();
  };

  const trimIdleTabs = () => {
    const idle = [...tabs.values()].filter((entry) => entry.tab.viewerCount === 0).sort((a, b) => a.tab.lastViewedAt - b.tab.lastViewedAt);
    while (idle.length > MAX_IDLE_TABS) void closeTabEntry(idle.shift(), 'closed');
  };

  const entryOf = (tab) => {
    const entry = tabs.get(tab.key);
    return entry?.tab === tab ? entry : null;
  };

  const onTabEmpty = (tab) => {
    const entry = entryOf(tab);
    if (!entry) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (tab.viewerCount === 0 && entryOf(tab) === entry) void closeTabEntry(entry, 'closed');
    }, TAB_IDLE_MS);
    entry.idleTimer.unref?.();
    trimIdleTabs();
  };

  // A page closed itself (`window.close()`).
  const onTabClosed = (tab) => {
    const timer = setTimeout(() => {
      const entry = entryOf(tab);
      if (!entry) return;
      forgetTab(entry, 'closed');
      scheduleBrowserIdle();
    }, SELF_CLOSE_SETTLE_MS);
    timer.unref?.();
  };

  // A popup is never shown: its first document request names the address,
  // which loads in the opener's tab instead, under the same rule as a link
  // the page followed. The new page has no `window.opener`.
  const popupOwner = (instance) => ({ targetId, opener }) => {
    let settled = false;
    const finish = (url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      instance.guard.removePage(targetId);
      void instance.guard.closeTarget(targetId);
      if (url && url !== 'about:blank') opener.openFromPage(url);
    };
    const timer = setTimeout(() => finish(''), POPUP_URL_WAIT_MS);
    timer.unref?.();
    return {
      sourceUrl: () => opener.sourceUrl(),
      consumeUserLoad: () => false,
      blocked: (url) => {
        opener.blocked(url, { mainFrame: false });
        finish('');
      },
      admit: (url, { mainFrame }) => {
        if (!mainFrame) return true;
        finish(url);
        return false;
      },
      titleChanged: () => {},
    };
  };

  const stopInstance = async (instance) => {
    instance.stopping = true;
    await instance.guard.detach();
    let timer;
    await Promise.race([
      instance.context.close().catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_TIMEOUT_MS); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
  };

  const stopBrowser = async (reason = 'closed') => {
    const current = browser;
    browser = null;
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
    for (const entry of [...tabs.values()]) forgetTab(entry, reason);
    if (current) await stopInstance(current);
  };

  const launch = async (executable) => {
    const version = learnedVersions.get(executable) ?? await readChromeVersion(executable);
    const options = { executable, userDataDir: profileDir, noSandbox: noSandbox(), extraArgs: extraChromeArgs, isRoot, env };
    let context = await launchChrome({ ...options, userAgent: pageUserAgent(version, platform) });
    const running = context.browser()?.version() || null;
    if (!version && pageUserAgent(running, platform)) {
      // The version was unknown until Chrome ran; start again with the user agent.
      learnedVersions.set(executable, running);
      await context.close().catch(() => {});
      context = await launchChrome({ ...options, userAgent: pageUserAgent(running, platform) });
    }
    return { context, version: running };
  };

  const ensureBrowser = async () => {
    // Never start Chrome on a profile that is being deleted.
    while (clearing) await clearing.catch(() => {});
    if (browser) return browser;
    if (launching) return launching;
    const current = status();
    if (current.problem && current.problem.kind !== 'launch-failed') {
      throw Object.assign(new Error('Server browser unavailable'), { status: current });
    }
    launching = (async () => {
      await fs.promises.mkdir(profileDir, { recursive: true, mode: 0o700 });
      let launched;
      try {
        launched = await launch(current.executable.path);
      } catch (error) {
        const failure = error instanceof ChromeLaunchError ? error.failure : { kind: 'unknown', detail: error?.message || String(error) };
        lastFailure = { kind: 'launch-failed', reason: failure.kind, library: failure.library, detail: failure.detail };
        throw Object.assign(new Error('Server browser failed to start'), { status: status() });
      }
      lastFailure = null;
      const instance = { context: launched.context, version: launched.version, stopping: false, guard: null };
      instance.guard = createGuard({ onPopupTarget: popupOwner(instance), log });
      instance.context.on('close', () => {
        if (browser !== instance) return;
        browser = null;
        const reason = instance.stopping ? 'closed' : 'browser-exited';
        if (!instance.stopping) log('[server-browser] Chrome exited unexpectedly');
        void instance.guard.detach();
        for (const entry of [...tabs.values()]) forgetTab(entry, reason);
      });
      try {
        await instance.guard.attach(instance.context);
      } catch (error) {
        // Not tracked yet, so nothing else would stop it; a running Chrome
        // keeps the profile locked for the next launch.
        await stopInstance(instance);
        throw error;
      }
      browser = instance;
      return instance;
    })();
    try {
      return await launching;
    } finally {
      launching = null;
    }
  };

  const createTab = async (key, url) => {
    const instance = await ensureBrowser();
    if (tabs.size >= MAX_TABS) trimIdleTabs();
    if (tabs.size >= MAX_TABS) throw new Error('Too many server browser tabs are open');
    const tab = createServerBrowserTab({
      key,
      openPage: () => instance.context.newPage(),
      guard: instance.guard,
      onEmpty: onTabEmpty,
      onClosed: onTabClosed,
      onDownload: (owner, download) => void downloads.add(owner, download),
      log,
    });
    const entry = { tab, idleTimer: null };
    tabs.set(key, entry);
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
    try {
      await tab.init({ url });
    } catch (error) {
      await closeTabEntry(entry, 'closed');
      throw error;
    }
    return tab;
  };

  /**
   * The page for a PiChamber browser tab, opening it on `url` (or the address
   * it last showed) when it is not open.
   */
  const openTab = async (key, { url } = {}) => {
    if (!isValidTabKey(key)) throw new Error('Invalid tab');
    const existing = tabs.get(key);
    if (existing) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
      return existing.tab;
    }
    if (opening.has(key)) return opening.get(key);
    const startUrl = normalizeServerBrowserUrl(url || '') ?? null;
    const promise = createTab(key, startUrl && startUrl !== 'about:blank' ? startUrl : lastUrls.get(key));
    opening.set(key, promise);
    try {
      return await promise;
    } finally {
      opening.delete(key);
    }
  };

  const closeTab = async (key) => {
    lastUrls.delete(key);
    const entry = tabs.get(key);
    if (entry) await closeTabEntry(entry, 'closed');
  };

  /** Clears cookies, logins, and site data by starting over with an empty profile. */
  const clearData = () => {
    clearing ??= (async () => {
      // A launch in progress would assign Chrome after the stop below.
      await launching?.catch(() => {});
      await stopBrowser('browser-restarting');
      await fs.promises.rm(profileDir, { recursive: true, force: true });
    })().finally(() => { clearing = null; });
    return clearing;
  };

  const shutdown = async () => {
    await stopBrowser('closed');
    await uploads.clear();
  };

  return {
    status,
    saveSettings,
    openTab,
    closeTab,
    clearData,
    saveUpload: (upload) => uploads.save(upload),
    uploadPaths: (ids) => uploads.paths(ids),
    getDownload: (id) => downloads.get(id),
    shutdown,
  };
};
