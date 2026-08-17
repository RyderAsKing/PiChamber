import { describe, expect, test } from 'bun:test';

import { configuredProviders, isConfiguredProvider } from './configured-providers';

describe('configuredProviders', () => {
  test('keeps authenticated providers that have models', () => {
    const providers = [
      { id: 'p1', authenticated: true, models: [{ id: 'm1' }] },
      { id: 'p2', authenticated: false, models: [{ id: 'm2' }] },
      { id: 'p3', authenticated: true, models: [] },
      { id: 'p4', authenticated: true, models: { m4: { id: 'm4' } } },
    ];
    expect(configuredProviders(providers).map((provider) => provider.id)).toEqual(['p1', 'p4']);
  });

  test('treats missing authenticated as unconfigured', () => {
    expect(isConfiguredProvider({ models: [{ id: 'm1' }] })).toBe(false);
    expect(isConfiguredProvider({ authenticated: true, models: [{ id: 'm1' }] })).toBe(true);
  });
});
