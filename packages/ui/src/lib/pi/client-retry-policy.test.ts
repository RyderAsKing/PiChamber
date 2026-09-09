import { afterEach, describe, expect, mock, test } from 'bun:test';
import { PiRequestError, PiService } from '@/lib/pi/client';

// Focused coverage for the safe-retry contract (finding #3): reads retry on
// transient failures, mutations never blanket-retry unless the caller supplied
// a stable idempotency key (the send operation id), and a request timeout is
// a distinct uncertain outcome — not an abort and not a definite failure.
// The file is self-contained (bun test --isolate): globalThis.fetch is
// swapped, everything else is the real client code.

const originalFetch = globalThis.fetch;

type FetchCall = { url: string; init?: RequestInit };
const calls: FetchCall[] = [];

const installFetchMock = (responder: (call: FetchCall, attempt: number) => Response | Promise<Response>) => {
  calls.length = 0;
  let attempt = 0;
  const fn = mock(async (url: string, init?: RequestInit) => {
    const call: FetchCall = { url, init };
    calls.push(call);
    return responder(call, attempt++);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
};

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('pi client send retry policy', () => {
  test('a mutation without an idempotency key is never blanket-retried', async () => {
    installFetchMock(() => {
      throw new TypeError('fetch failed');
    });
    const client = new PiService();
    await expect(
      client.sendPrompt({ sessionId: 's1', text: 'hello' }),
    ).rejects.toThrow('fetch failed');
    expect(calls).toHaveLength(1);
  });

  test('a mutation with a stable operation id retries transiently and dedupes server-side', async () => {
    installFetchMock((_call, attempt) => {
      if (attempt === 0) throw new TypeError('fetch failed');
      return jsonResponse({ accepted: true, messageId: 'm-1' }, { status: 202 });
    });
    const client = new PiService();
    const result = await client.sendPrompt({
      sessionId: 's1',
      text: 'hello',
      operationId: 'op-retry',
    });
    expect(result).toEqual({ accepted: true, messageId: 'm-1' });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].init?.body as string)).toMatchObject({ operationId: 'op-retry' });
  });

  test('a transient 503 on an idempotent send is retried', async () => {
    installFetchMock((_call, attempt) => {
      if (attempt === 0) return jsonResponse({ error: { code: 'DAEMON_UNAVAILABLE' } }, { status: 503 });
      return jsonResponse({ accepted: true, messageId: 'm-2', deduplicated: true }, { status: 202 });
    });
    const client = new PiService();
    const result = await client.sendSteer({ sessionId: 's1', text: 'hello', operationId: 'op-503' });
    expect(result).toMatchObject({ accepted: true, messageId: 'm-2', deduplicated: true });
    expect(calls).toHaveLength(2);
  });

  test('a transient 503 on a non-idempotent mutation is not retried', async () => {
    installFetchMock(() => jsonResponse({ error: { code: 'DAEMON_UNAVAILABLE' } }, { status: 503 }));
    const client = new PiService();
    const transientError = await client
      .compactSession({ sessionId: 's1' })
      .then(() => null, (error: unknown) => error);
    expect((transientError as PiRequestError).status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  test('reads retry transient failures', async () => {
    installFetchMock((_call, attempt) => {
      if (attempt === 0) throw new TypeError('fetch failed');
      return jsonResponse({ providers: [] });
    });
    const client = new PiService();
    expect(await client.listProviders()).toEqual({ providers: [] });
    expect(calls).toHaveLength(2);
  });

  test('a request timeout is a distinct DAEMON_TIMEOUT failure, not an abort', async () => {
    installFetchMock(() => {
      // Emulate the transport aborting on the internal deadline: the fetch
      // rejects with AbortError while no external signal was aborted.
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const client = new PiService();
    const timeoutError = await client
      .sendPrompt({ sessionId: 's1', text: 'hello', operationId: 'op-timeout' })
      .then(() => null, (error: unknown) => error);
    expect(timeoutError).toBeInstanceOf(PiRequestError);
    expect((timeoutError as PiRequestError).code).toBe('DAEMON_TIMEOUT');
    // Uncertain outcomes are not retried either.
    expect(calls).toHaveLength(1);
  });

  test('a runtime-switch guard cancels the send locally without any fetch', async () => {
    installFetchMock(() => jsonResponse({ accepted: true }, { status: 202 }));
    const client = new PiService();
    const guardError = await client
      .sendPrompt({ sessionId: 's1', text: 'hello' }, { runtimeKey: 'stale-runtime' })
      .then(() => null, (error: unknown) => error);
    expect((guardError as PiRequestError).code).toBe('DAEMON_UNAVAILABLE');
    // Locally cancelled before dispatch: distinct from timeout and rejection.
    expect(calls).toHaveLength(0);
  });
});
