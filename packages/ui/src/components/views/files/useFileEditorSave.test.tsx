import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, mock, test } from 'bun:test';

import type { FileRevisionScope } from './fileRevisionCache';

// The hook only uses `toast` from the UI barrel; replace it so the test stays
// self-contained and records error surfacing.
const toastErrors: string[] = [];
mock.module('@/components/ui', () => ({
  toast: {
    error: (message: string) => { toastErrors.push(message); },
    success: () => undefined,
  },
}));

import type { FileEditorConflict } from './useFileEditorSave';
const { useFileEditorSave } = await import('./useFileEditorSave');

type HookOptions = Parameters<typeof useFileEditorSave>[0];
type HookResult = ReturnType<typeof useFileEditorSave>;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

let latest: HookResult | null = null;
const Probe = (props: HookOptions) => {
  latest = useFileEditorSave(props);
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

const roots: Root[] = [];
const restoreFns: Array<() => void> = [];

const renderHook = async (props: HookOptions) => {
  const dom = installMinimalDom();
  restoreFns.push(dom.restore);
  const root = createRoot(dom.container);
  roots.push(root);
  await act(async () => {
    root.render(<Probe {...props} />);
  });
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  restoreFns.splice(0).forEach((restore) => restore());
  latest = null;
  toastErrors.length = 0;
});

const baseOptions = (overrides: Partial<HookOptions>): HookOptions => ({
  autoSaveEnabled: false,
  selectedPath: '/repo/a.txt',
  loadedPath: '/repo/a.txt',
  fileLoading: false,
  isDirty: true,
  draftContent: 'draft',
  fileContent: 'base',
  lineEnding: '\n',
  isNonEditableBinary: false,
  writeFile: async () => ({ success: true, path: '/repo/a.txt', revision: 'rev-2' }),
  expectedRevision: 'rev-1',
  onSaved: () => undefined,
  ...overrides,
});

const baseScope: FileRevisionScope = {
  runtimeKey: 'local',
  root: '/repo',
  path: '/repo/a.txt',
  generation: 1,
};

describe('useFileEditorSave authority', () => {
  test('forwards the guarded revision and reports saved revision with scope', async () => {
    const writes: Array<{ path: string; content: string; options?: unknown }> = [];
    const onSavedCalls: Array<{ path: string; content: string; revision?: string | null; scope?: FileRevisionScope | null }> = [];
    await renderHook(baseOptions({
      writeFile: async (path, content, options) => {
        writes.push({ path, content, options });
        return { success: true, path, revision: 'rev-2' };
      },
      onSaved: (path, content, revision, scope) => { onSavedCalls.push({ path, content, revision, scope }); },
      captureSaveScope: () => baseScope,
      currentSaveScope: () => baseScope,
    }));

    let saved = false;
    await act(async () => {
      saved = await latest!.saveNow();
    });
    expect(saved).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].options).toEqual({ expectedRevision: 'rev-1' });
    expect(onSavedCalls).toHaveLength(1);
    expect(onSavedCalls[0]).toMatchObject({
      path: '/repo/a.txt',
      content: 'draft',
      revision: 'rev-2',
      scope: baseScope,
    });
  });

  test('drops stale save completions after a selection/generation switch', async () => {
    const onSavedCalls: unknown[] = [];
    let currentGeneration = 1;
    const writeGate = deferred<void>();
    let writes = 0;
    await renderHook(baseOptions({
      writeFile: async () => {
        writes += 1;
        await writeGate.promise;
        return { success: true, path: '/repo/a.txt', revision: 'rev-2' };
      },
      onSaved: () => { onSavedCalls.push('saved'); },
      captureSaveScope: () => ({ ...baseScope, generation: 1 }),
      currentSaveScope: () => ({ ...baseScope, generation: currentGeneration }),
    }));

    let saved: boolean | undefined;
    await act(async () => {
      const pending = latest!.saveNow().then((value) => { saved = value; });
      // The selection switches to another file (generation bump) while the
      // write is in flight; the completion must not clobber the new document.
      currentGeneration = 2;
      writeGate.resolve();
      await pending;
    });
    expect(writes).toBe(1);
    expect(saved).toBe(false);
    expect(onSavedCalls).toHaveLength(0);
  });

  test('drops stale conflict completions after a selection/generation switch', async () => {
    const onConflictCalls: FileEditorConflict[] = [];
    let currentGeneration = 1;
    const writeGate = deferred<void>();
    await renderHook(baseOptions({
      writeFile: async () => {
        await writeGate.promise;
        throw Object.assign(new Error('File has changed on disk'), {
          name: 'FileRevisionConflictError',
          reason: 'file-revision-conflict',
          currentRevision: 'rev-9',
          exists: true,
          filePath: '/repo/a.txt',
        });
      },
      onConflict: (conflict) => { onConflictCalls.push(conflict); },
      captureSaveScope: () => baseScope,
      currentSaveScope: () => ({ ...baseScope, generation: currentGeneration }),
    }));

    let saved: boolean | undefined;
    await act(async () => {
      const pending = latest!.saveNow().then((value) => { saved = value; });
      currentGeneration = 2;
      writeGate.resolve();
      await pending;
    });
    expect(saved).toBe(false);
    expect(onConflictCalls).toHaveLength(0);
    expect(latest!.saveConflict).toBeNull();
  });

  test('surfaces typed conflicts with the current revision for current scopes', async () => {
    const onConflictCalls: FileEditorConflict[] = [];
    await renderHook(baseOptions({
      writeFile: async () => {
        throw Object.assign(new Error('File has changed on disk'), {
          name: 'FileRevisionConflictError',
          reason: 'file-revision-conflict',
          currentRevision: 'rev-9',
          exists: true,
          filePath: '/repo/a.txt',
        });
      },
      onConflict: (conflict) => { onConflictCalls.push(conflict); },
      captureSaveScope: () => baseScope,
      currentSaveScope: () => baseScope,
    }));

    let saved: boolean | undefined;
    await act(async () => {
      saved = await latest!.saveNow();
    });
    expect(saved).toBe(false);
    expect(latest!.saveConflict).not.toBeNull();
    expect(latest!.saveConflict).toMatchObject({
      path: '/repo/a.txt',
      currentRevision: 'rev-9',
      exists: true,
    });
    expect(onConflictCalls).toHaveLength(1);
  });
});
