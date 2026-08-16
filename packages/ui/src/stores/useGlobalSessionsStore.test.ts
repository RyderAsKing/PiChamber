/* eslint-disable */
// @ts-nocheck
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/chat/types';
import { piClient } from '@/lib/pi/client';

import {
  isGlobalSessionRecencyOnlyUpdate,
  resolveGlobalSessionDirectory,
  mergeLiveSessionWithGlobalSession,
  useGlobalSessionsStore,
} from './useGlobalSessionsStore';
import { useProjectsStore } from './useProjectsStore';
import { getPiSessionStore } from '@/apps/pi-session-store';

beforeEach(() => {
    // Reset the singleton's catalog so tests do not leak listSessions
    // results into one another. The global store reads from the catalog
    // via the dedup check; a stale `'ready'` from a prior test would skip
    // this test's listing.
    getPiSessionStore().clear();
});

type SessionExtra = Partial<Session> & {
  directory?: string | null;
  project?: { worktree?: string | null } | null;
};

const buildSession = (shareUrl: string, extra: SessionExtra = {}): Session => ({
  id: 'ses_1',
  title: 'Shared session',
  time: { created: 1, updated: 2 },
  share: { url: shareUrl },
  ...extra,
} as Session);

describe('useGlobalSessionsStore', () => {
  const originalListSessions = piClient.listSessions;

  beforeEach(() => {
    piClient.listSessions = originalListSessions;
    useProjectsStore.setState({ projects: [], activeProjectId: null });
    useGlobalSessionsStore.setState({
      activeSessions: [],
      archivedSessions: [],
      sessionsByDirectory: new Map(),
      hasLoaded: false,
      status: 'idle',
    });
  });

  afterEach(() => {
    piClient.listSessions = originalListSessions;
    useProjectsStore.setState({ projects: [], activeProjectId: null });
  });

  test('updates an existing session when the share URL changes', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a'));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b'));

    expect(useGlobalSessionsStore.getState().activeSessions[0]?.share?.url).toBe('https://share.example/b');
  });

  test('publishes an updated session when sharing is removed', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a'));
    const sharedSessions = useGlobalSessionsStore.getState().activeSessions;

    useGlobalSessionsStore.getState().upsertSession({
      ...buildSession('https://share.example/a'),
      share: undefined,
      time: { created: 1, updated: 3 },
    });

    const unsharedSessions = useGlobalSessionsStore.getState().activeSessions;
    expect(unsharedSessions).not.toBe(sharedSessions);
    expect(unsharedSessions[0]?.share).toBe(undefined);
  });

  test('preserves directory metadata when a live update omits it', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      time: { created: 1, updated: 3 },
    }));

    const session = useGlobalSessionsStore.getState().activeSessions[0];
    expect(resolveGlobalSessionDirectory(session)).toBe('/repo/app');
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app')?.[0]?.id).toBe('ses_1');
  });

  test('preserves raw directory metadata when a live update only has project worktree', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      project: { worktree: '/repo/app' },
      time: { created: 1, updated: 3 },
    }));

    const session = useGlobalSessionsStore.getState().activeSessions[0] as Session & { directory?: string | null };
    expect(session.directory).toBe('/repo/app');
    expect(resolveGlobalSessionDirectory(session)).toBe('/repo/app');
  });

  test('trusts explicit incoming raw directory metadata', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      directory: '/repo/app-worktree',
      time: { created: 1, updated: 3 },
    }));

    expect(resolveGlobalSessionDirectory(useGlobalSessionsStore.getState().activeSessions[0])).toBe('/repo/app-worktree');
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app')).toBe(undefined);
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/repo/app-worktree')?.[0]?.id).toBe('ses_1');
  });

  test('preserves directory metadata when moving a session to archived', () => {
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/a', { directory: '/repo/app' }));
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/b', {
      time: { created: 1, updated: 3, archived: 4 },
    }));

    expect(useGlobalSessionsStore.getState().activeSessions).toEqual([]);
    expect(resolveGlobalSessionDirectory(useGlobalSessionsStore.getState().archivedSessions[0])).toBe('/repo/app');
  });

  test('preserves the opposite session-list reference during an upsert', () => {
    const active = buildSession('https://share.example/active');
    const archived = buildSession('https://share.example/archived', {
      id: 'ses_archived',
      time: { created: 1, updated: 2, archived: 3 },
    });
    useGlobalSessionsStore.getState().applySnapshot([active], [archived]);

    const archivedSessions = useGlobalSessionsStore.getState().archivedSessions;
    useGlobalSessionsStore.getState().upsertSession(buildSession('https://share.example/active-updated', {
      time: { created: 1, updated: 3 },
    }));
    expect(useGlobalSessionsStore.getState().archivedSessions).toBe(archivedSessions);

    const activeSessions = useGlobalSessionsStore.getState().activeSessions;
    useGlobalSessionsStore.getState().upsertSession({
      ...archived,
      time: { created: 1, updated: 4, archived: 3 },
    });
    expect(useGlobalSessionsStore.getState().activeSessions).toBe(activeSessions);
  });

  test('preserves sessions from other projects while refreshing directory snapshots', async () => {
    const projectA = buildSession('https://share.example/a', { id: 'ses_a_old', directory: '/project-a' });
    const projectB = buildSession('https://share.example/b', { id: 'ses_b', directory: '/project-b' });
    useGlobalSessionsStore.getState().applySnapshot([projectA, projectB], []);

    piClient.listSessions = async ({ directory } = {}) => {
      if (directory === '/project-b') throw new Error('project B unavailable');
      return {
        sessions: [{
          session: { id: 'ses_a_new', directory: '/project-a', title: 'New A', createdAt: 3, updatedAt: 4 },
          updatedAt: 4,
        }],
      };
    };

    await useGlobalSessionsStore.getState().refreshSessionsForDirectories(['/project-a', '/project-b']);

    expect(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id).sort()).toEqual(['ses_a_new', 'ses_b']);
  });

  test('applies a batch of session upserts in one store publication', () => {
    let publications = 0;
    const unsubscribe = useGlobalSessionsStore.subscribe(() => {
      publications += 1;
    });

    useGlobalSessionsStore.getState().upsertSessions([
      buildSession('https://share.example/a'),
      buildSession('https://share.example/b', { id: 'ses_2' }),
    ]);

    unsubscribe();
    expect(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id)).toEqual(['ses_2', 'ses_1']);
    expect(publications).toBe(1);
  });

  test('loadSessions fetches sessions for all registered project directories', async () => {
    useProjectsStore.setState({
      projects: [
        { id: 'proj-a', path: '/project-a' },
        { id: 'proj-b', path: '/project-b' },
      ],
      activeProjectId: 'proj-a',
    });

    piClient.listSessions = async ({ directory } = {}) => {
      if (directory === '/project-a') {
        return {
          sessions: [{
            session: { id: 'ses_a_1', directory: '/project-a', title: 'Session A1', createdAt: 10, updatedAt: 20 },
            updatedAt: 20,
          }],
        };
      }
      if (directory === '/project-b') {
        return {
          sessions: [{
            session: { id: 'ses_b_1', directory: '/project-b', title: 'Session B1', createdAt: 15, updatedAt: 25 },
            updatedAt: 25,
          }],
        };
      }
      return { sessions: [] };
    };

    const result = await useGlobalSessionsStore.getState().loadSessions();

    expect(result.activeSessions.map((s) => s.id).sort()).toEqual(['ses_a_1', 'ses_b_1']);
    expect(useGlobalSessionsStore.getState().status).toBe('ready');
    expect(useGlobalSessionsStore.getState().hasLoaded).toBe(true);
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/project-a')?.[0]?.id).toBe('ses_a_1');
    expect(useGlobalSessionsStore.getState().sessionsByDirectory.get('/project-b')?.[0]?.id).toBe('ses_b_1');
  });

  test('loadSessions preserves successful project sessions when one project fails', async () => {
    useProjectsStore.setState({
      projects: [
        { id: 'proj-a', path: '/project-a' },
        { id: 'proj-b', path: '/project-b' },
      ],
      activeProjectId: 'proj-a',
    });

    piClient.listSessions = async ({ directory } = {}) => {
      if (directory === '/project-a') {
        return {
          sessions: [{
            session: { id: 'ses_a_1', directory: '/project-a', title: 'Session A1', createdAt: 10, updatedAt: 20 },
            updatedAt: 20,
          }],
        };
      }
      if (directory === '/project-b') {
        throw new Error('project B network error');
      }
      return { sessions: [] };
    };

    const result = await useGlobalSessionsStore.getState().loadSessions();

    expect(result.activeSessions.map((s) => s.id)).toEqual(['ses_a_1']);
    expect(useGlobalSessionsStore.getState().status).toBe('ready');
    expect(useGlobalSessionsStore.getState().hasLoaded).toBe(true);
  });

  test('syncFromPiStore does not throw when the Pi session store emits', async () => {
    // The crash hotfix: the global store used to call a removed
    // `piListItemToUiSession` here. A subsequent catalog emit would throw a
    // ReferenceError on every refresh. This test pins the safe path.
    useProjectsStore.setState({
      projects: [{ id: 'proj-a', path: '/repo-a' }],
      activeProjectId: 'proj-a',
    });
    const store = getPiSessionStore();
    // Seed the catalog with a single session so the focused directory's
    // listing is ready when the global store reads it.
    store.getState();
    await store.refreshDirectoryCatalog('/repo-a');
    // The session-store subscription is set up by the first loadSessions;
    // calling it once ensures the listener is attached.
    piClient.listSessions = async () => ({
      sessions: [{
        session: { id: 'ses_a_1', directory: '/repo-a', title: 'Session A1', createdAt: 10, updatedAt: 20 },
        updatedAt: 20,
      }],
    });
    await useGlobalSessionsStore.getState().loadSessions();
    // Now mutate the catalog \u2014 syncFromPiStore should not throw.
    expect(() => store.refreshDirectoryCatalog('/repo-a')).not.toThrow();
  });

  test('focusPending does not empty the global folder slice', async () => {
    useProjectsStore.setState({
      projects: [{ id: 'proj-a', path: '/repo-a' }],
      activeProjectId: 'proj-a',
    });
    piClient.listSessions = async ({ directory } = {}) => {
      if (directory === '/repo-a') {
        return {
          sessions: [{
            session: { id: 'ses_a_1', directory: '/repo-a', title: 'Session A1', createdAt: 10, updatedAt: 20 },
            updatedAt: 20,
          }],
        };
      }
      return { sessions: [] };
    };
    const first = await useGlobalSessionsStore.getState().loadSessions();
    expect(first.activeSessions.map((s) => s.id)).toEqual(['ses_a_1']);
    // A second call while no project-store change happened must not wipe the
    // existing slice, because the focused folder's catalog may already be
    // ready and the second call should be a no-op read.
    const second = await useGlobalSessionsStore.getState().loadSessions();
    expect(second.activeSessions.map((s) => s.id)).toEqual(['ses_a_1']);
  });
});

