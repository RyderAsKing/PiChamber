import { beforeEach, describe, expect, mock, test } from 'bun:test';

let fetchCalls = 0;
let runtimeGeneration = 0;
let fetchImplementation: () => Promise<Response> = async () => new Response();
const runtimeFetch = async () => {
  fetchCalls += 1;
  return fetchImplementation();
};
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch }));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeEndpointGeneration: () => runtimeGeneration,
}));

const { installWebUpdate, waitForUpdateApplied, waitForUpdateJob } = await import('./web-update');

beforeEach(() => {
  fetchCalls = 0;
  runtimeGeneration = 0;
  fetchImplementation = async () => new Response();
});

describe('web update errors', () => {
  test('preserves the pinned server channel and target', async () => {
    fetchImplementation = async () => new Response(JSON.stringify({
      success: true,
      autoRestart: true,
      jobId: '10000000-0000-4000-8000-000000000001',
      channel: 'rc',
      targetVersion: '2.0.0-rc.3',
    }), { status: 202 });

    expect(await installWebUpdate()).toEqual({
      success: true,
      autoRestart: true,
      jobId: '10000000-0000-4000-8000-000000000001',
      channel: 'rc',
      targetVersion: '2.0.0-rc.3',
    });
  });

  test('preserves deployment-specific manual commands', async () => {
    fetchImplementation = async () => new Response(JSON.stringify({
      success: false,
      code: 'CUSTOM_SYSTEMD_UNIT',
      error: 'Restart the custom unit manually.',
      commands: ['pichamber update', 'systemctl --user restart custom.service'],
    }), { status: 409 });

    expect(await installWebUpdate()).toEqual({
      success: false,
      error: 'Restart the custom unit manually.',
      commands: ['pichamber update', 'systemctl --user restart custom.service'],
    });
  });
});

describe('web update fallback polling', () => {
  for (const currentVersion of ['1.0.0', '2.0.0']) {
    test(`rejects version-check errors even with currentVersion ${currentVersion}`, async () => {
      fetchImplementation = async () => new Response(JSON.stringify({
        available: false,
        currentVersion,
        error: 'Unable to determine versions',
      }), { status: 200 });

      expect(await waitForUpdateApplied('1.0.0', 100, 0)).toEqual({
        applied: false,
        error: 'Unable to determine versions',
      });
      expect(fetchCalls).toBe(1);
    });
  }

  for (const available of [false, true]) {
    test(`accepts successful legacy version checks with available ${available}`, async () => {
      fetchImplementation = async () => new Response(JSON.stringify({
        available,
        currentVersion: '2.0.0',
      }), { status: 200 });

      expect(await waitForUpdateApplied('1.0.0', 100, 0)).toEqual({ applied: true });
      expect(fetchCalls).toBe(1);
    });
  }

  test('reports lost authentication as an unknown outcome', async () => {
    fetchImplementation = async () => new Response(null, { status: 403 });

    const result = await waitForUpdateApplied('1.0.0', 100, 0);

    expect(result).toEqual({
      applied: false,
      error: 'Authentication was lost while following the update. Reauthenticate to check its status.',
    });
    expect(fetchCalls).toBe(1);
  });
});

describe('web update job polling', () => {
  test('follows persisted state through a temporary disconnect and completion', async () => {
    const responses: Array<Response | Error> = [
      new Response(JSON.stringify({ state: 'installing' }), { status: 200 }),
      new Error('server restarting'),
      new Response(JSON.stringify({ state: 'restarting' }), { status: 200 }),
      new Response(JSON.stringify({ state: 'complete' }), { status: 200 }),
    ];
    fetchImplementation = async () => {
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response ?? new Response(null, { status: 500 });
    };
    const states: string[] = [];

    const result = await waitForUpdateJob(
      '10000000-0000-4000-8000-000000000001',
      (state) => states.push(state),
      4,
      0,
    );
    expect(result).toEqual({ applied: true });
    expect(states).toEqual(['updating', 'reconnecting', 'restarting']);
  });

  test('returns the worker failure without waiting for the timeout', async () => {
    fetchImplementation = async () => new Response(JSON.stringify({
      state: 'failed',
      error: 'Package manager exited with code 1',
    }), { status: 200 });

    const result = await waitForUpdateJob(
      '10000000-0000-4000-8000-000000000001',
      () => {},
      100,
      0,
    );
    expect(result).toEqual({ applied: false, error: 'Package manager exited with code 1' });
    expect(fetchCalls).toBe(1);
  });

  test('reports a lost job immediately after the server reconnects', async () => {
    fetchImplementation = async () => new Response(null, { status: 404 });

    const result = await waitForUpdateJob(
      '10000000-0000-4000-8000-000000000001',
      () => {},
      100,
      0,
    );

    expect(result.applied).toBe(false);
    expect(result.error).toContain('lost the update status');
    expect(fetchCalls).toBe(1);
  });

  test('reports lost authentication as an unknown outcome instead of success', async () => {
    fetchImplementation = async () => new Response(null, { status: 401 });

    const result = await waitForUpdateJob(
      '10000000-0000-4000-8000-000000000001',
      () => {},
      100,
      0,
    );

    expect(result).toEqual({
      applied: false,
      error: 'Authentication was lost while following the update. Reauthenticate to check its status.',
    });
    expect(fetchCalls).toBe(1);
  });

  test('stops following a job when the active runtime changes', async () => {
    fetchImplementation = async () => {
      runtimeGeneration += 1;
      return new Response(JSON.stringify({ state: 'complete' }), { status: 200 });
    };
    const states: string[] = [];

    const result = await waitForUpdateJob(
      '10000000-0000-4000-8000-000000000001',
      (state) => states.push(state),
      100,
      0,
    );

    expect(result).toEqual({ applied: false, stale: true });
    expect(states).toEqual([]);
    expect(fetchCalls).toBe(1);
  });
});
