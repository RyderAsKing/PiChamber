import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

let capacitorMode = true;
const capacitorHttpRequests: unknown[] = [];

mock.module('@/lib/platform', () => ({
  isCapacitorApp: () => capacitorMode,
  isIPadApp: () => false,
  getClientPlatform: () => (capacitorMode ? ('android' as const) : ('web' as const)),
  isWindowsArm64: () => false,
}));

mock.module('@capacitor/core', () => ({
  ExceptionCode: {},
  SystemBarsStyle: {},
  SystemBarType: {},
  Capacitor: {
    getPlatform: () => 'android',
    isNativePlatform: () => capacitorMode,
  },
  CapacitorCookies: {},
  CapacitorException: class {},
  CapacitorHttp: {
    request: async (options: unknown) => {
      capacitorHttpRequests.push(options);
      return {
        status: 200,
        headers: {},
        data: { ok: true },
      };
    },
  },
  SystemBars: {},
  WebPlugin: class {},
  WebView: {},
  buildRequestInit: () => ({}),
  registerPlugin: () => ({}),
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

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

const installWindow = () => {
  (globalThis as Record<string, unknown>).window = {
    setTimeout: ((cb: () => void, ms?: number) => globalThis.setTimeout(cb, ms)) as typeof setTimeout,
    clearTimeout: ((id: number) => globalThis.clearTimeout(id as unknown as ReturnType<typeof setTimeout>)) as typeof clearTimeout,
    location: { origin: 'http://localhost' },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
  };
};

const { nativeHttpRequest, requestWithTimeout } = await import('./mobileConnectionTransport');
const { MOBILE_CONNECT_TIMEOUT_MS, MOBILE_NATIVE_HTTP_TIMEOUT_MS } = await import('./mobileConnectionTypes');

describe('nativeHttpRequest connectTimeout and readTimeout', () => {
  beforeEach(() => {
    capacitorMode = true;
    capacitorHttpRequests.length = 0;
    installWindow();
  });

  afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  test('passes default MOBILE_CONNECT_TIMEOUT_MS when options omitted', async () => {
    const result = await nativeHttpRequest('https://example.com/api/test', {
      method: 'POST',
      body: JSON.stringify({ key: 'value' }),
    });

    expect(result?.ok).toBe(true);
    expect(capacitorHttpRequests).toHaveLength(1);
    const req = capacitorHttpRequests[0] as {
      url: string;
      method: string;
      connectTimeout?: number;
      readTimeout?: number;
    };
    expect(req.url).toBe('https://example.com/api/test');
    expect(req.method).toBe('POST');
    expect(req.connectTimeout).toBe(MOBILE_CONNECT_TIMEOUT_MS);
    expect(req.readTimeout).toBe(MOBILE_CONNECT_TIMEOUT_MS);
  });

  test('passes custom timeoutMs when specified in options', async () => {
    const customTimeout = 1500;
    const result = await nativeHttpRequest(
      'https://example.com/api/test',
      { method: 'GET' },
      { timeoutMs: customTimeout },
    );

    expect(result?.ok).toBe(true);
    expect(capacitorHttpRequests).toHaveLength(1);
    const req = capacitorHttpRequests[0] as {
      url: string;
      method: string;
      connectTimeout?: number;
      readTimeout?: number;
    };
    expect(req.connectTimeout).toBe(customTimeout);
    expect(req.readTimeout).toBe(customTimeout);
  });

  test('requestWithTimeout passes native timeout to nativeHttpRequest', async () => {
    const result = await requestWithTimeout('https://example.com/health', { method: 'GET' });

    expect(result?.ok).toBe(true);
    expect(capacitorHttpRequests).toHaveLength(1);
    const req = capacitorHttpRequests[0] as {
      url: string;
      connectTimeout?: number;
      readTimeout?: number;
    };
    expect(req.connectTimeout).toBe(MOBILE_NATIVE_HTTP_TIMEOUT_MS);
    expect(req.readTimeout).toBe(MOBILE_NATIVE_HTTP_TIMEOUT_MS);
  });

  test('returns null when not running in Capacitor', async () => {
    capacitorMode = false;
    const result = await nativeHttpRequest('https://example.com/api/test');
    expect(result).toBeNull();
    expect(capacitorHttpRequests).toHaveLength(0);
  });
});
