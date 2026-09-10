import { beforeEach, describe, expect, mock, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Controlled state for module mocks (process-global within this file only;
// `bun test --isolate` keeps this file self-contained).
// ---------------------------------------------------------------------------

let capacitorMode = false;
let runtimeKey = '';
let apiBaseUrl = '';
let runtimeGeneration = 0;
const switchCalls: Array<{
  apiBaseUrl: string;
  clientToken?: string | null;
  runtimeKey?: string | null;
}> = [];
let relayActive = false;

let fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
let fetchHandler:
  | ((url: string, init?: RequestInit) => Promise<Response | null>)
  | null = null;

let tunnelCloseCount = 0;
let tunnelFetchHandler:
  | ((path: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> } | null>)
  | null = null;
let adoptedTunnels: unknown[] = [];

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

mock.module('@/lib/platform', () => ({
  isCapacitorApp: () => capacitorMode,
  isIPadApp: () => false,
  getClientPlatform: () => 'web' as const,
  isWindowsArm64: () => false,
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => runtimeKey,
  getRuntimeApiBaseUrl: () => apiBaseUrl,
  getRuntimeEndpointGeneration: () => runtimeGeneration,
  switchRuntimeEndpoint: (options: {
    apiBaseUrl: string;
    clientToken?: string | null;
    runtimeKey?: string | null;
  }) => {
    switchCalls.push({ ...options });
    runtimeGeneration += 1;
    apiBaseUrl = options.apiBaseUrl.trim();
    if (typeof options.runtimeKey === 'string' && options.runtimeKey.trim()) {
      runtimeKey = options.runtimeKey.trim();
    } else {
      runtimeKey = `url:${apiBaseUrl}`;
    }
    if (options.apiBaseUrl === '') {
      relayActive = false;
    }
  },
  subscribeRuntimeEndpointChanged: () => () => {},
  subscribeRuntimeEndpointWillChange: () => () => {},
}));

mock.module('@/lib/relay/runtime-tunnel', () => ({
  isRelayModeActive: () => relayActive,
  adoptRelayTunnel: (_descriptor: unknown, client: unknown) => {
    adoptedTunnels.push(client);
    relayActive = true;
  },
  activateRelayTunnel: () => {},
  deactivateRelayTunnel: () => {
    relayActive = false;
  },
}));

mock.module('@/lib/relay/tunnel-client', () => ({
  createRelayTunnelClient: (_descriptor: unknown) => {
    void _descriptor;
    return {
      fetch: (path: string, init?: RequestInit) => {
        if (tunnelFetchHandler) return tunnelFetchHandler(path, init);
        return Promise.resolve(null);
      },
      close: () => {
        tunnelCloseCount += 1;
      },
    };
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async () => null,
}));

mock.module('@/lib/mobile-error-log', () => ({
  recordMobileDiagnostic: () => {},
}));

const transport = await import('./mobileConnectionTransport');
const storage = await import('./mobileConnectionStorage');

const STORAGE_KEY = 'pichamber.mobile.connections.v1';

const installWindow = () => {
  const store = new Map<string, string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  (globalThis as Record<string, unknown>).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
    location: { protocol: 'https:', origin: 'https://app.example' },
    // Candidate refresh schedules a 5s follow-up; ignore it in tests so a
    // fresh `switchToTransport` cannot fire a background reprobe after the
    // test finished. Probe timeouts (fast 2500ms) still use real timers.
    setTimeout: ((callback: () => void, ms?: number) => {
      if (ms === 5000) return 0 as unknown as number;
      const id = setTimeout(callback, ms);
      timers.add(id);
      return id as unknown as number;
    }) as typeof setTimeout,
    clearTimeout: ((id: number) => {
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    }) as typeof clearTimeout,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  };
  return {
    store,
    clearTimers: () => {
      for (const id of timers) clearTimeout(id);
      timers.clear();
    },
  };
};

let windowHandle: ReturnType<typeof installWindow>;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;

const okHealth = (serverId?: string) =>
  Response.json(serverId ? { ok: true, serverId } : { ok: true });
const okSession = () =>
  Response.json({ authenticated: true, scope: 'client' });

beforeEach(() => {
  capacitorMode = false;
  runtimeKey = '';
  apiBaseUrl = '';
  runtimeGeneration = 0;
  switchCalls.length = 0;
  relayActive = false;
  fetchCalls = [];
  fetchHandler = null;
  tunnelCloseCount = 0;
  tunnelFetchHandler = null;
  adoptedTunnels = [];
  windowHandle = installWindow();
  transport.__resetMobileProbeStateForTests();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    fetchCalls.push({ url, headers });
    if (fetchHandler) return fetchHandler(url, init);
    return null;
  }) as typeof fetch;
});

