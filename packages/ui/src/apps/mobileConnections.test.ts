import { describe, expect, mock, test } from 'bun:test';

import { createMobilePasswordOperationTracker, loadMobileConnections, migrateLegacyInlineTokenRecords, upsertMobileConnection, validateMobileConnectionSession, type MobileRelayConfig } from './mobileConnections';
import { getMobileDeviceId, MOBILE_DEVICE_ID_STORAGE_KEY } from './mobile/mobileConnectionTypes';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

const createLocalStorageStub = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
};

const installTestWindow = () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      location: { protocol: 'https:' },
      localStorage: createLocalStorageStub(),
    },
  });
};

const restoreGlobals = () => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
};

const STORAGE_KEY = 'pichamber.mobile.connections.v1';

const testRelay: MobileRelayConfig = {
  relayUrl: 'wss://relay.example/tunnel',
  serverId: 'srv_test123',
  hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'eHhY', y: 'eVlZ' },
};

describe('mobile connection storage', () => {
  test('cancellation invalidates an in-flight password completion', async () => {
    const tracker = createMobilePasswordOperationTracker();
    const operation = tracker.begin();
    let resolveLogin: () => void = () => {
      throw new Error('Login was not started');
    };
    let switchedRuntime = false;
    const completion = new Promise<void>((resolve) => { resolveLogin = resolve; }).then(() => {
      if (tracker.isCurrent(operation)) switchedRuntime = true;
    });

    tracker.cancel();
    resolveLogin();
    await completion;

    expect(switchedRuntime).toBe(false);
  });

  test('removes inline tokens only after each secure migration succeeds', async () => {
    const result = await migrateLegacyInlineTokenRecords([
      { id: 'ok', url: 'http://ok.example', clientToken: 'token-ok' },
      { id: 'failed', url: 'http://failed.example', clientToken: 'token-failed' },
    ], async (url) => url.includes('ok.example'));

    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.records[0]).toEqual({ id: 'ok', url: 'http://ok.example', hasToken: true });
    expect(result.records[1]).toEqual({ id: 'failed', url: 'http://failed.example', clientToken: 'token-failed' });
  });

  test('entries persisted before candidates migrate to a single direct candidate', async () => {
    try {
      installTestWindow();
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([
        { id: 'a', label: 'Home', url: 'http://192.168.1.10:2606', lastUsedAt: 10, clientToken: 'tok-a' },
        { id: 'b', label: 'Work', url: 'http://work.example', lastUsedAt: 5 },
      ]));

      const connections = await loadMobileConnections();
      expect(connections).toHaveLength(2);
      const home = connections.find((c) => c.id === 'a')!;
      expect(home.candidates).toEqual([{ kind: 'direct', url: 'http://192.168.1.10:2606' }]);
      expect(home.clientToken).toBe('tok-a');
    } finally {
      restoreGlobals();
    }
  });

  test('a relay device round-trips its candidate + token', async () => {
    try {
      installTestWindow();

      await upsertMobileConnection({
        label: 'My Desktop',
        candidates: [{ kind: 'relay', relay: testRelay }],
        clientToken: 'oc_client_secret',
      });

      const connections = await loadMobileConnections();
      expect(connections).toHaveLength(1);
      const saved = connections[0]!;
      expect(saved.candidates).toEqual([{ kind: 'relay', relay: testRelay }]);
      // Web surface: token stays inline like direct connections.
      expect(saved.clientToken).toBe('oc_client_secret');

      // Persisted metadata carries only the three transport fields — no grant/token.
      const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]') as Array<Record<string, unknown>>;
      const rawCandidate = (raw[0]?.candidates as Array<Record<string, unknown>>)[0];
      expect(rawCandidate.kind).toBe('relay');
      expect(Object.keys(rawCandidate.relay as object).sort()).toEqual(['hostEncPubJwk', 'relayUrl', 'serverId']);
    } finally {
      restoreGlobals();
    }
  });

  test('a multi-transport device persists all candidates in order (LAN then relay)', async () => {
    try {
      installTestWindow();
      await upsertMobileConnection({
        label: 'Both',
        candidates: [{ kind: 'direct', url: 'http://192.168.1.5:2606' }, { kind: 'relay', relay: testRelay }],
        clientToken: 'tok',
      });

      const connections = await loadMobileConnections();
      expect(connections[0]?.candidates.map((c) => c.kind)).toEqual(['direct', 'relay']);
    } finally {
      restoreGlobals();
    }
  });

  test('a legacy relay entry with malformed transport config is dropped, direct entries survive', async () => {
    try {
      installTestWindow();
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([
        { id: 'bad', label: 'Broken', lastUsedAt: 20, mode: 'relay', relay: { relayUrl: 'wss://relay.example' } },
        { id: 'ok', label: 'Home', url: 'http://192.168.1.10:2606', lastUsedAt: 10 },
      ]));

      const connections = await loadMobileConnections();
      expect(connections).toHaveLength(1);
      expect(connections[0]?.id).toBe('ok');
      expect(connections[0]?.candidates[0]?.kind).toBe('direct');
    } finally {
      restoreGlobals();
    }
  });

  test('relay and direct devices dedupe independently by candidate identity', async () => {
    try {
      installTestWindow();
      await upsertMobileConnection({ label: 'Direct', candidates: [{ kind: 'direct', url: 'http://host.example' }] });
      await upsertMobileConnection({ label: 'Relay', candidates: [{ kind: 'relay', relay: testRelay }] });
      await upsertMobileConnection({ label: 'Relay renamed', candidates: [{ kind: 'relay', relay: testRelay }] });

      const connections = await loadMobileConnections();
      expect(connections).toHaveLength(2);
      const relayEntries = connections.filter((c) => c.candidates.some((x) => x.kind === 'relay'));
      expect(relayEntries).toHaveLength(1);
      expect(relayEntries[0]?.label).toBe('Relay renamed');
    } finally {
      restoreGlobals();
    }
  });
});

