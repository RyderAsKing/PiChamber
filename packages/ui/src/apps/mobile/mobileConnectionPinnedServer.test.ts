import { beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('@/lib/platform', () => ({
  isCapacitorApp: () => false,
  isIPadApp: () => false,
  getClientPlatform: () => 'web' as const,
  isWindowsArm64: () => false,
}));

mock.module('@/lib/mobile-error-log', () => ({
  recordMobileDiagnostic: () => {},
  recordMobileDiagnosticError: () => {},
  startMobileErrorLogCapture: () => () => {},
  buildMobileErrorLog: () => '',
  exportMobileErrorLog: async () => 'copied' as const,
  flushMobileErrorLog: () => {},
  flushMobileDiagnostics: () => {},
  __resetMobileErrorLogForTests: () => {},
}));

mock.module('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {
    internalGetItem: async () => ({ data: null }),
    internalSetItem: async () => {},
    internalRemoveItem: async () => ({ success: true }),
  },
}));

type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[] = [];
let healthServerId: string | null = 'srv-real';
let sessionBehavior: 'ok' | 'unauthorized' = 'ok';

const installWindowAndFetch = () => {
  (globalThis as Record<string, unknown>).window = {
    setTimeout: ((cb: () => void, ms?: number) => globalThis.setTimeout(cb, ms)) as typeof setTimeout,
    clearTimeout: ((id: number) => globalThis.clearTimeout(id as unknown as ReturnType<typeof setTimeout>)) as typeof clearTimeout,
    location: { origin: 'http://localhost' },
    localStorage: {
      getItem: () => '[]',
      setItem: () => {},
      removeItem: () => {},
    },
  };
  (globalThis as Record<string, unknown>).fetch = async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    if (String(url).endsWith('/health')) {
      return {
        ok: true,
        status: 200,
        json: async () =>
          healthServerId ? { serverId: healthServerId } : {},
      };
    }
    if (String(url).endsWith('/auth/session')) {
      if (sessionBehavior === 'unauthorized') {
        return { ok: false, status: 401, json: async () => ({ authenticated: false }) };
      }
      return { ok: true, status: 200, json: async () => ({ authenticated: true }) };
    }
    return { ok: false, status: 404, json: async () => null };
  };
};

const { probeConnectionCandidates, establishLiveTransport } = await import('./mobileConnectionTransport');
const {
  readConnections,
  secureTokenKeyOf,
  upsertConnectionInList,
  writeConnections,
} = await import('./mobileConnectionStorage');

const directOnly = (url: string) => [{ kind: 'direct' as const, url }];

const authHeadersSent = (): string[] =>
  fetchCalls
    .map((call) => new Headers(call.init?.headers).get('authorization'))
    .filter((value): value is string => Boolean(value));

describe('pinned server identity (F9)', () => {
  beforeEach(() => {
    fetchCalls = [];
    healthServerId = 'srv-real';
    sessionBehavior = 'ok';
    installWindowAndFetch();
  });

  test('mismatch never sends the bearer and reports wrong server', async () => {
    healthServerId = 'srv-evil';
    const result = await probeConnectionCandidates(directOnly('http://10.0.0.9:3000'), 'secret-token', {
      pinnedServerId: 'srv-real',
    });
    expect(result.status).toBe('unreachable');
    expect((result as { reason?: string }).reason).toBe('wrong-server');
    expect(authHeadersSent()).toEqual([]);
    // Only the credential-free health check went out.
    expect(fetchCalls.map((call) => call.url)).toEqual(['http://10.0.0.9:3000/health']);
  });

  test('matching pin proceeds to the authenticated session probe', async () => {
    const result = await probeConnectionCandidates(directOnly('http://10.0.0.9:3000'), 'secret-token', {
      pinnedServerId: 'srv-real',
    });
    expect(result.status).toBe('ok');
    expect(authHeadersSent()).toEqual(['Bearer secret-token']);
  });

  test('missing pin is learned trust-on-first-use from /health', async () => {
    healthServerId = 'srv-new';
    const result = await probeConnectionCandidates(directOnly('http://10.0.0.9:3000'), 'secret-token');
    expect(result.status).toBe('ok');
    expect((result as { serverId?: string }).serverId).toBe('srv-new');
  });

  test('servers without serverId keep working (backward compatible)', async () => {
    healthServerId = null;
    const result = await probeConnectionCandidates(directOnly('http://10.0.0.9:3000'), 'secret-token', {
      pinnedServerId: 'srv-real',
    });
    expect(result.status).toBe('ok');
  });

  test('live-transport establishment enforces the pin before credentials', async () => {
    healthServerId = 'srv-evil';
    const blocked = await establishLiveTransport(directOnly('http://10.0.0.9:3000'), 'srv-real');
    expect(blocked).toBeNull();
    expect(authHeadersSent()).toEqual([]);
    healthServerId = 'srv-real';
    const live = await establishLiveTransport(directOnly('http://10.0.0.9:3000'), 'srv-real');
    expect(live).toMatchObject({ kind: 'direct', url: 'http://10.0.0.9:3000' });
  });

  test('pin survives storage round-trips and never enters the token key', () => {
    const keyBefore = secureTokenKeyOf({ candidates: directOnly('http://10.0.0.9:3000') });
    const next = upsertConnectionInList([], {
      label: 'home',
      candidates: directOnly('http://10.0.0.9:3000'),
      pinnedServerId: 'srv-real',
    });
    expect(next[0]?.pinnedServerId).toBe('srv-real');
    // Omitted pin preserves the existing one; null clears it.
    const preserved = upsertConnectionInList(next, {
      id: next[0]?.id,
      label: 'home',
      candidates: directOnly('http://10.0.0.9:3000'),
    });
    expect(preserved[0]?.pinnedServerId).toBe('srv-real');
    const cleared = upsertConnectionInList(preserved, {
      id: next[0]?.id,
      label: 'home',
      candidates: directOnly('http://10.0.0.99:3000'),
      pinnedServerId: null,
    });
    expect(cleared[0]?.pinnedServerId).toBeUndefined();
    const keyAfter = secureTokenKeyOf({ candidates: directOnly('http://10.0.0.9:3000') });
    expect(keyAfter).toBe(keyBefore);
    writeConnections(next);
    void readConnections;
  });

  test('older records without a pin load and stay usable', () => {
    const legacy = upsertConnectionInList([], {
      label: 'legacy',
      candidates: directOnly('http://10.0.0.9:3000'),
    });
    expect(legacy[0]?.pinnedServerId).toBeUndefined();
    expect(legacy[0]?.hasToken).toBe(false);
  });
});
