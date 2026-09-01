import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, mock, test } from 'bun:test';

let piState = {
  selectedSessionId: null as string | null,
  directory: 'C:\\repo' as string | null,
  connection: 'ready' as const,
  focusPending: false,
};
const piListeners = new Set<() => void>();
const piStore = {
  getState: () => piState,
  subscribe: (listener: () => void) => {
    piListeners.add(listener);
    return () => piListeners.delete(listener);
  },
};

let currentDirectory = 'C:/repo';
let setDirectoryCalls = 0;
const setDirectory = (directory: string) => {
  setDirectoryCalls += 1;
  currentDirectory = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  piState = {
    ...piState,
    directory: piState.directory === 'C:\\repo' ? 'C:/repo/' : 'C:\\repo',
  };
  piListeners.forEach((listener) => listener());
};

const configState = {
  initializeApp: async () => undefined,
  isInitialized: true,
  isConnected: true,
  loadProviders: async () => undefined,
  providers: [{}],
  activateDirectory: async () => undefined,
};
const useConfigStore = Object.assign(
  (selector: (state: typeof configState) => unknown) => selector(configState),
  { getState: () => configState },
);

mock.module('@/hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: () => undefined }));
mock.module('@/hooks/usePwaManifestSync', () => ({ usePwaManifestSync: () => undefined }));
mock.module('@/hooks/useQueuedMessageAutoSend', () => ({ useQueuedMessageAutoSend: () => undefined }));
mock.module('@/hooks/useSessionAutoCleanup', () => ({ useSessionAutoCleanup: () => undefined }));
mock.module('@/hooks/useWindowControlsOverlayLayout', () => ({ useWindowControlsOverlayLayout: () => undefined }));
mock.module('@/sync/session-actions', () => ({ setOptimisticRefs: () => undefined }));
mock.module('@/sync/notification-store', () => ({ markSessionViewed: () => undefined }));
mock.module('@/sync/sync-context', () => ({
  setExternallyViewedSession: () => undefined,
}));
mock.module('@/sync/use-sync', () => ({
  useSync: () => ({
    optimistic: {
      add: () => undefined,
      remove: () => undefined,
      confirm: () => undefined,
    },
  }),
}));
mock.module('@/apps/pi-session-store', () => ({ getPiSessionStore: () => piStore }));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: null,
    }),
    setState: () => undefined,
  },
}));
mock.module('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: {
    getState: () => ({ currentDirectory, setDirectory }),
  },
}));
mock.module('@/stores/useConfigStore', () => ({ useConfigStore }));
mock.module('@/lib/router/session-intent', () => ({ isNewSessionDraftActive: () => false }));
mock.module('@/sync/pi-session-catalog-feeder', () => ({ PiSessionCatalogFeeder: () => null }));
mock.module('@/sync/worktree-discovery', () => ({ WorktreeDiscovery: () => null }));

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
  setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
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
const restoreDom: Array<() => void> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  restoreDom.splice(0).forEach((restore) => restore());
  piListeners.clear();
  piState = {
    selectedSessionId: null,
    directory: 'C:\\repo',
    connection: 'ready',
    focusPending: false,
  };
  currentDirectory = 'C:/repo';
  setDirectoryCalls = 0;
});

describe('SyncAppEffects directory bridge', () => {
  test('does not feed equivalent server path spellings back into the directory store', async () => {
    const { SyncAppEffects } = await import('./AppEffects');
    const dom = installMinimalDom();
    restoreDom.push(dom.restore);
    const root = createRoot(dom.container);
    roots.push(root);

    await act(async () => {
      root.render(<SyncAppEffects embeddedBackgroundWorkEnabled={false} />);
    });

    expect(setDirectoryCalls).toBe(0);
  });
});
