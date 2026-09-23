import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'bun:test';

import { getPiSessionStore } from '@/apps/pi-session-store';
import { piClient } from '@/lib/pi/client';
import { useSessionMessageRecords } from '@/sync/sync-context';

// The records the chat renders for a session opened while its turn is still
// streaming. Store state alone is not enough: the live-tail freeze reuses
// published records, so a record projected before the assistant was marked
// streaming must not survive as "completed" (Worked for 0.1s + footer).

const EPOCH = 'epoch-1';
const DIR = '/repo';

const installMinimalDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  class ElementStub {}
  const documentStub: Record<string, unknown> = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const container = {
    nodeType: 1,
    tagName: 'DIV',
    nodeName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentStub,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  documentStub.documentElement = container;
  documentStub.body = container;
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('location', { protocol: 'http:', hostname: 'localhost', search: '', origin: 'http://localhost', href: 'http://localhost/' });
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return {
    container: container as unknown as Element,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const busyDetail = () => ({
  session: { id: 'live', directory: DIR, createdAt: 1, updatedAt: 1 },
  messages: [
    { message: { id: 'u1', sessionId: 'live', directory: DIR, role: 'user', createdAt: 1000, text: 'hello' }, parts: [] },
    {
      message: { id: 'a1', sessionId: 'live', directory: DIR, role: 'assistant', parentId: 'u1', createdAt: 1100, text: 'word1 word2' },
      parts: [{ id: 'a1:text:0', index: 0, type: 'text', text: 'word1 word2' }],
    },
  ],
  lastSequence: 40,
  isStreaming: true,
  lifecycle: 'busy',
  runStartedAt: Date.now() - 5_000,
  serverNow: Date.now(),
  streamEpoch: EPOCH,
});

const originals = {
  selectProject: piClient.selectProject.bind(piClient),
  listSessions: piClient.listSessions.bind(piClient),
  getSession: piClient.getSession.bind(piClient),
  health: piClient.health.bind(piClient),
};

const frame = (name: string, sequence: number, payload: Record<string, unknown>) => ({
  protocolVersion: 1, kind: 'event', name, sequence, sessionId: 'live', directory: DIR, streamEpoch: EPOCH, payload,
});

let latest: ReturnType<typeof useSessionMessageRecords> = [];
const Probe = () => {
  latest = useSessionMessageRecords('live', DIR);
  return null;
};

const roots: Root[] = [];
const restores: Array<() => void> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  getPiSessionStore().dispose();
  restores.splice(0).forEach((restore) => restore());
  Object.assign(piClient, originals);
  latest = [];
});

const assistantRecord = () => latest.find((record) => record.info.id === 'a1')?.info as {
  time?: { completed?: number };
  finish?: string;
} | undefined;

describe('records rendered for a session opened mid-turn', () => {
  test('the in-flight assistant is not rendered as completed through attach and live deltas', async () => {
    piClient.selectProject = (async (directory: string) => ({ directory })) as typeof piClient.selectProject;
    piClient.listSessions = (async () => ({
      streamEpoch: EPOCH,
      sessions: [{ session: { id: 'live', directory: DIR, createdAt: 1, updatedAt: 1 }, updatedAt: 1, live: { lifecycle: 'busy', sequence: 39 } }],
    })) as unknown as typeof piClient.listSessions;
    piClient.getSession = (async () => busyDetail()) as unknown as typeof piClient.getSession;
    piClient.health = (async () => ({ state: 'ready', protocolVersion: 1, capabilities: ['events.streamEpoch'], streamEpoch: EPOCH })) as typeof piClient.health;

    const dom = installMinimalDom();
    restores.push(dom.restore);
    const root = createRoot(dom.container);
    roots.push(root);
    await act(async () => root.render(<Probe />));

    const store = getPiSessionStore();
    await act(async () => {
      await store.start({ directory: DIR, sessionId: 'live' });
    });
    expect(store.getState().reducer.bySession.get('live')?.messages.get('a1')?.streaming).toBe(true);
    expect(assistantRecord()?.time?.completed).toBeUndefined();

    const commit = (events: unknown[]) => (store as unknown as { commitEvents: (events: unknown[]) => void }).commitEvents(events);
    await act(async () => {
      commit([frame('session.snapshot', 41, { snapshot: { sessionId: 'live', directory: DIR, isStreaming: true, lifecycle: 'busy', queue: { steering: 0, followUp: 0 }, lastText: 'word1 word2', lastSequence: 41, serverNow: Date.now() } })]);
    });
    expect(assistantRecord()?.time?.completed).toBeUndefined();
    await act(async () => {
      commit([frame('assistant.message.delta', 42, { messageId: 'a1', contentIndex: 0, delta: ' word3', partId: 'a1:text:0' })]);
    });
    expect(assistantRecord()?.time?.completed).toBeUndefined();
    expect(assistantRecord()?.finish).toBeUndefined();
  });
});