const restoreAfterEach = () => {
  windowHandle?.clearTimers();
  transport.__resetMobileProbeStateForTests();
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
};

// Helper: seed one saved connection with [better, current] direct candidates
// and point the mocked runtime at `current`. Returns ids/keys for assertions.
const seedDirectPair = async (options?: {
  betterUrl?: string;
  currentUrl?: string;
  token?: string;
}) => {
  const betterUrl = options?.betterUrl ?? 'https://better.example';
  const currentUrl = options?.currentUrl ?? 'https://current.example';
  const token = options?.token ?? 'token-old';
  const label = 'Device A';
  // Seed via real storage so `upsertMobileConnection` staleness is observable
  // through `lastUsedAt` (stale probes must not bump it).
  const rows = await storage.upsertMobileConnection({
    label,
    candidates: [
      { kind: 'direct' as const, url: betterUrl },
      { kind: 'direct' as const, url: currentUrl },
    ],
    clientToken: token,
  });
  const active = rows[0]!;
  // Force an old lastUsedAt so a late upsert is detectable.
  const raw = JSON.parse(
    windowHandle.store.get(STORAGE_KEY) || '[]'
  ) as Array<Record<string, unknown>>;
  raw[0]!['lastUsedAt'] = 1;
  windowHandle.store.set(STORAGE_KEY, JSON.stringify(raw));
  const secureKey = storage.secureTokenKeyOf(active);
  runtimeKey = secureKey;
  apiBaseUrl = currentUrl;
  relayActive = false;
  return { active, secureKey, betterUrl, currentUrl, token };
};

const readSeededLastUsedAt = (): number => {
  const raw = JSON.parse(
    windowHandle.store.get(STORAGE_KEY) || '[]'
  ) as Array<{ lastUsedAt?: number }>;
  return raw[0]?.lastUsedAt ?? -1;
};

