import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useUIStore } from '@/stores/useUIStore';
import {
  getSettingsSaveState,
  invalidateSettingsCache,
  loadSharedSettingsDocument,
  subscribeToSettingsSaveState,
  syncDesktopSettings,
  updateDesktopSettings,
} from './persistence';
import { switchRuntimeEndpoint } from './runtime-switch';
import { fetchPiChamberDefaults } from '@/stores/config/defaults';

// Startup-burst regression coverage for `packages/ui/src/lib/persistence.ts`:
// no-op PUT suppression against the last-synced image, and sequential GET
// dedupe through the settled-value cache. Self-contained: every stub
// (runtime settings API, global fetch) is installed within this file and no
// shared module is partially mocked.

type TestWindow = {
  __PICHAMBER_HOME__?: string;
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  dispatchEvent: (event: Event) => boolean;
};

let createdWindow = false;
let createdLocalStorage = false;

const ensureLocalStorage = (): void => {
  if (typeof localStorage !== 'undefined') {
    return;
  }
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
      clear: () => {
        values.clear();
      },
    },
    configurable: true,
    writable: true,
  });
  createdLocalStorage = true;
};

const getWindow = (): TestWindow => {
  if (typeof window === 'undefined') {
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    createdWindow = true;
  }
  const testWindow = window as unknown as Partial<TestWindow>;
  if (!testWindow.addEventListener || !testWindow.removeEventListener) {
    const eventTarget = new EventTarget();
    testWindow.addEventListener = eventTarget.addEventListener.bind(eventTarget);
    testWindow.removeEventListener = eventTarget.removeEventListener.bind(eventTarget);
    testWindow.dispatchEvent = eventTarget.dispatchEvent.bind(eventTarget);
  }
  testWindow.dispatchEvent ??= () => true;
  ensureLocalStorage();
  return testWindow as TestWindow;
};

const registerSettingsApi = (
  save: (changes: Partial<SettingsPayload>) => Promise<SettingsPayload>,
  load: () => Promise<{ settings: SettingsPayload; source: 'web' }>,
): void => {
  registerRuntimeAPIs({
    runtime: { platform: 'web', isDesktop: false },
    settings: { load, save },
  } as unknown as RuntimeAPIs);
};

type FetchCall = { url: string; method: string };
let fetchCalls: FetchCall[] = [];
let fetchHandler: (url: string, method: string, body?: string) => Response | Promise<Response> =
  () => new Response(null, { status: 500 });
const previousFetch = globalThis.fetch;

const jsonResponse = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  getWindow();
  registerRuntimeAPIs(null);
  invalidateSettingsCache();
  fetchCalls = [];
  fetchHandler = () => new Response(null, { status: 500 });
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : String((input as { url?: string }).url ?? input);
    const method = init?.method ?? 'GET';
    fetchCalls.push({ url, method });
    return fetchHandler(url, method, typeof init?.body === 'string' ? init.body : undefined);
  }) as typeof fetch;
});

