import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ChromeLaunchError, launchChrome as defaultLaunchChrome } from './browser-process.js';
import { createServerBrowserTab, normalizeServerBrowserUrl, pageUserAgent } from './browser-tab.js';
import { chromeInstallCommands, findChromeExecutable } from './chrome-executable.js';

// A tab nobody watches keeps running this long, then its page closes. Its
// address is remembered, so opening it again reloads that address.
const TAB_IDLE_MS = 10 * 60 * 1000;
// Chrome exits this long after its last page closes.
const BROWSER_IDLE_MS = 5 * 60 * 1000;
// Pages kept open without viewers before the least recently viewed closes.
const MAX_IDLE_TABS = 6;
const MAX_TABS = 16;
const MAX_REMEMBERED_URLS = 200;
const MAX_DOWNLOADS = 50;
const POPUP_URL_WAIT_MS = 3000;
const TAB_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;

export const isValidTabKey = (value) => typeof value === 'string' && TAB_KEY_PATTERN.test(value);

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const safeFileName = (value) => {
  const base = path.basename(String(value || '')).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  return (base || 'file').slice(0, 200);
};

/**
 * The server browser: one headless Chrome on the server, with a page per
 * PiChamber browser tab. People watch and drive pages through viewers; see
 * `DOCUMENTATION.md`.
 */
