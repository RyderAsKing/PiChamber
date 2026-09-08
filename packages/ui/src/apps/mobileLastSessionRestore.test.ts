import { describe, expect, test } from 'bun:test';

import { initialCatalog } from '@/sync/pi-session-catalog';
import { decideMobileRestore } from './mobileLastSessionRestore';

const catalogWith = (entries: Array<{ id: string; directory: string; archived?: boolean }>) => {
  const byId = new Map(
    entries.map((e) => [
      e.id,
      {
        id: e.id,
        directory: e.directory,
        parentId: null,
        title: e.id,
        archived: e.archived ?? false,
        createdAt: 1,
        updatedAt: 2,
        lifecycle: 'idle' as const,
        hydrated: false,
      },
    ]),
  );
  const byDirectory = new Map<string, readonly string[]>();
  for (const e of entries) {
    const list = byDirectory.get(e.directory) ?? [];
    byDirectory.set(e.directory, [...list, e.id]);
  }
  return {
    ...initialCatalog(),
    byId,
    byDirectory,
    listStatusByDirectory: new Map([[entries[0]?.directory ?? '/proj-a', 'ready' as const]]),
  };
};

describe('decideMobileRestore', () => {
  test('demands a persisted directory even for unknown projects', () => {
    expect(
      decideMobileRestore({
        persisted: { sessionId: 's-1', directory: null },
        persistedDirectory: null,
        stale: false,
        ready: false,
        catalog: null,
        runtimeKey: 'r1',
        capturedRuntimeKey: 'r1',
        storeIdentityMatches: true,
        generationMatches: true,
      }),
    ).toEqual({ action: 'wait' });
  });

  test('stale results never clear or select', () => {
    const catalog = catalogWith([{ id: 's-1', directory: '/proj-a' }]);
    expect(
      decideMobileRestore({
        persisted: { sessionId: 's-1', directory: '/proj-a' },
        persistedDirectory: '/proj-a',
        stale: true,
        ready: true,
        catalog,
        runtimeKey: 'r1',
        capturedRuntimeKey: 'r1',
        storeIdentityMatches: true,
        generationMatches: true,
      }),
    ).toEqual({ action: 'wait' });
    expect(
      decideMobileRestore({
        persisted: { sessionId: 's-1', directory: '/proj-a' },
        persistedDirectory: '/proj-a',
        stale: false,
        ready: true,
        catalog,
        runtimeKey: 'r2',
        capturedRuntimeKey: 'r1',
        storeIdentityMatches: true,
        generationMatches: true,
      }),
    ).toEqual({ action: 'wait' });
  });

  test('non-ready target never clears on empty partial results', () => {
    const catalog = catalogWith([{ id: 'other', directory: '/proj-a' }]);
    expect(
      decideMobileRestore({
        persisted: { sessionId: 'missing', directory: '/proj-a' },
        persistedDirectory: '/proj-a',
        stale: false,
        ready: false,
        catalog,
        runtimeKey: 'r1',
        capturedRuntimeKey: 'r1',
        storeIdentityMatches: true,
        generationMatches: true,
      }),
    ).toEqual({ action: 'wait' });
  });

  test('authoritative ready scope clears missing/archived and selects active', () => {
    const missingCatalog = catalogWith([{ id: 'other', directory: '/proj-a' }]);
    expect(
      decideMobileRestore({
        persisted: { sessionId: 'missing', directory: '/proj-a' },
        persistedDirectory: '/proj-a',
        stale: false,
        ready: true,
        catalog: missingCatalog,
        runtimeKey: 'r1',
        capturedRuntimeKey: 'r1',
        storeIdentityMatches: true,
        generationMatches: true,
      }),
    ).toEqual({ action: 'clear' });

    const archivedCatalog = catalogWith([{ id: 's-1', directory: '/proj-a', archived: true }]);
    expect(
      decideMobileRestore({
        persisted: { sessionId: 's-1', directory: '/proj-a' },
        persistedDirectory: '/proj-a',
        stale: false,
        ready: true,
        catalog: archivedCatalog,
        runtimeKey: 'r1',
        capturedRuntimeKey: 'r1',
        storeIdentityMatches: true,
        generationMatches: true,
      }),
    ).toEqual({ action: 'clear' });

    const activeCatalog = catalogWith([{ id: 's-1', directory: '/proj-a' }]);
    expect(
      decideMobileRestore({
        persisted: { sessionId: 's-1', directory: '/proj-a' },
        persistedDirectory: '/proj-a',
        stale: false,
        ready: true,
        catalog: activeCatalog,
        runtimeKey: 'r1',
        capturedRuntimeKey: 'r1',
        storeIdentityMatches: true,
        generationMatches: true,
      }),
    ).toEqual({ action: 'select', sessionId: 's-1', directory: '/proj-a' });
  });
});
