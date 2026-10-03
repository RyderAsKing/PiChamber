import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { runtimeFetch } from './runtime-fetch';

let capacitorMode = true;
let fetchHandler: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
const originalFetch = globalThis.fetch;

mock.module('./platform', () => ({
  isCapacitorApp: () => capacitorMode,
  isIPadApp: () => false,
  getClientPlatform: () => (capacitorMode ? ('android' as const) : ('web' as const)),
  isWindowsArm64: () => false,
}));

mock.module('./relay/runtime-tunnel', () => ({
  getActiveRelayTunnel: () => null,
  isRelayModeActive: () => false,
}));

describe('runtimeFetch Capacitor direct mode AbortSignal enforcement', () => {
  beforeEach(() => {
    capacitorMode = true;
    fetchHandler = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (fetchHandler) return fetchHandler(url, init);
      // Default: returns a promise that never resolves (and ignores signal)
      return new Promise<Response>(() => {});
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('a fetch that never resolves rejects with AbortError when signal aborts', async () => {
    const controller = new AbortController();
    const fetchPromise = runtimeFetch('/api/pi/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'test' }),
      signal: controller.signal,
    });

    // Abort after a short tick
    setTimeout(() => controller.abort(), 10);

    let caughtError: unknown;
    try {
      await fetchPromise;
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(DOMException);
    expect((caughtError as DOMException).name).toBe('AbortError');
  });

  test('already-aborted signal rejects immediately with AbortError without starting fetch', async () => {
    const controller = new AbortController();
    controller.abort();

    let fetchStarted = false;
    fetchHandler = async () => {
      fetchStarted = true;
      return new Response(JSON.stringify({ ok: true }));
    };

    let caughtError: unknown;
    try {
      await runtimeFetch('/api/pi/sessions', {
        method: 'POST',
        signal: controller.signal,
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(DOMException);
    expect((caughtError as DOMException).name).toBe('AbortError');
    expect(fetchStarted).toBe(false);
  });

  test('Request object signal is honored when fetch hangs', async () => {
    const controller = new AbortController();
    const request = new Request('http://localhost/api/pi/sessions', {
      method: 'POST',
      signal: controller.signal,
    });

    const fetchPromise = runtimeFetch(request);
    setTimeout(() => controller.abort(), 10);

    let caughtError: unknown;
    try {
      await fetchPromise;
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(DOMException);
    expect((caughtError as DOMException).name).toBe('AbortError');
  });

  test('cleans up abort listener on normal fetch resolution', async () => {
    fetchHandler = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });

    const controller = new AbortController();
    let addCalls = 0;
    let removeCalls = 0;

    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);

    controller.signal.addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
      if (type === 'abort') addCalls += 1;
      return originalAdd(type, listener, options as boolean | AddEventListenerOptions);
    };
    controller.signal.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
      if (type === 'abort') removeCalls += 1;
      return originalRemove(type, listener, options as boolean | EventListenerOptions);
    };

    const response = await runtimeFetch('/api/pi/sessions', {
      method: 'POST',
      signal: controller.signal,
    });

    expect(response.ok).toBe(true);
    expect(addCalls).toBe(1);
    expect(removeCalls).toBe(1);
  });

  test('cleans up abort listener on fetch error', async () => {
    fetchHandler = async () => {
      throw new Error('Network error');
    };

    const controller = new AbortController();
    let addCalls = 0;
    let removeCalls = 0;

    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);

    controller.signal.addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
      if (type === 'abort') addCalls += 1;
      return originalAdd(type, listener, options as boolean | AddEventListenerOptions);
    };
    controller.signal.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
      if (type === 'abort') removeCalls += 1;
      return originalRemove(type, listener, options as boolean | EventListenerOptions);
    };

    let caughtError: unknown;
    try {
      await runtimeFetch('/api/pi/sessions', {
        method: 'POST',
        signal: controller.signal,
      });
    } catch (error) {
      caughtError = error;
    }

    expect((caughtError as Error).message).toBe('Network error');
    expect(addCalls).toBe(1);
    expect(removeCalls).toBe(1);
  });
});
