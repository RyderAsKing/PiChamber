import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// ---------------------------------------------------------------------------
// Mounted wiring for the mobile directory-focus effect. `MobileApp`, the Pi
// session store, the focus preference helper, and `PiSessionBootstrapBridge`
// (inside `SyncAppEffects`) stay real; only the Pi RPC surface and unrelated
// shell boundaries are stubbed. Per-file isolation (`bun test --isolate`)
// keeps the module mocks below self-contained.
// ---------------------------------------------------------------------------

type Listener = () => void;

const createMutableStore = <T extends object>(initial: T) => {
  let state = initial;
  const listeners = new Set<Listener>();
  const subscribe = (listener: Listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const getState = () => state;
  const setState = (patch: Partial<T>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const useStore = <S,>(selector: (value: T) => S): S => React.useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
  return Object.assign(useStore, { getState, setState, reset: (value: T) => { state = value; } });
};

const directoryStore = createMutableStore({
  currentDirectory: '/other',
  setDirectory: (directory: string) => directoryStore.setState({ currentDirectory: directory }),
});

type SessionUIState = {
  currentSessionId: string | null;
  currentSessionDirectory: string | null;
  newSessionDraft: { open: boolean } | null;
  error: null;
  clearError: () => void;
};
const initialSessionUI = (): SessionUIState => ({
  currentSessionId: null,
  currentSessionDirectory: null,
  newSessionDraft: null,
  error: null,
  clearError: () => undefined,
});
const sessionUIStore = createMutableStore<SessionUIState>(initialSessionUI());

const configSnapshot = {
  initializeApp: async () => undefined,
  isInitialized: true,
  isConnected: true,
  connectionPhase: 'connected',
  providers: [{}],
  agents: [{}],
  loadProviders: async () => undefined,
  loadAgents: async () => undefined,
  activateDirectory: async () => undefined,
};

mock.module('@/components/update/MobileAppUpdateToast', () => ({ MobileAppUpdateToast: () => null }));
mock.module('@/components/ui/button', () => ({ Button: () => null }));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/components/ui/PiChamberLogo', () => ({ PiChamberLogo: () => null }));
mock.module('@/components/ui/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: React.PropsWithChildren) => children,
}));
mock.module('@/components/session/SessionDialogs', () => ({ SessionDialogs: () => null }));
mock.module('@/contexts/RuntimeAPIProvider', () => ({
  RuntimeAPIProvider: ({ children }: React.PropsWithChildren) => children,
}));
mock.module('@/contexts/runtimeAPIRegistry', () => ({
  registerRuntimeAPIs: () => undefined,
  getRegisteredRuntimeAPIs: () => null,
}));
mock.module('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: React.PropsWithChildren) => children,
}));
mock.module('@/components/ui/sonner', () => ({ Toaster: () => null }));
mock.module('@/components/perf/PerfHudHost', () => ({ PerfHudHost: () => null }));
mock.module('@/components/worktree/WorktreeCreationToasts', () => ({ WorktreeCreationToasts: () => null }));
mock.module('@/hooks/usePushVisibilityBeacon', () => ({ usePushVisibilityBeacon: () => undefined }));
mock.module('@/hooks/useRouter', () => ({ useRouter: () => undefined }));
mock.module('@/hooks/useUpdatePolling', () => ({ DeferredUpdatePolling: () => null }));
mock.module('@/hooks/useWindowTitle', () => ({ WindowTitleEffect: () => null }));
mock.module('@/hooks/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: () => undefined }));
mock.module('@/hooks/usePwaManifestSync', () => ({ usePwaManifestSync: () => undefined }));
mock.module('@/hooks/useQueuedMessageAutoSend', () => ({ useQueuedMessageAutoSend: () => undefined }));
mock.module('@/hooks/useSessionAutoCleanup', () => ({ useSessionAutoCleanup: () => undefined }));
mock.module('@/hooks/useWindowControlsOverlayLayout', () => ({ useWindowControlsOverlayLayout: () => undefined }));
mock.module('@/hooks/useDesktopMenuActions', () => ({ useDesktopMenuActions: () => undefined }));
mock.module('@/sync/pi-session-catalog-feeder', () => ({ PiSessionCatalogFeeder: () => null }));
mock.module('@/sync/worktree-discovery', () => ({ WorktreeDiscovery: () => null }));
mock.module('@/lib/persistence', () => ({ syncDesktopSettings: () => Promise.resolve(), updateDesktopSettings: () => Promise.resolve() }));
mock.module('@/lib/mobile-error-log', () => ({
  startMobileErrorLogCapture: () => () => undefined,
  recordMobileDiagnostic: () => undefined,
  recordMobileDiagnosticError: () => undefined,
}));
mock.module('@/sync/last-session-cache', () => ({
  readLastActiveSession: () => null,
  clearLastActiveSession: () => undefined,
  persistLastActiveSession: () => undefined,
}));
mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: Object.assign((selector: (s: typeof configSnapshot) => unknown) => selector(configSnapshot), {
    getState: () => configSnapshot,
  }),
}));
mock.module('@/stores/useDirectoryStore', () => ({ useDirectoryStore: directoryStore }));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: Object.assign((selector: (s: { setIsMobile: () => void }) => unknown) => selector({ setIsMobile: () => undefined }), {
    getState: () => ({ setIsMobile: () => undefined }),
  }),
}));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: sessionUIStore }));
mock.module('@/sync/pi-session-context', () => ({
  PiSessionProvider: ({ children }: React.PropsWithChildren) => children,
}));
mock.module('@/contexts/FireworksContext', () => ({
  FireworksProvider: ({ children }: React.PropsWithChildren) => children,
}));
mock.module('@/components/chat/AgentThinkingLoader', () => ({ AgentThinkingLoader: () => null }));
mock.module('@/apps/MobileConnectionWelcome', () => ({ MobileConnectionWelcome: () => null }));
mock.module('@/apps/MobileShell', () => ({ MobileShell: () => null }));
mock.module('@/apps/mobileConnections', () => ({
  autoConnectLastInstance: () => Promise.resolve({ status: 'no-candidate' as const }),
  getAutoConnectTargetLabel: () => null,
  reprobeActiveConnection: () => Promise.resolve('unchanged' as const),
}));
mock.module('@/lib/runtime-switch', () => ({
  getActiveRelayTunnel: () => null,
  getRuntimeApiBaseUrl: () => 'https://server.example',
  getRuntimeKey: () => 'mobile-conn-1',
  getRuntimeEndpointGeneration: () => 0,
  initializeRuntimeEndpoint: () => undefined,
  switchRuntimeEndpoint: () => undefined,
  subscribeRuntimeEndpointChanged: () => () => undefined,
  subscribeRuntimeEndpointWillChange: () => () => undefined,
}));
mock.module('@/apps/mobileNativeChrome', () => ({
  isCapacitorMobileApp: () => true,
  useNativeMobileChrome: () => undefined,
  useNativeMobileLifecycle: () => undefined,
  useNativeAndroidBackButton: () => undefined,
}));
mock.module('@/apps/runtimeEndpointReset', () => ({
  reconnectAppForTransportSwitch: () => undefined,
  resetAppForRuntimeEndpointChange: () => undefined,
}));
mock.module('@/apps/useAppFontEffects', () => ({ useAppFontEffects: () => undefined }));
mock.module('@/apps/useFontsReady', () => ({ useFontsReady: () => true }));
mock.module('@/apps/deepLinkNavigation', () => ({ useDeepLinkSource: () => undefined }));
mock.module('@/apps/useNativePushRegistration', () => ({ useNativePushRegistration: () => undefined }));