describe('mobile connection IDs without randomUUID (LAN HTTP)', () => {
  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  test('device ID persists a cryptographic fallback and reuses it', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
    try {
      installTestWindow();
      Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
      const first = getMobileDeviceId();
      expect(UUID_PATTERN.test(first)).toBe(true);
      expect(getMobileDeviceId()).toBe(first);
    } finally {
      if (descriptor) Object.defineProperty(globalThis.crypto, 'randomUUID', descriptor);
      else Reflect.deleteProperty(globalThis.crypto as unknown as Record<string, unknown>, 'randomUUID');
      restoreGlobals();
    }
  });

  test('new connections mint fallback IDs and reuse persisted IDs', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
    try {
      installTestWindow();
      Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
      await upsertMobileConnection({
        label: 'LAN',
        candidates: [{ kind: 'direct', url: 'http://192.168.1.20:2606' }],
      });
      const connections = await loadMobileConnections();
      expect(connections).toHaveLength(1);
      const createdId = connections[0]!.id;
      expect(UUID_PATTERN.test(createdId)).toBe(true);

      await upsertMobileConnection({
        label: 'LAN renamed',
        candidates: [{ kind: 'direct', url: 'http://192.168.1.20:2606' }],
      });
      const renamed = await loadMobileConnections();
      expect(renamed).toHaveLength(1);
      expect(renamed[0]!.id).toBe(createdId);
      expect(renamed[0]!.label).toBe('LAN renamed');
    } finally {
      if (descriptor) Object.defineProperty(globalThis.crypto, 'randomUUID', descriptor);
      else Reflect.deleteProperty(globalThis.crypto as unknown as Record<string, unknown>, 'randomUUID');
      restoreGlobals();
    }
  });

  test('device ID falls back when localStorage read throws', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
    try {
      installTestWindow();
      Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
      window.localStorage.getItem = () => {
        throw new Error('read failed');
      };
      // Throws would fail the test; reaching the assertion proves no throw.
      const id = getMobileDeviceId();
      expect(UUID_PATTERN.test(id)).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(globalThis.crypto, 'randomUUID', descriptor);
      else Reflect.deleteProperty(globalThis.crypto as unknown as Record<string, unknown>, 'randomUUID');
      restoreGlobals();
    }
  });

  test('device ID falls back when localStorage write throws', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
    try {
      installTestWindow();
      Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
      window.localStorage.setItem = () => {
        throw new Error('write failed');
      };
      // Throws would fail the test; reaching the assertion proves no throw.
      const id = getMobileDeviceId();
      expect(UUID_PATTERN.test(id)).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(globalThis.crypto, 'randomUUID', descriptor);
      else Reflect.deleteProperty(globalThis.crypto as unknown as Record<string, unknown>, 'randomUUID');
      restoreGlobals();
    }
  });

  test('reuses stored device ID without entropy', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
    const getRandomValues = globalThis.crypto.getRandomValues;
    try {
      installTestWindow();
      window.localStorage.setItem(MOBILE_DEVICE_ID_STORAGE_KEY, 'stored-device-id');
      Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
      globalThis.crypto.getRandomValues = (() => {
        throw new Error('entropy unavailable');
      }) as typeof globalThis.crypto.getRandomValues;
      // Throws would fail the test; reaching the assertion proves no throw.
      const id = getMobileDeviceId();
      expect(id).toBe('stored-device-id');
    } finally {
      if (descriptor) Object.defineProperty(globalThis.crypto, 'randomUUID', descriptor);
      else Reflect.deleteProperty(globalThis.crypto as unknown as Record<string, unknown>, 'randomUUID');
      globalThis.crypto.getRandomValues = getRandomValues;
      restoreGlobals();
    }
  });

  test('renaming a persisted connection reuses its ID without entropy', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
    const getRandomValues = globalThis.crypto.getRandomValues;
    try {
      installTestWindow();
      Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
      await upsertMobileConnection({
        label: 'LAN',
        candidates: [{ kind: 'direct', url: 'http://192.168.1.22:2606' }],
      });
      const createdId = (await loadMobileConnections())[0]!.id;
      expect(UUID_PATTERN.test(createdId)).toBe(true);
      globalThis.crypto.getRandomValues = (() => {
        throw new Error('entropy unavailable');
      }) as typeof globalThis.crypto.getRandomValues;
      await upsertMobileConnection({
        label: 'LAN renamed',
        candidates: [{ kind: 'direct', url: 'http://192.168.1.22:2606' }],
      });
      const renamed = await loadMobileConnections();
      expect(renamed).toHaveLength(1);
      expect(renamed[0]!.id).toBe(createdId);
      expect(renamed[0]!.label).toBe('LAN renamed');
    } finally {
      if (descriptor) Object.defineProperty(globalThis.crypto, 'randomUUID', descriptor);
      else Reflect.deleteProperty(globalThis.crypto as unknown as Record<string, unknown>, 'randomUUID');
      globalThis.crypto.getRandomValues = getRandomValues;
      restoreGlobals();
    }
  });

  test('random-source failure throws instead of minting an ID', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
    const getRandomValues = globalThis.crypto.getRandomValues;
    try {
      installTestWindow();
      Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
      globalThis.crypto.getRandomValues = (() => {
        throw new Error('entropy unavailable');
      }) as typeof globalThis.crypto.getRandomValues;
      expect(() => getMobileDeviceId()).toThrow('entropy unavailable');
      await expect(upsertMobileConnection({
        label: 'LAN',
        candidates: [{ kind: 'direct', url: 'http://192.168.1.21:2606' }],
      })).rejects.toThrow('entropy unavailable');
    } finally {
      if (descriptor) Object.defineProperty(globalThis.crypto, 'randomUUID', descriptor);
      else Reflect.deleteProperty(globalThis.crypto as unknown as Record<string, unknown>, 'randomUUID');
      globalThis.crypto.getRandomValues = getRandomValues;
      restoreGlobals();
    }
  });
});

