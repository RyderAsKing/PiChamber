import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, test } from 'bun:test';

import { areFileNodesEqual, shouldEnableFilesTree, useFilesTree } from './useFilesTree';
import type { FileNode } from './filesViewModel';

const roots: Root[] = [];
const restoreDom: Array<() => void> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  restoreDom.splice(0).forEach((restore) => restore());
});

const installMinimalDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();

  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  };

  class ElementStub {}

  const documentStub: Record<string, unknown> = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    hidden: false,
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

  return {
    container: container as unknown as Element,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, name);
        }
      }
    },
  };
};

const setup = () => {
  const dom = installMinimalDom();
  restoreDom.push(dom.restore);
  const root = createRoot(dom.container);
  roots.push(root);
  return root;
};

const flush = async (ms = 10) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

type Entry = { name: string; path: string; isDirectory: boolean; size?: number };

const makeFiles = (
  resolveEntries: (dir: string) => Entry[],
  opts?: { failDirs?: Record<string, string> },
) => {
  const calls: string[] = [];
  const failDirs = opts?.failDirs ?? {};

  return {
    calls,
    files: {
      listDirectory: async (dir: string) => {
        calls.push(dir);
        if (failDirs[dir]) {
          throw new Error(failDirs[dir]);
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { directory: dir, entries: resolveEntries(dir) };
      },
    },
  };
};

const makeDeferredFiles = (resolveEntries: (dir: string) => Entry[]) => {
  const calls: string[] = [];
  const resolvers: Array<() => void> = [];

  return {
    calls,
    releaseAll: () => {
      while (resolvers.length > 0) {
        resolvers.shift()?.();
      }
    },
    files: {
      listDirectory: (dir: string) => {
        return new Promise<{ directory: string; entries: Entry[] }>((resolve) => {
          calls.push(dir);
          resolvers.push(() => {
            resolve({ directory: dir, entries: resolveEntries(dir) });
          });
        });
      },
    },
  };
};

const dispatchRuntimeSwitch = async (runtimeKey: string) => {
  await act(async () => {
    const dispatch = (
      globalThis as unknown as { dispatchEvent: (event: Event) => boolean }
    ).dispatchEvent;
    dispatch(
      new CustomEvent('pichamber:runtime-endpoint-changed', {
        detail: {
          apiBaseUrl: `https://${runtimeKey}.example`,
          previousApiBaseUrl: 'https://previous.example',
          runtimeKey,
          previousRuntimeKey: 'previous',
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
};

// Captures the real 8s polling callbacks via window.setInterval so fan-out and
// hide/reactivate run through the production registration path.
const installFakeScheduler = () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let nextId = 1_000_000;
  const registered = new Map<number, { callback: () => void; ms: number }>();

  (globalThis as unknown as { setInterval: unknown }).setInterval = ((
    callback: (...args: unknown[]) => void,
    ms: number,
    ...args: unknown[]
  ) => {
    const id = nextId++;
    registered.set(id, {
      callback: () => callback(...args),
      ms,
    });
    return id as unknown as NodeJS.Timeout;
  }) as typeof setInterval;

  (globalThis as unknown as { clearInterval: unknown }).clearInterval = ((
    id: unknown,
  ) => {
    registered.delete(Number(id));
  }) as typeof clearInterval;

  return {
    count8000: () => {
      return [...registered.values()].filter((entry) => entry.ms === 8000).length;
    },
    drive8000: () => {
      const tickers = [...registered.values()].filter((entry) => entry.ms === 8000);
      for (const entry of tickers) {
        entry.callback();
      }
    },
    restore: () => {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    },
  };
};

const baseProps = {
  activeDirectory: undefined as string | undefined,
  expandedPaths: [] as string[],
  chrome: 'desktop' as const,
  showGitignored: true,
  removeExpandedPathsByPrefix: () => undefined,
};

describe('needs-tree policy (mobile preserved)', () => {
  test('mobile always needs its tree; desktop only in full mode', () => {
    expect(shouldEnableFilesTree('mobile', 'editor-only')).toBe(true);
    expect(shouldEnableFilesTree('mobile', 'full')).toBe(true);
    expect(shouldEnableFilesTree('desktop', 'full')).toBe(true);
    expect(shouldEnableFilesTree('desktop', 'editor-only')).toBe(false);
  });
});

describe('areFileNodesEqual', () => {
  test('compares every render-relevant FileNode field', () => {
    const base: FileNode[] = [
      { path: '/root/a.ts', name: 'a.ts', type: 'file', extension: 'ts', size: 10 },
      { path: '/root/sub', name: 'sub', type: 'directory', extension: undefined, size: undefined },
    ];
    const identical = structuredClone(base);
    expect(areFileNodesEqual(base, identical)).toBe(true);
    expect(areFileNodesEqual(base, [{ ...base[0], size: 11 }, base[1]])).toBe(false);
    expect(
      areFileNodesEqual(base, [
        ...base,
        { path: '/root/extra.ts', name: 'extra.ts', type: 'file' },
      ]),
    ).toBe(false);
  });
});

describe('disabled/hidden gating', () => {
  test('inactive surfaces issue zero requests and catch up once on activation', async () => {
    const root = setup();
    const treeRoot = '/proj-gating';
    const { files, calls } = makeFiles((dir) => [
      { name: 'a.ts', path: `${dir}/a.ts`, isDirectory: false, size: 5 },
    ]);
    let latest!: ReturnType<typeof useFilesTree>;
    let enabled = false;
    let visible = false;

    const Harness = () => {
      latest = useFilesTree({
        files: files as never,
        root: treeRoot,
        ...baseProps,
        enabled,
        visible,
      });
      return null;
    };

    await act(async () => root.render(React.createElement(Harness)));
    await flush();
    expect(calls.length).toBe(0);

    enabled = true;
    await act(async () => root.render(React.createElement(Harness)));
    await flush();
    expect(calls.length).toBe(0);
    expect(latest.childrenByDir[treeRoot]).toBe(undefined);

    visible = true;
    await act(async () => root.render(React.createElement(Harness)));
    await flush();
    expect(calls.length).toBe(1);
    expect(latest.childrenByDir[treeRoot]?.map((node) => node.name)).toEqual(['a.ts']);

    await act(async () => root.render(React.createElement(Harness)));
    await flush();
    expect(calls.length).toBe(1);
  });
});

describe('StrictMode (real setup-cleanup-setup)', () => {
  test('remount still loads root with rows present', async () => {
    const root = setup();
    const treeRoot = '/proj-strict';
    const { files, calls } = makeFiles((dir) => [
      { name: 'a.ts', path: `${dir}/a.ts`, isDirectory: false, size: 7 },
    ]);
    let latest!: ReturnType<typeof useFilesTree>;

    const Harness = () => {
      latest = useFilesTree({
        files: files as never,
        root: treeRoot,
        ...baseProps,
        enabled: true,
        visible: true,
      });
      return null;
    };

    await act(async () => {
      root.render(
        React.createElement(React.StrictMode, null, React.createElement(Harness)),
      );
    });
    await flush(20);

    // StrictMode double-invokes effects, so 1-2 fetches are fine; rows must not be dropped.
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length <= 2).toBe(true);
    expect(latest.childrenByDir[treeRoot]?.map((node) => node.name)).toEqual(['a.ts']);
  });
});

describe('runtime identity (canonical subscription only)', () => {
  test('same files object with a runtime switch reloads once', async () => {
    const root = setup();
    const treeRoot = '/proj-runtime-canonical';
    let version = 1;
    const { files, calls } = makeFiles((dir) => {
      if (version === 1) {
        return [{ name: 'a.ts', path: `${dir}/a.ts`, isDirectory: false, size: 1 }];
      }
      return [{ name: 'b.ts', path: `${dir}/b.ts`, isDirectory: false, size: 2 }];
    });
    let latest!: ReturnType<typeof useFilesTree>;

    const Harness = () => {
      latest = useFilesTree({
        files: files as never,
        root: treeRoot,
        ...baseProps,
        enabled: true,
        visible: true,
      });
      return null;
    };

    await act(async () => root.render(React.createElement(Harness)));
    await flush();
    expect(calls).toEqual([treeRoot]);
    expect(latest.childrenByDir[treeRoot]?.map((node) => node.name)).toEqual(['a.ts']);

    version = 2;
    await dispatchRuntimeSwitch(`runtime-canonical-b-${Date.now()}`);
    await flush();
    expect(calls).toEqual([treeRoot, treeRoot]);
    expect(latest.childrenByDir[treeRoot]?.map((node) => node.name)).toEqual(['b.ts']);

    await act(async () => root.render(React.createElement(Harness)));
    await flush();
    expect(calls).toEqual([treeRoot, treeRoot]);
  });

  test('stale completion after runtime switch is rejected even before reset', async () => {
    const root = setup();
    const treeRoot = '/proj-runtime-stale';
    const deferred = makeDeferredFiles((dir) => [
      {
        name: `entry-${deferred.calls.length}.ts`,
        path: `${dir}/entry-${deferred.calls.length}.ts`,
        isDirectory: false,
      },
    ]);
    let latest!: ReturnType<typeof useFilesTree>;

    const Harness = () => {
      latest = useFilesTree({
        files: deferred.files as never,
        root: treeRoot,
        ...baseProps,
        enabled: true,
        visible: true,
      });
      return null;
    };

    await act(async () => root.render(React.createElement(Harness)));
    expect(deferred.calls).toEqual([treeRoot]);

    await dispatchRuntimeSwitch(`runtime-stale-${Date.now()}`);
    await act(async () => deferred.releaseAll());
    await flush();
    expect(deferred.calls.length).toBe(2);
    expect(latest.childrenByDir[treeRoot]?.map((n) => n.name)).toEqual(['entry-2.ts']);
  });

  test('stale completion after unmount publishes nothing', async () => {
    const root = setup();
    const treeRoot = '/proj-unmount-stale';
    const deferred = makeDeferredFiles((dir) => [
      { name: 'a.ts', path: `${dir}/a.ts`, isDirectory: false },
    ]);

    const Harness = () => {
      useFilesTree({
        files: deferred.files as never,
        root: treeRoot,
        ...baseProps,
        enabled: true,
        visible: true,
      });
      return null;
    };

    await act(async () => root.render(React.createElement(Harness)));
    expect(deferred.calls).toEqual([treeRoot]);

    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);

    await act(async () => deferred.releaseAll());
    await flush();
    expect(deferred.calls).toEqual([treeRoot]);
  });
});

describe('polling scheduler (real 8s callbacks, 1/20/100 dirs)', () => {
  for (const count of [1, 20, 100]) {
    test(`one 8s tick refreshes exactly ${count} expanded dirs`, async () => {
      const root = setup();
      const scheduler = installFakeScheduler();
      restoreDom.push(scheduler.restore);
      const treeRoot = `/proj-poll-${count}`;
      const expandedPaths = Array.from(
        { length: count },
        (_, i) => `${treeRoot}/dir${i}`,
      );
      const { files, calls } = makeFiles((dir) => [
        { name: 'a.ts', path: `${dir}/a.ts`, isDirectory: false },
      ]);
      let latest!: ReturnType<typeof useFilesTree>;

      const Harness = () => {
        latest = useFilesTree({
          files: files as never,
          root: treeRoot,
          ...baseProps,
          expandedPaths,
          enabled: true,
          visible: true,
        });
        return null;
      };

      await act(async () => root.render(React.createElement(Harness)));
      await flush();
      expect(calls).toEqual([treeRoot]);
      expect(scheduler.count8000()).toBe(1);

      await act(async () => scheduler.drive8000());
      await flush();
      expect(calls.length).toBe(1 + count);
      expect(latest.childrenByDir[treeRoot]).toBeDefined();
      for (const dir of expandedPaths) {
        expect(latest.childrenByDir[dir]).toBeDefined();
      }
    });
  }

  test('hidden surface registers no 8s callback and resumes once on reactivation', async () => {
    const root = setup();
    const scheduler = installFakeScheduler();
    restoreDom.push(scheduler.restore);
    const treeRoot = '/proj-poll-hide';
    const expandedPaths = [`${treeRoot}/a`, `${treeRoot}/b`, `${treeRoot}/c`];
    const { files, calls } = makeFiles((dir) => [
      { name: 'x.ts', path: `${dir}/x.ts`, isDirectory: false },
    ]);
    let visible = true;

    const Harness = () => {
      useFilesTree({
        files: files as never,
        root: treeRoot,
        ...baseProps,
        expandedPaths,
        enabled: true,
        visible,
      });
      return null;
    };

    await act(async () => root.render(React.createElement(Harness)));
    await flush();
    expect(calls).toEqual([treeRoot]);
    expect(scheduler.count8000()).toBe(1);

    visible = false;
    await act(async () => root.render(React.createElement(Harness)));
    await flush();
    expect(scheduler.count8000()).toBe(0);

    await act(async () => scheduler.drive8000());
    await flush();
    expect(calls.length).toBe(1);

    visible = true;
    await act(async () => root.render(React.createElement(Harness)));
    await flush();
    expect(calls.length).toBe(1 + expandedPaths.length);
    expect(scheduler.count8000()).toBe(1);
  });

  test('slow poll does not overlap an in-flight dir', async () => {
    const root = setup();
    const scheduler = installFakeScheduler();
    restoreDom.push(scheduler.restore);
    const treeRoot = '/proj-slow-poll';
    const childDir = `${treeRoot}/child`;
    const deferred = makeDeferredFiles((dir) => [
      { name: 'a.ts', path: `${dir}/a.ts`, isDirectory: false },
    ]);
    let latest!: ReturnType<typeof useFilesTree>;

    const Harness = () => {
      latest = useFilesTree({
        files: deferred.files as never,
        root: treeRoot,
        ...baseProps,
        expandedPaths: [childDir],
        enabled: true,
        visible: true,
      });
      return null;
    };

    await act(async () => root.render(React.createElement(Harness)));
    expect(deferred.calls).toEqual([treeRoot]);

    await act(async () => deferred.releaseAll());
    await flush();

    await act(async () => scheduler.drive8000());
    expect(deferred.calls).toEqual([treeRoot, childDir]);

    await act(async () => scheduler.drive8000());
    expect(deferred.calls).toEqual([treeRoot, childDir]);

    await act(async () => deferred.releaseAll());
    await flush();
    expect(latest.childrenByDir[childDir]).toBeDefined();

    await act(async () => scheduler.drive8000());
    await flush();
    expect(deferred.calls).toEqual([treeRoot, childDir, childDir]);
  });

  test('concurrent same-dir loads share one underlying fetch', async () => {
    const root = setup();
    const treeRoot = '/proj-coalesce';
    const childDir = `${treeRoot}/child`;
    const deferred = makeDeferredFiles((dir) => [
      { name: 'a.ts', path: `${dir}/a.ts`, isDirectory: false },
    ]);
    let latest!: ReturnType<typeof useFilesTree>;

    const Harness = () => {
      latest = useFilesTree({
        files: deferred.files as never,
        root: treeRoot,
        ...baseProps,
        expandedPaths: [],
        enabled: true,
        visible: true,
      });
      return null;
    };

    await act(async () => root.render(React.createElement(Harness)));
    expect(deferred.calls).toEqual([treeRoot]);

    await act(async () => deferred.releaseAll());
    await flush();

    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    await act(async () => {
      first = latest.loadDirectory(childDir);
      second = latest.loadDirectory(childDir);
    });
    expect(deferred.calls).toEqual([treeRoot, childDir]);

    await act(async () => deferred.releaseAll());
    await act(async () => {
      await Promise.all([first, second]);
    });
    await flush();
    expect(latest.childrenByDir[childDir]).toBeDefined();
  });
});

describe('no-op refresh stability', () => {
  test('unchanged refresh preserves the bucket reference', async () => {
    const root = setup();
    const treeRoot = '/proj-stable';
    const { files, calls } = makeFiles((dir) => [
      { name: 'a.ts', path: `${dir}/a.ts`, isDirectory: false, size: 10 },
    ]);
    let api!: ReturnType<typeof useFilesTree>;

    const Harness = () => {
      api = useFilesTree({
        files: files as never,
        root: treeRoot,
        ...baseProps,
        enabled: true,
        visible: true,
      });
      return null;
    };

    await act(async () => root.render(React.createElement(Harness)));
    await flush();
    const first = api.childrenByDir[treeRoot];
    expect(first).toBeDefined();

    await act(async () => api.refreshDirectory(treeRoot));
    await flush();
    expect(api.childrenByDir[treeRoot]).toBe(first);
    expect(calls.length).toBe(2);
  });

  test('changed metadata republishes the affected bucket', async () => {
    const root = setup();
    const treeRoot = '/proj-changed';
    let size = 10;
    const { files, calls } = makeFiles((dir) => [
      { name: 'a.ts', path: `${dir}/a.ts`, isDirectory: false, size },
    ]);
    let latest!: ReturnType<typeof useFilesTree>;

    const Harness = () => {
      latest = useFilesTree({
        files: files as never,
        root: treeRoot,
        ...baseProps,
        enabled: true,
        visible: true,
      });
      return null;
    };

    await act(async () => root.render(React.createElement(Harness)));
    await flush();
    const first = latest.childrenByDir[treeRoot];
    expect(first?.[0]?.size).toBe(10);

    size = 999;
    await act(async () => latest.refreshDirectory(treeRoot));
    await flush();
    const second = latest.childrenByDir[treeRoot];
    expect(second?.[0]?.size).toBe(999);
    expect(second).not.toBe(first);
    expect(calls.length).toBe(2);
  });
});

describe('failure isolation (real hook)', () => {
  test('one failed directory records an error without clearing unrelated buckets', async () => {
    const root = setup();
    const treeRoot = '/proj-failure';
    const childDir = `${treeRoot}/child`;
    const { files } = makeFiles(
      (dir) => [{ name: 'ok.ts', path: `${dir}/ok.ts`, isDirectory: false }],
      { failDirs: { [childDir]: 'boom' } },
    );
    const originalError = console.error;
    console.error = () => undefined;

    try {
      let latest!: ReturnType<typeof useFilesTree>;

      const Harness = () => {
        latest = useFilesTree({
          files: files as never,
          root: treeRoot,
          ...baseProps,
          enabled: true,
          visible: true,
        });
        return null;
      };

      await act(async () => root.render(React.createElement(Harness)));
      await flush();
      expect(latest.childrenByDir[treeRoot]).toBeDefined();

      await act(async () => latest.loadDirectory(childDir));
      await flush();
      expect(latest.loadErrorsByDir[childDir]).toBe('boom');
      expect(latest.childrenByDir[treeRoot]).toBeDefined();
    } finally {
      console.error = originalError;
    }
  });
});
