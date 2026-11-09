import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, mock, test } from 'bun:test';

type Entry = { name: string; path: string; isDirectory: boolean };
type PendingRead = { path: string; resolve: (entries: Entry[]) => void };

// Each folder read waits until the test answers it, so the test controls the order.
const reads: PendingRead[] = [];
const answer = async (path: string, names: string[]) => {
  const index = reads.findIndex((read) => read.path === path);
  if (index < 0) throw new Error(`No pending read for ${path}`);
  const [read] = reads.splice(index, 1);
  const base = path.endsWith('/') ? path : `${path}/`;
  await act(async () => {
    read?.resolve(names.map((name) => ({ name, path: `${base}${name}`, isDirectory: true })));
  });
};

mock.module('@/lib/fsApi', () => ({
  getFilesystemHome: async () => '/home/u',
  listLocalDirectory: (path: string) => new Promise<Entry[]>((resolve) => reads.push({ path, resolve })),
  pickLocalDirectory: async () => ({ status: 'cancelled' }),
}));
mock.module('@/components/ui', () => ({ toast: { error: () => undefined } }));
mock.module('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: (selector: (state: { homeDirectory: string }) => unknown) => selector({ homeDirectory: '/home/u' }),
}));
mock.module('@/hooks/useFileSystemAccess', () => ({
  useFileSystemAccess: () => ({ canRequestAccess: false, startAccessing: async () => ({ success: true }) }),
}));
mock.module('@/lib/desktop', () => ({
  canRequestNativeDirectoryAccess: () => false,
  requestDirectoryAccess: async () => ({ success: false }),
}));

const { useDirectoryBrowser } = await import('../useDirectoryBrowser');
type HookResult = ReturnType<typeof useDirectoryBrowser>;

let latest: HookResult | null = null;
const noAddedProjects = new Set<string>();
const Probe = () => {
  latest = useDirectoryBrowser({ open: true, addedProjectPaths: noAddedProjects });
  return null;
};

const roots: Root[] = [];
const restoreFns: Array<() => void> = [];

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
    documentElement: { getAttribute: () => null },
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

const result = () => {
  if (!latest) throw new Error('Hook did not render');
  return latest;
};
const rowNames = () => result().rows.map((row) => (row.type === 'parent' ? '..' : row.name));

/** Renders the hook and answers the home folder's first read. */
const renderAtHome = async () => {
  const dom = installMinimalDom();
  restoreFns.push(dom.restore);
  const root = createRoot(dom.container);
  roots.push(root);
  await act(async () => root.render(<Probe />));
  await answer('/home/u/', ['code', 'notes']);
  expect(result().isSettled).toBe(true);
  expect(rowNames()).toEqual(['code', 'notes']);
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  restoreFns.splice(0).forEach((restore) => restore());
  reads.splice(0);
  latest = null;
});

describe('useDirectoryBrowser folder moves', () => {
  test('opening a folder reads it first, then switches the path and the list together', async () => {
    await renderAtHome();

    let move: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      move = result().navigate('~/code/');
    });

    // Still reading: the path and the list both still show home.
    expect(result().query).toBe('~/');
    expect(rowNames()).toEqual(['code', 'notes']);
    expect(result().isSettled).toBe(true);

    await answer('/home/u/code/', ['api']);

    expect(await move).toBe(true);
    expect(result().query).toBe('~/code/');
    expect(rowNames()).toEqual(['..', 'api']);
    expect(result().rows[0]?.target).toBe('~/');
    expect(result().isSettled).toBe(true);
  });

  test('a newer move wins over one still being read', async () => {
    await renderAtHome();

    let first: Promise<boolean> = Promise.resolve(false);
    let second: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      first = result().navigate('~/code/');
      second = result().navigate('~/notes/');
    });

    await answer('/home/u/notes/', ['drafts']);
    await answer('/home/u/code/', ['api']);

    expect(await second).toBe(true);
    expect(await first).toBe(false);
    expect(result().query).toBe('~/notes/');
    expect(rowNames()).toEqual(['..', 'drafts']);
  });

  test('a typed path keeps the last folder listed, narrowed to what was typed, until its folder is read', async () => {
    await renderAtHome();

    await act(async () => result().setQuery('~/code/'));

    expect(result().isSettled).toBe(false);
    expect(rowNames()).toEqual(['code']);
    // Rows carry their own targets, so the one still shown opens the right folder.
    expect(result().rows[0]?.target).toBe('~/code/');

    await answer('/home/u/code/', ['api']);

    expect(result().isSettled).toBe(true);
    expect(rowNames()).toEqual(['..', 'api']);
  });
});
