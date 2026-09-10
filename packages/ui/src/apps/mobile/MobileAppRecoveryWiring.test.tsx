import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// ---------------------------------------------------------------------------
// Mutable controls (read through mock closures; reset per test).
// Per-file isolation (`bun test --isolate`) keeps this self-contained.
// ---------------------------------------------------------------------------

let apiBaseUrl = 'https://server.example';
let runtimeKey = 'mobile-conn-1';
type SwitchCall = { apiBaseUrl: string; clientToken?: string | null; runtimeKey?: string | null };
const switchCalls: SwitchCall[] = [];
let endpointListener: ((detail: { runtimeKey: string; previousRuntimeKey: string }) => void) | null = null;

let reprobeCalls = 0;
let reprobeHandler: () => Promise<'switched' | 'unchanged' | 'unreachable' | 'needs-login' | 'no-connection'> =
  async () => 'unchanged';

let autoConnectCalls = 0;
let autoLabel: string | null = 'Device A';

let cfgInitialized = true;
let cfgConnected = true;
let cfgPhase: string = 'connected';
let cfgProviders: Array<Record<string, unknown>> = [{}];
let cfgAgents: Array<Record<string, unknown>> = [{}];
let initCalls = 0;
let loadProvidersCalls = 0;
let loadAgentsCalls = 0;

const getCfgSnapshot = () => ({
  initializeApp: async () => {
    initCalls += 1;
  },
  isInitialized: cfgInitialized,
  isConnected: cfgConnected,
  connectionPhase: cfgPhase,
  providers: cfgProviders,
  agents: cfgAgents,
  loadProviders: async () => {
    loadProvidersCalls += 1;
  },
  loadAgents: async () => {
    loadAgentsCalls += 1;
  },
});

let shellMounts = 0;
let shellUnmounts = 0;
let welcomeMounts = 0;
const welcomeNotices: Array<{ kind: string; label: string } | null> = [];
const syncPropsHistory: boolean[] = [];
let syncRenders = 0;
let capturedOnResume: (() => void) | null = null;
let focusProjectCalls: unknown[][] = [];
let clearLastActiveCalls = 0;
let resetCalls = 0;
let reconnectCalls = 0;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// ---------------------------------------------------------------------------
// Boundary mocks. The recovery controller + uncertainty flag + auth event
// stay real; everything else is a narrow boundary stub so the real MobileApp
// wiring (props, probe calls, cancel, preserved drafts) is exercised.
// ---------------------------------------------------------------------------

