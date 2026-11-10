import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, mock, test } from 'bun:test';

// Two stores that each hold "the current folder": the Pi session store
// (focus pointer) and the directory store. The bridge in AppEffects copies
// Pi focus into the directory store; the mobile hook copies the directory
// store into Pi focus. Both effects can fire in one commit.

type PiState = {
  selectedSessionId: string | null;
  directory: string | null;
  connection: 'ready';
  focusPending: boolean;
};

let piState: PiState;
const piListeners = new Set<() => void>();
let focusCalls: string[] = [];
const piStore = {
  getState: () => piState,
  subscribe: (listener: () => void) => {
    piListeners.add(listener);
    return () => piListeners.delete(listener);
  },
  focusProject: async (directory: string | null) => {
    focusCalls.push(String(directory));
    if (focusCalls.length > 200) throw new Error('focus loop');
    if (directory === piState.directory) return;
    piState = { ...piState, directory };
    piListeners.forEach((listener) => listener());
  },
};

type DirectoryState = { currentDirectory: string; setDirectory: (directory: string) => void };
let setDirectoryCalls: string[] = [];
const directoryListeners = new Set<() => void>();
let directoryState: DirectoryState;
const setDirectory = (directory: string) => {
  setDirectoryCalls.push(directory);
  if (setDirectoryCalls.length > 200) throw new Error('setDirectory loop');
  directoryState = { ...directoryState, currentDirectory: directory };
  directoryListeners.forEach((listener) => listener());
};
const subscribeDirectory = (listener: () => void) => {
  directoryListeners.add(listener);
  return () => directoryListeners.delete(listener);
};
const useDirectoryStore = Object.assign(
  <T,>(selector: (state: DirectoryState) => T): T => React.useSyncExternalStore(
    subscribeDirectory,
    () => selector(directoryState),
    () => selector(directoryState),
  ),
  { getState: () => directoryState },
);

const resetStores = (piDirectory: string, currentDirectory: string) => {
  piState = { selectedSessionId: null, directory: piDirectory, connection: 'ready', focusPending: false };
  directoryState = { currentDirectory, setDirectory };
  focusCalls = [];
  setDirectoryCalls = [];
};
resetStores('/srv/b', '/srv/a');

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
mock.module('@/hooks/useDesktopMenuActions', () => ({ useDesktopMenuActions: () => undefined }));
mock.module('@/sync/notification-store', () => ({ markSessionViewed: () => undefined }));
mock.module('@/apps/pi-session-store', () => ({ getPiSessionStore: () => piStore }));
mock.module('@/sync/pi-session-focus-preference', () => ({ focusPreferenceForDirectory: () => null }));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({ currentSessionId: null, currentSessionDirectory: null, newSessionDraft: null }),
    setState: () => undefined,
  },
}));
mock.module('@/stores/useDirectoryStore', () => ({ useDirectoryStore }));
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
  directoryListeners.clear();
  resetStores('/srv/b', '/srv/a');
});

const renderMobileShell = async () => {
  const { SyncAppEffects } = await import('./AppEffects');
  const { useMobileFolderFocus } = await import('./useMobileFolderFocus');
  // Mirrors MobileApp: the shell reads the directory store and drives Pi
  // focus, and the bridge is mounted beneath it.
  const MobileShell = () => {
    const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
    useMobileFolderFocus(currentDirectory, true);
    return <SyncAppEffects embeddedBackgroundWorkEnabled={false} />;
  };
  const dom = installMinimalDom();
  restoreDom.push(dom.restore);
  const root = createRoot(dom.container);
  roots.push(root);
  await act(async () => {
    root.render(<MobileShell />);
  });
};

describe('mobile folder focus and the directory bridge', () => {
  test('settle on one folder when both stores start on different folders', async () => {
    resetStores('/srv/b', '/srv/a');

    await renderMobileShell();

    // Pi's focus (a restored session's folder) wins over the phone's saved one.
    expect(piState.directory).toBe('/srv/b');
    expect(directoryState.currentDirectory).toBe('/srv/b');
    expect(setDirectoryCalls).toEqual(['/srv/b']);
    expect(focusCalls).toEqual(['/srv/b']);
  });

  test('a folder chosen on the phone moves Pi focus without bouncing back', async () => {
    resetStores('/srv/a', '/srv/a');
    await renderMobileShell();
    focusCalls = [];
    setDirectoryCalls = [];

    await act(async () => {
      setDirectory('/srv/c');
    });

    expect(piState.directory).toBe('/srv/c');
    expect(directoryState.currentDirectory).toBe('/srv/c');
    expect(setDirectoryCalls).toEqual(['/srv/c']);
  });

  test('a folder chosen by Pi moves the directory store without bouncing back', async () => {
    resetStores('/srv/a', '/srv/a');
    await renderMobileShell();
    focusCalls = [];
    setDirectoryCalls = [];

    await act(async () => {
      piState = { ...piState, directory: '/srv/d' };
      piListeners.forEach((listener) => listener());
    });

    expect(directoryState.currentDirectory).toBe('/srv/d');
    expect(piState.directory).toBe('/srv/d');
    expect(setDirectoryCalls).toEqual(['/srv/d']);
  });
});
