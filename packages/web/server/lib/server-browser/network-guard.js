import dns from 'node:dns';
import net from 'node:net';

import { isServerNetworkHost, isServerNetworkSource } from '../security/server-network-host.js';

// A page's load waits this long for the server-network check of its name.
const NAME_CHECK_TIMEOUT_MS = 5_000;
// A request from a frame not yet linked to its page waits this long for the
// link (Chrome reports an out-of-process frame just after its first request).
const OWNER_WAIT_MS = 1_000;
const MAX_TRACKED = 4_096;

const hostOf = (value) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname;
  } catch {
    return null;
  }
};

/** Whether a page at `url` is a public page (not about:blank, data:, or the server's network). */
const isPublicPage = (url) => {
  const host = typeof url === 'string' ? hostOf(url) : null;
  return Boolean(host) && !isServerNetworkSource(host);
};

/**
 * Whether a page load to `url` must be refused because it would reach the
 * server's own network from a public page. `from` is the address that caused
 * the load: the page showing, or the page that redirected. Loads the person
 * asked for (typed, back, forward, reload) pass `from = null`.
 */
export const isBlockedServerNetworkLoad = ({ url, from }) => {
  const host = hostOf(url);
  if (!host || !isServerNetworkHost(host)) return false;
  if (from === null) return false;
  return isPublicPage(from);
};

const lookupAll = (host) => dns.promises.lookup(host, { all: true });

const remember = (map, key, value) => {
  map.set(key, value);
  if (map.size > MAX_TRACKED) map.delete(map.keys().next().value);
};

/**
 * The server-network rule for every page in the browser, on one
 * browser-level DevTools session: each document request (main frames,
 * subframes, popups, redirects) pauses until it is checked. Playwright's
 * request routing would turn off the HTTP cache and never shows redirects,
 * so this uses Chrome's Fetch domain directly.
 *
 * Pages register an owner:
 * - `sourceUrl()`: the address loads in the page come from;
 * - `consumeUserLoad(url)`: whether a main-frame load is one the person asked for;
 * - `blocked(url, { mainFrame })`: a load was refused;
 * - optional `admit(url, { mainFrame })`: return false to cancel an allowed load.
 *
 * A request is linked to its page through its frame: the page's own target,
 * or a chain of parent frames reported by the page (`frameAttached`) or by
 * Chrome (out-of-process frames). A request whose page cannot be found is
 * judged as coming from a public page.
 */