afterAll(() => {
  registerRuntimeAPIs(null);
  globalThis.fetch = previousFetch;
  if (createdWindow) {
    delete (globalThis as { window?: unknown }).window;
  }
  if (createdLocalStorage) {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

describe('settings write suppression', () => {
  test('skips the PUT when the whole patch echoes the last synced image', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://suppression-echo.example', runtimeKey: 'suppression-echo' });
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    const autoSaveEnabled = useUIStore.getState().autoSaveEnabled;
    registerSettingsApi(
      async (changes) => {
        saveCalls.push(changes);
        return changes as SettingsPayload;
      },
      async () => ({
        settings: {
          themeId: 'echo-theme',
          autoSaveEnabled,
          homeDirectory: '/home/echo',
          lastDirectory: '/home/echo/proj',
          draftStartersScheduleTaskAdded: true,
        },
        source: 'web',
      }),
    );

    // The autoSaveEnabled seed migration patch echoes the fetched value, so
    // even the boot sync itself sends nothing.
    await syncDesktopSettings();
    expect(saveCalls).toHaveLength(0);

    const states: string[] = [];
    const unsubscribe = subscribeToSettingsSaveState(() => {
      states.push(getSettingsSaveState());
    });
    try {
      await updateDesktopSettings({ homeDirectory: '/home/echo', lastDirectory: '/home/echo/proj' });
      expect(saveCalls).toHaveLength(0);
      // Suppressed flushes resolve/dispatch exactly as a successful save.
      expect(states).toEqual(['saving', 'idle']);
    } finally {
      unsubscribe();
    }
  });

  test('sends a changed key with the existing whole-patch contract, then suppresses the repeat', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://suppression-changed.example', runtimeKey: 'suppression-changed' });
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    const autoSaveEnabled = useUIStore.getState().autoSaveEnabled;
    registerSettingsApi(
      async (changes) => {
        saveCalls.push(changes);
        return changes as SettingsPayload;
      },
      async () => ({
        settings: {
          themeId: 'changed-theme',
          autoSaveEnabled,
          homeDirectory: '/home/changed',
          draftStartersScheduleTaskAdded: true,
        },
        source: 'web',
      }),
    );

    await syncDesktopSettings();
    expect(saveCalls).toHaveLength(0);

    await updateDesktopSettings({ homeDirectory: '/home/elsewhere' });
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]).toEqual({ homeDirectory: '/home/elsewhere' });

    // The acknowledged PUT joined the image, so the identical write is a no-op.
    await updateDesktopSettings({ homeDirectory: '/home/elsewhere' });
    expect(saveCalls).toHaveLength(1);
  });

  test('restoring a key while its PUT is in flight still sends', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://suppression-rollback.example', runtimeKey: 'suppression-rollback' });
    const autoSaveEnabled = useUIStore.getState().autoSaveEnabled;
    const stored: SettingsPayload = {
      themeId: 'rollback-theme',
      autoSaveEnabled,
      homeDirectory: '/home/original',
      lastDirectory: '/home/original/proj',
      draftStartersScheduleTaskAdded: true,
    };
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    const responses: Array<ReturnType<typeof deferred<SettingsPayload>>> = [];
    registerSettingsApi(
      (changes) => {
        saveCalls.push(changes);
        const response = deferred<SettingsPayload>();
        responses.push(response);
        return response.promise;
      },
      async () => ({ settings: stored, source: 'web' }),
    );

    await syncDesktopSettings();
    expect(saveCalls).toHaveLength(0);

    const changed = updateDesktopSettings({ homeDirectory: '/home/changed' }, { immediate: true });
    expect(saveCalls).toEqual([{ homeDirectory: '/home/changed' }]);

    // The image still holds the original value, but the outstanding PUT is
    // about to replace it: the restoration is a real write.
    const restored = updateDesktopSettings({ homeDirectory: '/home/original' }, { immediate: true });
    expect(saveCalls).toEqual([{ homeDirectory: '/home/changed' }, { homeDirectory: '/home/original' }]);

    // A key the outstanding PUT does not carry is still an echo.
    await updateDesktopSettings({ lastDirectory: '/home/original/proj' }, { immediate: true });
    expect(saveCalls).toHaveLength(2);

    responses[0].resolve({ ...stored, homeDirectory: '/home/changed' });
    await changed;
    responses[1].resolve({ ...stored, homeDirectory: '/home/original' });
    await restored;

    // Both PUTs settled, so the restored value is the image again.
    await updateDesktopSettings({ homeDirectory: '/home/original' }, { immediate: true });
    expect(saveCalls).toHaveLength(2);
  });

  test('a failed PUT does not update the image, so a retry still sends', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://suppression-retry.example', runtimeKey: 'suppression-retry' });
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    let failNext = true;
    registerSettingsApi(
      async (changes) => {
        saveCalls.push(changes);
        if (failNext) {
          failNext = false;
          throw new Error('suppression save offline');
        }
        return changes as SettingsPayload;
      },
      async () => ({
        settings: {
          themeId: 'retry-base',
          autoSaveEnabled: useUIStore.getState().autoSaveEnabled,
          draftStartersScheduleTaskAdded: true,
        },
        source: 'web',
      }),
    );

    await syncDesktopSettings();
    expect(saveCalls).toHaveLength(0);

    await updateDesktopSettings({ themeId: 'retry-me' });
    expect(saveCalls).toHaveLength(1);

    await updateDesktopSettings({ themeId: 'retry-me' });
    expect(saveCalls).toHaveLength(2);
  });

  test('an unknown image after a failed initial GET always sends', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://suppression-unknown.example', runtimeKey: 'suppression-unknown' });
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(
      async (changes) => {
        saveCalls.push(changes);
        return changes as SettingsPayload;
      },
      async () => {
        throw new Error('suppression load offline');
      },
    );

    // The runtime load fails and the fetch fallback 500s, so no synced image
    // exists. (fetchCalls may include the fallback GET plus endpoint auth
    // traffic; the assertion below only pins the write path.)
    await syncDesktopSettings();

    await updateDesktopSettings({ themeId: 'unknown-write' });
    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]).toEqual({ themeId: 'unknown-write' });
  });

  test('a runtime switch resets the image', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://suppression-a.example', runtimeKey: 'suppression-a' });
    const saveCallsA: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(
      async (changes) => {
        saveCallsA.push(changes);
        return changes as SettingsPayload;
      },
      async () => ({
        settings: {
          themeId: 'shared-theme',
          autoSaveEnabled: useUIStore.getState().autoSaveEnabled,
          draftStartersScheduleTaskAdded: true,
        },
        source: 'web',
      }),
    );
    await syncDesktopSettings();
    expect(saveCallsA).toHaveLength(0);

    switchRuntimeEndpoint({ apiBaseUrl: 'https://suppression-b.example', runtimeKey: 'suppression-b' });
    const saveCallsB: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(
      async (changes) => {
        saveCallsB.push(changes);
        return changes as SettingsPayload;
      },
      async () => ({
        settings: { themeId: 'other-theme', draftStartersScheduleTaskAdded: true },
        source: 'web',
      }),
    );

    // Echoes runtime A's image, but B has no baseline — the write must go out.
    await updateDesktopSettings({ themeId: 'shared-theme' });
    expect(saveCallsB).toHaveLength(1);
  });

  test('null against an absent key sends, undefined against an absent key is a no-op', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://suppression-null.example', runtimeKey: 'suppression-null' });
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(
      async (changes) => {
        saveCalls.push(changes);
        return changes as SettingsPayload;
      },
      async () => ({
        settings: {
          themeId: 'null-theme',
          autoSaveEnabled: useUIStore.getState().autoSaveEnabled,
          draftStartersScheduleTaskAdded: true,
        },
        source: 'web',
      }),
    );

    await syncDesktopSettings();
    expect(saveCalls).toHaveLength(0);

    // `null` persists as a value in the server JSON files — a real change.
    await updateDesktopSettings({ tunnelBootstrapTtlMs: null });
    expect(saveCalls).toHaveLength(1);

    // `undefined` serializes away, so the key is already absent — a no-op.
    await updateDesktopSettings({ managedLocalTunnelConfigPath: undefined });
    expect(saveCalls).toHaveLength(1);
  });
});

