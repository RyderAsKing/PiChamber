import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, mock, test } from 'bun:test';

type Hit = { name: string; path: string; relativePath: string; extension?: string };
let searchImpl: (directory: string, query: string) => Promise<Hit[]> = async () => [];

// The hook reads only `searchFiles` from the store. It must be one stable
// function, as the real store's is: the hook's effect depends on it.
const searchFiles = (directory: string, query: string) => searchImpl(directory, query);
mock.module('@/stores/useFileSearchStore', () => ({
  useFileSearchStore: (selector: (state: { searchFiles: typeof searchImpl }) => unknown) =>
    selector({ searchFiles }),
}));

const { useFilesViewSearch } = await import('./useFilesViewSearch');

type HookOptions = Parameters<typeof useFilesViewSearch>[0];
let latest: ReturnType<typeof useFilesViewSearch> | null = null;
const Probe = (props: HookOptions) => {
  latest = useFilesViewSearch(props);
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
    container: container as unknown as Element,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

let root: Root | null = null;
let restore: (() => void) | null = null;

const render = async (props: HookOptions) => {
  if (!root) {
    const dom = installMinimalDom();
    restore = dom.restore;
    root = createRoot(dom.container);
  }
  const current = root;
  await act(async () => {
    current.render(<Probe {...props} />);
  });
};

// Past the hook's 200ms debounce, letting the search settle.
const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 260));
});

afterEach(async () => {
  const current = root;
  if (current) await act(async () => current.unmount());
  root = null;
  restore?.();
  restore = null;
  latest = null;
  searchImpl = async () => [];
});

const options = (query: string): HookOptions => ({
  directory: '/repo',
  query,
  chrome: 'desktop',
  showGitignored: false,
});

describe('useFilesViewSearch', () => {
  test('counts as searching from the first keystroke, before the debounce sends it', async () => {
    await render(options(''));
    await render(options('bil'));
    expect(latest?.searching).toBe(true);
    expect(latest?.failed).toBe(false);
  });

  test('a failed search reports failure instead of an empty match list', async () => {
    searchImpl = async () => { throw new Error('offline'); };
    await render(options('billing'));
    await settle();
    expect(latest).toMatchObject({ results: [], searching: false, failed: true });
  });

  test('typing again clears the failure while the new query is pending', async () => {
    searchImpl = async () => { throw new Error('offline'); };
    await render(options('billing'));
    await settle();
    await render(options('billing.ts'));
    expect(latest).toMatchObject({ searching: true, failed: false });
  });

  test('keeps git internals out of the hits', async () => {
    searchImpl = async () => [
      { name: 'billing.ts', path: '/repo/billing.ts', relativePath: 'billing.ts', extension: 'ts' },
      { name: 'config', path: '/repo/.git/config', relativePath: '.git/config' },
    ];
    await render(options('i'));
    await settle();
    expect(latest?.failed).toBe(false);
    expect(latest?.results.map((hit) => hit.relativePath)).toEqual(['billing.ts']);
  });
});
