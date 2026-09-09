/**
 * Terminal reattach: mounted TerminalView pane behavior.
 *
 * Replaces the former source-string assertions in this file with real mounted
 * behavior. The productionKeys under test live in the actual render tree:
 * TerminalView maps one TerminalTabPane per tab (key={tab.id},
 * sessionKey={`${directory}::${tab.id}`) and TerminalTabPane keeps every pane
 * mounted while hidden (block/hidden CSS + aria-hidden) with its viewport
 * keyed by the tab-stable sessionKey.
 *
 * Coverage replaced (old source-string tests in this file):
 * - "panes stay mounted while hidden" -> now mounted: both panes in the DOM,
 *   inactive pane hidden via CSS but still mounted with preserved instance
 *   state across tab toggles.
 * - "viewport identity is tab-stable, never PTY-keyed" -> now mounted:
 *   assigning a PTY id to the same tab keeps the same sessionKey and does not
 *   remount the viewport (mount count + local marker stable).
 * - "transport switch reattaches via connect, creation only for null IDs",
 *   "shared auth/URL/relay routing stays centralized", and "renamed transport
 *   reset" string checks were removed here: they are proven behaviorally by
 *   useTerminalSessionStream.transportSwitch.test.tsx (hook reattach exactly
 *   once, stale rejection, different-runtime isolation, pending/input gating)
 *   and terminalTransportSwitch.test.ts + terminalApi.test.ts (generation
 *   bump, centralized auth refresh, stale disposal, no replay).
 *
 * Strategy: mount the real TerminalView with only its heavy leaf mocked
 * (TerminalViewport -> lightweight probe). The real TerminalTabPane wrapper
 * (hidden CSS, sessionKey key) and TerminalView mapping (key={tab.id}) stay
 * under test. Runtime/theme/device/directory are test controls, not behavior
 * under test.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, mock, test } from 'bun:test';

import type { TerminalAPI } from '@/lib/api/types';
import type { Theme } from '@/types/theme';

// --- Test controls (not behavior under test) -------------------------------

let fakeTerminal: TerminalAPI = {
  async createSession() {
    return { sessionId: 'created-1', cols: 80, rows: 24, status: 'running' };
  },
  connect() {
    return { close: () => undefined };
  },
  async sendInput() {},
  async resize() {},
  async close() {},
} as unknown as TerminalAPI;

const fakeTheme = {
  metadata: {
    id: 'test-dark',
    name: 'Test Dark',
    description: 'Test theme',
    version: '1',
    variant: 'dark',
    tags: [],
  },
  colors: {
    primary: { base: '#ffffff' },
    surface: {
      background: '#000000',
      foreground: '#ffffff',
      muted: '#111111',
      mutedForeground: '#aaaaaa',
      elevated: '#111111',
      elevatedForeground: '#ffffff',
      overlay: '#000000',
      subtle: '#111111',
    },
    interactive: {
      border: '#333333',
      borderHover: '#444444',
      borderFocus: '#555555',
      selection: '#333333',
      selectionForeground: '#ffffff',
      focus: '#ffffff',
      focusRing: '#ffffff',
      cursor: '#ffffff',
      hover: '#222222',
      active: '#222222',
    },
    status: {
      error: '#ff0000',
      errorForeground: '#ffcccc',
      errorBackground: '#330000',
      errorBorder: '#ff0000',
      warning: '#ffff00',
      warningForeground: '#333300',
      warningBackground: '#333300',
      warningBorder: '#ffff00',
      success: '#00ff00',
      successForeground: '#003300',
      successBackground: '#003300',
      successBorder: '#00ff00',
      info: '#0000ff',
      infoForeground: '#ffffff',
      infoBackground: '#000033',
      infoBorder: '#0000ff',
    },
    syntax: {
      base: {
        background: '#000000',
        foreground: '#ffffff',
        comment: '#888888',
        keyword: '#ff00ff',
        string: '#00ff00',
        number: '#ff0000',
        function: '#00ffff',
        variable: '#ffffff',
        type: '#ffff00',
        operator: '#ffffff',
      },
    },
  },
} as unknown as Theme;

const desktopDeviceInfo = {
  isMobile: false,
  isTablet: false,
  isDesktop: true,
  deviceType: 'desktop' as const,
  screenWidth: 1280,
  breakpoint: 'xl' as const,
  hasTouchInput: false,
  hasTouchOnlyPointer: false,
};

// Viewport probe state: one lightweight leaf per sessionKey. Mount counts and
// a per-instance marker prove whether React remounted the viewport.
const viewportMounts = new Map<string, number>();
const viewportUnmounts = new Map<string, number>();
const viewportLatestProps = new Map<string, { sessionKey: string; isVisible: boolean }>();
let viewportInstanceSeq = 0;

mock.module('@/components/icon/Icon', () => ({
  Icon: () => null,
}));

mock.module('@/components/terminal/TerminalViewport', () => ({
  TerminalViewport: React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
    const sessionKey = props['sessionKey'] as string;
    const isVisible = props['isVisible'] as boolean;
    const [marker] = React.useState(() => {
      viewportInstanceSeq += 1;
      return `instance-${viewportInstanceSeq}`;
    });
    React.useEffect(() => {
      viewportMounts.set(sessionKey, (viewportMounts.get(sessionKey) ?? 0) + 1);
      return () => {
        viewportUnmounts.set(sessionKey, (viewportUnmounts.get(sessionKey) ?? 0) + 1);
      };
    }, [sessionKey]);
    viewportLatestProps.set(sessionKey, { sessionKey, isVisible });
    React.useImperativeHandle(
      ref,
      () => ({
        focus: () => undefined,
        fit: () => undefined,
        getSelection: () => null,
      }),
      [],
    );
    return React.createElement('div', {
      'data-testid': `viewport-${sessionKey}`,
      'data-session-key': sessionKey,
      'data-visible': String(isVisible),
      'data-marker': marker,
    });
  }),
}));

mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({
    terminal: fakeTerminal,
    runtime: { platform: 'web', isDesktop: true },
  }),
}));

mock.module('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ currentTheme: fakeTheme }),
  useOptionalThemeSystem: () => ({ currentTheme: fakeTheme }),
}));

mock.module('@/lib/device', () => ({
  useDeviceInfo: () => desktopDeviceInfo,
  useTabletLayout: () => ({ enabled: false, roomyForPanels: false }),
  useOrientation: () => 'landscape' as const,
  useTabletStandalonePwaRuntime: () => false,
  isMobileDeviceViaCSS: () => false,
  getDeviceInfo: () => desktopDeviceInfo,
  readTabletLayout: () => ({ enabled: false, roomyForPanels: false }),
}));

mock.module('@/hooks/useEffectiveDirectory', () => ({
  useEffectiveDirectory: () => '/repo',
}));

const { TerminalView } = await import('@/components/views/TerminalView');
const { useTerminalStore } = await import('@/stores/useTerminalStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');

// --- Minimal DOM stub (proven DiagramView/number-input pattern) -------------

interface FakeNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: FakeDocument | null;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  style: Record<string, unknown>;
  classList: { add(...c: string[]): void; remove(...c: string[]): void; contains(c: string): boolean };
  [key: string]: unknown;
}

interface FakeDocument extends FakeNode {
  defaultView: FakeWindow;
  body: FakeNode;
  head: FakeNode;
  documentElement: FakeNode;
  createElement(tag: string): FakeNode;
  createElementNS(_ns: string, tag: string): FakeNode;
  createTextNode(text: string): FakeNode;
  createDocumentFragment(): FakeNode;
  getElementById(_id: string): FakeNode | null;
  activeElement: FakeNode | null;
}

interface FakeWindow {
  document: FakeDocument;
  navigator: { userAgent: string; platform: string; maxTouchPoints: number };
  location: { search: string; protocol: string; hostname: string };
  innerWidth: number;
  innerHeight: number;
  matchMedia(query: string): { matches: boolean; addEventListener(): void; removeEventListener(): void };
  getComputedStyle(_elt: unknown): { getPropertyValue(_name: string): string };
  requestAnimationFrame(cb: () => void): number;
  cancelAnimationFrame(_id: number): void;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  addEventListener(): void;
  removeEventListener(): void;
  dispatchEvent(): boolean;
  [key: string]: unknown;
}

function makeNode(tag: string, owner: FakeDocument | null): FakeNode {
  const node = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    ownerDocument: owner,
    parentNode: null,
    childNodes: [] as FakeNode[],
    style: {
      setProperty() {},
      getPropertyValue() { return ''; },
      removeProperty() {},
    },
    classList: {
      add() {},
      remove() {},
      contains() { return false; },
    },
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
    hasPointerCapture() { return false; },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() { return { width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600 }; },
    querySelector() { return null; },
    closest() { return null; },
    textContent: '',
    innerHTML: '',
  } as unknown as FakeNode;
  return node;
}

function installDomStub(): { restore: () => void; container: FakeNode } {
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
    addEventListener() {},
    removeEventListener() {},
    hasFocus() { return true; },
    getElementById() { return null; },
    querySelector() { return null; },
    createTextNode(text: string) {
      return { nodeType: 3, nodeName: '#text', textContent: text, parentNode: null } as unknown as FakeNode;
    },
    createElement(tag: string) { return makeNode(tag, document as unknown as FakeDocument); },
    createElementNS(_ns: string, tag: string) { return makeNode(tag, document as unknown as FakeDocument); },
    createDocumentFragment() { return makeNode('#fragment', document as unknown as FakeDocument); },
    visibilityState: 'visible',
    activeElement: null,
  } as unknown as FakeDocument;

  const win = {
    document,
    navigator: { userAgent: 'test', platform: 'test', maxTouchPoints: 0 },
    location: { search: '', protocol: 'http:', hostname: 'localhost' },
    innerWidth: 1280,
    innerHeight: 800,
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    getComputedStyle() { return { getPropertyValue() { return ''; } }; },
    requestAnimationFrame(cb: () => void) { return setTimeout(cb, 0) as unknown as number; },
    cancelAnimationFrame(id: number) { clearTimeout(id); },
    setTimeout,
    clearTimeout,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    Element: class {},
    HTMLElement: class {},
    HTMLIFrameElement: class {},
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  } as unknown as FakeWindow;
  document.defaultView = win;
  document.body = makeNode('body', document);
  document.head = makeNode('head', document);
  document.documentElement = makeNode('html', document);

  const g = globalThis as unknown as Record<string, unknown>;
  const previous = {
    document: g['document'],
    window: g['window'],
    navigator: g['navigator'],
    Element: g['Element'],
    HTMLElement: g['HTMLElement'],
    HTMLIFrameElement: g['HTMLIFrameElement'],
    requestAnimationFrame: g['requestAnimationFrame'],
    cancelAnimationFrame: g['cancelAnimationFrame'],
    getComputedStyle: g['getComputedStyle'],
    ResizeObserver: g['ResizeObserver'],
    IntersectionObserver: g['IntersectionObserver'],
    localStorage: g['localStorage'],
    sessionStorage: g['sessionStorage'],
    IS_REACT_ACT_ENVIRONMENT: g['IS_REACT_ACT_ENVIRONMENT'],
  };
  g['IS_REACT_ACT_ENVIRONMENT'] = true;
  g['document'] = document;
  g['window'] = win;
  g['navigator'] = win.navigator;
  g['Element'] = win['Element'];
  g['HTMLElement'] = win['HTMLElement'];
  g['HTMLIFrameElement'] = win['HTMLIFrameElement'];
  g['requestAnimationFrame'] = win.requestAnimationFrame.bind(win);
  g['cancelAnimationFrame'] = win.cancelAnimationFrame.bind(win);
  g['getComputedStyle'] = win.getComputedStyle.bind(win);
  g['ResizeObserver'] = win['ResizeObserver'];
  g['IntersectionObserver'] = win['IntersectionObserver'];
  if (!g['localStorage']) {
    const store = new Map<string, string>();
    g['localStorage'] = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    };
  }
  if (!g['sessionStorage']) {
    const store = new Map<string, string>();
    g['sessionStorage'] = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    };
  }
  const container = document.createElement('div');
  return {
    container,
    restore() {
      g['document'] = previous['document'];
      g['window'] = previous['window'];
      g['navigator'] = previous['navigator'];
      g['Element'] = previous['Element'];
      g['HTMLElement'] = previous['HTMLElement'];
      g['HTMLIFrameElement'] = previous['HTMLIFrameElement'];
      g['requestAnimationFrame'] = previous['requestAnimationFrame'];
      g['cancelAnimationFrame'] = previous['cancelAnimationFrame'];
      g['getComputedStyle'] = previous['getComputedStyle'];
      g['ResizeObserver'] = previous['ResizeObserver'];
      g['IntersectionObserver'] = previous['IntersectionObserver'];
      g['localStorage'] = previous['localStorage'];
      g['sessionStorage'] = previous['sessionStorage'];
      g['IS_REACT_ACT_ENVIRONMENT'] = previous['IS_REACT_ACT_ENVIRONMENT'];
    },
  };
}

const roots: Root[] = [];
const restores: Array<() => void> = [];

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
};

const reactPropsOf = (node: FakeNode): Record<string, unknown> | null => {
  const key = Object.keys(node).find((k) => k.startsWith('__reactProps'));
  if (!key) return null;
  return (node as unknown as Record<string, Record<string, unknown>>)[key] ?? null;
};

const collectViewports = (container: FakeNode): Array<{ node: FakeNode; props: Record<string, unknown> }> => {
  const found: Array<{ node: FakeNode; props: Record<string, unknown> }> = [];
  const visit = (node: FakeNode) => {
    const props = reactPropsOf(node);
    if (props && typeof props['data-testid'] === 'string' && (props['data-testid'] as string).startsWith('viewport-')) {
      found.push({ node, props });
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(container);
  return found;
};

const wrapperHiddenState = (viewportNode: FakeNode): { className: string; ariaHidden: unknown } => {
  // The real TerminalTabPane wrapper is the direct parent of the viewport
  // probe: <div className="h-full w-full block|hidden" aria-hidden>.
  const parent = viewportNode.parentNode;
  if (!parent) return { className: '', ariaHidden: undefined };
  const props = reactPropsOf(parent);
  return {
    className: typeof props?.['className'] === 'string' ? (props['className'] as string) : '',
    ariaHidden: props?.['aria-hidden'],
  };
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  restores.splice(0).forEach((restore) => restore());
  viewportMounts.clear();
  viewportUnmounts.clear();
  viewportLatestProps.clear();
  viewportInstanceSeq = 0;
  fakeTerminal = {
    async createSession() {
      return { sessionId: 'created-1', cols: 80, rows: 24, status: 'running' };
    },
    connect() {
      return { close: () => undefined };
    },
    async sendInput() {},
    async resize() {},
    async close() {},
  } as unknown as TerminalAPI;
  useTerminalStore.getState().clearAll();
  useSessionUIStore.setState({ currentSessionId: null, newSessionDraft: { open: false } as never });
});

const renderTerminalView = async () => {
  const stub = installDomStub();
  restores.push(stub.restore);
  useSessionUIStore.setState({ currentSessionId: 'sess-1' });
  const root = createRoot(stub.container as unknown as Element);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(TerminalView, { visible: true }));
  });
  await flush();
  await flush();
  return stub.container;
};

const setupTwoTabs = () => {
  useTerminalStore.getState().clearAll();
  useTerminalStore.getState().ensureDirectory('/repo');
  const first = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!.id;
  const second = useTerminalStore.getState().createTab('/repo');
  useTerminalStore.getState().setTabSessionId('/repo', first, 'pty-a');
  useTerminalStore.getState().setTabSessionId('/repo', second, 'pty-b');
  useTerminalStore.getState().setActiveTab('/repo', first);
  return { first, second };
};

describe('terminal reattach preserves viewport identity (mounted)', () => {
  test('tab toggle keeps both panes mounted; hidden pane preserves instance state', async () => {
    const { first, second } = setupTwoTabs();
    const container = await renderTerminalView();

    const keyFor = (tabId: string) => `/repo::${tabId}`;
    let viewports = collectViewports(container);
    // Both tabs render a pane even though only one is active: no unmount on
    // tab switch, so VT state and xterm selection survive.
    expect(viewports).toHaveLength(2);

    const byKey = new Map(viewports.map((v) => [v.props['data-session-key'], v]));
    expect([...byKey.keys()].sort()).toEqual([keyFor(first), keyFor(second)].sort());
    for (const v of viewports) {
      expect(viewportMounts.get(v.props['data-session-key'] as string)).toBe(1);
    }
    const markerBefore = new Map(viewports.map((v) => [v.props['data-session-key'], v.props['data-marker']]));

    const activeBefore = byKey.get(keyFor(first))!;
    const hiddenBefore = byKey.get(keyFor(second))!;
    expect(wrapperHiddenState(activeBefore.node).className).toContain('block');
    expect(wrapperHiddenState(activeBefore.node).className).not.toContain('hidden');
    expect(wrapperHiddenState(activeBefore.node).ariaHidden).toBe(false);
    expect(wrapperHiddenState(hiddenBefore.node).className).toContain('hidden');
    expect(wrapperHiddenState(hiddenBefore.node).ariaHidden).toBe(true);

    // Toggle the active tab. The switch only flips visibility: both viewport
    // instances stay mounted with identical local markers.
    await act(async () => {
      useTerminalStore.getState().setActiveTab('/repo', second);
    });
    await flush();

    viewports = collectViewports(container);
    expect(viewports).toHaveLength(2);
    const byKeyAfter = new Map(viewports.map((v) => [v.props['data-session-key'], v]));
    expect([...byKeyAfter.keys()].sort()).toEqual([keyFor(first), keyFor(second)].sort());
    for (const v of viewports) {
      expect(v.props['data-marker']).toBe(markerBefore.get(v.props['data-session-key']));
      expect(viewportMounts.get(v.props['data-session-key'] as string)).toBe(1);
      expect(viewportUnmounts.get(v.props['data-session-key'] as string) ?? 0).toBe(0);
    }

    const nowActive = byKeyAfter.get(keyFor(second))!;
    const nowHidden = byKeyAfter.get(keyFor(first))!;
    expect(wrapperHiddenState(nowActive.node).className).toContain('block');
    expect(wrapperHiddenState(nowActive.node).ariaHidden).toBe(false);
    expect(wrapperHiddenState(nowHidden.node).className).toContain('hidden');
    expect(wrapperHiddenState(nowHidden.node).ariaHidden).toBe(true);

    // Toggling back still preserves both instances.
    await act(async () => {
      useTerminalStore.getState().setActiveTab('/repo', first);
    });
    await flush();
    viewports = collectViewports(container);
    expect(viewports).toHaveLength(2);
    for (const v of viewports) {
      expect(v.props['data-marker']).toBe(markerBefore.get(v.props['data-session-key']));
      expect(viewportMounts.get(v.props['data-session-key'] as string)).toBe(1);
    }
  });

  test('assigning a PTY id to the same tab keeps the stable sessionKey without remounting', async () => {
    useTerminalStore.getState().clearAll();
    useTerminalStore.getState().ensureDirectory('/repo');
    const tabId = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!.id;
    const container = await renderTerminalView();

    const sessionKey = `/repo::${tabId}`;
    let viewports = collectViewports(container);
    expect(viewports).toHaveLength(1);
    expect(viewports[0]!.props['data-session-key']).toBe(sessionKey);
    const markerBefore = viewports[0]!.props['data-marker'];
    expect(viewportMounts.get(sessionKey)).toBe(1);

    // Fresh PTY assignment for the same tab: the viewport identity is
    // directory+tab, never the PTY id, so the xterm instance (dims/selection)
    // survives instead of remounting.
    await act(async () => {
      useTerminalStore.getState().setTabSessionId('/repo', tabId, 'pty-a');
    });
    await flush();
    await flush();

    viewports = collectViewports(container);
    expect(viewports).toHaveLength(1);
    expect(viewports[0]!.props['data-session-key']).toBe(sessionKey);
    expect(viewports[0]!.props['data-marker']).toBe(markerBefore);
    expect(viewportMounts.get(sessionKey)).toBe(1);
    expect(viewportUnmounts.get(sessionKey) ?? 0).toBe(0);

    // Reassigning to another PTY id on the same tab is still the same pane.
    await act(async () => {
      useTerminalStore.getState().setTabSessionId('/repo', tabId, 'pty-b');
    });
    await flush();
    await flush();

    viewports = collectViewports(container);
    expect(viewports).toHaveLength(1);
    expect(viewports[0]!.props['data-session-key']).toBe(sessionKey);
    expect(viewports[0]!.props['data-marker']).toBe(markerBefore);
    expect(viewportMounts.get(sessionKey)).toBe(1);
    expect(viewportUnmounts.get(sessionKey) ?? 0).toBe(0);
  });
});
