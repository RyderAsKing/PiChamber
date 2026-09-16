import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { withCrossProcessLock } from '../server/cross-process-lock.js';
import { signRelayMessage } from '../relay/signing-key.js';

const STORE_VERSION = 1;
const MAX_ENTRIES_PER_CLIENT = 10;
const MAX_STORED_ENTRIES = 1_000;
const VISIBILITY_TTL_MS = 30_000;
const DEFAULT_RELAY_URL = 'https://api.pichamber.dev/v1/push/send';

const emptyStore = () => ({
  version: STORE_VERSION,
  subscriptionsByClient: {},
  nativeTokensByClient: {},
});

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const boundEntriesByClient = (entriesByClient) => {
  const newest = Object.entries(entriesByClient)
    .flatMap(([clientId, entries]) => (Array.isArray(entries)
      ? entries.map((entry) => ({ clientId, entry }))
      : []))
    .filter(({ entry }) => isRecord(entry))
    .sort((left, right) => (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0))
    .slice(0, MAX_STORED_ENTRIES);
  const bounded = {};
  for (const { clientId, entry } of newest) {
    (bounded[clientId] ??= []).push(entry);
  }
  return bounded;
};

export const createNotificationDeliveryRuntime = ({
  dataDir,
  webPush,
  crypto,
  fetch: fetchImpl = globalThis.fetch,
  storeFile = join(dataDir, 'notifications.json'),
  relayUrl = process.env.PICHAMBER_PUSH_RELAY_URL || DEFAULT_RELAY_URL,
  onDesktopNotification,
}) => {
  const visibilityByClient = new Map();
  let initializedWebPush = false;

  const readStore = async () => {
    try {
      const parsed = JSON.parse(await readFile(storeFile, 'utf8'));
      if (!isRecord(parsed) || parsed.version !== STORE_VERSION) return emptyStore();
      return {
        version: STORE_VERSION,
        subscriptionsByClient: isRecord(parsed.subscriptionsByClient) ? parsed.subscriptionsByClient : {},
        nativeTokensByClient: isRecord(parsed.nativeTokensByClient) ? parsed.nativeTokensByClient : {},
        ...(isRecord(parsed.vapidKeys) ? { vapidKeys: parsed.vapidKeys } : {}),
        ...(isRecord(parsed.relaySigningKey) ? { relaySigningKey: parsed.relaySigningKey } : {}),
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyStore();
      throw error;
    }
  };

  const writeStore = async (store) => {
    await mkdir(dirname(storeFile), { recursive: true, mode: 0o700 });
    const temporary = `${storeFile}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, storeFile);
    if (process.platform !== 'win32') await chmod(storeFile, 0o600);
  };

  const mutateStore = (mutate) => withCrossProcessLock(`${storeFile}.lock`, async () => {
    const next = await mutate(await readStore());
    await writeStore(next);
    return next;
  });

  const getOrCreateVapidKeys = async () => {
    const current = await readStore();
    if (typeof current.vapidKeys?.publicKey === 'string' && typeof current.vapidKeys?.privateKey === 'string') {
      return current.vapidKeys;
    }
    const generated = webPush.generateVAPIDKeys();
    const next = await mutateStore((store) => ({ ...store, vapidKeys: store.vapidKeys ?? generated }));
    return next.vapidKeys;
  };

  const ensureWebPush = async () => {
    if (initializedWebPush) return;
    const keys = await getOrCreateVapidKeys();
    webPush.setVapidDetails('mailto:pichamber@localhost', keys.publicKey, keys.privateKey);
    initializedWebPush = true;
  };

  const addWebSubscription = async (clientId, input) => {
    await ensureWebPush();
    await mutateStore((store) => {
      const existing = Array.isArray(store.subscriptionsByClient[clientId])
        ? store.subscriptionsByClient[clientId]
        : [];
      const entries = existing.filter((entry) => entry?.endpoint !== input.endpoint);
      entries.unshift({ ...input, updatedAt: Date.now() });
      return {
        ...store,
        subscriptionsByClient: boundEntriesByClient({
          ...store.subscriptionsByClient,
          [clientId]: entries.slice(0, MAX_ENTRIES_PER_CLIENT),
        }),
      };
    });
  };

  const removeWebSubscription = async (clientId, endpoint) => {
    await mutateStore((store) => {
      const existing = Array.isArray(store.subscriptionsByClient[clientId])
        ? store.subscriptionsByClient[clientId]
        : [];
      const entries = existing.filter((entry) => entry?.endpoint !== endpoint);
      const subscriptionsByClient = { ...store.subscriptionsByClient };
      if (entries.length > 0) subscriptionsByClient[clientId] = entries;
      else delete subscriptionsByClient[clientId];
      return { ...store, subscriptionsByClient };
    });
  };

  const getOrCreateRelayKey = async () => {
    const current = await readStore();
    if (isRecord(current.relaySigningKey?.privateJwk) && isRecord(current.relaySigningKey?.publicJwk)) {
      return {
        privateKey: crypto.createPrivateKey({ key: current.relaySigningKey.privateJwk, format: 'jwk' }),
        publicJwk: current.relaySigningKey.publicJwk,
      };
    }
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const generated = {
      privateJwk: pair.privateKey.export({ format: 'jwk' }),
      publicJwk: pair.publicKey.export({ format: 'jwk' }),
    };
    const next = await mutateStore((store) => ({ ...store, relaySigningKey: store.relaySigningKey ?? generated }));
    return {
      privateKey: crypto.createPrivateKey({ key: next.relaySigningKey.privateJwk, format: 'jwk' }),
      publicJwk: next.relaySigningKey.publicJwk,
    };
  };

  const relayPublicJwk = (jwk) => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });

  const registerNativeTokenWithRelay = async (token, platform) => {
    if (!relayUrl || process.env.PICHAMBER_PUSH_RELAY_DISABLED === 'true') return;
    const { privateKey, publicJwk } = await getOrCreateRelayKey();
    const ts = Date.now();
    const sig = signRelayMessage({ crypto }, privateKey, `${ts}.${token}.${platform}`);
    const response = await fetchImpl(relayUrl.replace(/\/send$/, '/register-token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, platform, publicKeyJwk: relayPublicJwk(publicJwk), ts, sig }),
    });
    if (!response.ok) throw new Error(`PUSH_RELAY_REGISTRATION_FAILED_${response.status}`);
  };

  const addNativeToken = async (clientId, input) => {
    await mutateStore((store) => {
      const existing = Array.isArray(store.nativeTokensByClient[clientId])
        ? store.nativeTokensByClient[clientId]
        : [];
      const entries = existing.filter((entry) => entry?.token !== input.token);
      entries.unshift({ ...input, updatedAt: Date.now() });
      return {
        ...store,
        nativeTokensByClient: boundEntriesByClient({
          ...store.nativeTokensByClient,
          [clientId]: entries.slice(0, MAX_ENTRIES_PER_CLIENT),
        }),
      };
    });
    await registerNativeTokenWithRelay(input.token, input.platform);
  };

  const removeNativeToken = async (clientId, token) => {
    await mutateStore((store) => {
      const existing = Array.isArray(store.nativeTokensByClient[clientId])
        ? store.nativeTokensByClient[clientId]
        : [];
      const entries = existing.filter((entry) => entry?.token !== token);
      const nativeTokensByClient = { ...store.nativeTokensByClient };
      if (entries.length > 0) nativeTokensByClient[clientId] = entries;
      else delete nativeTokensByClient[clientId];
      return { ...store, nativeTokensByClient };
    });
  };

  const removeNativeTokenFromAllClients = async (token) => {
    await mutateStore((store) => {
      const nativeTokensByClient = {};
      for (const [clientId, entries] of Object.entries(store.nativeTokensByClient)) {
        const kept = Array.isArray(entries) ? entries.filter((entry) => entry?.token !== token) : [];
        if (kept.length > 0) nativeTokensByClient[clientId] = kept;
      }
      return { ...store, nativeTokensByClient };
    });
  };

  const updateVisibility = (clientId, visible, platform) => {
    visibilityByClient.set(clientId, { visible, platform, updatedAt: Date.now() });
  };

  const isAnyInteractiveClientVisible = () => {
    const now = Date.now();
    for (const [clientId, state] of visibilityByClient) {
      if (now - state.updatedAt > VISIBILITY_TTL_MS) {
        visibilityByClient.delete(clientId);
        continue;
      }
      if (state.visible && state.platform !== 'ios' && state.platform !== 'android') return true;
    }
    return false;
  };

  const removeDeadWebEndpoint = async (endpoint) => {
    await mutateStore((store) => {
      const subscriptionsByClient = {};
      for (const [clientId, entries] of Object.entries(store.subscriptionsByClient)) {
        const kept = Array.isArray(entries) ? entries.filter((entry) => entry?.endpoint !== endpoint) : [];
        if (kept.length > 0) subscriptionsByClient[clientId] = kept;
      }
      return { ...store, subscriptionsByClient };
    });
  };

  const sendWebPush = async (payload) => {
    await ensureWebPush();
    const store = await readStore();
    const byEndpoint = new Map();
    for (const entries of Object.values(store.subscriptionsByClient)) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (typeof entry?.endpoint === 'string') byEndpoint.set(entry.endpoint, entry);
      }
    }
    await Promise.all([...byEndpoint.values()].map(async (entry) => {
      try {
        await webPush.sendNotification({
          endpoint: entry.endpoint,
          keys: { p256dh: entry.p256dh, auth: entry.auth },
        }, JSON.stringify(payload));
      } catch (error) {
        if (error?.statusCode === 404 || error?.statusCode === 410) {
          await removeDeadWebEndpoint(entry.endpoint);
          return;
        }
        console.warn(`[Push] delivery failed with status ${error?.statusCode ?? 'unknown'}`);
      }
    }));
  };

  const sendNativePush = async (payload) => {
    if (!relayUrl || process.env.PICHAMBER_PUSH_RELAY_DISABLED === 'true') return;
    if (isAnyInteractiveClientVisible()) return;
    const store = await readStore();
    const tokens = new Set();
    for (const entries of Object.values(store.nativeTokensByClient)) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (typeof entry?.token === 'string') tokens.add(entry.token);
      }
    }
    if (tokens.size === 0) return;
    const list = [...tokens].slice(0, 100);
    const { privateKey, publicJwk } = await getOrCreateRelayKey();
    const ts = Date.now();
    const sig = signRelayMessage({ crypto }, privateKey, `${ts}.${[...list].sort().join(',')}.${payload.title}`);
    const response = await fetchImpl(relayUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tokens: list,
        title: payload.title,
        body: payload.body,
        collapseId: payload.tag?.slice(0, 64),
        data: payload.data,
        publicKeyJwk: relayPublicJwk(publicJwk),
        ts,
        sig,
      }),
    });
    if (!response.ok) {
      console.warn(`[Push relay] delivery failed with status ${response.status}`);
      return;
    }
    const result = await response.json().catch(() => null);
    for (const entry of Array.isArray(result?.results) ? result.results : []) {
      if (entry?.drop === true && typeof entry.token === 'string') {
        await removeNativeTokenFromAllClients(entry.token);
      }
    }
  };

  const send = async (payload) => {
    const desktop = typeof onDesktopNotification === 'function'
      ? Promise.resolve().then(() => onDesktopNotification(payload))
      : Promise.resolve();
    await Promise.allSettled([desktop, sendWebPush(payload), sendNativePush(payload)]);
  };

  return {
    getOrCreateVapidKeys,
    addWebSubscription,
    removeWebSubscription,
    addNativeToken,
    removeNativeToken,
    updateVisibility,
    send,
  };
};
