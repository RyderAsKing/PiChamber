import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

type ListRow = {
  directory?: string;
  extensions: Array<{ id: string; name: string }>;
  commands: Array<{ name: string; description?: string; source?: string; scope?: string }>;
};

let listCalls = 0;
let listExtensionsImpl: (directory?: string) => Promise<ListRow>;
let runtimeKey = 'test-runtime';

mock.module('@/lib/pi/client', () => ({
  piClient: {
    listExtensions: (directory?: string) => {
      listCalls += 1;
      return listExtensionsImpl(directory);
    },
  },
}));
mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointChanged: () => () => undefined,
}));

const { useInstalledExtensions } = await import('./useInstalledExtensions');

type Snapshot = ReturnType<typeof useInstalledExtensions>;
let snapshot: Snapshot | undefined;

const Probe = ({ directory }: { directory?: string }) => {
  snapshot = useInstalledExtensions(directory);
  return null;
};

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
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

type Mount = { root: Root; restore: () => void };

const activeMounts: Mount[] = [];

const mountProbe = async (directory?: string): Promise<Mount> => {
  const dom = installMinimalDom();
  const container = (globalThis as unknown as { document: { body: unknown } }).document.body as unknown as Element;
  const root = createRoot(container);
  await act(async () => {
    root.render(<Probe directory={directory} />);
  });
  const mount = { root, restore: dom.restore };
  activeMounts.push(mount);
  return mount;
};

const unmountProbe = async (mount: Mount): Promise<void> => {
  const index = activeMounts.indexOf(mount);
  if (index >= 0) activeMounts.splice(index, 1);
  await act(async () => {
    mount.root.unmount();
  });
  mount.restore();
};

describe('useInstalledExtensions', () => {
  beforeEach(() => {
    listCalls = 0;
    snapshot = undefined;
    runtimeKey = 'test-runtime';
    listExtensionsImpl = async () => ({ extensions: [], commands: [] });
  });

  afterEach(async () => {
    while (activeMounts.length > 0) {
      const mount = activeMounts[activeMounts.length - 1];
      await unmountProbe(mount);
    }
  });

  test('lists the extensions and commands the daemon reports', async () => {
    listExtensionsImpl = async () => ({
      directory: '/repo',
      extensions: [
        { id: 'abc123', name: 'pi-mistral-native' },
        { id: 'def456', name: 'pi-btw' },
      ],
      commands: [
        { name: 'btw', description: 'Ask a side question', source: 'extension', scope: 'user' },
        { name: 'deploy', source: 'extension', scope: 'project' },
      ],
    });

    await mountProbe('/repo');

    expect(listCalls).toBe(1);
    expect(snapshot?.extensions).toEqual([
      { id: 'abc123', name: 'pi-mistral-native' },
      { id: 'def456', name: 'pi-btw' },
    ]);
    expect(snapshot?.commands).toEqual([
      { name: 'btw', description: 'Ask a side question', source: 'extension', scope: 'user' },
      { name: 'deploy', source: 'extension', scope: 'project' },
    ]);
    expect(snapshot?.isLoading).toBe(false);
    expect(snapshot?.failed).toBe(false);
  });

  test('keeps the last known list when a refresh fails', async () => {
    listExtensionsImpl = async () => ({
      extensions: [{ id: 'abc123', name: 'pi-btw' }],
      commands: [{ name: 'btw', source: 'extension' }],
    });

    const mount = await mountProbe('/repo');
    expect(snapshot?.extensions).toHaveLength(1);

    listExtensionsImpl = async () => {
      throw new Error('daemon down');
    };
    await act(async () => {
      snapshot?.refresh();
    });

    // The panel keeps showing what it had; the failure is reported beside it
    // rather than blanking the list.
    expect(snapshot?.extensions).toEqual([{ id: 'abc123', name: 'pi-btw' }]);
    expect(snapshot?.commands).toHaveLength(1);
    expect(snapshot?.failed).toBe(true);
    expect(snapshot?.isLoading).toBe(false);

    await unmountProbe(mount);
  });

  test('refetches when the directory changes', async () => {
    const seen: Array<string | undefined> = [];
    listExtensionsImpl = async (directory) => {
      seen.push(directory);
      return { extensions: [{ id: `${directory}-id`, name: `ext-for-${directory}` }], commands: [] };
    };

    const mount = await mountProbe('/alpha');
    expect(snapshot?.extensions[0]?.name).toBe('ext-for-/alpha');

    await act(async () => {
      mount.root.render(<Probe directory="/beta" />);
    });

    expect(seen).toEqual(['/alpha', '/beta']);
    expect(snapshot?.extensions[0]?.name).toBe('ext-for-/beta');

    await unmountProbe(mount);
  });
});
