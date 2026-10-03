import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('@/lib/platform', () => ({ isCapacitorApp: () => true, getClientPlatform: () => 'web' }));

const STORAGE_KEY = 'pichamber.mobile.diagnostics.v1';

const installWindow = () => {
  const store = new Map<string, string>();
  const windowListeners = new Map<string, Set<EventListener>>();
  const documentListeners = new Map<string, Set<EventListener>>();
  let visibilityState = 'visible';

  const doc = {
    get visibilityState() {
      return visibilityState;
    },
    set visibilityState(val: string) {
      visibilityState = val;
    },
    addEventListener: (type: string, listener: EventListener) => {
      const set = documentListeners.get(type) ?? new Set();
      set.add(listener);
      documentListeners.set(type, set);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      documentListeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: Event) => {
      for (const listener of documentListeners.get(event.type) ?? []) {
        listener(event);
      }
      return true;
    },
  };

  const win = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener: (type: string, listener: EventListener) => {
      const set = windowListeners.get(type) ?? new Set();
      set.add(listener);
      windowListeners.set(type, set);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      windowListeners.get(type)?.delete(listener);
    },
    dispatchEvent: (event: Event) => {
      for (const listener of windowListeners.get(event.type) ?? []) {
        listener(event);
      }
      return true;
    },
  };

  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).document = doc;
  (globalThis as Record<string, unknown>).localStorage = win.localStorage;

  return {
    store,
    win,
    doc,
    dispatchPageHide: () => win.dispatchEvent(new Event('pagehide')),
    dispatchVisibilityChange: (state: string) => {
      visibilityState = state;
      doc.dispatchEvent(new Event('visibilitychange'));
    },
  };
};

let windowHandle: ReturnType<typeof installWindow>;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