export const createNetworkGuard = ({ lookup = lookupAll, onPopupTarget = () => null, log = () => {} } = {}) => {
  let session = null;
  const owners = new Map();
  const parents = new Map();
  const requestUrls = new Map();
  const waiters = new Set();

  const notify = () => {
    for (const waiter of [...waiters]) waiter();
  };

  const ownerOf = (frameId) => {
    let id = frameId;
    for (let depth = 0; depth < 32 && id; depth += 1) {
      const owner = owners.get(id);
      if (owner) return { owner, mainFrame: id === frameId };
      id = parents.get(id);
    }
    return null;
  };

  const waitForOwner = (frameId) => new Promise((resolve) => {
    const check = () => {
      const found = ownerOf(frameId);
      if (!found) return;
      finish(found);
    };
    const finish = (found) => {
      waiters.delete(check);
      clearTimeout(timer);
      resolve(found);
    };
    const timer = setTimeout(() => finish(null), OWNER_WAIT_MS);
    timer.unref?.();
    waiters.add(check);
  });

  const send = (method, params) => session?.send(method, params).catch(() => {});

  const decide = async ({ url, from, unknownSource }) => {
    if (from === null) return 'allow';
    if (!unknownSource && !isPublicPage(from)) return 'allow';
    const host = hostOf(url);
    if (!host) return 'allow';
    if (isServerNetworkHost(host)) return 'block';
    if (net.isIP(host.replace(/^\[|\]$/g, ''))) return 'allow';
    // A public name can resolve to the server's network (127.0.0.1.nip.io).
    // Chrome resolves the name again itself, so a name that changes its
    // answer in between (DNS rebinding) is not caught. A name that cannot be
    // checked does not load: Chrome shows its own error page for it.
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), NAME_CHECK_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      const addresses = await Promise.race([Promise.resolve().then(() => lookup(host)), timedOut]);
      if (addresses === 'timeout') return 'TimedOut';
      if (!Array.isArray(addresses) || addresses.length === 0) return 'NameNotResolved';
      return addresses.some((entry) => isServerNetworkHost(entry.address)) ? 'block' : 'allow';
    } catch {
      return 'NameNotResolved';
    } finally {
      clearTimeout(timer);
    }
  };

  const onRequestPaused = async ({ requestId, request, frameId, redirectedRequestId }) => {
    const url = request?.url || '';
    remember(requestUrls, requestId, url);
    const found = ownerOf(frameId) ?? await waitForOwner(frameId);
    const mainFrame = found?.mainFrame === true;
    let from;
    if (redirectedRequestId && requestUrls.has(redirectedRequestId)) from = requestUrls.get(redirectedRequestId);
    else if (mainFrame && found.owner.consumeUserLoad(url)) from = null;
    else from = found ? found.owner.sourceUrl() : undefined;
    const outcome = await decide({ url, from, unknownSource: !found && from === undefined });
    if (outcome === 'block') {
      // Cancel rather than fail: the current page stays, with no error page
      // standing in for the blocked address that Reload would then load.
      await send('Fetch.failRequest', { requestId, errorReason: 'Aborted' });
      if (found) found.owner.blocked(url, { mainFrame });
      else log(`[server-browser] blocked a frame of an unknown page from loading ${hostOf(url)}`);
      return;
    }
    if (outcome !== 'allow') {
      await send('Fetch.failRequest', { requestId, errorReason: outcome });
      return;
    }
    if (found?.owner.admit && found.owner.admit(url, { mainFrame }) === false) {
      await send('Fetch.failRequest', { requestId, errorReason: 'Aborted' });
      return;
    }
    await send('Fetch.continueRequest', { requestId });
  };

  return {
    /** Starts checking requests in `context`'s browser. */
    async attach(context) {
      const browser = context.browser();
      if (!browser) throw new Error('The browser connection is not available');
      session = await browser.newBrowserCDPSession();
      session.on('Fetch.requestPaused', (params) => {
        void onRequestPaused(params).catch((error) => {
          log(`[server-browser] request check failed: ${error?.message || error}`);
          void send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Failed' });
        });
      });
      session.on('Target.targetCreated', ({ targetInfo }) => {
        if (targetInfo.type === 'iframe' && targetInfo.parentFrameId) {
          remember(parents, targetInfo.targetId, targetInfo.parentFrameId);
          notify();
          return;
        }
        // A popup: its first request pauses after this.
        if (targetInfo.type === 'page' && targetInfo.openerId && owners.has(targetInfo.openerId) && !owners.has(targetInfo.targetId)) {
          const owner = onPopupTarget({ targetId: targetInfo.targetId, opener: owners.get(targetInfo.openerId) });
          if (owner) {
            owners.set(targetInfo.targetId, owner);
            notify();
          }
        }
      });
      session.on('Target.targetDestroyed', ({ targetId }) => {
        parents.delete(targetId);
        // A popup that closed before a tab claimed it.
        owners.delete(targetId);
      });
      await session.send('Target.setDiscoverTargets', { discover: true });
      await session.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] });
      // Chrome's Local Network Access also keeps public pages' scripts and
      // subresources off the server's network. Its permission name changed
      // over versions; unknown names fail.
      for (const name of ['local-network-access', 'local-network', 'loopback-network']) {
        await session.send('Browser.setPermission', { permission: { name }, setting: 'denied' }).catch(() => {});
      }
    },

    addPage(targetId, owner) {
      owners.set(targetId, owner);
      notify();
    },

    removePage(targetId, owner) {
      if (!owner || owners.get(targetId) === owner) owners.delete(targetId);
    },

    /** A page reported a frame in its own process. */
    frameAttached(frameId, parentFrameId) {
      if (!parentFrameId) return;
      remember(parents, frameId, parentFrameId);
      notify();
    },

    closeTarget(targetId) {
      return send('Target.closeTarget', { targetId });
    },

    detach() {
      waiters.clear();
      owners.clear();
      parents.clear();
      requestUrls.clear();
      const current = session;
      session = null;
      return current?.detach().catch(() => {});
    },
  };
};
