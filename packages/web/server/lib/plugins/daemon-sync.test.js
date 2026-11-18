import { describe, expect, it, vi } from 'vitest';

import { createPluginDaemonSync } from './daemon-sync.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

describe('plugin daemon sync', () => {
  it('configures each daemon process once per revision, before its request', async () => {
    let config = { plugins: [] };
    const sync = createPluginDaemonSync({ buildConfig: async () => config, logger: { warn: vi.fn() } });
    const request = vi.fn(async () => ({}));

    await sync.onDaemonReady({ health: { streamEpoch: 'a' }, request });
    await sync.onDaemonReady({ health: { streamEpoch: 'a' }, request });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenLastCalledWith('plugins.configure', { plugins: [] });

    // A restarted or different daemon process has a new epoch.
    await sync.onDaemonReady({ health: { streamEpoch: 'b' }, request });
    expect(request).toHaveBeenCalledTimes(2);

    config = { plugins: [{ id: 'visuals' }] };
    sync.changed();
    await sync.onDaemonReady({ health: { streamEpoch: 'a' }, request });
    await sync.onDaemonReady({ health: { streamEpoch: 'b' }, request });
    expect(request).toHaveBeenCalledTimes(4);
    expect(request).toHaveBeenLastCalledWith('plugins.configure', config);
  });

  it('builds a scoped hook\'s config with its scope', async () => {
    const buildConfig = vi.fn(async (scope) => ({ plugins: [], scope: scope ?? null }));
    const sync = createPluginDaemonSync({ buildConfig, logger: { warn: vi.fn() } });
    const request = vi.fn(async () => ({}));
    await sync.onDaemonReady({ health: { streamEpoch: 'main' }, request });
    await sync.onDaemonReadyFor({ roots: ['/work/night'] })({ health: { streamEpoch: 'sandbox' }, request });
    expect(request.mock.calls).toEqual([
      ['plugins.configure', { plugins: [], scope: null }],
      ['plugins.configure', { plugins: [], scope: { roots: ['/work/night'] } }],
    ]);
  });

  it('shares one push between concurrent requests', async () => {
    const gate = deferred();
    const sync = createPluginDaemonSync({ buildConfig: async () => ({ plugins: [] }) });
    const request = vi.fn(() => gate.promise);
    const first = sync.onDaemonReady({ health: { streamEpoch: 'a' }, request });
    const second = sync.onDaemonReady({ health: { streamEpoch: 'a' }, request });
    gate.resolve({});
    await Promise.all([first, second]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('logs a failed push, never throws, and retries after the delay', async () => {
    let time = 0;
    const logger = { warn: vi.fn() };
    const sync = createPluginDaemonSync({ buildConfig: async () => ({ plugins: [] }), logger, retryDelayMs: 1_000, now: () => time });
    const request = vi.fn(async () => {
      const error = new Error('down');
      error.code = 'DAEMON_UNAVAILABLE';
      throw error;
    });
    await expect(sync.onDaemonReady({ health: { streamEpoch: 'a' }, request })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DAEMON_UNAVAILABLE'));
    await sync.onDaemonReady({ health: { streamEpoch: 'a' }, request });
    expect(request).toHaveBeenCalledTimes(1);
    time = 1_500;
    request.mockResolvedValueOnce({});
    await sync.onDaemonReady({ health: { streamEpoch: 'a' }, request });
    expect(request).toHaveBeenCalledTimes(2);
    await sync.onDaemonReady({ health: { streamEpoch: 'a' }, request });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('a config that cannot be built is a failed push, not a thrown request', async () => {
    const logger = { warn: vi.fn() };
    const sync = createPluginDaemonSync({ buildConfig: async () => { throw Object.assign(new Error('x'), { code: 'PLUGINS_UNREADABLE' }); }, logger });
    const request = vi.fn();
    await sync.onDaemonReady({ health: { streamEpoch: 'a' }, request });
    expect(request).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('PLUGINS_UNREADABLE'));
  });

  it('pushes changes in order and probes on change', async () => {
    const pushed = [];
    let value = 0;
    const gate = deferred();
    const refresh = vi.fn();
    const sync = createPluginDaemonSync({ buildConfig: async () => ({ value }), refresh });
    const request = vi.fn(async (_command, payload) => {
      if (pushed.length === 0) await gate.promise;
      pushed.push(payload.value);
    });
    const first = sync.onDaemonReady({ health: { streamEpoch: 'a' }, request });
    value = 1;
    sync.changed();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
    const second = sync.onDaemonReady({ health: { streamEpoch: 'a' }, request });
    gate.resolve();
    await Promise.all([first, second]);
    // The first push already carried the newer value; nothing older lands last.
    expect(pushed.at(-1)).toBe(1);
  });
});
