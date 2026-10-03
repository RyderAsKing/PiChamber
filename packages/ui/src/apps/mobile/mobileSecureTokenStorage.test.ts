import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Mock state for isolated tests
// ---------------------------------------------------------------------------

let capacitorMode = true;
let runtimeKey = '';
let apiBaseUrl = '';
let runtimeGeneration = 0;
const switchCalls: Array<{
  apiBaseUrl: string;
  clientToken?: string | null;
  runtimeKey?: string | null;
}> = [];

let secureStorageGetCalls = 0;
let secureStorageSetCalls = 0;
let secureStorageRemoveCalls = 0;
let secureStorageGetHandler:
  | ((options: { prefixedKey: string; sync: boolean }) => Promise<{ data: string | null }>)
  | null = null;
let secureStorageSetHandler:
  | ((options: { prefixedKey: string; data: string; sync: boolean; access: number }) => Promise<void>)
  | null = null;
let secureStorageRemoveHandler:
  | ((options: { prefixedKey: string; sync: boolean }) => Promise<{ success: boolean }>)
  | null = null;

mock.module('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {
    internalGetItem: async (options: { prefixedKey: string; sync: boolean }) => {
      secureStorageGetCalls += 1;
      if (secureStorageGetHandler) return secureStorageGetHandler(options);
      return { data: null };
    },
    internalSetItem: async (options: {
      prefixedKey: string;
      data: string;
      sync: boolean;
      access: number;
    }) => {
      secureStorageSetCalls += 1;
      if (secureStorageSetHandler) return secureStorageSetHandler(options);
    },
    internalRemoveItem: async (options: { prefixedKey: string; sync: boolean }) => {
      secureStorageRemoveCalls += 1;
      if (secureStorageRemoveHandler) return secureStorageRemoveHandler(options);
      return { success: true };
    },
  },
}));

mock.module('@/lib/platform', () => ({
  isCapacitorApp: () => capacitorMode,
  isIPadApp: () => false,
  getClientPlatform: () => (capacitorMode ? ('android' as const) : ('web' as const)),
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
  },
  subscribeRuntimeEndpointChanged: () => () => {},
  subscribeRuntimeEndpointWillChange: () => () => {},
}));

mock.module('@/lib/relay/runtime-tunnel', () => ({
  isRelayModeActive: () => false,
  adoptRelayTunnel: () => {},
  activateRelayTunnel: () => {},
  deactivateRelayTunnel: () => {},
}));

mock.module('@/lib/relay/tunnel-client', () => ({
  createRelayTunnelClient: () => ({
    fetch: async () => null,
    close: () => {},
  }),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async () => null,
}));

mock.module('@/lib/mobile-error-log', () => ({
  recordMobileDiagnostic: () => {},
  recordMobileDiagnosticError: () => {},
  startMobileErrorLogCapture: () => () => {},
  buildMobileErrorLog: () => '',
  exportMobileErrorLog: async () => 'copied' as const,
  flushMobileDiagnostics: () => {},
  __resetMobileErrorLogForTests: () => {},
}));

