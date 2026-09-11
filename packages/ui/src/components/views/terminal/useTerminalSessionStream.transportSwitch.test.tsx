import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'bun:test';

import { useTerminalStore } from '@/stores/useTerminalStore';
import type { TerminalAPI, TerminalHandlers, TerminalStreamEvent } from '@/lib/api/types';
import { getTerminalTransportGeneration, resetTerminalTransport } from '@/lib/terminalApi';

const { useTerminalSessionStream } = await import('./useTerminalSessionStream');
const { useTerminalInputHandling } = await import('./useTerminalInputHandling');

type StreamProps = Parameters<typeof useTerminalSessionStream>[0];
type StreamResult = ReturnType<typeof useTerminalSessionStream>;

let latest: StreamResult | null = null;
const Probe = (props: StreamProps) => {
  latest = useTerminalSessionStream(props);
  return null;
};

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
    hasFocus: () => true,
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

const roots: Root[] = [];
const restoreFns: Array<() => void> = [];

const renderStream = async (props: StreamProps) => {
  const dom = installMinimalDom();
  restoreFns.push(dom.restore);
  const root = createRoot(dom.container);
  roots.push(root);
  await act(async () => {
    root.render(<Probe {...props} />);
  });
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  restoreFns.splice(0).forEach((restore) => restore());
  latest = null;
  useTerminalStore.getState().clearAll();
});

type FakeConnection = {
  sessionId: string;
  handlers: TerminalHandlers;
  closed: boolean;
};

const createFakeTerminal = (options: { autoSnapshot?: boolean } = {}) => {
  const autoSnapshot = options.autoSnapshot ?? true;
  const connections: FakeConnection[] = [];
  const created: Array<{ cwd: string }> = [];
  const resized: Array<{ sessionId: string; cols: number; rows: number }> = [];
  const terminal: TerminalAPI = {
    async createSession(options) {
      created.push({ cwd: options.cwd });
      return { sessionId: `created-${created.length}`, cols: 80, rows: 24, status: 'running' };
    },
    connect(sessionId, handlers) {
      const conn: FakeConnection = { sessionId, handlers, closed: false };
      connections.push(conn);
      // Authoritative snapshot on attach (same PTY, same history).
      if (autoSnapshot) {
        queueMicrotask(() => {
          if (!conn.closed) handlers.onEvent({ type: 'snapshot', sequence: 10, data: 'prompt$ ', status: 'running' });
        });
      }
      return { close: () => { conn.closed = true; } };
    },
    async sendInput() {},
    async resize(payload) { resized.push(payload); },
    async close() {},
  };
  const connectsFor = (id: string) => connections.filter((c) => c.sessionId === id);
  const emit = (sessionId: string, event: TerminalStreamEvent) => {
    for (const conn of connectsFor(sessionId)) {
      if (!conn.closed) conn.handlers.onEvent(event);
    }
  };
  return { terminal, connections, created, resized, connectsFor, emit };
};

const appearanceRef = () => ({ current: { themeMode: 'dark' as const, terminalBackground: '', terminalForeground: '' } });

const setupTwoTabs = () => {
  const store = useTerminalStore.getState();
  store.clearAll();
  store.ensureDirectory('/repo');
  const first = store.getDirectoryState('/repo')!.tabs[0]!.id;
  const second = store.createTab('/repo');
  useTerminalStore.getState().setTabSessionId('/repo', first, 'pty-a');
  useTerminalStore.getState().setTabSessionId('/repo', second, 'pty-b');
  useTerminalStore.getState().appendToBuffer('/repo', first, 'prompt$ ', 10);
  useTerminalStore.getState().appendToBuffer('/repo', second, 'prompt$ ', 10);
  return { first, second };
};

const streamProps = (fake: ReturnType<typeof createFakeTerminal>, tabs: Array<{ id: string; terminalSessionId: string | null; label: string }>, overrides: Partial<StreamProps> = {}): StreamProps => ({
  terminal: fake.terminal,
  effectiveDirectory: '/repo',
  activeTabId: tabs[0]!.id,
  terminalSessionId: tabs[0]!.terminalSessionId,
  terminalLifecycle: 'running',
  hasOpenedTerminalViewport: true,
  terminalHydrated: true,
  terminalShell: 'auto',
  terminalLoginShell: false,
  terminalAppearanceRef: appearanceRef(),
  enableTabs: true,
  hasActiveContext: true,
  focusTerminalWhenWindowActive: () => {},
  tabs,
  ...overrides,
});