describe('settings GET dedupe', () => {
  const settingsPayload = {
    themeId: 'cached-theme',
    autoSaveEnabled: true,
    draftStartersScheduleTaskAdded: true,
  };

  test('a second sequential sync within the window issues no new GET', async () => {
    registerRuntimeAPIs(null);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://suppression-get.example', runtimeKey: 'suppression-get' });
    fetchHandler = (url, method) => {
      if (url.includes('/api/pi/ui-settings') && method === 'GET') return jsonResponse(settingsPayload);
      return new Response(null, { status: 500 });
    };

    await syncDesktopSettings();
    await syncDesktopSettings();

    const gets = fetchCalls.filter((call) => call.url.includes('/api/pi/ui-settings') && call.method === 'GET');
    const puts = fetchCalls.filter((call) => call.url.includes('/api/pi/ui-settings') && call.method === 'PUT');
    expect(gets).toHaveLength(1);
    expect(puts).toHaveLength(0);
  });

  test('a PUT adopts the full response, so the next sync needs no refetch', async () => {
    registerRuntimeAPIs(null);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://suppression-adopt.example', runtimeKey: 'suppression-adopt' });
    const autoSaveEnabled = useUIStore.getState().autoSaveEnabled;
    let serverState: Record<string, unknown> = {
      themeId: 'adopt-theme',
      autoSaveEnabled,
      draftStartersScheduleTaskAdded: true,
    };
    fetchHandler = (url, method, body) => {
      if (!url.includes('/api/pi/ui-settings')) return new Response(null, { status: 500 });
      if (method === 'GET') return jsonResponse(serverState);
      serverState = { ...serverState, ...((body ? JSON.parse(body) : {}) as Record<string, unknown>) };
      return jsonResponse(serverState);
    };

    await syncDesktopSettings();
    await updateDesktopSettings({ themeId: 'adopted-theme' });
    await syncDesktopSettings();

    const gets = fetchCalls.filter((call) => call.url.includes('/api/pi/ui-settings') && call.method === 'GET');
    const puts = fetchCalls.filter((call) => call.url.includes('/api/pi/ui-settings') && call.method === 'PUT');
    expect(gets).toHaveLength(1);
    expect(puts).toHaveLength(1);

    // The PUT response became the synced image, so echoing it sends nothing.
    await updateDesktopSettings({ themeId: 'adopted-theme' });
    const putsAfter = fetchCalls.filter((call) => call.url.includes('/api/pi/ui-settings') && call.method === 'PUT');
    expect(putsAfter).toHaveLength(1);
  });

  test('a PUT with an invalid response falls back to invalidating the cache', async () => {
    registerRuntimeAPIs(null);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://suppression-invalid-put.example', runtimeKey: 'suppression-invalid-put' });
    const autoSaveEnabled = useUIStore.getState().autoSaveEnabled;
    let serverState: Record<string, unknown> = {
      themeId: 'invalid-put-theme',
      autoSaveEnabled,
      draftStartersScheduleTaskAdded: true,
    };
    fetchHandler = (url, method, body) => {
      if (!url.includes('/api/pi/ui-settings')) return new Response(null, { status: 500 });
      if (method === 'GET') return jsonResponse(serverState);
      // The server applies the write but answers with a truthy non-object
      // body: applied as today, while the image falls back to the
      // acknowledged patch and the cache is invalidated.
      serverState = { ...serverState, ...((body ? JSON.parse(body) : {}) as Record<string, unknown>) };
      return jsonResponse('stale-partial');
    };

    await syncDesktopSettings();
    await updateDesktopSettings({ themeId: 'invalid-put-theme-2' });
    await syncDesktopSettings();

    const gets = fetchCalls.filter((call) => call.url.includes('/api/pi/ui-settings') && call.method === 'GET');
    const puts = fetchCalls.filter((call) => call.url.includes('/api/pi/ui-settings') && call.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(gets).toHaveLength(2);

    // The fallback merged the acknowledged patch, so repeating it is a no-op.
    await updateDesktopSettings({ themeId: 'invalid-put-theme-2' });
    const putsAfter = fetchCalls.filter((call) => call.url.includes('/api/pi/ui-settings') && call.method === 'PUT');
    expect(putsAfter).toHaveLength(1);
  });

  test('failed GETs are never cached', async () => {
    registerRuntimeAPIs(null);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://suppression-get-fail.example', runtimeKey: 'suppression-get-fail' });
    fetchHandler = () => new Response(null, { status: 500 });

    await syncDesktopSettings();
    await syncDesktopSettings();

    const gets = fetchCalls.filter((call) => call.url.includes('/api/pi/ui-settings') && call.method === 'GET');
    expect(gets).toHaveLength(2);
  });
});

describe('settings initial-load gating', () => {
  const countCalls = (method: string): number =>
    fetchCalls.filter((call) => call.url.includes('/api/pi/ui-settings') && call.method === method).length;

  test('a write enqueued before any GET waits for one GET and sends zero PUTs when echo', async () => {
    registerRuntimeAPIs(null);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://gate-before.example', runtimeKey: 'gate-before' });
    const autoSaveEnabled = useUIStore.getState().autoSaveEnabled;
    const serverDoc = {
      themeId: 'gate-before-theme',
      autoSaveEnabled,
      homeDirectory: '/home/gate-before',
      lastDirectory: '/home/gate-before/proj',
      draftStartersScheduleTaskAdded: true,
    };
    fetchHandler = (url, method, body) => {
      if (!url.includes('/api/pi/ui-settings')) return new Response(null, { status: 500 });
      if (method === 'GET') return jsonResponse(serverDoc);
      return jsonResponse({ ...serverDoc, ...((body ? JSON.parse(body) : {}) as Record<string, unknown>) });
    };

    // No sync has run: the flush starts the boot GET early, diffs against
    // it, and suppresses the echo.
    const states: string[] = [];
    const unsubscribe = subscribeToSettingsSaveState(() => {
      states.push(getSettingsSaveState());
    });
    try {
      await updateDesktopSettings({ homeDirectory: '/home/gate-before', lastDirectory: '/home/gate-before/proj' });
      expect(countCalls('GET')).toBe(1);
      expect(countCalls('PUT')).toBe(0);
      expect(states).toEqual(['saving', 'idle']);
    } finally {
      unsubscribe();
    }
  });

  test('a write while the boot GET is in flight reuses that GET', async () => {
    registerRuntimeAPIs(null);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://gate-inflight.example', runtimeKey: 'gate-inflight' });
    const autoSaveEnabled = useUIStore.getState().autoSaveEnabled;
    const serverDoc = {
      themeId: 'gate-inflight-theme',
      autoSaveEnabled,
      homeDirectory: '/home/gate-inflight',
      lastDirectory: '/home/gate-inflight/proj',
      draftStartersScheduleTaskAdded: true,
    };
    const getGate = deferred<Response>();
    fetchHandler = (url, method, body) => {
      if (!url.includes('/api/pi/ui-settings')) return new Response(null, { status: 500 });
      if (method === 'GET') return getGate.promise;
      return jsonResponse({ ...serverDoc, ...((body ? JSON.parse(body) : {}) as Record<string, unknown>) });
    };

    const sync = syncDesktopSettings();
    await delay(20);
    const update = updateDesktopSettings({ homeDirectory: '/home/gate-inflight', lastDirectory: '/home/gate-inflight/proj' });
    // The debounce has fired and the flush is parked on the in-flight GET:
    // no second GET, no PUT.
    await delay(300);
    expect(countCalls('GET')).toBe(1);
    expect(countCalls('PUT')).toBe(0);

    getGate.resolve(jsonResponse(serverDoc));
    await sync;
    await update;
    expect(countCalls('GET')).toBe(1);
    expect(countCalls('PUT')).toBe(0);
  });

  test('a real change sends one PUT after the gating GET', async () => {
    registerRuntimeAPIs(null);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://gate-change.example', runtimeKey: 'gate-change' });
    const autoSaveEnabled = useUIStore.getState().autoSaveEnabled;
    const serverDoc = {
      themeId: 'gate-change-theme',
      autoSaveEnabled,
      draftStartersScheduleTaskAdded: true,
    };
    const putBodies: string[] = [];
    fetchHandler = (url, method, body) => {
      if (!url.includes('/api/pi/ui-settings')) return new Response(null, { status: 500 });
      if (method === 'GET') return jsonResponse(serverDoc);
      putBodies.push(body ?? '');
      return jsonResponse({ ...serverDoc, ...((body ? JSON.parse(body) : {}) as Record<string, unknown>) });
    };

    await updateDesktopSettings({ themeId: 'gate-change-new' });
    expect(countCalls('GET')).toBe(1);
    expect(countCalls('PUT')).toBe(1);
    expect((JSON.parse(putBodies[0]) as Record<string, unknown>).themeId).toBe('gate-change-new');
  });

  test('a failed initial GET still sends the PUT', async () => {
    registerRuntimeAPIs(null);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://gate-get-fail.example', runtimeKey: 'gate-get-fail' });
    fetchHandler = (url, method, body) => {
      if (!url.includes('/api/pi/ui-settings')) return new Response(null, { status: 500 });
      if (method === 'GET') return new Response(null, { status: 500 });
      return jsonResponse((body ? JSON.parse(body) : {}) as Record<string, unknown>);
    };

    await updateDesktopSettings({ themeId: 'gate-get-fail-theme' });
    expect(countCalls('GET')).toBe(1);
    expect(countCalls('PUT')).toBe(1);
  });

  test('a hung initial GET times out and the PUT is sent', async () => {
    registerRuntimeAPIs(null);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://gate-timeout.example', runtimeKey: 'gate-timeout' });
    fetchHandler = (url, method, body) => {
      if (!url.includes('/api/pi/ui-settings')) return new Response(null, { status: 500 });
      if (method === 'GET') return new Promise<Response>(() => {});
      return jsonResponse((body ? JSON.parse(body) : {}) as Record<string, unknown>);
    };

    await updateDesktopSettings({ themeId: 'gate-timeout-theme' });
    expect(countCalls('GET')).toBe(1);
    expect(countCalls('PUT')).toBe(1);
  });

  test('a runtime switch during the wait never suppresses against the old image', async () => {
    registerRuntimeAPIs(null);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://gate-a.example', runtimeKey: 'gate-a' });
    const autoSaveEnabled = useUIStore.getState().autoSaveEnabled;
    const getGateA = deferred<Response>();
    let switched = false;
    const putBodies: string[] = [];
    const docA = {
      themeId: 'shared-theme',
      autoSaveEnabled,
      draftStartersScheduleTaskAdded: true,
    };
    const docB = {
      themeId: 'b-theme',
      autoSaveEnabled,
      draftStartersScheduleTaskAdded: true,
    };
    fetchHandler = (url, method, body) => {
      if (!url.includes('/api/pi/ui-settings')) return new Response(null, { status: 500 });
      if (method === 'GET') return switched ? jsonResponse(docB) : getGateA.promise;
      // Runtime A's endpoint-change drain may reach the stub after the
      // switch; only writes addressed to runtime B count here.
      if (switched && body && url.includes('gate-b.example')) putBodies.push(body);
      return jsonResponse(docB);
    };

    // Park runtime A's flush on its hanging boot GET.
    const first = updateDesktopSettings({ themeId: 'shared-theme' });
    await delay(300);
    expect(countCalls('PUT')).toBe(0);

    switchRuntimeEndpoint({ apiBaseUrl: 'https://gate-b.example', runtimeKey: 'gate-b' });
    switched = true;
    // A's load resolves after the switch: the stale flush must not send.
    getGateA.resolve(jsonResponse(docA));
    await first;
    expect(putBodies).toHaveLength(0);

    // B's image holds a different theme, so the same value is a real change
    // there — the old runtime's image is never consulted.
    await updateDesktopSettings({ themeId: 'shared-theme' });
    expect(putBodies).toHaveLength(1);
    expect((JSON.parse(putBodies[0]) as Record<string, unknown>).themeId).toBe('shared-theme');
  });
});

describe('shared settings document', () => {
  const countSettingsGets = () =>
    fetchCalls.filter((call) => call.method === 'GET' && call.url.includes('/api/pi/ui-settings')).length;

  test('config defaults reuse the startup GET, including fields the sanitizer drops', async () => {
    registerRuntimeAPIs(null);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://shared-doc.example', runtimeKey: 'shared-doc' });
    fetchHandler = (url) => {
      if (!url.includes('/api/pi/ui-settings')) return new Response(null, { status: 500 });
      return jsonResponse({
        themeId: 'shared-theme',
        defaultModel: 'anthropic/claude',
        zenModel: 'zen-1',
        messageStreamTransport: 'sse',
        draftStartersScheduleTaskAdded: true,
      });
    };

    await syncDesktopSettings();
    const defaults = await fetchPiChamberDefaults();

    expect(countSettingsGets()).toBe(1);
    expect(defaults.defaultModel).toBe('anthropic/claude');
    expect(defaults.zenModel).toBe('zen-1');
    expect(defaults.messageStreamTransport).toBe('sse');
  });

  test('a failed shared load returns null and defaults fall back to their own request', async () => {
    registerRuntimeAPIs(null);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://shared-doc-fail.example', runtimeKey: 'shared-doc-fail' });
    let settingsGets = 0;
    fetchHandler = (url) => {
      if (!url.includes('/api/pi/ui-settings')) return new Response(null, { status: 500 });
      settingsGets += 1;
      return settingsGets === 1
        ? new Response(null, { status: 503 })
        : jsonResponse({ defaultModel: 'fallback/model' });
    };

    expect(await loadSharedSettingsDocument()).toBeNull();
    // The failure is not cached: the next shared load retries and succeeds.
    const defaults = await fetchPiChamberDefaults();
    expect(defaults.defaultModel).toBe('fallback/model');
  });
});
