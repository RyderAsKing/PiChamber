import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  ConfigStoreReconciler,
  CONFIG_RECONCILIATION_INITIAL_DELAY_MS,
  CONFIG_RECONCILIATION_MAX_DELAY_MS,
  useConfigStoreReconciliation,
} from './useConfigStoreReconciliation';

type MockTimer = {
  id: number;
  fn: () => void;
  runAt: number;
};

class FakeClock {
  currentTime = 0;
  private nextId = 1;
  private timers = new Map<number, MockTimer>();
  private originalSetTimeout = globalThis.setTimeout;
  private originalClearTimeout = globalThis.clearTimeout;

  install() {
    this.currentTime = 0;
    this.timers.clear();
    globalThis.setTimeout = ((fn: () => void, delay = 0) => {
      const id = this.nextId++;
      this.timers.set(id, { id, fn, runAt: this.currentTime + delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    globalThis.clearTimeout = ((id?: number | ReturnType<typeof setTimeout>) => {
      if (typeof id === 'number') {
        this.timers.delete(id);
      }
    }) as typeof clearTimeout;
  }

  uninstall() {
    globalThis.setTimeout = this.originalSetTimeout;
    globalThis.clearTimeout = this.originalClearTimeout;
    this.timers.clear();
  }

  async advanceTime(ms: number) {
    const targetTime = this.currentTime + ms;
    while (true) {
      let earliest: MockTimer | null = null;
      for (const timer of this.timers.values()) {
        if (timer.runAt <= targetTime) {
          if (!earliest || timer.runAt < earliest.runAt || (timer.runAt === earliest.runAt && timer.id < earliest.id)) {
            earliest = timer;
          }
        }
      }
      if (!earliest) break;
      this.timers.delete(earliest.id);
      this.currentTime = earliest.runAt;
      earliest.fn();
      await Promise.resolve();
    }
    this.currentTime = targetTime;
    await Promise.resolve();
  }

  get pendingTimersCount(): number {
    return this.timers.size;
  }
}

describe('ConfigStoreReconciler unit tests', () => {
  let clock: FakeClock;

  beforeEach(() => {
    clock = new FakeClock();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
  });

  test('reconciles when isInitialized is true, isConnected is false, and connection is ready', async () => {
    const connection = 'ready';
    const isInitialized = true;
    let isConnected = false;
    let initCalls = 0;

    const reconciler = new ConfigStoreReconciler({
      getConnection: () => connection,
      getIsInitialized: () => isInitialized,
      getIsConnected: () => isConnected,
      initializeApp: async () => {
        initCalls += 1;
        isConnected = true;
      },
      isDocumentHidden: () => false,
    });

    reconciler.reconcile();
    await Promise.resolve();

    expect(initCalls).toBe(1);
    expect(isConnected).toBe(true);
    expect(reconciler.isRunning).toBe(false);
    expect(clock.pendingTimersCount).toBe(0);

    reconciler.dispose();
  });

  test('retries with paced exponential backoff and stops when isConnected becomes true', async () => {
    const connection = 'ready';
    const isInitialized = true;
    let isConnected = false;
    let initCalls = 0;

    const reconciler = new ConfigStoreReconciler({
      getConnection: () => connection,
      getIsInitialized: () => isInitialized,
      getIsConnected: () => isConnected,
      initializeApp: async () => {
        initCalls += 1;
        // Succeed on attempt 6
        if (initCalls >= 6) {
          isConnected = true;
        }
      },
      isDocumentHidden: () => false,
    });

    // Attempt 1: immediate
    reconciler.reconcile();
    await Promise.resolve();
    expect(initCalls).toBe(1);
    expect(reconciler.currentBackoffDelayMs).toBe(4000); // next backoff after 2000ms retry
    expect(clock.pendingTimersCount).toBe(1);

    // Attempt 2: after 2000ms
    await clock.advanceTime(1999);
    expect(initCalls).toBe(1);
    await clock.advanceTime(1);
    expect(initCalls).toBe(2);
    expect(reconciler.currentBackoffDelayMs).toBe(8000);

    // Attempt 3: after 4000ms
    await clock.advanceTime(3999);
    expect(initCalls).toBe(2);
    await clock.advanceTime(1);
    expect(initCalls).toBe(3);
    expect(reconciler.currentBackoffDelayMs).toBe(16000);

    // Attempt 4: after 8000ms
    await clock.advanceTime(8000);
    expect(initCalls).toBe(4);
    expect(reconciler.currentBackoffDelayMs).toBe(CONFIG_RECONCILIATION_MAX_DELAY_MS); // capped at 30s

    // Attempt 5: after 16000ms
    await clock.advanceTime(16000);
    expect(initCalls).toBe(5);
    expect(reconciler.currentBackoffDelayMs).toBe(CONFIG_RECONCILIATION_MAX_DELAY_MS); // stays capped at 30s

    // Attempt 6: after 30000ms -> succeeds
    await clock.advanceTime(30000);
    expect(initCalls).toBe(6);
    expect(isConnected).toBe(true);
    expect(reconciler.isRunning).toBe(false);
    expect(reconciler.currentBackoffDelayMs).toBe(CONFIG_RECONCILIATION_INITIAL_DELAY_MS);
    expect(clock.pendingTimersCount).toBe(0);

    // Further time passing does not trigger more calls
    await clock.advanceTime(60000);
    expect(initCalls).toBe(6);

    reconciler.dispose();
  });

  test('does not retry while connection is not ready and cancels pending retry when transport drops', async () => {
    let connection = 'connecting';
    const isInitialized = true;
    const isConnected = false;
    let initCalls = 0;

    const reconciler = new ConfigStoreReconciler({
      getConnection: () => connection,
      getIsInitialized: () => isInitialized,
      getIsConnected: () => isConnected,
      initializeApp: async () => {
        initCalls += 1;
      },
      isDocumentHidden: () => false,
    });

    // When connection is not ready, reconcile does not run
    reconciler.reconcile();
    await Promise.resolve();
    expect(initCalls).toBe(0);
    expect(clock.pendingTimersCount).toBe(0);

    // Connection becomes ready -> runs attempt 1
    connection = 'ready';
    reconciler.reconcile();
    await Promise.resolve();
    expect(initCalls).toBe(1);
    expect(clock.pendingTimersCount).toBe(1);

    // Connection drops to error before timer expires -> timer canceled
    connection = 'error';
    reconciler.reconcile();
    await Promise.resolve();
    expect(clock.pendingTimersCount).toBe(0);
    expect(reconciler.currentBackoffDelayMs).toBe(CONFIG_RECONCILIATION_INITIAL_DELAY_MS);

    // Time advances -> no retry fired while not ready
    await clock.advanceTime(10000);
    expect(initCalls).toBe(1);

    reconciler.dispose();
  });

  test('pauses while document is hidden and resumes promptly on wake', async () => {
    const connection = 'ready';
    const isInitialized = true;
    const isConnected = false;
    let isHidden = true;
    let initCalls = 0;

    const reconciler = new ConfigStoreReconciler({
      getConnection: () => connection,
      getIsInitialized: () => isInitialized,
      getIsConnected: () => isConnected,
      initializeApp: async () => {
        initCalls += 1;
      },
      isDocumentHidden: () => isHidden,
    });

    // Hidden -> does not run
    reconciler.reconcile();
    await Promise.resolve();
    expect(initCalls).toBe(0);
    expect(clock.pendingTimersCount).toBe(0);

    // Document becomes visible -> wake runs immediately
    isHidden = false;
    reconciler.wake();
    await Promise.resolve();
    expect(initCalls).toBe(1);
    expect(clock.pendingTimersCount).toBe(1);

    // Document becomes hidden while waiting for retry -> timer cleared
    isHidden = true;
    reconciler.reconcile();
    await Promise.resolve();
    expect(clock.pendingTimersCount).toBe(0);

    // Time advances while hidden -> no calls
    await clock.advanceTime(10000);
    expect(initCalls).toBe(1);

    // Document becomes visible again -> wakes promptly
    isHidden = false;
    reconciler.wake();
    await Promise.resolve();
    expect(initCalls).toBe(2);

    reconciler.dispose();
  });

  test('resets backoff and cancels timer on runtime switch', async () => {
    const connection = 'ready';
    const isInitialized = true;
    const isConnected = false;
    let initCalls = 0;

    const reconciler = new ConfigStoreReconciler({
      getConnection: () => connection,
      getIsInitialized: () => isInitialized,
      getIsConnected: () => isConnected,
      initializeApp: async () => {
        initCalls += 1;
      },
      isDocumentHidden: () => false,
    });

    reconciler.reconcile();
    await Promise.resolve();
    expect(initCalls).toBe(1);
    expect(reconciler.currentBackoffDelayMs).toBe(4000);
    expect(clock.pendingTimersCount).toBe(1);

    // Runtime switch
    reconciler.resetForRuntimeSwitch();
    expect(reconciler.currentBackoffDelayMs).toBe(CONFIG_RECONCILIATION_INITIAL_DELAY_MS);
    expect(clock.pendingTimersCount).toBe(0);

    reconciler.dispose();
  });

  test('first bootstrap when isInitialized is false runs initializeApp', async () => {
    const connection = 'ready';
    let isInitialized = false;
    let isConnected = false;
    let initCalls = 0;

    const reconciler = new ConfigStoreReconciler({
      getConnection: () => connection,
      getIsInitialized: () => isInitialized,
      getIsConnected: () => isConnected,
      initializeApp: async () => {
        initCalls += 1;
        isInitialized = true;
        isConnected = true;
      },
      isDocumentHidden: () => false,
    });

    reconciler.reconcile();
    await Promise.resolve();
    expect(initCalls).toBe(1);
    expect(isInitialized).toBe(true);
    expect(isConnected).toBe(true);
    expect(clock.pendingTimersCount).toBe(0);

    reconciler.dispose();
  });
});

describe('useConfigStoreReconciliation React hook', () => {
  const installMinimalDom = () => {
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    const setGlobal = (name: string, value: unknown) => {
      descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };
    class ElementStub {}
    const documentListeners = new Map<string, Set<() => void>>();
    const windowListeners = new Map<string, Set<() => void>>();

    const documentStub: Record<string, unknown> = {
      nodeType: 9,
      defaultView: globalThis,
      activeElement: null,
      visibilityState: 'visible',
      addEventListener: (type: string, listener: () => void) => {
        const set = documentListeners.get(type) ?? new Set();
        set.add(listener);
        documentListeners.set(type, set);
      },
      removeEventListener: (type: string, listener: () => void) => {
        documentListeners.get(type)?.delete(listener);
      },
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

    const windowStub: Record<string, unknown> = {
      addEventListener: (type: string, listener: () => void) => {
        const set = windowListeners.get(type) ?? new Set();
        set.add(listener);
        windowListeners.set(type, set);
      },
      removeEventListener: (type: string, listener: () => void) => {
        windowListeners.get(type)?.delete(listener);
      },
    };

    setGlobal('document', documentStub);
    setGlobal('window', windowStub);
    setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
    setGlobal('Element', ElementStub);
    setGlobal('HTMLElement', ElementStub);
    setGlobal('HTMLIFrameElement', ElementStub);
    setGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    return {
      container: container as unknown as Element,
      dispatchVisibility: (state: string) => {
        documentStub.visibilityState = state;
        for (const listener of [...(documentListeners.get('visibilitychange') ?? [])]) {
          listener();
        }
      },
      dispatchOnline: () => {
        for (const listener of [...(windowListeners.get('online') ?? [])]) {
          listener();
        }
      },
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
  });

  test('calls initializeApp on mount when mismatched and wakes on visibility and online', async () => {
    const dom = installMinimalDom();
    restoreDom.push(dom.restore);
    const root = createRoot(dom.container);
    roots.push(root);

    let initCalls = 0;
    let isConnected = false;

    const TestComponent = ({
      connection = 'ready',
      isInitialized = true,
      connected = false,
    }: {
      connection?: string;
      isInitialized?: boolean;
      connected?: boolean;
    }) => {
      useConfigStoreReconciliation({
        connection,
        isInitialized,
        isConnected: connected,
        initializeApp: async () => {
          initCalls += 1;
        },
      });
      return null;
    };

    await act(async () => {
      root.render(<TestComponent connection="ready" isInitialized={true} connected={isConnected} />);
    });

    expect(initCalls).toBe(1);

    // Online event wakes and retries
    await act(async () => {
      dom.dispatchOnline();
    });
    expect(initCalls).toBe(2);

    // Visibility change to visible wakes
    await act(async () => {
      dom.dispatchVisibility('visible');
    });
    expect(initCalls).toBe(3);

    // When connected becomes true, no more calls
    isConnected = true;
    await act(async () => {
      root.render(<TestComponent connection="ready" isInitialized={true} connected={true} />);
    });
    expect(initCalls).toBe(3);
  });
});