describe('useTerminalSessionStream transport switch', () => {
  test('mounted multiple tabs reattach same PTYs exactly once, preserving scrollback/dims', async () => {
    const fake = createFakeTerminal();
    const { first, second } = setupTwoTabs();
    const tabs = [
      { id: first, terminalSessionId: 'pty-a', label: 'Terminal' },
      { id: second, terminalSessionId: 'pty-b', label: 'Terminal 2' },
    ];
    await renderStream(streamProps(fake, tabs));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(fake.connectsFor('pty-a')).toHaveLength(1);
    expect(fake.connectsFor('pty-b')).toHaveLength(1);
    expect(fake.created).toHaveLength(0);

    const bufferBeforeA = useTerminalStore.getState().getBuffer('/repo', first);
    latest!.lastViewportSizeRef.current = { cols: 100, rows: 30 };

    const generationBefore = getTerminalTransportGeneration();
    await act(async () => { resetTerminalTransport(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(getTerminalTransportGeneration()).toBe(generationBefore + 1);
    // Exactly one reattach per PTY, same IDs, no new PTY creation.
    expect(fake.connectsFor('pty-a')).toHaveLength(2);
    expect(fake.connectsFor('pty-b')).toHaveLength(2);
    expect(fake.created).toHaveLength(0);
    // Tab IDs preserved, scrollback not duplicated (snapshot sequence 10 deduped).
    const bufferAfterA = useTerminalStore.getState().getBuffer('/repo', first);
    expect(bufferAfterA.lastSequence).toBe(10);
    expect(bufferAfterA.chunks.map((c) => c.data).join('')).toBe(bufferBeforeA.chunks.map((c) => c.data).join(''));
    // Dims preserved and re-asserted on the reattached PTYs.
    expect(latest!.lastViewportSizeRef.current).toEqual({ cols: 100, rows: 30 });
    expect(fake.resized.filter((r) => r.sessionId === 'pty-a' || r.sessionId === 'pty-b').length).toBeGreaterThanOrEqual(2);
    // Reconnect pending cleared by the active tab snapshot.
    expect(latest!.isReconnectPending).toBe(false);
  });

  test('old late events after replacement are rejected', async () => {
    const fake = createFakeTerminal();
    const { first } = setupTwoTabs();
    const tabs = [
      { id: first, terminalSessionId: 'pty-a', label: 'Terminal' },
      { id: useTerminalStore.getState().getDirectoryState('/repo')!.tabs[1]!.id, terminalSessionId: 'pty-b', label: 'Terminal 2' },
    ];
    await renderStream(streamProps(fake, tabs));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const oldConns = [...fake.connections];
    await act(async () => { resetTerminalTransport(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const bufferBefore = useTerminalStore.getState().getBuffer('/repo', first).chunks.map((c) => c.data).join('');
    // Late data on the old generation must not append.
    await act(async () => {
      for (const conn of oldConns) {
        if (conn.sessionId === 'pty-a') conn.handlers.onEvent({ type: 'data', sequence: 99, data: 'STALE' });
      }
    });
    const bufferAfter = useTerminalStore.getState().getBuffer('/repo', first).chunks.map((c) => c.data).join('');
    expect(bufferAfter).toBe(bufferBefore);
    expect(bufferAfter).not.toContain('STALE');
  });

  test('different runtime same ID never attaches old PTYs', async () => {
    const fake = createFakeTerminal();
    const { first } = setupTwoTabs();
    const tabs = [{ id: first, terminalSessionId: 'pty-a', label: 'Terminal' }];
    await renderStream(streamProps(fake, tabs));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(fake.connectsFor('pty-a')).toHaveLength(1);

    // Different-runtime reset clears the store; the hook must not reattach old IDs.
    await act(async () => {
      useTerminalStore.getState().clearAll();
      resetTerminalTransport();
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    // No additional attach for the old ID after the store was cleared.
    expect(fake.connectsFor('pty-a')).toHaveLength(1);
  });

  test('no resize on stale/unowned tabs during a different-runtime switch', async () => {
    const fake = createFakeTerminal();
    const { first, second } = setupTwoTabs();
    const tabs = [
      { id: first, terminalSessionId: 'pty-a', label: 'Terminal' },
      { id: second, terminalSessionId: 'pty-b', label: 'Terminal 2' },
    ];
    await renderStream(streamProps(fake, tabs));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(fake.connectsFor('pty-a')).toHaveLength(1);
    expect(fake.connectsFor('pty-b')).toHaveLength(1);
    // Viewport dims are known, so the reattach path would resize owned PTYs.
    latest!.lastViewportSizeRef.current = { cols: 100, rows: 30 };
    fake.resized.length = 0;

    // Stale close/reassign raced the switch: the store no longer owns pty-b
    // while the hook props (tabsRef) still hold it. Only the owned PTY may
    // reattach and resize; the stale ID must never reach the new transport.
    await act(async () => {
      useTerminalStore.getState().setTabSessionId('/repo', second, null);
    });
    await act(async () => { resetTerminalTransport(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(fake.connectsFor('pty-a')).toHaveLength(2);
    expect(fake.connectsFor('pty-b')).toHaveLength(1);
    expect(fake.resized.filter((r) => r.sessionId === 'pty-a')).toHaveLength(1);
    expect(fake.resized.filter((r) => r.sessionId === 'pty-b')).toHaveLength(0);

    // Different-runtime switch with a stale tabsRef: clearAll() runs before
    // the synchronous generation bump without a re-render, so tabsRef still
    // holds the old IDs. No old PTY may be resized on the new runtime.
    fake.resized.length = 0;
    const connectsBefore = fake.connections.length;
    await act(async () => {
      useTerminalStore.getState().clearAll();
      resetTerminalTransport();
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(fake.connections.length).toBe(connectsBefore);
    expect(fake.resized).toHaveLength(0);
  });

  test('unmount cleans up generation listeners; no reattach after unmount', async () => {
    const fake = createFakeTerminal();
    const { first, second } = setupTwoTabs();
    const tabs = [
      { id: first, terminalSessionId: 'pty-a', label: 'Terminal' },
      { id: second, terminalSessionId: 'pty-b', label: 'Terminal 2' },
    ];
    await renderStream(streamProps(fake, tabs));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(fake.connections).toHaveLength(2);
    for (const root of roots.splice(0)) {
      await act(async () => root.unmount());
    }
    restoreFns.splice(0).forEach((restore) => restore());
    latest = null;
    await act(async () => { resetTerminalTransport(); });
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.connections).toHaveLength(2);
  });

  test('reattach raises pending until the fresh snapshot arrives (input gate window)', async () => {
    // Manual snapshots so the test can observe the pending window before the
    // fresh snapshot clears it. Auto snapshots would flush inside act and
    // hide the synchronous pending=true set by the generation handler.
    const fake = createFakeTerminal({ autoSnapshot: false });
    const { first, second } = setupTwoTabs();
    const tabs = [
      { id: first, terminalSessionId: 'pty-a', label: 'Terminal' },
      { id: second, terminalSessionId: 'pty-b', label: 'Terminal 2' },
    ];
    await renderStream(streamProps(fake, tabs));
    await act(async () => {
      fake.emit('pty-a', { type: 'snapshot', sequence: 10, data: 'prompt$ ', status: 'running' });
      fake.emit('pty-b', { type: 'snapshot', sequence: 10, data: 'prompt$ ', status: 'running' });
    });
    expect(latest!.isReconnectPending).toBe(false);
    // Reset raises pending synchronously; the fresh snapshot clears it.
    // Input typed in this window must be dropped, never replayed (the
    // viewport input handler early-returns while pending, and the transport
    // write guard rejects writes straddling the generation bump).
    // Render without awaiting the snapshot flush: act without the 10ms wait
    // keeps the manual snapshot from arriving, so pending stays observable.
    await act(async () => { resetTerminalTransport(); });
    expect(latest!.isReconnectPending).toBe(true);
    await act(async () => {
      fake.emit('pty-a', { type: 'snapshot', sequence: 10, data: 'prompt$ ', status: 'running' });
      fake.emit('pty-b', { type: 'snapshot', sequence: 10, data: 'prompt$ ', status: 'running' });
    });
    expect(latest!.isReconnectPending).toBe(false);
    expect(fake.connectsFor('pty-a')).toHaveLength(2);
    expect(fake.connectsFor('pty-b')).toHaveLength(2);
  });

  test('old late snapshot/open and reconnecting/backoff are rejected after replacement', async () => {
    const fake = createFakeTerminal();
    const { first } = setupTwoTabs();
    const tabs = [
      { id: first, terminalSessionId: 'pty-a', label: 'Terminal' },
      { id: useTerminalStore.getState().getDirectoryState('/repo')!.tabs[1]!.id, terminalSessionId: 'pty-b', label: 'Terminal 2' },
    ];
    await renderStream(streamProps(fake, tabs));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    const oldConns = [...fake.connections];
    const bufferBefore = useTerminalStore.getState().getBuffer('/repo', first).chunks.map((c) => c.data).join('');
    await act(async () => { resetTerminalTransport(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    // Fresh snapshot arrived and cleared pending.
    expect(latest!.isReconnectPending).toBe(false);
    // Old late snapshot/open with a newer sequence must not overwrite.
    await act(async () => {
      for (const conn of oldConns) {
        if (conn.sessionId === 'pty-a') conn.handlers.onEvent({ type: 'snapshot', sequence: 99, data: 'STALE-SNAPSHOT', status: 'running' });
      }
    });
    const afterStaleSnapshot = useTerminalStore.getState().getBuffer('/repo', first).chunks.map((c) => c.data).join('');
    expect(afterStaleSnapshot).toBe(bufferBefore);
    expect(afterStaleSnapshot).not.toContain('STALE-SNAPSHOT');
    // Old late reconnecting/backoff must not raise pending after it cleared.
    await act(async () => {
      for (const conn of oldConns) {
        if (conn.sessionId === 'pty-a') conn.handlers.onEvent({ type: 'reconnecting', attempt: 7, maxAttempts: Number.POSITIVE_INFINITY });
      }
    });
    expect(latest!.isReconnectPending).toBe(false);
    // Old late non-fatal error must not surface.
    await act(async () => {
      for (const conn of oldConns) {
        if (conn.sessionId === 'pty-a') conn.handlers.onError?.(Object.assign(new Error('stale'), { code: 'STALE' }), false);
      }
    });
    expect(latest!.isReconnectPending).toBe(false);
  });

  test('ordinary reconnect still works after a switch (later reconnect)', async () => {
    const fake = createFakeTerminal();
    const { first, second } = setupTwoTabs();
    const tabs = [
      { id: first, terminalSessionId: 'pty-a', label: 'Terminal' },
      { id: second, terminalSessionId: 'pty-b', label: 'Terminal 2' },
    ];
    await renderStream(streamProps(fake, tabs));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    await act(async () => { resetTerminalTransport(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(latest!.isReconnectPending).toBe(false);
    const attachesBefore = fake.connectsFor('pty-a').length + fake.connectsFor('pty-b').length;
    // Later ordinary reconnect on the CURRENT generation still signals pending
    // (hidden/offline backoff lives in the transport; the hook surfaces it).
    await act(async () => {
      fake.emit('pty-a', { type: 'reconnecting', attempt: 1, maxAttempts: Number.POSITIVE_INFINITY });
    });
    expect(latest!.isReconnectPending).toBe(true);
    await act(async () => {
      fake.emit('pty-a', { type: 'snapshot', sequence: 10, data: 'prompt$ ', status: 'running' });
    });
    expect(latest!.isReconnectPending).toBe(false);
    // No extra PTY creation or reattach from the later reconnect.
    expect(fake.created).toHaveLength(0);
    expect(fake.connectsFor('pty-a').length + fake.connectsFor('pty-b').length).toBe(attachesBefore);
    // Scrollback still deduped by sequence after the later cycle.
    const buffer = useTerminalStore.getState().getBuffer('/repo', first).chunks.map((c) => c.data).join('');
    expect(buffer).toBe('prompt$ ');
  });

  test('input is dropped while reattach pending, sent after snapshot (no replay)', async () => {
    const sent: Array<{ sessionId: string; data: string }> = [];
    const fakeTerminal = {
      async createSession() { throw new Error('unreachable'); },
      connect() { return { close: () => {} }; },
      async sendInput(sessionId: string, data: string) { sent.push({ sessionId, data }); },
      async resize() {},
      async close() {},
    } as unknown as TerminalAPI;
    let latestInput: ReturnType<typeof useTerminalInputHandling> | null = null;
    const InputProbe = ({ pending }: { pending: boolean }) => {
      const terminalIdRef = React.useRef<string | null>('pty-a');
      const lastViewportSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);
      const [, setError] = React.useState<string | null>(null);
      latestInput = useTerminalInputHandling({
        terminal: fakeTerminal,
        terminalIdRef,
        isReconnectPending: pending,
        setConnectionError: setError,
        showQuickKeys: false,
        isTerminalVisible: true,
        lastViewportSizeRef,
        terminalSessionId: 'pty-a',
        useTouchTerminalInput: false,
      });
      return null;
    };
    const dom = installMinimalDom();
    restoreFns.push(dom.restore);
    const root = createRoot(dom.container);
    roots.push(root);
    await act(async () => { root.render(<InputProbe pending />); });
    latestInput!.handleViewportInput('typed-during-gap');
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(sent).toHaveLength(0);
    // After the fresh snapshot clears pending, the same input sends once.
    await act(async () => { root.render(<InputProbe pending={false} />); });
    latestInput!.handleViewportInput('typed-after-snapshot');
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(sent).toEqual([{ sessionId: 'pty-a', data: 'typed-after-snapshot' }]);
  });

  test('ambiguous tabs without session IDs never connect', async () => {
    const fake = createFakeTerminal();
    useTerminalStore.getState().clearAll();
    useTerminalStore.getState().ensureDirectory('/repo');
    const tabId = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!.id;
    const tabs = [{ id: tabId, terminalSessionId: null, label: 'Terminal' }];
    await renderStream(streamProps(fake, tabs));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(fake.connections).toHaveLength(0);
  });
});