describe('reprobe late-probe core guard (actual switchToTransport)', () => {
  test('explicit disconnect while pending commits nothing (zero old switches)', async () => {
    const handle = deferred<Response | null>();
    try {
      const { betterUrl, currentUrl } = await seedDirectPair();
      // Barrier: better health hangs until we disconnect.
      fetchHandler = async (url) => {
        if (url === `${betterUrl}/health`) return handle.promise;
        if (url === `${betterUrl}/auth/session`) return okSession();
        if (url === `${currentUrl}/health`) return okHealth();
        if (url === `${currentUrl}/auth/session`) return okSession();
        return null;
      };

      const pending = transport.reprobeActiveConnection();
      // Let the probe reach the health barrier.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fetchCalls.some((c) => c.url === `${betterUrl}/health`)).toBe(true);

      // Explicit disconnect while pending (new generation, no endpoint).
      const switchesBefore = switchCalls.length;
      runtimeGeneration += 1;
      runtimeKey = 'mobile-disconnected';
      apiBaseUrl = '';
      relayActive = false;
      // Storage row still exists (disconnect clears endpoint, not the row),
      // but the selection is gone — the late probe must not resurrect it.
      void switchesBefore;

      handle.resolve(okHealth());
      const outcome = await pending;
      expect(outcome).toBe('no-connection');
      // Zero transport switches from the stale probe: the endpoint stays
      // disconnected instead of flipping back to the old host.
      expect(switchCalls).toHaveLength(0);
      expect(runtimeKey).toBe('mobile-disconnected');
      expect(apiBaseUrl).toBe('');
      // Late storage upsert skipped: lastUsedAt still the seeded old value.
      expect(readSeededLastUsedAt()).toBe(1);
    } finally {
      restoreAfterEach();
    }
  });

  test('new host while pending never switches back and never sends old creds there', async () => {
    const handle = deferred<Response | null>();
    try {
      const { betterUrl, token } = await seedDirectPair({
        betterUrl: 'https://old-better.example',
        currentUrl: 'https://old-current.example',
        token: 'old-token-123',
      });
      fetchHandler = async (url) => {
        if (url === `${betterUrl}/health`) return handle.promise;
        if (url === `${betterUrl}/auth/session`) return okSession();
        return okHealth();
      };

      const pending = transport.reprobeActiveConnection();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // User picks another server while pending.
      runtimeGeneration += 1;
      runtimeKey = 'url:https://new.example';
      apiBaseUrl = 'https://new.example';
      relayActive = false;

      handle.resolve(okHealth());
      const outcome = await pending;
      expect(outcome).toBe('no-connection');
      expect(switchCalls).toHaveLength(0);
      expect(apiBaseUrl).toBe('https://new.example');
      // Old credential never sent to the new host.
      const leaked = fetchCalls.filter(
        (c) =>
          c.url.startsWith('https://new.example') &&
          c.headers['authorization'] === `Bearer ${token}`
      );
      expect(leaked).toEqual([]);
    } finally {
      restoreAfterEach();
    }
  });

  test('same-key disconnect/reconnect flap still invalidates (generation, not key)', async () => {
    const handle = deferred<Response | null>();
    try {
      const { active, secureKey, betterUrl, currentUrl } = await seedDirectPair();
      fetchHandler = async (url) => {
        if (url === `${betterUrl}/health`) return handle.promise;
        if (url === `${betterUrl}/auth/session`) return okSession();
        return okHealth();
      };

      const pending = transport.reprobeActiveConnection();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Disconnect then reconnect to the SAME logical instance (same key+url).
      // Identity matches again, but the generation moved twice — stale stays stale.
      runtimeGeneration += 1;
      runtimeKey = 'mobile-disconnected';
      apiBaseUrl = '';
      runtimeGeneration += 1;
      runtimeKey = secureKey;
      apiBaseUrl = currentUrl;
      void active;

      handle.resolve(okHealth());
      const outcome = await pending;
      expect(outcome).toBe('no-connection');
      expect(switchCalls).toHaveLength(0);
      // Reconnect value preserved, not overwritten by the stale better winner.
      expect(apiBaseUrl).toBe(currentUrl);
      expect(runtimeKey).toBe(secureKey);
    } finally {
      restoreAfterEach();
    }
  });


  test('concurrent same-selection probes share one owner (one fetch, one switch)', async () => {
    const handle = deferred<Response | null>();
    try {
      const { betterUrl } = await seedDirectPair();
      let healthCalls = 0;
      fetchHandler = async (url) => {
        if (url === `${betterUrl}/health`) {
          healthCalls += 1;
          return handle.promise;
        }
        if (url === `${betterUrl}/auth/session`) return okSession();
        return null;
      };

      // Controller probe + background candidate-refresh follow-up at once.
      const first = transport.reprobeActiveConnection();
      const second = transport.reprobeActiveConnection();
      await new Promise((resolve) => setTimeout(resolve, 10));
      handle.resolve(okHealth());
      const [a, b] = await Promise.all([first, second]);
      expect(a).toBe('switched');
      expect(b).toBe('switched');
      // Single network race, single transport switch — no double-switch.
      expect(healthCalls).toBe(1);
      expect(switchCalls).toHaveLength(1);
      expect(switchCalls[0]?.apiBaseUrl).toBe(betterUrl);
    } finally {
      restoreAfterEach();
    }
  });

  test('stale relay winner is closed, fresh winner is adopted (resource counts)', async () => {
    const relayGate = deferred<{
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    } | null>();
    try {
      // Active: [relay-better, direct-current]; current is direct.
      const relay = {
        relayUrl: 'wss://relay.example/tunnel',
        serverId: 'srv_1',
        hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      };
      const currentUrl = 'https://current.example';
      const rows = await storage.upsertMobileConnection({
        label: 'Relay device',
        candidates: [
          { kind: 'relay' as const, relay },
          { kind: 'direct' as const, url: currentUrl },
        ],
        clientToken: 'relay-token',
      });
      const active = rows[0]!;
      const secureKey = storage.secureTokenKeyOf(active);
      runtimeKey = secureKey;
      apiBaseUrl = currentUrl;
      relayActive = false;

      tunnelFetchHandler = async () => relayGate.promise;

      const pending = transport.reprobeActiveConnection();
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Disconnect while the relay session fetch is pending.
      runtimeGeneration += 1;
      runtimeKey = 'mobile-disconnected';
      apiBaseUrl = '';

      relayGate.resolve({
        ok: true,
        status: 200,
        json: async () => ({ authenticated: true, scope: 'client' }),
      });
      const outcome = await pending;
      expect(outcome).toBe('no-connection');
      expect(switchCalls).toHaveLength(0);
      // Stale winner closed, never adopted.
      expect(tunnelCloseCount).toBe(1);
      expect(adoptedTunnels).toHaveLength(0);

      // Fresh probe with no interruption adopts without closing the winner.
      transport.__resetMobileProbeStateForTests();
      runtimeGeneration += 1;
      runtimeKey = secureKey;
      apiBaseUrl = currentUrl;
      tunnelCloseCount = 0;
      adoptedTunnels = [];
      tunnelFetchHandler = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ authenticated: true, scope: 'client' }),
      });
      const fresh = await transport.reprobeActiveConnection();
      expect(fresh).toBe('switched');
      expect(switchCalls).toHaveLength(1);
      expect(tunnelCloseCount).toBe(0);
      expect(adoptedTunnels).toHaveLength(1);
    } finally {
      restoreAfterEach();
    }
  });
});