mock.module('@/components/update/MobileAppUpdateToast', () => ({ MobileAppUpdateToast: () => null }));
mock.module('@/components/ui/button', () => ({
  Button: (props: { children?: React.ReactNode; onClick?: () => void }) =>
    React.createElement('button', { onClick: props.onClick }, props.children),
}));
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
mock.module('@/apps/pi-session-store', () => ({
  getPiSessionStore: () => ({
    focusProject: (...args: unknown[]) => {
      focusProjectCalls.push(args);
      return Promise.resolve();
    },
  }),
}));
mock.module('@/lib/persistence', () => ({ syncDesktopSettings: () => Promise.resolve(), updateDesktopSettings: () => Promise.resolve() }));
mock.module('@/lib/mobile-error-log', () => ({
  startMobileErrorLogCapture: () => () => undefined,
  recordMobileDiagnostic: () => undefined,
}));
mock.module('@/stores/useGlobalSessionsStore', () => ({
  refreshGlobalSessions: () => Promise.resolve(null),
  resolveGlobalSessionDirectory: () => null,
}));
mock.module('@/sync/last-session-cache', () => ({
  readLastActiveSession: () => null,
  clearLastActiveSession: () => {
    clearLastActiveCalls += 1;
  },
  persistLastActiveSession: () => undefined,
}));
mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: Object.assign((selector: (s: ReturnType<typeof getCfgSnapshot>) => unknown) => selector(getCfgSnapshot()), {
    getState: () => getCfgSnapshot(),
  }),
}));
mock.module('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: Object.assign((selector: (s: { currentDirectory: string }) => unknown) => selector({ currentDirectory: '/repo' }), {
    getState: () => ({ currentDirectory: '/repo', setDirectory: () => undefined }),
  }),
}));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: Object.assign((selector: (s: { setIsMobile: () => void }) => unknown) => selector({ setIsMobile: () => undefined }), {
    getState: () => ({ setIsMobile: () => undefined }),
  }),
}));
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: Object.assign(
    (selector: (s: { error: null; clearError: () => void }) => unknown) => selector({ error: null, clearError: () => undefined }),
    {
      getState: () => ({ currentSessionId: null, currentSessionDirectory: null, newSessionDraft: null }),
      setState: () => undefined,
    },
  ),
}));
mock.module('@/sync/pi-session-context', () => ({
  PiSessionProvider: ({ children }: React.PropsWithChildren) => children,
}));
mock.module('@/contexts/FireworksContext', () => ({
  FireworksProvider: ({ children }: React.PropsWithChildren) => children,
}));
mock.module('@/apps/AppEffects', () => ({
  SyncAppEffects: (props: { embeddedBackgroundWorkEnabled: boolean }) => {
    syncPropsHistory.push(props.embeddedBackgroundWorkEnabled);
    syncRenders += 1;
    return null;
  },
}));
mock.module('@/components/chat/AgentThinkingLoader', () => ({ AgentThinkingLoader: () => null }));
mock.module('@/apps/MobileConnectionWelcome', () => ({
  MobileConnectionWelcome: (props: { onConnected: () => void; notice?: { kind: string; label: string } | null }) => {
    welcomeNotices.push(props.notice ?? null);
    welcomeMounts += 1;
    return null;
  },
}));
mock.module('@/apps/MobileShell', () => ({
  MobileShell: () => {
    React.useEffect(() => {
      shellMounts += 1;
      return () => {
        shellUnmounts += 1;
      };
    }, []);
    return null;
  },
}));
mock.module('@/apps/mobileConnections', () => ({
  autoConnectLastInstance: () => {
    autoConnectCalls += 1;
    return Promise.resolve({ status: 'no-candidate' as const });
  },
  getAutoConnectTargetLabel: () => autoLabel,
  reprobeActiveConnection: () => {
    reprobeCalls += 1;
    return reprobeHandler();
  },
}));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: () => apiBaseUrl,
  getRuntimeKey: () => runtimeKey,
  getRuntimeEndpointGeneration: () => 0,
  switchRuntimeEndpoint: (options: SwitchCall) => {
    switchCalls.push({ ...options });
    apiBaseUrl = options.apiBaseUrl.trim();
    if (typeof options.runtimeKey === 'string' && options.runtimeKey.trim()) {
      runtimeKey = options.runtimeKey.trim();
    } else {
      runtimeKey = `url:${apiBaseUrl}`;
    }
  },
  subscribeRuntimeEndpointChanged: (callback: (detail: { runtimeKey: string; previousRuntimeKey: string }) => void) => {
    endpointListener = callback;
    return () => {
      endpointListener = null;
    };
  },
  subscribeRuntimeEndpointWillChange: () => () => undefined,
}));
mock.module('@/apps/mobileNativeChrome', () => ({
  isCapacitorMobileApp: () => true,
  useNativeMobileChrome: () => undefined,
  useNativeMobileLifecycle: (onResume: () => void) => {
    capturedOnResume = onResume;
  },
  useNativeAndroidBackButton: () => undefined,
}));
mock.module('@/apps/runtimeEndpointReset', () => ({
  reconnectAppForTransportSwitch: () => {
    reconnectCalls += 1;
  },
  resetAppForRuntimeEndpointChange: () => {
    resetCalls += 1;
  },
}));
mock.module('@/apps/useAppFontEffects', () => ({ useAppFontEffects: () => undefined }));
mock.module('@/apps/useFontsReady', () => ({ useFontsReady: () => true }));
mock.module('@/apps/deepLinkNavigation', () => ({ useDeepLinkSource: () => undefined }));
mock.module('@/apps/useNativePushRegistration', () => ({ useNativePushRegistration: () => undefined }));
mock.module('@/lib/relay/runtime-tunnel', () => ({
  isRelayModeActive: () => false,
  adoptRelayTunnel: () => undefined,
  activateRelayTunnel: () => undefined,
  deactivateRelayTunnel: () => undefined,
  getActiveRelayTunnel: () => null,
}));

