import { beforeEach, describe, expect, mock, test } from 'bun:test';

let fetchCalls = 0;
let fetchImplementation: () => Promise<Response> = async () => new Response();
const runtimeFetch = async () => {
  fetchCalls += 1;
  return fetchImplementation();
};
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch }));

const { installWebUpdate, waitForUpdateJob } = await import('./web-update');

beforeEach(() => {
  fetchCalls = 0;
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
});
