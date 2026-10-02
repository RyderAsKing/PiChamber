import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';
import type { DesktopSettings } from '@/lib/desktop';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useUIStore } from '@/stores/useUIStore';
import { DEFAULT_SIDEBAR_VIEW_MODE } from '@/lib/sidebarViewMode';
import { createProjectIdFromPath } from '@/lib/projectId';
import {
  invalidateSettingsCache,
  refreshDesktopSettings,
  syncDesktopSettings,
  updateDesktopSettings,
} from './persistence';
import { switchRuntimeEndpoint } from './runtime-switch';

// Post-boot settings refresh coverage for `packages/ui/src/lib/persistence.ts`:
// another client's change reaches this one, and a refresh can never revert or
// mis-suppress a local write. Self-contained: every stub (runtime settings
// API, global fetch, clock) is installed within this file and no shared module
// is partially mocked.

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

const realDateNow = Date.now;
// Step past the refresh floor without waiting for it.
const advanceClock = (ms: number): void => {
  const base = Date.now();
  Date.now = () => base + ms;
};

const baseSettings = { draftStartersScheduleTaskAdded: true, autoSaveEnabled: true };

afterEach(() => {
  Date.now = realDateNow;
  useUIStore.setState({ sidebarViewMode: DEFAULT_SIDEBAR_VIEW_MODE });
});

