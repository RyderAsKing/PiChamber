import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, mock, test } from 'bun:test';

let resolveSettingsSync: (() => void) | null = null;
let appearanceAutoSaveStarts = 0;
let appearanceAutoSaveStops = 0;
let modelPrefsAutoSaveStarts = 0;
let modelPrefsAutoSaveStops = 0;

mock.module('@/components/layout/MainLayout', () => ({ MainLayout: () => null }));
mock.module('@/components/ui/sonner', () => ({ Toaster: () => null }));
mock.module('@/components/ui/ErrorBoundary', () => ({ ErrorBoundary: () => null }));
mock.module('@/components/ui/tooltip', () => ({ TooltipProvider: ({ children }: React.PropsWithChildren) => children }));
mock.module('@/contexts/RuntimeAPIProvider', () => ({ RuntimeAPIProvider: ({ children }: React.PropsWithChildren) => children }));
mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: () => null,
  registerRuntimeAPIs: () => undefined,
}));
mock.module('@/apps/AppEffects', () => ({ SyncAppEffects: () => null }));
mock.module('@/apps/runtimeEndpointReset', () => ({ resetAppForRuntimeEndpointChange: () => undefined }));
mock.module('@/apps/useAppFontEffects', () => ({ useAppFontEffects: () => undefined }));
mock.module('@/sync/pi-session-context', () => ({ PiSessionProvider: ({ children }: React.PropsWithChildren) => children }));
mock.module('@/contexts/FireworksContext', () => ({ FireworksProvider: ({ children }: React.PropsWithChildren) => children }));
mock.module('@/components/perf/PerfHudHost', () => ({ PerfHudHost: () => null }));
mock.module('@/components/worktree/WorktreeCreationToasts', () => ({ WorktreeCreationToasts: () => null }));
mock.module('@/hooks/useRouter', () => ({ useRouter: () => undefined }));
mock.module('@/hooks/useWindowTitle', () => ({ WindowTitleEffect: () => null }));
mock.module('@/lib/runtime-switch', () => ({ subscribeRuntimeEndpointChanged: () => () => undefined }));
mock.module('@/lib/persistence', () => ({
  syncDesktopSettings: () => new Promise<void>((resolve) => {
    resolveSettingsSync = resolve;
  }),
}));
mock.module('@/lib/appearanceAutoSave', () => ({
  startAppearanceAutoSave: () => {
    appearanceAutoSaveStarts += 1;
    return () => {
      appearanceAutoSaveStops += 1;
    };
  },
}));
mock.module('@/lib/modelPrefsAutoSave', () => ({
  startModelPrefsAutoSave: () => {
    modelPrefsAutoSaveStarts += 1;
    return () => {
      modelPrefsAutoSaveStops += 1;
    };
  },
}));

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
  resolveSettingsSync = null;
  appearanceAutoSaveStarts = 0;
  appearanceAutoSaveStops = 0;
  modelPrefsAutoSaveStarts = 0;
  modelPrefsAutoSaveStops = 0;
});

describe('App settings bootstrap', () => {
  test('starts all shared settings autosave after the initial settings sync', async () => {
    const App = (await import('./App')).default;
    const dom = installMinimalDom();
    restoreDom.push(dom.restore);
    const root = createRoot(dom.container);
    roots.push(root);

    await act(async () => {
      root.render(<App apis={{ runtime: { platform: 'web', isDesktop: false } } as never} />);
    });

    expect(appearanceAutoSaveStarts).toBe(0);
    expect(modelPrefsAutoSaveStarts).toBe(0);

    await act(async () => {
      resolveSettingsSync?.();
      await Promise.resolve();
    });

    expect(appearanceAutoSaveStarts).toBe(1);
    expect(modelPrefsAutoSaveStarts).toBe(1);

    await act(async () => root.unmount());
    roots.pop();
    expect(appearanceAutoSaveStops).toBe(1);
    expect(modelPrefsAutoSaveStops).toBe(1);
  });
});