describe('mergeLiveSessionWithGlobalSession', () => {
  test('preserves global share over live share', () => {
    const live = buildSession('https://live.example/s', { time: { created: 1, updated: 5 } });
    const global = buildSession('https://global.example/s', { time: { created: 1, updated: 3 } });

    const merged = mergeLiveSessionWithGlobalSession(live, global);
    expect(merged.share?.url).toBe('https://global.example/s');
    expect(merged.time?.updated).toBe(5);
  });

  test('preserves directory from global when live omits it', () => {
    const live = buildSession('https://live.example/s', { time: { created: 1, updated: 5 } });
    const global = buildSession('https://global.example/s', { directory: '/repo/app' });

    const merged = mergeLiveSessionWithGlobalSession(live, global);
    expect(resolveGlobalSessionDirectory(merged)).toBe('/repo/app');
  });

  test('live directory takes precedence over global when present', () => {
    const live = buildSession('https://live.example/s', { directory: '/repo/worktree' });
    const global = buildSession('https://global.example/s', { directory: '/repo/app' });

    const merged = mergeLiveSessionWithGlobalSession(live, global);
    expect(resolveGlobalSessionDirectory(merged)).toBe('/repo/worktree');
  });
});

describe('isGlobalSessionRecencyOnlyUpdate', () => {
  test('accepts an updated timestamp while preserving omitted directory metadata', () => {
    const existing = buildSession('https://share.example/s', {
      directory: '/repo/app',
      time: { created: 1, updated: 2 },
    });
    const incoming = buildSession('https://share.example/s', {
      time: { created: 1, updated: 3 },
    });

    expect(isGlobalSessionRecencyOnlyUpdate(existing, incoming)).toBe(true);
  });

  test('rejects title and archive changes as structural updates', () => {
    const existing = buildSession('https://share.example/s', { time: { created: 1, updated: 2 } });
    const renamed = buildSession('https://share.example/s', {
      title: 'Renamed',
      time: { created: 1, updated: 3 },
    });
    const archived = buildSession('https://share.example/s', {
      time: { created: 1, updated: 3, archived: 4 },
    });

    expect(isGlobalSessionRecencyOnlyUpdate(existing, renamed)).toBe(false);
    expect(isGlobalSessionRecencyOnlyUpdate(existing, archived)).toBe(false);
  });

  test('rejects parent and slug changes as structural updates', () => {
    const existing = buildSession('https://share.example/s', {
      parentID: 'parent-a',
      slug: 'slug-a',
      time: { created: 1, updated: 2 },
    });
    const reparented = buildSession('https://share.example/s', {
      parentID: 'parent-b',
      slug: 'slug-a',
      time: { created: 1, updated: 3 },
    });
    const reslugged = buildSession('https://share.example/s', {
      parentID: 'parent-a',
      slug: 'slug-b',
      time: { created: 1, updated: 3 },
    });

    expect(isGlobalSessionRecencyOnlyUpdate(existing, reparented)).toBe(false);
    expect(isGlobalSessionRecencyOnlyUpdate(existing, reslugged)).toBe(false);
  });
});
