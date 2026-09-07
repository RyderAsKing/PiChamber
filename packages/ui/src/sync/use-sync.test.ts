import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, mock, test } from 'bun:test';

// Controllable Pi cluster fake: `selectedSessionId` drives the
// select/no-selection branches of the original `useSync` contract.
let selectedSessionId: string | null = null;
const selectCalls: string[] = [];
const hydrateCalls: string[] = [];

const fakeStore = {
  getState: () => ({ selectedSessionId }),
  select: mock(async (sessionId: string) => {
    selectCalls.push(sessionId);
  }),
  ensureHydrated: mock(async (sessionId: string) => {
    hydrateCalls.push(sessionId);
  }),
};

mock.module('@/apps/pi-session-store', () => ({
  getPiSessionStore: () => fakeStore,
}));

import { useSync } from './use-sync';

type SyncApi = ReturnType<typeof useSync>;
let captured: SyncApi | null = null;
function Probe() {
  captured = useSync();
  return null;
}

const roots: Root[] = [];
const restores: Array<() => void> = [];

function installMinimalDom() {
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
  setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return () => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

async function renderSync(): Promise<SyncApi> {
  captured = null;
  const restore = installMinimalDom();
  restores.push(restore);
  const container = (globalThis as unknown as { document: { body: Element } }).document.body;
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(Probe));
  });
  if (!captured) throw new Error('useSync did not render');
  return captured;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  for (const restore of restores.splice(0)) restore();
  selectedSessionId = null;
  selectCalls.length = 0;
  hydrateCalls.length = 0;
});

describe('useSync original select contract', () => {
  test('syncSession selects when the id differs and never hydrates', async () => {
    selectedSessionId = 'other';
    const sync = await renderSync();
    await sync.syncSession('s1');
    expect(selectCalls).toEqual(['s1']);
    expect(hydrateCalls).toEqual([]);
  });

  test('syncSession does nothing when the id is already selected', async () => {
    selectedSessionId = 's1';
    const sync = await renderSync();
    await sync.syncSession('s1');
    expect(selectCalls).toEqual([]);
    expect(hydrateCalls).toEqual([]);
  });

  test('syncSession noops on empty id', async () => {
    selectedSessionId = 'other';
    const sync = await renderSync();
    await sync.syncSession('');
    expect(selectCalls).toEqual([]);
    expect(hydrateCalls).toEqual([]);
  });

  test('ensureSessionRenderable selects when the id differs without hydrating', async () => {
    selectedSessionId = 'other';
    const sync = await renderSync();
    await sync.ensureSessionRenderable('s1');
    expect(selectCalls).toEqual(['s1']);
    expect(hydrateCalls).toEqual([]);
  });

  test('ensureSessionRenderable hydrates without reselecting when already selected', async () => {
    selectedSessionId = 's1';
    const sync = await renderSync();
    await sync.ensureSessionRenderable('s1');
    expect(selectCalls).toEqual([]);
    expect(hydrateCalls).toEqual(['s1']);
  });

  test('ensureSessionRenderable noops on empty id', async () => {
    selectedSessionId = 's1';
    const sync = await renderSync();
    await sync.ensureSessionRenderable('');
    expect(selectCalls).toEqual([]);
    expect(hydrateCalls).toEqual([]);
  });
});
