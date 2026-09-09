import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useChatAutoFollow } from './useChatAutoFollow';
import type {
  UseChatAutoFollowOptions,
  UseChatAutoFollowResult,
} from './autoFollow/autoFollowTypes';

const __dirname = dirname(fileURLToPath(import.meta.url));
const autoFollowSource = readFileSync(join(__dirname, 'useChatAutoFollow.ts'), 'utf-8');

describe('useChatAutoFollow viewport side channel retired (architectural guard)', () => {
  test('has no saved-write side channel', () => {
    expect(autoFollowSource).not.toContain('viewport-store');
    expect(autoFollowSource).not.toContain('saveSnapshot');
    expect(autoFollowSource).not.toContain('queueSave');
    expect(autoFollowSource).not.toContain('SAVE_DEBOUNCE_MS');
  });
});

// ---------------------------------------------------------------------------
// Real-hook harness (useQueuedMessageAutoSend.test.ts / AppEffects.test.tsx
// precedent). Self-contained: simulated scroll element, no extra deps.
// The turn observer is disabled (no onActiveTurnChange) and ResizeObserver is
// left undefined so those effects early-return. This exercises real hook
// state transitions, not browser layout proof.
// ---------------------------------------------------------------------------

type ScrollListener = () => void;

interface FakeScrollElement {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  firstElementChild: null;
  scrollTo: (init: { top: number }) => void;
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  querySelectorAll: () => [];
  listeners: Map<string, Set<() => void>>;
}

const createFakeScrollElement = (): FakeScrollElement => {
  const listeners = new Map<string, Set<() => void>>();
  const el: FakeScrollElement = {
    scrollTop: 0,
    scrollHeight: 800,
    clientHeight: 600,
    firstElementChild: null,
    scrollTo: (init) => {
      el.scrollTop = init.top;
    },
    addEventListener: (type, listener) => {
      const fn = listener as unknown as () => void;
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(fn);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener as unknown as () => void);
    },
    querySelectorAll: () => [],
    listeners,
  };
  return el;
};

const installMinimalDom = (): (() => void) => {
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
};

const roots: Root[] = [];
const domRestores: Array<() => void> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  for (const restore of domRestores.splice(0)) restore();
});

function Probe({
  fakeEl,
  options,
  onResult,
}: {
  fakeEl: FakeScrollElement;
  options: UseChatAutoFollowOptions;
  onResult: (result: UseChatAutoFollowResult) => void;
}) {
  const result = useChatAutoFollow(options);
  onResult(result);
  // Simulated container: assign before the hook's layout effect observes it.
  if (result.scrollRef.current !== (fakeEl as unknown as HTMLDivElement)) {
    result.scrollRef.current = fakeEl as unknown as HTMLDivElement;
  }
  return null;
}

const baseOptions = (overrides?: Partial<UseChatAutoFollowOptions>): UseChatAutoFollowOptions => ({
  currentSessionId: 's1',
  currentSessionKey: 's1-key',
  sessionMessageCount: 2,
  sessionIsWorking: false,
  isMobile: false,
  ...overrides,
});

async function mountAutoFollow(options: UseChatAutoFollowOptions, fakeEl: FakeScrollElement) {
  domRestores.push(installMinimalDom());
  const container = (globalThis as unknown as { document: { body: Element } }).document.body;
  const root = createRoot(container);
  roots.push(root);
  let latest: UseChatAutoFollowResult | null = null;
  const renderOptions = (next: UseChatAutoFollowOptions) =>
    act(async () => {
      root.render(React.createElement(Probe, { fakeEl, options: next, onResult: (r) => { latest = r; } }));
    });
  await renderOptions(options);
  // Flush the container-attach layout effect + gesture subscription.
  await act(async () => {});
  const get = (): UseChatAutoFollowResult => {
    if (!latest) throw new Error('hook did not render');
    return latest;
  };
  return { root, get, renderOptions };
}

const getScrollHandler = (fakeEl: FakeScrollElement): ScrollListener => {
  const handlers = fakeEl.listeners.get('scroll');
  if (!handlers || handlers.size === 0) throw new Error('no scroll listener subscribed');
  return [...handlers][0] as ScrollListener;
};

describe('useChatAutoFollow real hook transitions (simulated scroll element)', () => {
  test('restoreSnapshot pins to following and scrolls to bottom', async () => {
    const fakeEl = createFakeScrollElement();
    fakeEl.scrollTop = 0;
    const { get } = await mountAutoFollow(baseOptions(), fakeEl);

    let restored: boolean | undefined;
    await act(async () => {
      restored = await get().restoreSnapshot();
    });

    expect(restored).toBe(false);
    expect(get().state).toBe('following');
    expect(get().isPinned).toBe(true);
    expect(fakeEl.scrollTop).toBe(fakeEl.scrollHeight + 4096);
    expect(get().isOverflowing).toBe(true);
  });

  test('user scroll upward releases and does not snap back', async () => {
    const fakeEl = createFakeScrollElement();
    const { get } = await mountAutoFollow(baseOptions(), fakeEl);
    await act(async () => {
      await get().restoreSnapshot();
    });
    expect(get().state).toBe('following');

    fakeEl.scrollTop = 0;
    await act(async () => {
      getScrollHandler(fakeEl)();
    });

    expect(get().state).toBe('released');
    expect(get().isPinned).toBe(false);
    expect(fakeEl.scrollTop).toBe(0);
  });

  test('unrelated message-count rerender does not restore saved position', async () => {
    const fakeEl = createFakeScrollElement();
    const { get, renderOptions } = await mountAutoFollow(baseOptions(), fakeEl);
    await act(async () => {
      await get().restoreSnapshot();
    });
    fakeEl.scrollTop = 0;
    await act(async () => {
      getScrollHandler(fakeEl)();
    });
    expect(get().state).toBe('released');

    await renderOptions(baseOptions({ sessionMessageCount: 3 }));
    await act(async () => {});

    expect(get().state).toBe('released');
    expect(get().isPinned).toBe(false);
    expect(fakeEl.scrollTop).toBe(0);
  });

  test('unmount clears queued timers', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const pending = new Map<unknown, () => void>();
    const trackTimeout = ((callback: () => void, delay?: number, ...args: unknown[]) => {
      const id = originalSetTimeout(() => {
        pending.delete(id);
        callback();
      }, delay, ...args);
      pending.set(id, callback);
      return id;
    }) as unknown as typeof setTimeout;
    const trackClear = ((id: unknown) => {
      pending.delete(id);
      return originalClearTimeout(id as ReturnType<typeof setTimeout>);
    }) as unknown as typeof clearTimeout;
    globalThis.setTimeout = trackTimeout;
    globalThis.clearTimeout = trackClear;
    try {
      const fakeEl = createFakeScrollElement();
      const mounted = await mountAutoFollow(baseOptions(), fakeEl);
      await act(async () => {
        await mounted.get().restoreSnapshot();
      });
      expect(pending.size).toBeGreaterThan(0);
      await act(async () => {
        await new Promise((resolve) => originalSetTimeout(resolve, 0));
      });
      const queuedBeforeUnmount = pending.size;
      expect(queuedBeforeUnmount).toBeGreaterThan(0);

      const index = roots.indexOf(mounted.root);
      if (index >= 0) roots.splice(index, 1);
      await act(async () => mounted.root.unmount());
      expect(pending.size).toBe(0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