describe('mobile error diagnostics', () => {
  beforeEach(async () => {
    windowHandle = installWindow();
    const { __resetMobileErrorLogForTests } = await import('./mobile-error-log');
    __resetMobileErrorLogForTests();
  });

  afterEach(async () => {
    const { __resetMobileErrorLogForTests } = await import('./mobile-error-log');
    __resetMobileErrorLogForTests();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  test('exports bounded entries without credentials, URLs, or paths', async () => {
    const { buildMobileErrorLog, recordMobileDiagnostic } = await import('./mobile-error-log');

    recordMobileDiagnostic('stream', {
      code: 'failed',
      detail: 'Authorization: Bearer super-secret-client-token https://192.168.0.203:10000/api /home/ryder/project',
    });

    const exported = buildMobileErrorLog();
    expect(exported).toContain('pichamber-mobile-diagnostics-v1');
    expect(exported).toContain('[path]');
    expect(exported).toContain('[url]');
    expect(exported).not.toContain('super-secret-client-token');
    expect(exported).not.toContain('192.168.0.203');
    expect(exported).not.toContain('/home/ryder/project');
  });

  test('persists entries to localStorage and round-trips after in-memory reset', async () => {
    const {
      buildMobileErrorLog,
      flushMobileDiagnostics,
      recordMobileDiagnostic,
      __resetMobileErrorLogForTests,
    } = await import('./mobile-error-log');

    recordMobileDiagnostic('pi-connection', {
      code: 'ready',
      detail: 'connected to daemon',
    });
    flushMobileDiagnostics();

    const storedRaw = windowHandle.store.get(STORAGE_KEY);
    expect(storedRaw).toBeDefined();
    expect(storedRaw).toContain('pi-connection');
    expect(storedRaw).toContain('ready');

    // Simulate app process termination / fresh launch
    __resetMobileErrorLogForTests();

    // On rebuild, entries should be lazy-loaded from storage
    const restored = buildMobileErrorLog();
    expect(restored).toContain('pichamber-mobile-diagnostics-v1');
    expect(restored).toContain('pi-connection');
    expect(restored).toContain('ready');
  });

  test('persisted content contains no secret, token, URL, or path from recorded detail', async () => {
    const { flushMobileDiagnostics, recordMobileDiagnostic } = await import('./mobile-error-log');

    recordMobileDiagnostic('auth-test', {
      detail: 'token=super-secret-tok password=mypassword https://internal.server.local:8080/v1 /var/log/private.log',
    });
    flushMobileDiagnostics();

    const rawStorage = windowHandle.store.get(STORAGE_KEY) ?? '';
    expect(rawStorage).toContain('[redacted]');
    expect(rawStorage).toContain('[url]');
    expect(rawStorage).toContain('[path]');
    expect(rawStorage).not.toContain('super-secret-tok');
    expect(rawStorage).not.toContain('mypassword');
    expect(rawStorage).not.toContain('internal.server.local');
    expect(rawStorage).not.toContain('/var/log/private.log');
  });

  test('tolerates malformed or invalid JSON in storage without throwing', async () => {
    const { buildMobileErrorLog, recordMobileDiagnostic, __resetMobileErrorLogForTests } = await import('./mobile-error-log');

    // Invalid JSON string
    windowHandle.store.set(STORAGE_KEY, '{invalid json');
    __resetMobileErrorLogForTests();

    recordMobileDiagnostic('recovery', { code: 'start' });
    const log1 = buildMobileErrorLog();
    expect(log1).toContain('recovery');
    expect(log1).toContain('start');

    // Array containing non-objects and missing required fields
    windowHandle.store.set(STORAGE_KEY, JSON.stringify([
      null,
      123,
      'a string',
      { missingAtAndCategory: true },
      { at: 12345, category: 'bad-type' },
      { at: new Date().toISOString(), category: 'valid-entry', code: 'ok' },
    ]));
    __resetMobileErrorLogForTests();

    const log2 = buildMobileErrorLog();
    expect(log2).toContain('valid-entry');
    expect(log2).not.toContain('bad-type');
  });

  test('enforces max cap of 300 entries on persisted storage', async () => {
    const {
      flushMobileDiagnostics,
      recordMobileDiagnostic,
      __resetMobileErrorLogForTests,
    } = await import('./mobile-error-log');

    // Seed 250 entries
    const initialEntries = Array.from({ length: 250 }, (_, i) => ({
      at: new Date(Date.now() - 10000 + i).toISOString(),
      category: 'bulk',
      code: `entry-${i}`,
    }));
    windowHandle.store.set(STORAGE_KEY, JSON.stringify(initialEntries));
    __resetMobileErrorLogForTests();

    // Record 100 more entries (total 350)
    for (let i = 250; i < 350; i++) {
      recordMobileDiagnostic('bulk', { code: `entry-${i}` });
    }
    flushMobileDiagnostics();

    const storedRaw = windowHandle.store.get(STORAGE_KEY) ?? '[]';
    const parsed = JSON.parse(storedRaw) as Array<{ code: string }>;
    expect(parsed.length).toBe(300);
    // Oldest entries (0..49) should have been dropped; newest (50..349) kept
    expect(parsed[0]?.code).toBe('entry-50');
    expect(parsed[299]?.code).toBe('entry-349');
  });

  test('startMobileErrorLogCapture records app-launch entry and flushes on lifecycle events', async () => {
    const {
      buildMobileErrorLog,
      recordMobileDiagnostic,
      startMobileErrorLogCapture,
    } = await import('./mobile-error-log');

    const stopCapture = startMobileErrorLogCapture();

    const log = buildMobileErrorLog();
    expect(log).toContain('app-launch');
    expect(log).toContain('start');

    // Record diagnostic and verify pagehide flushes to localStorage
    recordMobileDiagnostic('stream', { code: 'connecting' });
    windowHandle.dispatchPageHide();

    let raw = windowHandle.store.get(STORAGE_KEY) ?? '';
    expect(raw).toContain('connecting');

    // Record another and verify visibilitychange to hidden flushes
    recordMobileDiagnostic('stream', { code: 'reconnected' });
    windowHandle.dispatchVisibilityChange('hidden');

    raw = windowHandle.store.get(STORAGE_KEY) ?? '';
    expect(raw).toContain('reconnected');

    stopCapture();
  });

  test('exportMobileErrorLog throws cancelled error on share abort', async () => {
    const { exportMobileErrorLog, recordMobileDiagnostic } = await import('./mobile-error-log');
    recordMobileDiagnostic('test', { code: 'cancel-test' });

    (globalThis as Record<string, unknown>).navigator = {
      share: async () => {
        const error = new Error('Share canceled');
        error.name = 'AbortError';
        throw error;
      },
    };

    expect(exportMobileErrorLog()).rejects.toThrow('Diagnostics export was cancelled');
  });

  test('exportMobileErrorLog falls back to clipboard when share fails with non-abort error', async () => {
    const { exportMobileErrorLog, recordMobileDiagnostic } = await import('./mobile-error-log');
    recordMobileDiagnostic('test', { code: 'clip-fallback' });

    let clipboardText = '';
    (globalThis as Record<string, unknown>).navigator = {
      share: async () => {
        throw new Error('Native share plugin crashed');
      },
      clipboard: {
        writeText: async (text: string) => {
          clipboardText = text;
        },
      },
    };

    const result = await exportMobileErrorLog();
    expect(result).toBe('copied');
    expect(clipboardText).toContain('clip-fallback');
  });
});
