import { describe, expect, test } from 'bun:test';

import {
  installStandaloneViewportInsets,
  resolveViewportBottomStrip,
  type StandaloneViewportSample,
} from './standaloneViewportInsets';

// iPhone 16 Pro, portrait. Values from WebKit bug 313800 and the #203 screenshots.
const iphone16Pro: StandaloneViewportSample = {
  innerWidth: 402,
  innerHeight: 874,
  screenWidth: 402,
  screenHeight: 874,
  safeAreaTop: 62,
};

describe('resolveViewportBottomStrip', () => {
  test('a full-height standalone web view has no strip', () => {
    expect(resolveViewportBottomStrip(iphone16Pro)).toBe(0);
  });

  test('a web view short by exactly the top inset reports that strip', () => {
    expect(resolveViewportBottomStrip({ ...iphone16Pro, innerHeight: 812 })).toBe(62);
    // iPhone 16 Pro Max on the iOS 27 beta (bug 313800 comment 3).
    expect(resolveViewportBottomStrip({
      innerWidth: 440, innerHeight: 894, screenWidth: 440, screenHeight: 956, safeAreaTop: 62,
    })).toBe(62);
  });

  test('no top inset means the web view is not under the status bar', () => {
    // iOS 26.1 letterboxing (bug 301994): the missing height is above the page.
    expect(resolveViewportBottomStrip({ ...iphone16Pro, innerHeight: 812, safeAreaTop: 0 })).toBe(0);
  });

  test('other shortfalls are inconclusive so the last value is kept', () => {
    // Keyboard-sized resize.
    expect(resolveViewportBottomStrip({ ...iphone16Pro, innerHeight: 520 })).toBeNull();
  });

  test('landscape compares against the swapped screen size', () => {
    expect(resolveViewportBottomStrip({
      innerWidth: 874, innerHeight: 402, screenWidth: 402, screenHeight: 874, safeAreaTop: 0,
    })).toBe(0);
    expect(resolveViewportBottomStrip({
      innerWidth: 874, innerHeight: 382, screenWidth: 402, screenHeight: 874, safeAreaTop: 20,
    })).toBe(20);
  });

  test('windowed or split-view apps are left alone', () => {
    expect(resolveViewportBottomStrip({
      innerWidth: 694, innerHeight: 1000, screenWidth: 1032, screenHeight: 1376, safeAreaTop: 24,
    })).toBe(0);
  });

  test('invalid measurements are inconclusive', () => {
    expect(resolveViewportBottomStrip({ ...iphone16Pro, innerHeight: 0 })).toBeNull();
    expect(resolveViewportBottomStrip({ ...iphone16Pro, safeAreaTop: Number.NaN })).toBeNull();
  });
});

type Listener = () => void;

const createListenerTarget = () => {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener: (type: string, listener: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener);
    },
    dispatch: (type: string) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
    count: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
  };
};

// Minimal iOS standalone environment: just the globals the installer reads.
const installFakeIosStandalone = (options: { capacitor?: boolean; standalone?: boolean } = {}) => {
  const properties = new Map<string, string>();
  const probes = new Set<object>();
  const windowEvents = createListenerTarget();
  const visualViewportEvents = createListenerTarget();
  const documentEvents = createListenerTarget();
  const geometry = { innerWidth: 402, innerHeight: 812, safeAreaTop: 62 };

  const documentElement = {
    classList: { contains: (name: string) => name === 'oc-capacitor-app' && options.capacitor === true },
    style: {
      setProperty: (name: string, value: string) => { properties.set(name, value); },
      removeProperty: (name: string) => { properties.delete(name); },
    },
  };
  const fakeDocument = {
    documentElement,
    body: {
      appendChild: (node: object) => { probes.add(node); },
    },
    createElement: () => {
      const probe = {
        style: { cssText: '' },
        setAttribute: () => {},
        remove: () => { probes.delete(probe); },
      };
      return probe;
    },
    addEventListener: documentEvents.addEventListener,
    removeEventListener: documentEvents.removeEventListener,
  };
  const fakeWindow = {
    get innerWidth() { return geometry.innerWidth; },
    get innerHeight() { return geometry.innerHeight; },
    screen: { width: 402, height: 874 },
    CSS: { supports: (property: string) => property === '-webkit-touch-callout' },
    matchMedia: (query: string) => ({ matches: query === '(display-mode: standalone)' && options.standalone !== false }),
    getComputedStyle: () => ({ paddingTop: `${geometry.safeAreaTop}px` }),
    visualViewport: visualViewportEvents,
    addEventListener: windowEvents.addEventListener,
    removeEventListener: windowEvents.removeEventListener,
  };

  const globals = globalThis as Record<string, unknown>;
  const previous = { window: globals.window, document: globals.document, navigator: globals.navigator };
  globals.window = fakeWindow;
  globals.document = fakeDocument;
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true });

  return {
    geometry,
    properties,
    probes,
    listenerCount: () => windowEvents.count() + visualViewportEvents.count(),
    resize: () => windowEvents.dispatch('resize'),
    restore: () => {
      globals.window = previous.window;
      globals.document = previous.document;
      Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true, writable: true });
    },
  };
};

describe('installStandaloneViewportInsets', () => {
  test('publishes the strip, removes it once iOS restores the full viewport, and cleans up', () => {
    const env = installFakeIosStandalone();
    try {
      const uninstall = installStandaloneViewportInsets();
      expect(env.properties.get('--oc-viewport-bottom-strip')).toBe('62px');
      expect(env.probes.size).toBe(0);

      // Keyboard-sized resize is inconclusive: keep the last value.
      env.geometry.innerHeight = 520;
      env.resize();
      expect(env.properties.get('--oc-viewport-bottom-strip')).toBe('62px');

      // iOS grows the viewport once <html> is screen-tall.
      env.geometry.innerHeight = 874;
      env.resize();
      expect(env.properties.has('--oc-viewport-bottom-strip')).toBe(false);

      env.geometry.innerHeight = 812;
      env.resize();
      expect(env.properties.get('--oc-viewport-bottom-strip')).toBe('62px');

      uninstall();
      expect(env.properties.has('--oc-viewport-bottom-strip')).toBe(false);
      expect(env.listenerCount()).toBe(0);
    } finally {
      env.restore();
    }
  });

  test('does nothing outside an iOS Home Screen app', () => {
    for (const options of [{ capacitor: true }, { standalone: false }]) {
      const env = installFakeIosStandalone(options);
      try {
        installStandaloneViewportInsets()();
        expect(env.properties.size).toBe(0);
        expect(env.listenerCount()).toBe(0);
      } finally {
        env.restore();
      }
    }
  });
});