const storage = await import('./mobileConnectionStorage');
const transport = await import('./mobileConnectionTransport');

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
    setTimeout: ((callback: () => void, ms?: number) => {
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

beforeEach(() => {
  capacitorMode = true;
  runtimeKey = '';
  apiBaseUrl = '';
  runtimeGeneration = 0;
  switchCalls.length = 0;
  secureStorageGetCalls = 0;
  secureStorageSetCalls = 0;
  secureStorageRemoveCalls = 0;
  secureStorageGetHandler = null;
  secureStorageSetHandler = null;
  secureStorageRemoveHandler = null;
  windowHandle = installWindow();
  storage.__resetMobileTokenCacheForTests();
  transport.__resetMobileProbeStateForTests();
  globalThis.fetch = (async () => null) as unknown as typeof fetch;
});

afterEach(() => {
  windowHandle?.clearTimers();
  storage.__resetMobileTokenCacheForTests();
  transport.__resetMobileProbeStateForTests();
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('mobile secure token storage & cache', () => {
  test('read outcome: cache hit avoids a second plugin read', async () => {
    secureStorageGetHandler = async () => ({ data: 'secret-token-123' });

    const key = 'https://server.example';
    const firstResult = await storage.readSecureToken(key);
    expect(firstResult).toEqual({ status: 'present', token: 'secret-token-123' });
    expect(secureStorageGetCalls).toBe(1);

    // Second read must hit the in-memory cache and bypass the plugin
    const secondResult = await storage.readSecureToken(key);
    expect(secondResult).toEqual({ status: 'present', token: 'secret-token-123' });
    expect(secureStorageGetCalls).toBe(1);
  });

  test('write populates cache and delete invalidates cache', async () => {
    const key = 'https://server.example';
    const token = 'token-from-write';

    // Write populates cache
    const writeOk = await storage.writeSecureToken(key, token);
    expect(writeOk).toBe(true);
    expect(secureStorageSetCalls).toBe(1);

    // Read should hit cache immediately without calling plugin
    const readAfterWrite = await storage.readSecureToken(key);
    expect(readAfterWrite).toEqual({ status: 'present', token });
    expect(secureStorageGetCalls).toBe(0);

    // Delete invalidates cache
    await storage.deleteSecureToken(key);
    expect(secureStorageRemoveCalls).toBe(1);

    // Read after delete must query plugin again (not return cached token)
    secureStorageGetHandler = async () => ({ data: null });
    const readAfterDelete = await storage.readSecureToken(key);
    expect(readAfterDelete).toEqual({ status: 'absent' });
    expect(secureStorageGetCalls).toBe(1);
  });

  test('read timeout yields failure outcome, not absent', async () => {
    // Handler hangs indefinitely
    secureStorageGetHandler = () => new Promise(() => {});

    // For test speed, run bounded read with timeout
    const key = 'https://server.example';
    const result = await storage.readSecureToken(key);
    expect(result).toEqual({ status: 'failure' });
  }, 10_000);

  test('read error yields failure outcome, not absent', async () => {
    secureStorageGetHandler = async () => {
      throw new Error('Keystore corrupted or locked');
    };

    const key = 'https://server.example';
    const result = await storage.readSecureToken(key);
    expect(result).toEqual({ status: 'failure' });
  });

  test('undecryptable entries yield absent, other native errors stay failures', async () => {
    const key = 'https://server.example';
    secureStorageGetHandler = async () => {
      throw Object.assign(new Error('Invalid data'), { code: 'invalidData' });
    };
    expect(await storage.readSecureToken(key)).toEqual({ status: 'absent' });

    secureStorageGetHandler = async () => {
      throw Object.assign(new Error('An OS error occurred (javax.crypto.AEADBadTagException)'), { code: 'osError' });
    };
    expect(await storage.readSecureToken(key)).toEqual({ status: 'absent' });

    secureStorageGetHandler = async () => {
      throw Object.assign(new Error('An OS error occurred (android.security.KeyStoreException: busy)'), { code: 'osError' });
    };
    expect(await storage.readSecureToken(key)).toEqual({ status: 'failure' });
  });

  test('read returning null/empty yields absent outcome', async () => {
    secureStorageGetHandler = async () => ({ data: null });

    const key = 'https://server.example';
    const result = await storage.readSecureToken(key);
    expect(result).toEqual({ status: 'absent' });
  });

  test('deleteMobileConnection invalidates secure token cache for that connection', async () => {
    const connection = {
      label: 'Server 1',
      candidates: [{ kind: 'direct' as const, url: 'https://server1.example' }],
      clientToken: 'token-conn-1',
    };
    const saved = await storage.upsertMobileConnection(connection);
    const key = storage.secureTokenKeyOf({ candidates: connection.candidates });

    // Cache should be warm
    const warmRead = await storage.readSecureToken(key);
    expect(warmRead).toEqual({ status: 'present', token: 'token-conn-1' });
    expect(secureStorageGetCalls).toBe(0);

    // Delete connection
    await storage.deleteMobileConnection(saved[0]!.id);

    // Next read must hit plugin again
    secureStorageGetHandler = async () => ({ data: null });
    const coldRead = await storage.readSecureToken(key);
    expect(coldRead).toEqual({ status: 'absent' });
    expect(secureStorageGetCalls).toBe(1);
  });
});

describe('autoConnectLastInstance secure read error discrimination', () => {
  test('maps read failure/timeout to unreachable (retryable)', async () => {
    // Seed saved connection with hasToken=true
    await storage.upsertMobileConnection({
      label: 'My Server',
      candidates: [{ kind: 'direct' as const, url: 'https://myserver.example' }],
      clientToken: 'initial-token',
    });
    // Clear cache so it triggers a plugin read
    storage.__resetMobileTokenCacheForTests();

    // Secure read fails
    secureStorageGetHandler = async () => {
      throw new Error('Keystore read failed');
    };

    const outcome = await transport.autoConnectLastInstance();
    expect(outcome).toEqual({
      status: 'unreachable',
      label: 'My Server',
    });
  });

  test('maps authoritatively absent saved token to needs-login (re-pair notice)', async () => {
    // Seed saved connection with hasToken=true
    await storage.upsertMobileConnection({
      label: 'My Server',
      candidates: [{ kind: 'direct' as const, url: 'https://myserver.example' }],
      clientToken: 'initial-token',
    });
    storage.__resetMobileTokenCacheForTests();

    // Secure read returns null (missing)
    secureStorageGetHandler = async () => ({ data: null });

    const outcome = await transport.autoConnectLastInstance();
    expect(outcome).toEqual({ status: 'needs-login', label: 'My Server' });
  });

  test('maps candidate without hasToken to no-candidate', async () => {
    // Seed saved connection with hasToken=false
    const raw = [
      {
        id: 'conn_no_token',
        label: 'Unauthenticated Server',
        candidates: [{ kind: 'direct', url: 'https://unauth.example' }],
        lastUsedAt: Date.now(),
        hasToken: false,
      },
    ];
    windowHandle.store.set('pichamber.mobile.connections.v1', JSON.stringify(raw));

    const outcome = await transport.autoConnectLastInstance();
    expect(outcome).toEqual({ status: 'no-candidate' });
    expect(secureStorageGetCalls).toBe(0);
  });

  test('connects successfully when token is present and host is reachable', async () => {
    await storage.upsertMobileConnection({
      label: 'Healthy Server',
      candidates: [{ kind: 'direct' as const, url: 'https://healthy.example' }],
      clientToken: 'valid-token',
    });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://healthy.example/health') {
        return Response.json({ ok: true });
      }
      if (url === 'https://healthy.example/auth/session') {
        return Response.json({ authenticated: true, scope: 'client' });
      }
      return null;
    }) as unknown as typeof fetch;

    const outcome = await transport.autoConnectLastInstance();
    expect(outcome).toEqual({ status: 'connected' });
    expect(switchCalls).toHaveLength(1);
    expect(switchCalls[0]?.apiBaseUrl).toBe('https://healthy.example');
    expect(switchCalls[0]?.clientToken).toBe('valid-token');
  });
});

describe('reprobeActiveConnection secure read discrimination', () => {
  const seedActive = async () => {
    const rows = await storage.upsertMobileConnection({
      label: 'Active Server',
      candidates: [{ kind: 'direct' as const, url: 'https://active.example' }],
      clientToken: 'active-token',
    });
    runtimeKey = storage.secureTokenKeyOf(rows[0]!);
    apiBaseUrl = 'https://active.example';
    storage.__resetMobileTokenCacheForTests();
  };

  test('an authoritatively absent saved token enters the re-pair flow', async () => {
    await seedActive();
    secureStorageGetHandler = async () => ({ data: null });
    expect(await transport.reprobeActiveConnection()).toBe('needs-login');
  });

  test('a secure read failure stays retryable', async () => {
    await seedActive();
    secureStorageGetHandler = async () => {
      throw new Error('Keystore read failed');
    };
    expect(await transport.reprobeActiveConnection()).toBe('unreachable');
  });
});