describe('reprobe single-flight identity (candidates/secure reference)', () => {
  test('updated LAN candidates while direct probe in flight probes fresh (same credential reference)', async () => {
    const gate = deferred<Response | null>();
    try {
      const { active, betterUrl, currentUrl, token } = await seedDirectPair({
        betterUrl: 'https://better.example',
        currentUrl: 'https://current.example',
      });
      let betterHealthCalls = 0;
      fetchHandler = async (url) => {
        if (url === `${betterUrl}/health`) {
          betterHealthCalls += 1;
          // First race hangs; the serialized follow-up must issue its own race.
          if (betterHealthCalls === 1) return gate.promise;
          return okHealth();
        }
        if (url === `${betterUrl}/auth/session`) return okSession();
        if (url.endsWith('/health')) return okHealth();
        if (url.endsWith('/auth/session')) return okSession();
        return null;
      };

      const first = transport.reprobeActiveConnection();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(betterHealthCalls).toBe(1);

      // Candidate refresh: same credential reference (first URL unchanged, so
      // `secureKey` is identical) but a different candidate snapshot.
      const lanUrl = 'https://lan-new.example';
      await storage.upsertMobileConnection({
        id: active.id,
        label: active.label,
        candidates: [
          { kind: 'direct' as const, url: betterUrl },
          { kind: 'direct' as const, url: lanUrl },
        ],
        clientToken: token,
      });
      void currentUrl;
      // Follow-up while the old race is still pending must not share the stale
      // promise — it serializes behind it and probes the fresh set.
      const second = transport.reprobeActiveConnection();

      gate.resolve(okHealth());
      const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
      // Old selection is stale (candidate snapshot moved) → discarded.
      expect(firstOutcome).toBe('no-connection');
      // Fresh selection probes its own race and switches to the better host.
      expect(secondOutcome).toBe('switched');
      expect(betterHealthCalls).toBe(2);
      expect(switchCalls).toHaveLength(1);
      expect(switchCalls[0]?.apiBaseUrl).toBe(betterUrl);
    } finally {
      restoreAfterEach();
    }
  });



});