// Real wiring under test: controller + uncertainty flag + auth event stay unmocked.
const { MobileApp } = await import('../MobileApp');
const { isMobileConnectionUncertain, setMobileConnectionUncertain } = await import('./mobileRecoveryStatus');
const RUNTIME_AUTH_EXPIRED_EVENT = 'pichamber:auth-expired';

// ---------------------------------------------------------------------------
// Minimal DOM harness with functional online/visibility/auth events.
// Provenance: DiagramView/number-input Fake DOM (createElement + __reactProps
// clicks) extended with window/document event emitters for recovery wiring.
// ---------------------------------------------------------------------------

type FakeNode = {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: FakeDocument | null;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  style: Record<string, unknown>;
  classList: { add(...c: string[]): void; remove(...c: string[]): void; contains(c: string): boolean };
  [key: string]: unknown;
};

type FakeDocument = FakeNode & {
  defaultView: FakeWindow;
  body: FakeNode;
  documentElement: FakeNode;
  visibilityState: string;
  createElement(tag: string): FakeNode;
  createElementNS(_ns: string, tag: string): FakeNode;
  createTextNode(text: string): FakeNode;
  activeElement: FakeNode | null;
  addEventListener(type: string, listener: (e: { type: string }) => void): void;
  removeEventListener(type: string, listener: (e: { type: string }) => void): void;
  dispatchEvent(event: { type: string }): boolean;
};

type FakeWindow = {
  document: FakeDocument;
  navigator: { userAgent: string };
  location: { protocol: string; origin: string; href: string; search: string };
  addEventListener(type: string, listener: (e: { type: string }) => void): void;
  removeEventListener(type: string, listener: (e: { type: string }) => void): void;
  dispatchEvent(event: { type: string }): boolean;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  [key: string]: unknown;
};

function makeNode(tag: string, owner: FakeDocument): FakeNode {
  const node = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    ownerDocument: owner,
    parentNode: null,
    childNodes: [] as FakeNode[],
    style: { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} },
    classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute() {},
    removeAttribute() {},
    hasAttribute() { return false; },
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c: FakeNode) {
      (this as FakeNode).childNodes.push(c);
      c.parentNode = this as unknown as FakeNode;
      return c;
    },
    insertBefore(c: FakeNode, ref: FakeNode) {
      const list = (this as FakeNode).childNodes;
      const i = list.indexOf(ref);
      if (i < 0) list.push(c);
      else list.splice(i, 0, c);
      c.parentNode = this as unknown as FakeNode;
      return c;
    },
    removeChild(c: FakeNode) {
      const list = (this as FakeNode).childNodes;
      const i = list.indexOf(c);
      if (i >= 0) list.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    contains() { return false; },
    focus() {},
    blur() {},
    click() {},
    textContent: '',
    innerHTML: '',
  } as unknown as FakeNode;
  return node;
}

const roots: Root[] = [];
const restores: Array<() => void> = [];

