import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type FetchCall = { path: string; directory: string };

const calls: FetchCall[] = [];
let respond: (call: FetchCall) => Promise<Response> = async () => new Response(null, { status: 204 });
let runtimeKey = 'local';
const runtimeListeners = new Set<() => void>();

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (path: string, init: { query: { directory: string } }) => {
    const call = { path, directory: init.query.directory };
    calls.push(call);
    return respond(call);
  },
}));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    runtimeListeners.add(listener);
    return () => runtimeListeners.delete(listener);
  },
}));

const { ensureProjectIcon, readProjectIconUrl, resetProjectIconCacheForTests, subscribeProjectIcons } = await import('./projectIcon');

const png = () => new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), { status: 200 });

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  calls.length = 0;
  runtimeKey = 'local';
  respond = async () => new Response(null, { status: 204 });
  resetProjectIconCacheForTests();
});

afterEach(() => {
  resetProjectIconCacheForTests();
});

describe('project icon cache', () => {
  test('fetches each directory once and shares the result', async () => {
    respond = async () => png();
    ensureProjectIcon('/repo/app/');
    ensureProjectIcon('/repo/app');
    await settle();
    ensureProjectIcon('/repo/app');

    expect(calls).toEqual([{ path: '/api/fs/project-icon', directory: '/repo/app' }]);
    expect(readProjectIconUrl('/repo/app')?.startsWith('blob:')).toBe(true);
  });

  test('a project without an icon reads as null', async () => {
    ensureProjectIcon('/repo/plain');
    await settle();
    expect(calls).toHaveLength(1);
    expect(readProjectIconUrl('/repo/plain')).toBeNull();
  });

  test('a failed lookup keeps the icon already shown', async () => {
    respond = async () => png();
    ensureProjectIcon('/repo/app');
    await settle();
    const first = readProjectIconUrl('/repo/app');
    expect(first).not.toBeNull();

    // Force the entry stale, then fail the refresh.
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60 * 1000;
    try {
      respond = async () => new Response('boom', { status: 500 });
      ensureProjectIcon('/repo/app');
      await settle();
      expect(calls).toHaveLength(2);
      expect(readProjectIconUrl('/repo/app')).toBe(first);
    } finally {
      Date.now = realNow;
    }
  });

  test('retries a failed request a few times while icons are on screen', async () => {
    const timers: Array<{ run: () => void; delay: number }> = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((run: () => void, delay?: number) => {
      timers.push({ run, delay: delay ?? 0 });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const unsubscribe = subscribeProjectIcons(() => undefined);
    try {
      respond = async () => new Response('starting', { status: 502 });
      ensureProjectIcon('/repo/app');
      await Promise.resolve();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      expect(timers.map((timer) => timer.delay)).toEqual([2000]);

      // The server comes up: the scheduled retry finds the icon.
      respond = async () => png();
      timers.shift()?.run();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      expect(calls).toHaveLength(2);
      expect(readProjectIconUrl('/repo/app')).not.toBeNull();
      expect(timers).toHaveLength(0);
    } finally {
      unsubscribe();
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test('stops retrying after a few failures', async () => {
    const timers: Array<{ run: () => void; delay: number }> = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((run: () => void, delay?: number) => {
      timers.push({ run, delay: delay ?? 0 });
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const unsubscribe = subscribeProjectIcons(() => undefined);
    const delays: number[] = [];
    try {
      respond = async () => new Response('down', { status: 503 });
      ensureProjectIcon('/repo/app');
      for (let round = 0; round < 6; round += 1) {
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
        const timer = timers.shift();
        if (!timer) break;
        delays.push(timer.delay);
        timer.run();
      }
      expect(delays).toEqual([2000, 5000, 15000]);
      expect(calls).toHaveLength(4);
    } finally {
      unsubscribe();
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test('icons are cached per runtime', async () => {
    respond = async () => png();
    ensureProjectIcon('/repo/app');
    await settle();
    expect(readProjectIconUrl('/repo/app')).not.toBeNull();

    runtimeKey = 'remote';
    expect(readProjectIconUrl('/repo/app')).toBeNull();
    ensureProjectIcon('/repo/app');
    await settle();
    expect(calls).toHaveLength(2);
  });

  test('subscribers hear about loaded icons', async () => {
    respond = async () => png();
    let notified = 0;
    const unsubscribe = subscribeProjectIcons(() => {
      notified += 1;
    });
    ensureProjectIcon('/repo/app');
    await settle();
    unsubscribe();
    expect(notified).toBeGreaterThan(0);
  });

  test('ignores empty directories', async () => {
    ensureProjectIcon('   ');
    ensureProjectIcon(null);
    await settle();
    expect(calls).toHaveLength(0);
  });
});