describe('validateMobileConnectionSession', () => {
  test('accepts a reachable authenticated runtime', async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) return Response.json({ ok: true });
      if (url.endsWith('/auth/session')) return Response.json({ authenticated: true, scope: 'client' });
      return new Response(null, { status: 404 });
    });
    try {
      installTestWindow();
      globalThis.fetch = fetchMock as typeof fetch;

      const result = await validateMobileConnectionSession({ url: 'https://runtime.example', clientToken: 'token' });
      expect(result).toBe(true);
    } finally {
      restoreGlobals();
    }
  });

  test('rejects unreachable runtimes', async () => {
    try {
      installTestWindow();
      globalThis.fetch = mock(async () => new Response(null, { status: 503 })) as typeof fetch;

      const result = await validateMobileConnectionSession({ url: 'https://runtime.example', clientToken: 'token' });
      expect(result).toBe(false);
    } finally {
      restoreGlobals();
    }
  });

  test('rejects invalid or unauthenticated sessions', async () => {
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/health')) return Response.json({ ok: true });
      return Response.json({ authenticated: false }, { status: 401 });
    });
    try {
      installTestWindow();
      globalThis.fetch = fetchMock as typeof fetch;

      const result = await validateMobileConnectionSession({ url: 'https://runtime.example', clientToken: 'expired' });
      expect(result).toBe(false);
    } finally {
      restoreGlobals();
    }
  });
});
