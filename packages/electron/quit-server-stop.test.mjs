import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createQuitServerStop } from './quit-server-stop.mjs';

describe('quit-server-stop', () => {
  it('awaits the server stop and reports stopped', async () => {
    let stopped = false;
    const stopper = createQuitServerStop({ timeoutMs: 1000 });
    const result = await stopper.requestStop({
      stop: async () => {
        stopped = true;
      },
    });
    assert.equal(stopped, true);
    assert.equal(result.stopped, true);
  });

  it('shares one stop across concurrent quit paths (no double-stop)', async () => {
    let calls = 0;
    const stopper = createQuitServerStop({ timeoutMs: 1000 });
    const handle = {
      stop: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    };
    const [first, second] = await Promise.all([
      stopper.requestStop(handle),
      stopper.requestStop(handle),
    ]);
    assert.equal(calls, 1);
    assert.equal(first.stopped, true);
    assert.equal(second.stopped, true);
  });

  it('resolves after the bounded timeout when the server hangs', async () => {
    const stopper = createQuitServerStop({ timeoutMs: 20 });
    const started = Date.now();
    const result = await stopper.requestStop({
      stop: () => new Promise(() => {}),
    });
    assert.equal(result.stopped, true);
    assert.ok(Date.now() - started < 2000, 'quit stays responsive');
  });

  it('reports stop failures instead of throwing', async () => {
    const seen = [];
    const stopper = createQuitServerStop({ timeoutMs: 1000, onError: (error) => seen.push(error) });
    const failure = new Error('stop failed');
    const result = await stopper.requestStop({
      stop: async () => {
        throw failure;
      },
    });
    assert.equal(result.stopped, false);
    assert.equal(seen.length, 1);
  });

  it('resolves immediately without a server handle', async () => {
    const stopper = createQuitServerStop({ timeoutMs: 1000 });
    const result = await stopper.requestStop(null);
    assert.equal(result.stopped, false);
  });

  it('re-arms after reset for a fresh server start', async () => {
    let calls = 0;
    const stopper = createQuitServerStop({ timeoutMs: 1000 });
    const handle = {
      stop: async () => {
        calls += 1;
      },
    };
    await stopper.requestStop(handle);
    stopper.reset();
    await stopper.requestStop(handle);
    assert.equal(calls, 2);
  });
});
