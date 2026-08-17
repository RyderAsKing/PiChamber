import { describe, expect, mock, test } from 'bun:test';

const listProviders = mock(async () => ({
  providers: [
    {
      id: 'p1',
      label: 'Provider One',
      authenticated: true,
      models: [
        {
          id: 'm1',
          providerId: 'p1',
          label: 'Model One',
          contextWindow: 128000,
          supportsThinking: true,
        },
      ],
    },
    {
      id: 'p2',
      label: 'Provider Two',
      authenticated: false,
      models: [{ id: 'm2', providerId: 'p2', label: 'Model Two' }],
    },
  ],
  default: { providerId: 'p1', modelId: 'm1' },
}));

mock.module('@/apps/pi-session-store', () => ({
  getPiSessionStore: () => ({
    getState: () => ({ directory: '/workspace' }),
    open: mock(async () => undefined),
    archive: mock(async () => undefined),
    remove: mock(async () => undefined),
  }),
}));
mock.module('@/lib/pi/client', () => ({
  piClient: {
    listProviders,
    health: mock(async () => ({ state: 'ready' })),
  },
}));
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => 'runtime-a' }));
mock.module('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: { getState: () => ({ currentDirectory: '/workspace' }) },
}));

const { opencodeClient } = await import('./legacy-ui-client');

describe('opencodeClient.getProvidersForConfig', () => {
  test('projects Pi providers into the config-store provider list shape', async () => {
    const result = await opencodeClient.getProvidersForConfig();
    expect(result.providers).toHaveLength(2);
    expect(result.providers[0]?.id).toBe('p1');
    expect(result.providers).toEqual([
      {
        id: 'p1',
        name: 'Provider One',
        models: {
          m1: {
            id: 'm1',
            name: 'Model One',
            providerID: 'p1',
            reasoning: true,
            limit: { context: 128000 },
          },
        },
      },
      {
        id: 'p2',
        name: 'Provider Two',
        models: {
          m2: {
            id: 'm2',
            name: 'Model Two',
            providerID: 'p2',
            reasoning: false,
          },
        },
      },
    ]);
    expect(result.default).toEqual({ p1: 'm1' });
  });
});