describe('refreshDesktopSettings', () => {
  test('applies a sidebar view changed by another client', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://refresh-apply.example', runtimeKey: 'refresh-apply' });
    let serverMode = 'folder';
    let loadCalls = 0;
    registerSettingsApi(
      async (changes) => changes as SettingsPayload,
      async () => {
        loadCalls += 1;
        return { settings: { ...baseSettings, sidebarViewMode: serverMode } as SettingsPayload, source: 'web' };
      },
    );

    await syncDesktopSettings();
    expect(useUIStore.getState().sidebarViewMode).toBe('folder');

    serverMode = 'timeline';
    advanceClock(60_000);
    await refreshDesktopSettings();

    expect(loadCalls).toBe(2);
    expect(useUIStore.getState().sidebarViewMode).toBe('timeline');
  });

  test('resets to the default when the server no longer stores a mode', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://refresh-default.example', runtimeKey: 'refresh-default' });
    let settings: Record<string, unknown> = { ...baseSettings, sidebarViewMode: 'timeline' };
    registerSettingsApi(
      async (changes) => changes as SettingsPayload,
      async () => ({ settings: settings as SettingsPayload, source: 'web' }),
    );

    await syncDesktopSettings();
    expect(useUIStore.getState().sidebarViewMode).toBe('timeline');

    settings = { ...baseSettings };
    advanceClock(60_000);
    await refreshDesktopSettings();

    expect(useUIStore.getState().sidebarViewMode).toBe('workspace');
  });

  test('collapses a burst of resume signals into one request', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://refresh-burst.example', runtimeKey: 'refresh-burst' });
    let loadCalls = 0;
    registerSettingsApi(
      async (changes) => changes as SettingsPayload,
      async () => {
        loadCalls += 1;
        return { settings: { ...baseSettings } as SettingsPayload, source: 'web' };
      },
    );

    await syncDesktopSettings();
    expect(loadCalls).toBe(1);

    // Inside the floor: the boot document is fresh enough.
    await refreshDesktopSettings();
    expect(loadCalls).toBe(1);

    advanceClock(60_000);
    await Promise.all([refreshDesktopSettings(), refreshDesktopSettings(), refreshDesktopSettings()]);
    expect(loadCalls).toBe(2);
  });

  test('keeps the current state when the refresh request fails', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://refresh-fail.example', runtimeKey: 'refresh-fail' });
    let failing = false;
    registerSettingsApi(
      async (changes) => changes as SettingsPayload,
      async () => {
        if (failing) throw new Error('offline');
        return { settings: { ...baseSettings, sidebarViewMode: 'folder' } as SettingsPayload, source: 'web' };
      },
    );

    await syncDesktopSettings();
    expect(useUIStore.getState().sidebarViewMode).toBe('folder');

    failing = true;
    advanceClock(60_000);
    await refreshDesktopSettings();

    // The fallback route also failed (500): a failed read is not an empty
    // document, so nothing is reset to defaults.
    expect(fetchCalls.some((call) => call.method === 'GET')).toBe(true);
    expect(useUIStore.getState().sidebarViewMode).toBe('folder');
  });

  test('does not start while a local write is pending', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://refresh-pending.example', runtimeKey: 'refresh-pending' });
    let loadCalls = 0;
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(
      async (changes) => {
        saveCalls.push(changes);
        return { ...baseSettings, ...changes } as SettingsPayload;
      },
      async () => {
        loadCalls += 1;
        return { settings: { ...baseSettings, sidebarViewMode: 'workspace' } as SettingsPayload, source: 'web' };
      },
    );

    await syncDesktopSettings();
    advanceClock(60_000);

    useUIStore.getState().setSidebarViewMode('folder');
    const write = updateDesktopSettings({ sidebarViewMode: 'folder' });
    await refreshDesktopSettings();
    expect(loadCalls).toBe(1);
    expect(useUIStore.getState().sidebarViewMode).toBe('folder');

    await write;
    expect(saveCalls).toEqual([{ sidebarViewMode: 'folder' }]);
    expect(useUIStore.getState().sidebarViewMode).toBe('folder');
  });

  test('drops a response that predates a local write', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://refresh-race.example', runtimeKey: 'refresh-race' });
    const staleLoad = deferred<{ settings: SettingsPayload; source: 'web' }>();
    let loadCalls = 0;
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsApi(
      async (changes) => {
        saveCalls.push(changes);
        return { ...baseSettings, ...changes } as SettingsPayload;
      },
      () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          return Promise.resolve({ settings: { ...baseSettings, sidebarViewMode: 'workspace' } as SettingsPayload, source: 'web' as const });
        }
        return staleLoad.promise;
      },
    );

    await syncDesktopSettings();
    advanceClock(60_000);

    const refresh = refreshDesktopSettings();
    await delay(0);
    expect(loadCalls).toBe(2);

    // The user switches the view while the refresh GET is still in flight,
    // and the write completes first.
    useUIStore.getState().setSidebarViewMode('timeline');
    await updateDesktopSettings({ sidebarViewMode: 'timeline' }, { immediate: true });
    expect(saveCalls).toEqual([{ sidebarViewMode: 'timeline' }]);

    staleLoad.resolve({ settings: { ...baseSettings, sidebarViewMode: 'workspace' } as SettingsPayload, source: 'web' });
    await refresh;
    expect(useUIStore.getState().sidebarViewMode).toBe('timeline');

    // The stale document did not become the no-op suppression image either:
    // going back to the value it carried is a real change and is sent.
    useUIStore.getState().setSidebarViewMode('workspace');
    await updateDesktopSettings({ sidebarViewMode: 'workspace' }, { immediate: true });
    expect(saveCalls).toEqual([{ sidebarViewMode: 'timeline' }, { sidebarViewMode: 'workspace' }]);
  });

  test("carries the folder list but not another client's open folder", async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://refresh-projects.example', runtimeKey: 'refresh-projects' });
    const projectB = createProjectIdFromPath('/repo-b');
    const projectA = createProjectIdFromPath('/repo-a');
    const projects = [
      { id: projectB, path: '/repo-b', label: 'Repo B' },
      { id: projectA, path: '/repo-a', label: 'Repo A' },
    ];
    registerSettingsApi(
      async (changes) => changes as SettingsPayload,
      async () => ({
        settings: { ...baseSettings, projects, activeProjectId: projectB } as SettingsPayload,
        source: 'web',
      }),
    );
    const synced: DesktopSettings[] = [];
    const listener = (event: Event) => {
      synced.push((event as CustomEvent<DesktopSettings>).detail);
    };
    getWindow().addEventListener('pichamber:settings-synced', listener);
    try {
      await syncDesktopSettings();
      advanceClock(60_000);
      await refreshDesktopSettings();
    } finally {
      getWindow().removeEventListener('pichamber:settings-synced', listener);
    }

    expect(synced).toHaveLength(2);
    expect(synced[0]?.activeProjectId).toBe(projectB);
    expect(synced[1]?.projects?.map((project) => project.id)).toEqual([projectB, projectA]);
    expect(Object.prototype.hasOwnProperty.call(synced[1], 'activeProjectId')).toBe(false);
  });
});
