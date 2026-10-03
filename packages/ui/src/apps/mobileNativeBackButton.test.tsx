import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type ListenerCallback = (data: { canGoBack?: boolean }) => void;

const listeners: Map<string, Set<ListenerCallback>> = new Map();
let minimizeAppCalls = 0;
let removeCalls = 0;
let addListenerCalls = 0;

const mockApp = {
  addListener: mock((eventName: string, callback: ListenerCallback) => {
    addListenerCalls += 1;
    let set = listeners.get(eventName);
    if (!set) {
      set = new Set();
      listeners.set(eventName, set);
    }
    set.add(callback);
    return Promise.resolve({
      remove: () => {
        removeCalls += 1;
        set?.delete(callback);
        return Promise.resolve();
      },
    });
  }),
  minimizeApp: mock(async () => {
    minimizeAppCalls += 1;
  }),
};

mock.module('@capacitor/app', () => ({
  App: mockApp,
}));

import {
  dispatchNativeAndroidBackButton,
  getNativeAndroidBackButtonHandlerCountForTests,
  installNativeAndroidBackButtonListener,
  uninstallNativeAndroidBackButtonListenerForTests,
  useNativeAndroidBackButton,
} from './mobileNativeChrome';

const noop = () => undefined;

const installDom = () => {
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
    addEventListener: noop,
    removeEventListener: noop,
  };
  const makeNode = (tagName = 'div') => {
    const node: Record<string, unknown> = {
      nodeType: 1,
      tagName: tagName.toUpperCase(),
      nodeName: tagName.toUpperCase(),
      ownerDocument: documentStub,
      parentNode: null,
      childNodes: [],
      children: [],
      style: {
        getPropertyValue: () => '',
        getPropertyPriority: () => '',
        setProperty: noop,
        removeProperty: noop,
      },
      classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
      setAttribute: noop,
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
      (node.children as unknown[]).push(child);
      if (child && typeof child === 'object') {
        child.parentNode = node;
      }
      return child;
    };
    node.insertBefore = (child: Record<string, unknown>) => (node.appendChild as (c: unknown) => unknown)(child);
    node.removeChild = (child: Record<string, unknown>) => {
      const list = node.childNodes as unknown[];
      const idx = list.indexOf(child);
      if (idx !== -1) list.splice(idx, 1);
      const clist = node.children as unknown[];
      const cidx = clist.indexOf(child);
      if (cidx !== -1) clist.splice(cidx, 1);
      if (child && typeof child === 'object') {
        child.parentNode = null;
      }
      return child;
    };
    return node;
  };
  documentStub.createElement = makeNode;
  documentStub.createElementNS = (_ns: string, tag: string) => makeNode(tag);
  documentStub.createTextNode = (text: string) => ({ nodeType: 3, nodeName: '#text', textContent: text, parentNode: null });
  documentStub.getElementById = () => null;
  const container = makeNode('div');
  documentStub.documentElement = container;
  documentStub.body = container;
  documentStub.defaultView = globalThis;
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('navigator', { userAgent: 'test', onLine: true });
  setGlobal('location', { search: '', protocol: 'capacitor:', hostname: 'localhost', origin: 'capacitor://localhost', href: 'capacitor://localhost/' });
  setGlobal('matchMedia', () => ({ matches: false, addEventListener: noop, removeEventListener: noop }));
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  class MutationObserverStub {
    observe = noop;
    disconnect = noop;
    takeRecords = () => [];
  }
  setGlobal('MutationObserver', MutationObserverStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
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

const flush = async (rounds = 4) => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const triggerNativeBackButton = () => {
  const set = listeners.get('backButton');
  if (set) {
    set.forEach((cb) => cb({ canGoBack: false }));
  }
};

describe('Android hardware back button handling', () => {
  beforeEach(async () => {
    listeners.clear();
    minimizeAppCalls = 0;
    removeCalls = 0;
    addListenerCalls = 0;
    await uninstallNativeAndroidBackButtonListenerForTests();
  });

  afterEach(async () => {
    while (roots.length > 0) {
      const root = roots.pop();
      await act(async () => {
        root?.unmount();
      });
    }
    while (restores.length > 0) {
      restores.pop()?.();
    }
    await uninstallNativeAndroidBackButtonListenerForTests();
  });

  test('registers exactly one native listener across multiple hook mounts and callback changes', async () => {
    const dom = installDom();
    restores.push(dom.restore);

    const ComponentA: React.FC<{ onBack: () => boolean }> = ({ onBack }) => {
      useNativeAndroidBackButton(onBack);
      return null;
    };

    const ComponentB: React.FC<{ onBack: () => boolean }> = ({ onBack }) => {
      useNativeAndroidBackButton(onBack);
      return null;
    };

    const root = createRoot(dom.container);
    roots.push(root);

    let onBackA = () => false;
    let onBackB = () => true;

    await act(async () => {
      root.render(
        <div>
          <ComponentA onBack={onBackA} />
          <ComponentB onBack={onBackB} />
        </div>,
      );
    });
    await flush();

    // Exactly one native listener on @capacitor/app
    expect(addListenerCalls).toBe(1);
    expect(listeners.get('backButton')?.size).toBe(1);
    expect(getNativeAndroidBackButtonHandlerCountForTests()).toBe(2);

    // Re-rendering with changed onBack callbacks does NOT register or remove native listeners
    onBackA = () => true;
    onBackB = () => false;

    await act(async () => {
      root.render(
        <div>
          <ComponentA onBack={onBackA} />
          <ComponentB onBack={onBackB} />
        </div>,
      );
    });
    await flush();

    expect(addListenerCalls).toBe(1);
    expect(removeCalls).toBe(0);
    expect(listeners.get('backButton')?.size).toBe(1);
    expect(getNativeAndroidBackButtonHandlerCountForTests()).toBe(2);
  });

  test('executes handlers in LIFO order and stops on consumption', async () => {
    const dom = installDom();
    restores.push(dom.restore);

    const callOrder: string[] = [];

    const Component: React.FC<{ name: string; consumes: boolean }> = ({ name, consumes }) => {
      useNativeAndroidBackButton(() => {
        callOrder.push(name);
        return consumes;
      });
      return null;
    };

    const root = createRoot(dom.container);
    roots.push(root);

    await act(async () => {
      root.render(
        <div>
          <Component name="first" consumes={false} />
          <Component name="second" consumes={true} />
          <Component name="third" consumes={true} />
        </div>,
      );
    });
    await flush();

    expect(getNativeAndroidBackButtonHandlerCountForTests()).toBe(3);

    // Trigger back: 'third' was mounted last (top of stack), returns true, so 'second' and 'first' should not be called
    triggerNativeBackButton();
    expect(callOrder).toEqual(['third']);
    expect(minimizeAppCalls).toBe(0);

    // Mount only first and second (unmount third)
    callOrder.length = 0;
    await act(async () => {
      root.render(
        <div>
          <Component name="first" consumes={false} />
          <Component name="second" consumes={true} />
        </div>,
      );
    });
    await flush();

    expect(getNativeAndroidBackButtonHandlerCountForTests()).toBe(2);

    triggerNativeBackButton();
    expect(callOrder).toEqual(['second']);
    expect(minimizeAppCalls).toBe(0);

    // Mount only first (unmount second)
    callOrder.length = 0;
    await act(async () => {
      root.render(
        <div>
          <Component name="first" consumes={false} />
        </div>,
      );
    });
    await flush();

    expect(getNativeAndroidBackButtonHandlerCountForTests()).toBe(1);

    // 'first' returns false -> falls through to minimizeApp
    triggerNativeBackButton();
    expect(callOrder).toEqual(['first']);
    expect(minimizeAppCalls).toBe(1);
  });

  test('falls through to minimizeApp when handler stack is empty', async () => {
    const dom = installDom();
    restores.push(dom.restore);

    await installNativeAndroidBackButtonListener();
    expect(addListenerCalls).toBe(1);
    expect(getNativeAndroidBackButtonHandlerCountForTests()).toBe(0);

    triggerNativeBackButton();
    expect(minimizeAppCalls).toBe(1);
  });

  test('unmount unregisters handler from stack', async () => {
    const dom = installDom();
    restores.push(dom.restore);

    const Component: React.FC<{ onBack: () => boolean }> = ({ onBack }) => {
      useNativeAndroidBackButton(onBack);
      return null;
    };

    const root = createRoot(dom.container);
    roots.push(root);

    await act(async () => {
      root.render(<Component onBack={() => true} />);
    });
    await flush();

    expect(getNativeAndroidBackButtonHandlerCountForTests()).toBe(1);

    await act(async () => {
      root.render(<div />);
    });
    await flush();

    expect(getNativeAndroidBackButtonHandlerCountForTests()).toBe(0);
    // Native listener remains installed for lifetime
    expect(listeners.get('backButton')?.size).toBe(1);
    expect(removeCalls).toBe(0);

    // Back button now falls through to minimizeApp
    triggerNativeBackButton();
    expect(minimizeAppCalls).toBe(1);
  });

  test('invokes latest onBack callback without re-registering', async () => {
    const dom = installDom();
    restores.push(dom.restore);

    let state = 'initial';
    const Component: React.FC<{ value: string }> = ({ value }) => {
      useNativeAndroidBackButton(() => {
        state = value;
        return true;
      });
      return null;
    };

    const root = createRoot(dom.container);
    roots.push(root);

    await act(async () => {
      root.render(<Component value="first-value" />);
    });
    await flush();

    await act(async () => {
      root.render(<Component value="updated-value" />);
    });
    await flush();

    triggerNativeBackButton();
    expect(state).toBe('updated-value');
    expect(addListenerCalls).toBe(1);
    expect(removeCalls).toBe(0);
  });

  test('handler throwing an error falls through to next handler instead of crashing', async () => {
    const dom = installDom();
    restores.push(dom.restore);

    const callLog: string[] = [];

    const BadComponent: React.FC = () => {
      useNativeAndroidBackButton(() => {
        callLog.push('bad');
        throw new Error('boom');
      });
      return null;
    };

    const GoodComponent: React.FC = () => {
      useNativeAndroidBackButton(() => {
        callLog.push('good');
        return true;
      });
      return null;
    };

    const root = createRoot(dom.container);
    roots.push(root);

    await act(async () => {
      root.render(
        <div>
          <GoodComponent />
          <BadComponent />
        </div>,
      );
    });
    await flush();

    triggerNativeBackButton();
    expect(callLog).toEqual(['bad', 'good']);
    expect(minimizeAppCalls).toBe(0);
  });

  test('dispatchNativeAndroidBackButton can be called directly and returns boolean', async () => {
    const dom = installDom();
    restores.push(dom.restore);

    expect(dispatchNativeAndroidBackButton()).toBe(false);

    const Component: React.FC = () => {
      useNativeAndroidBackButton(() => true);
      return null;
    };

    const root = createRoot(dom.container);
    roots.push(root);

    await act(async () => {
      root.render(<Component />);
    });
    await flush();

    expect(dispatchNativeAndroidBackButton()).toBe(true);
  });

  test('does not register listener or stack handlers on web platform', async () => {
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
      addEventListener: noop,
      removeEventListener: noop,
    };
    const makeNode = (tagName = 'div') => {
      const node: Record<string, unknown> = {
        nodeType: 1,
        tagName: tagName.toUpperCase(),
        nodeName: tagName.toUpperCase(),
        ownerDocument: documentStub,
        parentNode: null,
        childNodes: [],
        children: [],
        style: { getPropertyValue: () => '', getPropertyPriority: () => '', setProperty: noop, removeProperty: noop },
        classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
        setAttribute: noop,
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
        (node.children as unknown[]).push(child);
        if (child && typeof child === 'object') {
          child.parentNode = node;
        }
        return child;
      };
      node.insertBefore = (child: Record<string, unknown>) => (node.appendChild as (c: unknown) => unknown)(child);
      node.removeChild = (child: Record<string, unknown>) => {
        const list = node.childNodes as unknown[];
        const idx = list.indexOf(child);
        if (idx !== -1) list.splice(idx, 1);
        const clist = node.children as unknown[];
        const cidx = clist.indexOf(child);
        if (cidx !== -1) clist.splice(cidx, 1);
        if (child && typeof child === 'object') {
          child.parentNode = null;
        }
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
    documentStub.defaultView = globalThis;
    setGlobal('document', documentStub);
    setGlobal('window', globalThis);
    setGlobal('navigator', { userAgent: 'test', onLine: true });
    setGlobal('location', { search: '', protocol: 'https:', hostname: 'example.com', origin: 'https://example.com', href: 'https://example.com/' });
    setGlobal('matchMedia', () => ({ matches: false, addEventListener: noop, removeEventListener: noop }));
    setGlobal('Element', ElementStub);
    setGlobal('HTMLElement', ElementStub);
    setGlobal('HTMLIFrameElement', ElementStub);
    setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setGlobal('Capacitor', undefined);

    const restoreWebDom = () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
    restores.push(restoreWebDom);

    const Component: React.FC = () => {
      useNativeAndroidBackButton(() => true);
      return null;
    };

    const root = createRoot(container as unknown as Element);
    roots.push(root);

    await act(async () => {
      root.render(<Component />);
    });
    await flush();

    expect(addListenerCalls).toBe(0);
    expect(getNativeAndroidBackButtonHandlerCountForTests()).toBe(0);
  });

  test('MobileQrScannerOverlay closes on back button press and unregisters on cancel', async () => {
    const dom = installDom();
    restores.push(dom.restore);

    let cancelCalls = 0;
    const { MobileQrScannerOverlay } = await import('./MobileQrScannerOverlay');

    const root = createRoot(dom.container);
    roots.push(root);

    await act(async () => {
      root.render(<MobileQrScannerOverlay onCancel={() => { cancelCalls += 1; }} />);
    });
    await flush();

    expect(getNativeAndroidBackButtonHandlerCountForTests()).toBe(1);
    expect(addListenerCalls).toBe(1);

    // Trigger back button: cancels the scanner overlay and consumes the event
    triggerNativeBackButton();
    expect(cancelCalls).toBe(1);
    expect(minimizeAppCalls).toBe(0);

    // Unmount overlay
    await act(async () => {
      root.render(<div />);
    });
    await flush();

    expect(getNativeAndroidBackButtonHandlerCountForTests()).toBe(0);

    // Subsequent back button falls through to minimizeApp
    triggerNativeBackButton();
    expect(minimizeAppCalls).toBe(1);
  });
});
