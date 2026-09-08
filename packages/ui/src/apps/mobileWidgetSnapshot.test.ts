import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { getPiSessionStore } from '@/apps/pi-session-store';
import { piClient } from '@/lib/pi/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { __resetDirectoryRefreshSchedulerForTests } from '@/sync/pi-session-catalog';
import { loadSessionCatalog } from '@/sync/session-catalog-access';
import { buildMobileWidgetSnapshot } from './mobileWidgetSnapshot';
import { useNotificationStore } from '@/sync/notification-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionPinnedStore, getPinnedSessionKey } from '@/stores/useSessionPinnedStore';
import { useSessionOrderingStore, resetSessionOrdering } from '@/sync/session-ordering';
import { useUIStore } from '@/stores/useUIStore';

const item = (id: string, directory: string, overrides?: { updatedAt?: number; title?: string; parentId?: string | null }) => ({
  session: {
    id,
    directory,
    title: overrides?.title ?? id,
    createdAt: 1,
    updatedAt: overrides?.updatedAt ?? 1,
    parentId: overrides?.parentId ?? null,
  },
  updatedAt: overrides?.updatedAt ?? 1,
});

const originalListSessions = piClient.listSessions;

beforeEach(() => {
  __resetDirectoryRefreshSchedulerForTests();
  getPiSessionStore().clear();
  useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [] });
  useNotificationStore.setState({
    list: [],
    index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } },
  });
  useSessionPinnedStore.setState({ ids: new Set(), touchedAt: {} });
  resetSessionOrdering();
});

afterEach(() => {
  piClient.listSessions = originalListSessions;
  __resetDirectoryRefreshSchedulerForTests();
  getPiSessionStore().clear();
  useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [] });
  useNotificationStore.setState({
    list: [],
    index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } },
  });
  useSessionPinnedStore.setState({ ids: new Set(), touchedAt: {} });
  resetSessionOrdering();
});

describe('buildMobileWidgetSnapshot', () => {
  test('reads the catalog directly, keeps pins/order/unread/max6/runtime stamp', async () => {
    piClient.listSessions = (async (scope: { directory?: string }) => {
      if (scope.directory === '/proj-a') {
        return {
          sessions: [
            item('s-1', '/proj-a', { updatedAt: 10 }),
            item('s-2', '/proj-a', { updatedAt: 20 }),
            item('s-3', '/proj-a', { updatedAt: 30 }),
            item('s-4', '/proj-a', { updatedAt: 40 }),
            item('s-5', '/proj-a', { updatedAt: 50 }),
            item('s-6', '/proj-a', { updatedAt: 60 }),
            item('child-1', '/proj-a', { updatedAt: 80, parentId: 's-1' }),
          ],
        };
      }
      return { sessions: [] };
    }) as typeof piClient.listSessions;

    await loadSessionCatalog(['/proj-a']);

    useProjectsStore.setState({
      projects: [{ id: 'p-a', path: '/proj-a', label: 'Alpha' }],
      activeProjectId: 'p-a',
      manualProjectOrder: [],
    });
    useNotificationStore.setState({
      list: [
        { type: 'turn-complete', session: 's-1', directory: '/proj-a', time: Date.now(), viewed: false },
        { type: 'turn-complete', session: 'child-1', directory: '/proj-a', time: Date.now(), viewed: false },
      ],
      index: {
        session: { unseenCount: { 's-1': 1, 'child-1': 1 }, unseenHasError: {} },
        project: { unseenCount: {}, unseenHasError: {} },
      },
    });
    const pinnedKey = getPinnedSessionKey(getRuntimeKey(), '/proj-a', 's-6');
    if (pinnedKey) {
      useSessionPinnedStore.setState({ ids: new Set([pinnedKey]), touchedAt: { [pinnedKey]: Date.now() } });
    }
    useSessionOrderingStore.setState({ rankById: new Map() });
    try {
      useUIStore.setState({ notifyOnSubtasks: false });
    } catch {
      // notifyOnSubtasks default already excludes subtask attention.
    }

    const snapshot = buildMobileWidgetSnapshot();

    expect(snapshot.runtimeKey).toBe(getRuntimeKey());
    // With subtask notifications muted, only the top-level unread counts;
    // the subtask row is excluded from both attention and the recent list.
    expect(snapshot.attentionCount).toBe(1);
    // Top-level only (child excluded), capped at 6, pinned first.
    expect(snapshot.recentSessions.length).toBe(6);
    expect(snapshot.recentSessions[0]?.id).toBe('s-6');
    expect(snapshot.recentSessions.some((s) => s.id === 'child-1')).toBe(false);
    const s1 = snapshot.recentSessions.find((s) => s.id === 's-1');
    expect(s1?.unread).toBe(true);
    expect(s1?.project).toBe('Alpha');
    expect(s1?.title).toBe('s-1');
  });

  test('stays synchronous and excludes archived rows', async () => {
    piClient.listSessions = (async () => ({
      sessions: [
        {
          session: { id: 'active-1', directory: '/proj-a', title: 'Active', createdAt: 1, updatedAt: 2 },
          updatedAt: 2,
        },
        {
          session: { id: 'archived-1', directory: '/proj-a', title: 'Archived', createdAt: 1, updatedAt: 2, archived: true, timeArchived: 5 },
          updatedAt: 2,
        },
      ],
    })) as typeof piClient.listSessions;

    await loadSessionCatalog(['/proj-a']);
    const snapshot = buildMobileWidgetSnapshot();
    expect(snapshot.recentSessions.map((s) => s.id)).toEqual(['active-1']);
    expect(snapshot.attentionCount).toBe(0);
  });
});
