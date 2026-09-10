import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, mock, test } from 'bun:test';

import type { FileRevisionScope } from './fileRevisionCache';
import type { DiagramSaveConflict } from './useFileViewerModes';

// The hook only uses `toast` from the UI barrel; replace it so the test stays
// self-contained and records error surfacing.
const toastErrors: string[] = [];
mock.module('@/components/ui', () => ({
  toast: {
    error: (message: string) => { toastErrors.push(message); },
    success: () => undefined,
  },
}));

const { useFileViewerModes } = await import('./useFileViewerModes');

type HookOptions = Parameters<typeof useFileViewerModes>[0];
type HookResult = ReturnType<typeof useFileViewerModes>;

let latest: HookResult | null = null;
const Probe = (props: HookOptions) => {
  latest = useFileViewerModes(props);
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

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

const baseScope: FileRevisionScope = {
  runtimeKey: 'local',
  root: '/repo',
  path: '/repo/d.drawio',
  generation: 1,
};

const baseOptions = (overrides: Partial<HookOptions>): HookOptions => ({
  root: '/repo',
  selectedPath: '/repo/d.drawio',
  fileContent: '<base/>',
  draftContent: '<base/>',
  setDraftContent: () => undefined,
  autoSaveEnabled: false,
  writeFile: async () => ({ success: true, path: '/repo/d.drawio', revision: 'rev-2' }),
  expectedRevision: 'rev-1',
  captureSaveScope: () => baseScope,
  currentSaveScope: () => baseScope,
  onSaved: () => undefined,
  onConflict: () => undefined,
  ...overrides,
});

const conflictError = () => Object.assign(new Error('File has changed on disk'), {
  name: 'FileRevisionConflictError',
  reason: 'file-revision-conflict',
  currentRevision: 'rev-9',
  exists: true,
  filePath: '/repo/d.drawio',
});

describe('useFileViewerModes diagram save authority', () => {
  test('forwards the guarded revision and reports the save with scope', async () => {
    const writes: Array<{ path: string; content: string; options?: unknown }> = [];
    const onSavedCalls: Array<{ path: string; content: string; revision?: string | null; scope?: FileRevisionScope | null }> = [];
    const drafts: string[] = [];
    await renderHook(baseOptions({
      writeFile: async (path, content, options) => {
        writes.push({ path, content, options });
        return { success: true, path, revision: 'rev-2' };
      },
      setDraftContent: (content) => { drafts.push(content); },
      onSaved: (path, content, revision, scope) => { onSavedCalls.push({ path, content, revision, scope }); },
    }));

    let saved = false;
    await act(async () => {
      saved = await latest!.saveDiagramXml('/repo/d.drawio', '<xml/>');
    });
    expect(saved).toBe(true);
    expect(writes).toEqual([{ path: '/repo/d.drawio', content: '<xml/>', options: { expectedRevision: 'rev-1' } }]);
    expect(drafts).toEqual(['<xml/>']);
    expect(onSavedCalls).toHaveLength(1);
    expect(onSavedCalls[0]).toMatchObject({
      path: '/repo/d.drawio',
      content: '<xml/>',
      revision: 'rev-2',
      scope: baseScope,
    });
  });

  test('no-ops when the diagram XML already matches the saved buffer', async () => {
    let writes = 0;
    await renderHook(baseOptions({
      writeFile: async () => { writes += 1; return { success: true, path: '/repo/d.drawio', revision: 'rev-2' }; },
    }));

    let saved = false;
    await act(async () => {
      saved = await latest!.saveDiagramXml('/repo/d.drawio', '<xml/>');
    });
    expect(saved).toBe(true);
    // Second attempt with identical XML must not write again.
    await act(async () => {
      saved = await latest!.saveDiagramXml('/repo/d.drawio', '<xml/>');
    });
    expect(saved).toBe(false);
    expect(writes).toBe(1);
  });

  test('forces overwrite past the guarded revision when asked', async () => {
    const writes: Array<{ options?: unknown }> = [];
    await renderHook(baseOptions({
      writeFile: async (_path, _content, options) => {
        writes.push({ options });
        return { success: true, path: '/repo/d.drawio', revision: 'rev-3' };
      },
    }));

    let saved = false;
    await act(async () => {
      saved = await latest!.saveDiagramXml('/repo/d.drawio', '<xml/>', { overwrite: true });
    });
    expect(saved).toBe(true);
    expect(writes[0]?.options).toEqual({ expectedRevision: 'rev-1', overwrite: true });
  });

  test('skips the write when the diagram is no longer the selected document', async () => {
    let writes = 0;
    await renderHook(baseOptions({
      writeFile: async () => { writes += 1; return { success: true, path: '/repo/d.drawio', revision: 'rev-2' }; },
      captureSaveScope: () => ({ ...baseScope, path: '/repo/other.drawio' }),
    }));

    let saved: boolean | undefined;
    await act(async () => {
      saved = await latest!.saveDiagramXml('/repo/d.drawio', '<xml/>');
    });
    expect(saved).toBe(false);
    expect(writes).toBe(0);
  });

  test('drops stale save completions after a selection/generation switch', async () => {
    const onSavedCalls: unknown[] = [];
    const drafts: string[] = [];
    let currentGeneration = 1;
    const writeGate = deferred<void>();
    let writes = 0;
    await renderHook(baseOptions({
      writeFile: async () => {
        writes += 1;
        await writeGate.promise;
        return { success: true, path: '/repo/d.drawio', revision: 'rev-2' };
      },
      setDraftContent: (content) => { drafts.push(content); },
      onSaved: () => { onSavedCalls.push('saved'); },
      currentSaveScope: () => ({ ...baseScope, generation: currentGeneration }),
    }));

    let saved: boolean | undefined;
    await act(async () => {
      const pending = latest!.saveDiagramXml('/repo/d.drawio', '<xml/>').then((value) => { saved = value; });
      // The selection switches to another file (generation bump) while the
      // write is in flight; the completion must not clobber the new document.
      currentGeneration = 2;
      writeGate.resolve();
      await pending;
    });
    expect(writes).toBe(1);
    expect(saved).toBe(false);
    expect(drafts).toEqual([]);
    expect(onSavedCalls).toHaveLength(0);
  });

  test('drops stale conflict completions after a selection/generation switch', async () => {
    const onConflictCalls: DiagramSaveConflict[] = [];
    let currentGeneration = 1;
    const writeGate = deferred<void>();
    await renderHook(baseOptions({
      writeFile: async () => {
        await writeGate.promise;
        throw conflictError();
      },
      onConflict: (conflict) => { onConflictCalls.push(conflict); },
      currentSaveScope: () => ({ ...baseScope, generation: currentGeneration }),
    }));

    let saved: boolean | undefined;
    await act(async () => {
      const pending = latest!.saveDiagramXml('/repo/d.drawio', '<xml/>').then((value) => { saved = value; });
      currentGeneration = 2;
      writeGate.resolve();
      await pending;
    });
    expect(saved).toBe(false);
    expect(onConflictCalls).toHaveLength(0);
    expect(toastErrors).toEqual([]);
  });

  test('surfaces typed conflicts with the preserved diagram XML', async () => {
    const onConflictCalls: DiagramSaveConflict[] = [];
    const drafts: string[] = [];
    await renderHook(baseOptions({
      writeFile: async () => { throw conflictError(); },
      setDraftContent: (content) => { drafts.push(content); },
      onConflict: (conflict) => { onConflictCalls.push(conflict); },
    }));

    let saved: boolean | undefined;
    await act(async () => {
      saved = await latest!.saveDiagramXml('/repo/d.drawio', '<xml/>');
    });
    expect(saved).toBe(false);
    expect(drafts).toEqual([]);
    expect(onConflictCalls).toHaveLength(1);
    expect(onConflictCalls[0]).toMatchObject({
      path: '/repo/d.drawio',
      currentRevision: 'rev-9',
      exists: true,
      xml: '<xml/>',
    });
    expect(toastErrors).toEqual([]);
  });

  test('toasts non-conflict write failures without touching buffers', async () => {
    const onConflictCalls: unknown[] = [];
    const onSavedCalls: unknown[] = [];
    const drafts: string[] = [];
    await renderHook(baseOptions({
      writeFile: async () => { throw new Error('Disk full'); },
      setDraftContent: (content) => { drafts.push(content); },
      onSaved: () => { onSavedCalls.push('saved'); },
      onConflict: () => { onConflictCalls.push('conflict'); },
    }));

    let saved: boolean | undefined;
    await act(async () => {
      saved = await latest!.saveDiagramXml('/repo/d.drawio', '<xml/>');
    });
    expect(saved).toBe(false);
    expect(toastErrors).toEqual(['Disk full']);
    expect(drafts).toEqual([]);
    expect(onSavedCalls).toEqual([]);
    expect(onConflictCalls).toEqual([]);
  });
});