const { MobileApp } = await import('../MobileApp');
const { getPiSessionStore } = await import('@/apps/pi-session-store');
const { piClient } = await import('@/lib/pi/client');

// ---------------------------------------------------------------------------
// Pi RPC stubs and harness
// ---------------------------------------------------------------------------

type ListEntry = { session: { id: string; directory: string }; updatedAt: number };
type ListResult = { sessions: ListEntry[] };

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

const listed = (directory: string, ids: string[]): ListResult => ({
  sessions: ids.map((id) => ({ session: { id, directory }, updatedAt: 1 })),
});

const originals = {
  selectProject: piClient.selectProject.bind(piClient),
  listSessions: piClient.listSessions.bind(piClient),
  getSession: piClient.getSession.bind(piClient),
};

let listHandler: (directory: string) => Promise<ListResult> = async () => ({ sessions: [] });
const listCalls: string[] = [];

const installPiStubs = () => {
  piClient.selectProject = (async (directory: string) => ({ directory })) as unknown as typeof piClient.selectProject;
  piClient.listSessions = (async (options: { directory?: string } = {}) => {
    const directory = options.directory ?? '';
    listCalls.push(directory);
    return listHandler(directory);
  }) as typeof piClient.listSessions;
  piClient.getSession = (async (id: string) => ({
    session: { id, directory: '/repo' },
    lastSequence: 0,
    messages: [],
  })) as unknown as typeof piClient.getSession;
};

/** Attach the singleton store as a connected cluster focused on `directory`. */
const attachStoreAt = (directory: string | null) => {
  const store = getPiSessionStore();
  const internal = store as unknown as { stream: unknown; state: ReturnType<typeof store.getState> };
  internal.stream = { dispose: () => undefined };
  internal.state = { ...store.getState(), directory, connection: 'ready', selectedSessionId: null };
  return store;
};

const installDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  class ElementStub {}
  const noop = () => undefined;
  const documentStub: Record<string, unknown> = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    visibilityState: 'visible',
    addEventListener: noop,
    removeEventListener: noop,
    getElementById: () => null,
  };
  const makeNode = (tag: string): Record<string, unknown> => {
    const node: Record<string, unknown> = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      nodeName: tag.toUpperCase(),
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      ownerDocument: documentStub,
      parentNode: null,
      childNodes: [] as unknown[],
      style: { setProperty: noop, removeProperty: noop, getPropertyValue: () => '' },
      classList: { add: noop, remove: noop, contains: () => false },
      setAttribute: noop,
      removeAttribute: noop,
      getAttribute: () => null,
      hasAttribute: () => false,
      addEventListener: noop,
      removeEventListener: noop,
      focus: noop,
      blur: noop,
      contains: () => false,
      textContent: '',
    };
    node.appendChild = (child: Record<string, unknown>) => {
      (node.childNodes as unknown[]).push(child);
      child.parentNode = node;
      return child;
    };
    node.insertBefore = (child: Record<string, unknown>) => (node.appendChild as (c: unknown) => unknown)(child);
    node.removeChild = (child: Record<string, unknown>) => {
      const list = node.childNodes as unknown[];
      const index = list.indexOf(child);
      if (index >= 0) list.splice(index, 1);
      child.parentNode = null;
      return child;
    };
    return node;
  };
  documentStub.createElement = makeNode;
  documentStub.createElementNS = (_ns: string, tag: string) => makeNode(tag);
  documentStub.createTextNode = (text: string) => ({ nodeType: 3, nodeName: '#text', textContent: text, parentNode: null });
  const container = makeNode('div');
  documentStub.documentElement = container;
  documentStub.body = container;
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('navigator', { userAgent: 'test', onLine: true });
  setGlobal('location', { search: '', protocol: 'capacitor:', hostname: 'localhost', origin: 'capacitor://localhost', href: 'capacitor://localhost/' });
  setGlobal('matchMedia', () => ({ matches: false, addEventListener: noop, removeEventListener: noop }));
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
const restores: Array<() => void> = [];

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const mountMobileApp = async () => {
  const dom = installDom();
  restores.push(dom.restore);
  const root = createRoot(dom.container);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(MobileApp, { apis: {} as never }));
  });
  await flush();
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  restores.splice(0).forEach((restore) => restore());
  piClient.selectProject = originals.selectProject;
  piClient.listSessions = originals.listSessions;
  piClient.getSession = originals.getSession;
  listHandler = async () => ({ sessions: [] });
  listCalls.length = 0;
  getPiSessionStore().dispose();
  directoryStore.reset({
    currentDirectory: '/other',
    setDirectory: (directory: string) => directoryStore.setState({ currentDirectory: directory }),
  });
  sessionUIStore.reset(initialSessionUI());
});

/** Folder switch as the drawer/project picker performs it after mount. */
const switchDirectory = async (directory: string) => {
  await act(async () => {
    directoryStore.getState().setDirectory(directory);
  });
};

describe('MobileApp directory focus keeps the user-owned selection (mounted)', () => {
  test('first connect: a session picked while the focus list is in flight survives the late list', async () => {
    installPiStubs();
    const store = attachStoreAt(null);
    const list = deferred<ListResult>();
    listHandler = (directory) => (directory === '/repo' ? list.promise : Promise.resolve(listed(directory, [])));
    directoryStore.reset({ ...directoryStore.getState(), currentDirectory: '/repo' });

    await mountMobileApp();
    expect(listCalls).toEqual(['/repo']);
    expect(store.getState().focusPending).toBe(true);

    await act(async () => {
      await store.select('x', '/repo');
    });
    await act(async () => {
      list.resolve(listed('/repo', ['y', 'x']));
    });
    await flush();

    expect(store.getState().selectedSessionId).toBe('x');
    expect(sessionUIStore.getState().currentSessionId).toBe('x');
    expect(sessionUIStore.getState().currentSessionDirectory).toBe('/repo');
  });

  test('folder switch carries the visible session of that folder instead of the first row', async () => {
    installPiStubs();
    const store = attachStoreAt('/other');
    listHandler = async (directory) => listed(directory, ['y', 'x']);
    await mountMobileApp();

    // The chat identity already names a session in the target folder (e.g. a
    // restore or notification tap that raced the folder change).
    sessionUIStore.setState({ currentSessionId: 'x', currentSessionDirectory: '/repo' });
    await switchDirectory('/repo');
    await flush();

    expect(store.getState().directory).toBe('/repo');
    expect(store.getState().selectedSessionId).toBe('x');
    expect(sessionUIStore.getState().currentSessionId).toBe('x');
  });

  test('a visible session from another folder is not carried into the focused folder', async () => {
    installPiStubs();
    const store = attachStoreAt('/other');
    listHandler = async (directory) => listed(directory, ['y', 'x']);
    await mountMobileApp();

    sessionUIStore.setState({ currentSessionId: 'x', currentSessionDirectory: '/other' });
    await switchDirectory('/repo');
    await flush();

    expect(store.getState().directory).toBe('/repo');
    expect(store.getState().selectedSessionId).toBe('y');
    expect(sessionUIStore.getState().currentSessionId).toBe('y');
  });

  test('an open draft keeps its blank-chat intent across the folder focus', async () => {
    installPiStubs();
    const store = attachStoreAt('/other');
    listHandler = async (directory) => listed(directory, ['y', 'x']);
    await mountMobileApp();

    sessionUIStore.setState({ newSessionDraft: { open: true } });
    await switchDirectory('/repo');
    await flush();

    expect(store.getState().directory).toBe('/repo');
    expect(sessionUIStore.getState().currentSessionId).toBeNull();
  });
});