export const createServerBrowser = ({
  dataDir,
  env = process.env,
  platform = process.platform,
  isRoot = typeof process.getuid === 'function' && process.getuid() === 0,
  findExecutable = () => findChromeExecutable({ env, platform }),
  installCommands = () => chromeInstallCommands({ platform }),
  launchChrome = defaultLaunchChrome,
  // Extra Chrome flags, for tests (such as `--host-resolver-rules`).
  extraChromeArgs = [],
  log = (message) => console.warn(message),
}) => {
  const root = path.join(dataDir, 'server-browser');
  const profileDir = path.join(root, 'profile');
  const downloadsDir = path.join(root, 'downloads');
  const uploadsDir = path.join(root, 'uploads');
  const settingsFile = path.join(root, 'settings.json');

  // Files from an earlier run are not indexed, so they can never be served.
  for (const dir of [downloadsDir, uploadsDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* unreadable; left alone */ }
  }

  let settings = { allowNoSandbox: false, ...(readJson(settingsFile) || {}) };
  const envNoSandbox = env.PICHAMBER_BROWSER_NO_SANDBOX === '1';
  let browser = null;
  let launching = null;
  let lastFailure = null;
  let browserIdleTimer = null;
  const tabs = new Map();
  const opening = new Map();
  const tabsBySession = new Map();
  const tabsByTarget = new Map();
  const tabIdleTimers = new Map();
  const lastUrls = new Map();
  const downloads = new Map();
  const uploads = new Map();
  const pendingPopups = new Map();

  const noSandbox = () => isRoot && (settings.allowNoSandbox === true || envNoSandbox);

  const status = () => {
    const executable = findExecutable();
    const base = {
      running: Boolean(browser),
      isRoot,
      platform,
      allowNoSandbox: settings.allowNoSandbox === true || envNoSandbox,
      allowNoSandboxFromEnv: envNoSandbox,
      installCommands: installCommands(),
      executable: executable?.path ? { path: executable.path, source: executable.source } : null,
      version: browser?.version?.product || null,
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

  const forgetTab = (tab, reason) => {
    rememberUrl(tab.key, tab.state.url);
    tabs.delete(tab.key);
    tabsBySession.delete(tab.sessionId);
    tabsByTarget.delete(tab.targetId);
    clearTimeout(tabIdleTimers.get(tab.key));
    tabIdleTimers.delete(tab.key);
    tab.detachAll(reason);
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

  const closeTabTarget = async (tab, reason) => {
    const current = browser;
    forgetTab(tab, reason);
    if (current) await current.cdp.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
    scheduleBrowserIdle();
  };

  const trimIdleTabs = () => {
    const idle = [...tabs.values()].filter((tab) => tab.viewerCount === 0).sort((a, b) => a.lastViewedAt - b.lastViewedAt);
    while (idle.length > MAX_IDLE_TABS) void closeTabTarget(idle.shift(), 'closed');
  };

  const onTabEmpty = (tab) => {
    clearTimeout(tabIdleTimers.get(tab.key));
    const timer = setTimeout(() => {
      tabIdleTimers.delete(tab.key);
      if (tab.viewerCount === 0 && tabs.get(tab.key) === tab) void closeTabTarget(tab, 'closed');
    }, TAB_IDLE_MS);
    timer.unref?.();
    tabIdleTimers.set(tab.key, timer);
    trimIdleTabs();
  };

  const tabForFrame = (frameId) => {
    for (const tab of tabs.values()) if (tab.frameIds.has(frameId)) return tab;
    return null;
  };

  const publicDownload = (download) => ({
    type: 'download',
    id: download.id,
    filename: download.filename,
    state: download.state,
    receivedBytes: download.receivedBytes,
    totalBytes: download.totalBytes,
  });

  const handlePopup = async (cdp, targetInfo, opener) => {
    let url = targetInfo.url;
    if (!url || url === 'about:blank') {
      url = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingPopups.delete(targetInfo.targetId);
          resolve('');
        }, POPUP_URL_WAIT_MS);
        timer.unref?.();
        pendingPopups.set(targetInfo.targetId, (next) => {
          clearTimeout(timer);
          pendingPopups.delete(targetInfo.targetId);
          resolve(next);
        });
      });
    }
    await cdp.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
    // The page opened it, so the same rules apply as for a link it followed.
    if (url && url !== 'about:blank') await opener.navigateFromPage(url);
  };

  const onBrowserEvent = (cdp, message) => {
    const { method, params } = message;
    if (message.sessionId) {
      tabsBySession.get(message.sessionId)?.handleEvent(method, params);
      return;
    }
    switch (method) {
      case 'Target.targetCreated': {
        const info = params.targetInfo;
        if (info.type !== 'page' || !info.openerId) return;
        const opener = tabsByTarget.get(info.openerId);
        if (!opener || tabsByTarget.has(info.targetId)) return;
        void handlePopup(cdp, info, opener);
        return;
      }
      case 'Target.targetInfoChanged': {
        const info = params.targetInfo;
        const resolvePopup = pendingPopups.get(info.targetId);
        if (resolvePopup && info.url && info.url !== 'about:blank') resolvePopup(info.url);
        tabsByTarget.get(info.targetId)?.updateTitle(info.title);
        return;
      }
      case 'Target.targetDestroyed': {
        const tab = tabsByTarget.get(params.targetId);
        if (tab) {
          forgetTab(tab, 'closed');
          scheduleBrowserIdle();
        }
        return;
      }
      case 'Browser.downloadWillBegin': {
        const tab = tabForFrame(params.frameId);
        if (downloads.size >= MAX_DOWNLOADS) {
          const [oldest] = downloads.values();
          downloads.delete(oldest.id);
          void fs.promises.rm(oldest.path, { force: true }).catch(() => {});
        }
        const download = {
          id: params.guid,
          filename: safeFileName(params.suggestedFilename),
          path: path.join(downloadsDir, params.guid),
          url: params.url,
          state: 'inProgress',
          receivedBytes: 0,
          totalBytes: 0,
          tabKey: tab?.key || null,
        };
        downloads.set(download.id, download);
        tab?.broadcast(publicDownload(download));
        return;
      }
      case 'Browser.downloadProgress': {
        const download = downloads.get(params.guid);
        if (!download) return;
        download.receivedBytes = params.receivedBytes;
        download.totalBytes = params.totalBytes;
        const changedState = download.state !== params.state;
        download.state = params.state;
        // Progress arrives often; viewers hear about state changes only.
        if (changedState && download.tabKey) tabs.get(download.tabKey)?.broadcast(publicDownload(download));
        return;
      }
      default:
    }
  };

  const stopBrowser = async (reason = 'closed') => {
    const current = browser;
    browser = null;
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
    for (const tab of [...tabs.values()]) forgetTab(tab, reason);
    if (!current) return;
    current.stopping = true;
    await current.cdp.send('Browser.close').catch(() => {});
    const exited = new Promise((resolve) => {
      if (current.process.exitCode !== null || current.process.signalCode !== null) resolve();
      else current.process.once('exit', resolve);
    });
    const timer = setTimeout(() => { try { current.process.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
    timer.unref?.();
    await exited;
    clearTimeout(timer);
  };

  const ensureBrowser = async () => {
    if (browser) return browser;
    if (launching) return launching;
    const current = status();
    if (current.problem && current.problem.kind !== 'launch-failed') {
      throw Object.assign(new Error('Server browser unavailable'), { status: current });
    }
    launching = (async () => {
      await fs.promises.mkdir(profileDir, { recursive: true, mode: 0o700 });
      await fs.promises.mkdir(downloadsDir, { recursive: true, mode: 0o700 });
      let launched;
      try {
        launched = await launchChrome({ executable: current.executable.path, userDataDir: profileDir, noSandbox: noSandbox(), extraArgs: extraChromeArgs, isRoot, env });
      } catch (error) {
        const failure = error instanceof ChromeLaunchError ? error.failure : { kind: 'unknown', detail: error?.message || String(error) };
        lastFailure = { kind: 'launch-failed', reason: failure.kind, library: failure.library, detail: failure.detail };
        throw Object.assign(new Error('Server browser failed to start'), { status: status() });
      }
      lastFailure = null;
      const instance = { ...launched, stopping: false };
      instance.cdp.onEvent((message) => onBrowserEvent(instance.cdp, message));
      instance.process.once('exit', () => {
        if (browser !== instance) return;
        browser = null;
        const reason = instance.stopping ? 'closed' : 'browser-exited';
        if (!instance.stopping) log('[server-browser] Chrome exited unexpectedly');
        for (const tab of [...tabs.values()]) forgetTab(tab, reason);
      });
      await instance.cdp.send('Target.setDiscoverTargets', { discover: true });
      await instance.cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloadsDir, eventsEnabled: true }).catch(() => {});
      // Public pages may not reach the server's own network from scripts.
      // Chrome's permission name changed over versions; unknown ones fail.
      for (const name of ['local-network-access', 'local-network', 'loopback-network']) {
        await instance.cdp.send('Browser.setPermission', { permission: { name }, setting: 'denied' }).catch(() => {});
      }
      instance.userAgent = pageUserAgent(await instance.cdp.send('Browser.getVersion').catch(() => null));
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
    const { targetId } = await instance.cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await instance.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = createServerBrowserTab({ key, cdp: instance.cdp, targetId, sessionId, onEmpty: onTabEmpty, log, userAgent: instance.userAgent });
    tabs.set(key, tab);
    tabsBySession.set(sessionId, tab);
    tabsByTarget.set(targetId, tab);
    clearTimeout(browserIdleTimer);
    browserIdleTimer = null;
    try {
      await tab.init({ url });
    } catch (error) {
      await closeTabTarget(tab, 'closed');
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
      clearTimeout(tabIdleTimers.get(key));
      tabIdleTimers.delete(key);
      return existing;
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
    const tab = tabs.get(key);
    if (tab) await closeTabTarget(tab, 'closed');
  };

  /** Clears cookies, logins, and site data by starting over with an empty profile. */
  const clearData = async () => {
    await stopBrowser('browser-restarting');
    await fs.promises.rm(profileDir, { recursive: true, force: true });
  };

  const saveUpload = async ({ name, stream, maxBytes = Infinity }) => {
    const id = crypto.randomUUID();
    const dir = path.join(uploadsDir, id);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, safeFileName(name));
    let received = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > maxBytes) {
          callback(Object.assign(new Error('File is too large'), { code: 'TOO_LARGE' }));
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(stream, limit, fs.createWriteStream(file, { mode: 0o600 }));
    } catch (error) {
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    uploads.set(id, { id, path: file, createdAt: Date.now() });
    return { id };
  };

  const uploadPaths = (ids) => (Array.isArray(ids) ? ids : [])
    .map((id) => uploads.get(id)?.path)
    .filter((file) => typeof file === 'string');

  const getDownload = (id) => {
    const download = downloads.get(id);
    if (!download || download.state !== 'completed') return null;
    return { path: download.path, filename: download.filename };
  };

  const shutdown = async () => {
    await stopBrowser('closed');
    await fs.promises.rm(uploadsDir, { recursive: true, force: true }).catch(() => {});
  };

  return {
    status,
    saveSettings,
    openTab,
    closeTab,
    clearData,
    saveUpload,
    uploadPaths,
    getDownload,
    shutdown,
  };
};
