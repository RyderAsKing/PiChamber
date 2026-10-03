import { beforeEach, describe, expect, mock, test } from 'bun:test';

let fetchHandler: ((path: string, init?: RequestInit) => Promise<Response>) | null = null;

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (path: string, init?: RequestInit) => {
    if (fetchHandler) return fetchHandler(path, init);
    return new Promise<Response>((_, reject) => {
      if (init?.signal?.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      init?.signal?.addEventListener(
        'abort',
        () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        },
        { once: true },
      );
    });
  },
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

const { fetchPiRuntimeHealth, resetPiRuntimeHealthCache } = await import('./transport');
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');

describe('fetchPiRuntimeHealth deadline enforcement', () => {
  beforeEach(() => {
    fetchHandler = null;
    switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost', runtimeKey: 'runtime-test' });
    resetPiRuntimeHealthCache();
  });

  test('a never-resolving fetch resolves to unavailable DAEMON_TIMEOUT after deadline', async () => {
    const result = await fetchPiRuntimeHealth(undefined, undefined, {
      fresh: true,
      timeoutMs: 25,
    });

    expect(result.state).toBe('unavailable');
    expect(result.error?.code).toBe('DAEMON_TIMEOUT');
  });

  test('caller-initiated abort resolves immediately to unavailable DAEMON_TIMEOUT', async () => {
    const controller = new AbortController();
    const promise = fetchPiRuntimeHealth(controller.signal, undefined, {
      fresh: true,
      timeoutMs: 5000,
    });

    // Abort early
    controller.abort();
    const result = await promise;

    expect(result.state).toBe('unavailable');
    expect(result.error?.code).toBe('DAEMON_TIMEOUT');
  });

  test('a hung response.json() read resolves to unavailable DAEMON_TIMEOUT after deadline', async () => {
    fetchHandler = async () => {
      // Return a response whose json() never resolves
      const hangingResponse = new Response('{}', { status: 200 });
      hangingResponse.json = () => new Promise<unknown>(() => {});
      return hangingResponse;
    };

    const result = await fetchPiRuntimeHealth(undefined, undefined, {
      fresh: true,
      timeoutMs: 25,
    });

    expect(result.state).toBe('unavailable');
    expect(result.error?.code).toBe('DAEMON_TIMEOUT');
  });

  test('normal fast response resolves to ready state and memoizes', async () => {
    fetchHandler = async () => {
      return new Response(
        JSON.stringify({
          state: 'ready',
          protocolVersion: 1,
          capabilities: ['events.streamEpoch'],
          streamEpoch: 'epoch-123',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const result = await fetchPiRuntimeHealth(undefined, undefined, {
      timeoutMs: 1000,
    });

    expect(result.state).toBe('ready');
    expect(result.streamEpoch).toBe('epoch-123');
    expect(result.capabilities).toContain('events.streamEpoch');
  });
});
