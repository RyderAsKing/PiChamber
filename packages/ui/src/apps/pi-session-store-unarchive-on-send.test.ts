import { describe, expect, test } from 'bun:test';

import { PiSessionStore } from '@/apps/pi-session-store';
import { PiRequestError, PiSendUnconfirmedError, piClient } from '@/lib/pi/client';
import { createReducerPartMap, type PiReducerSessionState } from '@/lib/pi/event-reducer';
import type { PiSessionEvent } from '@/lib/pi/protocol';
import { initialCatalog, type LiveSessionRecord } from '@/sync/pi-session-catalog';

// Sending to an archived session unarchives it: the server clears the mark
// when it accepts the send, this client clears it optimistically, and other
// clients re-list the session's folder after they see the send.

const waitFor = async (predicate: () => boolean, timeoutMs = 500): Promise<boolean> => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return true;
};

const DIRECTORY = '/repo-a';

const record = (id: string, archived: boolean): LiveSessionRecord => ({
  id,
  directory: DIRECTORY,
  parentId: null,
  title: id,
  archived,
  createdAt: 1,
  updatedAt: 2,
  lifecycle: 'idle',
  hydrated: true,
});

const reducerSession = (sessionId: string): PiReducerSessionState => ({
  sessionId,
  directory: DIRECTORY,
  lastSequence: 1,
  lifecycle: 'idle',
  messages: new Map([['m0', { id: 'm0', role: 'user' } as never]]),
  partOrder: new Map(),
  parts: createReducerPartMap(),
  toolsByCallId: new Map(),
  streamingMessages: new Set(),
  extensionStatuses: new Map(),
  extensionWidgets: new Map(),
  extensionDialogs: [],
  extensionNotices: [],
  extensionErrors: [],
  extensionPanels: new Map(),
  extensionApps: new Map(),
  queue: { steering: 0, followUp: 0 },
});

interface StoreInternal {
  state: ReturnType<PiSessionStore['getState']>;
  stream: { dispose: () => void } | null;
  hydratedSessionIds: Set<string>;
  remoteSendRefreshDelayMs: number;
  commitEvents: (events: PiSessionEvent[]) => void;
}

const internal = (store: PiSessionStore): StoreInternal => store as unknown as StoreInternal;

const seed = (store: PiSessionStore, archived: Record<string, boolean>) => {
  const ids = Object.keys(archived);
  internal(store).stream = { dispose: () => undefined };
  internal(store).remoteSendRefreshDelayMs = 5;
  for (const id of ids) internal(store).hydratedSessionIds.add(id);
  internal(store).state = {
    ...store.getState(),
    directory: DIRECTORY,
    connection: 'ready' as const,
    sessions: ids.map((id) => ({ session: { id, directory: DIRECTORY, title: id, createdAt: 1, updatedAt: 1, archived: archived[id] } }) as never),
    selectedSessionId: ids[0] ?? null,
    reducer: {
      ...store.getState().reducer,
      bySession: new Map(ids.map((id) => [id, reducerSession(id)])),
    },
    catalog: {
      ...initialCatalog(),
      byId: new Map(ids.map((id) => [id, record(id, archived[id])])),
      byDirectory: new Map([[DIRECTORY, ids]]),
      listStatusByDirectory: new Map([[DIRECTORY, 'ready' as const]]),
    },
  };
};

const isArchived = (store: PiSessionStore, id: string) => store.getState().catalog.byId.get(id)?.archived;

type Stubs = Partial<Pick<typeof piClient, 'sendPrompt' | 'runBash' | 'listSessions'>>;

const withStore = async (stubs: Stubs, run: (store: PiSessionStore) => Promise<void>) => {
  const originals = { sendPrompt: piClient.sendPrompt, runBash: piClient.runBash, listSessions: piClient.listSessions };
  Object.assign(piClient, stubs);
  const store = new PiSessionStore();
  try {
    await run(store);
  } finally {
    Object.assign(piClient, originals);
    store.dispose();
  }
};

const listItem = (id: string, archived: boolean) => ({
  session: { id, directory: DIRECTORY, title: id, createdAt: 1, updatedAt: 2, parentId: null, archived },
  updatedAt: 2,
});