function installMobileDom() {
  let online = true;
  let visible = true;
  const winListeners = new Map<string, Set<(e: { type: string }) => void>>();
  const docListeners = new Map<string, Set<(e: { type: string }) => void>>();

  const document = {
    nodeType: 9,
    nodeName: '#document',
    tagName: '#document',
    parentNode: null,
    childNodes: [] as FakeNode[],
    style: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute() {},
    getAttribute() { return null; },
    activeElement: null,
    getElementById() { return null; },
    createTextNode(text: string) {
      return { nodeType: 3, nodeName: '#text', textContent: text, parentNode: null } as unknown as FakeNode;
    },
    createElement(tag: string) { return makeNode(tag, document as unknown as FakeDocument); },
    createElementNS(_ns: string, tag: string) { return makeNode(tag, document as unknown as FakeDocument); },
    addEventListener(type: string, listener: (e: { type: string }) => void) {
      let set = docListeners.get(type);
      if (!set) {
        set = new Set();
        docListeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type: string, listener: (e: { type: string }) => void) {
      docListeners.get(type)?.delete(listener);
    },
    dispatchEvent(event: { type: string }) {
      for (const listener of [...(docListeners.get(event.type) ?? [])]) listener(event);
      return true;
    },
  } as unknown as FakeDocument;

  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden'),
  });

  const win = {
    document,
    navigator: { userAgent: 'test' },
    location: { protocol: 'capacitor:', origin: 'capacitor://localhost', href: 'capacitor://localhost/', search: '' },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener(type: string, listener: (e: { type: string }) => void) {
      let set = winListeners.get(type);
      if (!set) {
        set = new Set();
        winListeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type: string, listener: (e: { type: string }) => void) {
      winListeners.get(type)?.delete(listener);
    },
    dispatchEvent(event: { type: string }) {
      for (const listener of [...(winListeners.get(event.type) ?? [])]) listener(event);
      return true;
    },
    Element: class {},
    HTMLElement: class {},
    HTMLIFrameElement: class {},
  } as unknown as FakeWindow;

  document.defaultView = win;
  document.body = makeNode('body', document);
  document.documentElement = makeNode('html', document);

  const navigatorStub = {};
  Object.defineProperty(navigatorStub, 'onLine', {
    configurable: true,
    get: () => online,
  });

  const g = globalThis as unknown as Record<string, unknown>;
  const previous = {
    document: g['document'],
    window: g['window'],
    navigator: g['navigator'],
    location: g['location'],
    Element: g['Element'],
    HTMLElement: g['HTMLElement'],
    HTMLIFrameElement: g['HTMLIFrameElement'],
    IS_REACT_ACT_ENVIRONMENT: g['IS_REACT_ACT_ENVIRONMENT'],
  };
  g['document'] = document;
  g['window'] = win;
  (win as unknown as Record<string, unknown>)['window'] = win;
  g['navigator'] = navigatorStub;
  g['location'] = win.location;
  g['Element'] = (win as unknown as Record<string, unknown>)['Element'];
  g['HTMLElement'] = (win as unknown as Record<string, unknown>)['HTMLElement'];
  g['HTMLIFrameElement'] = (win as unknown as Record<string, unknown>)['HTMLIFrameElement'];
  g['IS_REACT_ACT_ENVIRONMENT'] = true;

  const container = document.createElement('div');
  return {
    container,
    setOnline: (value: boolean) => {
      online = value;
    },
    setVisible: (value: boolean) => {
      visible = value;
    },
    dispatchOnline: () => {
      (win.dispatchEvent as (e: { type: string }) => boolean)({ type: 'online' });
    },
    dispatchVisible: (nextVisible: boolean) => {
      visible = nextVisible;
      (document.dispatchEvent as (e: { type: string }) => boolean)({ type: 'visibilitychange' });
    },
    dispatchAuthExpired: () => {
      (win.dispatchEvent as (event: { type: string }) => boolean)({
        type: RUNTIME_AUTH_EXPIRED_EVENT,
      });
    },
    restore: () => {
      g['document'] = previous['document'];
      g['window'] = previous['window'];
      g['navigator'] = previous['navigator'];
      g['location'] = previous['location'];
      g['Element'] = previous['Element'];
      g['HTMLElement'] = previous['HTMLElement'];
      g['HTMLIFrameElement'] = previous['HTMLIFrameElement'];
      g['IS_REACT_ACT_ENVIRONMENT'] = previous['IS_REACT_ACT_ENVIRONMENT'];
    },
  };
}

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const resetControls = () => {
  apiBaseUrl = 'https://server.example';
  runtimeKey = 'mobile-conn-1';
  switchCalls.length = 0;
  endpointListener = null;
  reprobeCalls = 0;
  reprobeHandler = async () => 'unchanged';
  autoConnectCalls = 0;
  autoLabel = 'Device A';
  cfgInitialized = true;
  cfgConnected = true;
  cfgPhase = 'connected';
  cfgProviders = [{}];
  cfgAgents = [{}];
  initCalls = 0;
  loadProvidersCalls = 0;
  loadAgentsCalls = 0;
  shellMounts = 0;
  shellUnmounts = 0;
  welcomeMounts = 0;
  welcomeNotices.length = 0;
  syncPropsHistory.length = 0;
  syncRenders = 0;
  capturedOnResume = null;
  focusProjectCalls = [];
  clearLastActiveCalls = 0;
  resetCalls = 0;
  reconnectCalls = 0;
  setMobileConnectionUncertain(false);
};

beforeEach(() => {
  resetControls();
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  restores.splice(0).forEach((restore) => restore());
  resetControls();
});