const event = (sessionId: string, name: 'assistant.message.start' | 'session.bash', sequence = 5): PiSessionEvent => (
  name === 'assistant.message.start'
    ? { protocolVersion: 1, kind: 'event', name, sequence, sessionId, directory: DIRECTORY, payload: { messageId: `m-${sequence}`, role: 'user', startedAt: sequence } }
    : { protocolVersion: 1, kind: 'event', name, sequence, sessionId, directory: DIRECTORY, payload: { bash: { id: 'b1', command: 'ls', status: 'running' } } }
) as PiSessionEvent;

describe('unarchive on send', () => {
  test('a prompt clears the archived mark before the send answers and keeps it cleared', async () => {
    let release!: () => void;
    const answered = new Promise<void>((resolve) => { release = resolve; });
    await withStore({
      sendPrompt: (async () => { await answered; return { accepted: true, messageId: 'msg_1' }; }) as typeof piClient.sendPrompt,
    }, async (store) => {
      seed(store, { s1: true });
      const sending = store.prompt('s1', 'hello', 'prompt');
      expect(await waitFor(() => isArchived(store, 's1') === false)).toBe(true);
      expect(store.getState().sessions.find((item) => item.session.id === 's1')?.session.archived).toBe(false);
      release();
      await sending;
      expect(isArchived(store, 's1')).toBe(false);
    });
  });

  test('a definite rejection puts the archived mark back', async () => {
    await withStore({
      sendPrompt: (async () => { throw new PiRequestError('INVALID_SESSION', 'gone', 404); }) as typeof piClient.sendPrompt,
    }, async (store) => {
      seed(store, { s1: true });
      await expect(store.prompt('s1', 'hello', 'prompt')).rejects.toBeInstanceOf(PiRequestError);
      expect(isArchived(store, 's1')).toBe(true);
    });
  });

  test('an unconfirmed send asks the server instead of guessing', async () => {
    const listed: Array<string | undefined> = [];
    await withStore({
      sendPrompt: (async () => { throw new PiSendUnconfirmedError('DAEMON_TIMEOUT', 'timed out'); }) as typeof piClient.sendPrompt,
      listSessions: (async (scope?: { directory?: string }) => {
        listed.push(scope?.directory);
        return { sessions: [listItem('s1', true)] };
      }) as typeof piClient.listSessions,
    }, async (store) => {
      seed(store, { s1: true });
      await expect(store.prompt('s1', 'hello', 'prompt')).rejects.toBeInstanceOf(PiSendUnconfirmedError);
      expect(await waitFor(() => isArchived(store, 's1') === true)).toBe(true);
      expect(listed).toContain(DIRECTORY);
    });
  });

  test('a shell command unarchives the same way, and rolls back on rejection', async () => {
    let reject = false;
    await withStore({
      runBash: (async () => {
        if (reject) throw new PiRequestError('INVALID_ARGUMENT', 'bad', 400);
        return { id: 'b1' };
      }) as typeof piClient.runBash,
    }, async (store) => {
      seed(store, { s1: true, s2: true });
      await store.runBash('s1', 'ls');
      expect(isArchived(store, 's1')).toBe(false);
      reject = true;
      await expect(store.runBash('s2', 'ls')).rejects.toBeInstanceOf(PiRequestError);
      expect(isArchived(store, 's2')).toBe(true);
    });
  });

  test('another client re-lists the folder after a send to an archived session', async () => {
    const listed: Array<string | undefined> = [];
    await withStore({
      listSessions: (async (scope?: { directory?: string }) => {
        listed.push(scope?.directory);
        return { sessions: [listItem('s1', false), listItem('s2', false), listItem('s3', false)] };
      }) as typeof piClient.listSessions,
    }, async (other) => {
      seed(other, { s1: true, s2: true, s3: false });
      internal(other).commitEvents([event('s1', 'assistant.message.start', 5), event('s2', 'session.bash', 6)]);
      expect(await waitFor(() => isArchived(other, 's1') === false && isArchived(other, 's2') === false)).toBe(true);
      // Both sends coalesce into one re-list of their folder.
      expect(listed).toEqual([DIRECTORY]);

      // A send to a session that is not archived does not re-list.
      internal(other).commitEvents([event('s3', 'assistant.message.start', 7)]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(listed).toEqual([DIRECTORY]);
    });
  });
});