async function mountMobileApp() {
  const harness = installMobileDom();
  restores.push(harness.restore);
  const root = createRoot(harness.container as unknown as Element);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(MobileApp, { apis: {} as never }));
  });
  await flush();
  await flush();
  return { harness, root };
}

async function resumeViaNative() {
  const resume = capturedOnResume;
  expect(resume).not.toBeNull();
  await act(async () => {
    resume?.();
    await Promise.resolve();
  });
  await flush();
}

function lastSyncProp(): boolean | null {
  return syncPropsHistory.length > 0 ? syncPropsHistory[syncPropsHistory.length - 1]! : null;
}

describe('MobileApp recovery wiring (mounted)', () => {
  test('queued auto-send stays paused while the transport is uncertain, drains after a verified healthy probe', async () => {
    reprobeHandler = async () => 'unchanged';
    await mountMobileApp();

    expect(reprobeCalls).toBe(1);
    expect(endpointListener).not.toBeNull();
    expect(autoConnectCalls).toBe(0);
    expect(syncRenders).toBeGreaterThan(0);
    expect(resetCalls).toBe(0);
    expect(reconnectCalls).toBe(0);
    expect(loadProvidersCalls).toBe(0);
    expect(loadAgentsCalls).toBe(0);
    expect(isMobileConnectionUncertain()).toBe(false);
    expect(lastSyncProp()).toBe(true);
    expect(shellMounts).toBe(1);
    expect(shellUnmounts).toBe(0);
    expect(welcomeMounts).toBe(0);

    reprobeHandler = async () => 'unreachable';
    await resumeViaNative();

    expect(isMobileConnectionUncertain()).toBe(true);
    expect(lastSyncProp()).toBe(false);
    // The shell never unmounts, so its composer and local draft remain owned.
    expect(shellMounts).toBe(1);
    expect(shellUnmounts).toBe(0);
    expect(welcomeMounts).toBe(0);
    expect(switchCalls).toHaveLength(0);

    reprobeHandler = async () => 'unchanged';
    await resumeViaNative();

    expect(isMobileConnectionUncertain()).toBe(false);
    expect(lastSyncProp()).toBe(true);
    expect(shellMounts).toBe(1);
    expect(shellUnmounts).toBe(0);
    expect(welcomeMounts).toBe(0);
  });

  test('established auth-expired cancels recovery, disconnects, and preserves drafts for re-login', async () => {
    reprobeHandler = async () => 'unchanged';
    const { harness } = await mountMobileApp();
    expect(welcomeMounts).toBe(0);
    const initAtMount = initCalls;

    // Start a resume probe and keep it pending so the auth handler must cancel it.
    const gate = deferred<'switched' | 'unchanged' | 'unreachable' | 'needs-login' | 'no-connection'>();
    reprobeHandler = () => gate.promise;
    await resumeViaNative();
    const callsWithPending = reprobeCalls;
    expect(callsWithPending).toBeGreaterThan(1);

    await act(async () => {
      harness.dispatchAuthExpired();
      await Promise.resolve();
    });
    await flush();

    // Immediate handling: endpoint clears to the connect screen with an
    // auth-expired notice; uncertainty clears because the composer unmounts.
    expect(switchCalls.length).toBeGreaterThan(0);
    expect(switchCalls[switchCalls.length - 1]).toMatchObject({
      apiBaseUrl: '',
      runtimeKey: 'mobile-disconnected',
    });
    expect(isMobileConnectionUncertain()).toBe(false);
    expect(welcomeMounts).toBeGreaterThan(0);
    expect(welcomeNotices[welcomeNotices.length - 1]).toMatchObject({ kind: 'auth-expired', label: 'Device A' });
    // Saved rows/drafts stay: no destructive cache clear, no row delete.
    expect(clearLastActiveCalls).toBe(0);

    // The late probe commits nothing after cancel: no healthy resync, no
    // endpoint resurrection, no extra disconnect.
    const switchesAfterAuth = switchCalls.length;
    gate.resolve('unchanged');
    await flush();
    expect(switchCalls).toHaveLength(switchesAfterAuth);
    expect(initCalls).toBe(initAtMount);
    expect(apiBaseUrl).toBe('');
    expect(isMobileConnectionUncertain()).toBe(false);
  });
});
