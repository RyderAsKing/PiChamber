import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// --- Mutable test controls (read through mock closures) ------------------

let editorXml = '<base/>';
let currentRuntimeKey = 'local';
let runtimeListeners: Array<(detail?: unknown) => void> = [];
let readImpl: (path: string) => Promise<{ content: string; revision?: string | null; exists?: boolean }> = async () => ({
  content: '<base/>',
  revision: 'rev-1',
});
let writeImpl: (
  path: string,
  content: string,
  options?: { expectedRevision?: string | null; overwrite?: boolean },
) => Promise<{ success: boolean; path: string; revision?: string | null }> = async (path) => ({
  success: true,
  path,
  revision: 'rev-2',
});
type DialogProps = {
  open: boolean;
  conflict: {
    path: string;
    displayPath: string;
    exists: boolean;
    currentRevision: string | null;
    currentContent: string | null;
    dirtyContent: string;
  } | null;
  isResolving: boolean;
  showCompare: boolean;
  onToggleCompare: () => void;
  onReload: () => void;
  onOverwrite: () => void;
  onClose: () => void;
};
let lastDialogProps: DialogProps | null = null;
let lastEditorProps: { xml: string } | null = null;
const toastErrors: string[] = [];
const writes: Array<{ path: string; content: string; options?: unknown }> = [];

mock.module('@/components/ui', () => ({
  toast: {
    error: (message: string) => { toastErrors.push(message); },
    success: () => undefined,
  },
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: () => null,
}));

mock.module('@/components/diagram/DiagramEditor', () => ({
  DiagramEditor: React.forwardRef(({ xml }: { xml: string }, ref: React.Ref<{ getXml: () => string }>) => {
    lastEditorProps = { xml };
    const prevRef = React.useRef<string | null>(null);
    const mountedRef = React.useRef(false);
    if (!mountedRef.current) {
      mountedRef.current = true;
      prevRef.current = xml;
      editorXml = xml;
    } else if (prevRef.current !== xml) {
      prevRef.current = xml;
      editorXml = xml;
    }
    React.useImperativeHandle(ref, () => ({ getXml: () => editorXml }));
    return null;
  }),
}));

mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({
    files: {
      readFile: (path: string) => readImpl(path),
      writeFile: (path: string, content: string, options?: { expectedRevision?: string | null; overwrite?: boolean }) => {
        writes.push({ path, content, options });
        return writeImpl(path, content, options);
      },
    },
    runtime: { platform: 'web', isDesktop: false },
  }),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => currentRuntimeKey,
  subscribeRuntimeEndpointChanged: (callback: (detail?: unknown) => void) => {
    runtimeListeners.push(callback);
    return () => {
      runtimeListeners = runtimeListeners.filter((listener) => listener !== callback);
    };
  },
}));

mock.module('@/components/views/files/FileSaveConflictDialog', () => ({
  FileSaveConflictDialog: (props: DialogProps) => {
    lastDialogProps = props;
    if (!props.open || !props.conflict) return null;
    return React.createElement(
      'div',
      { 'data-testid': 'conflict-dialog' },
      React.createElement('div', { 'data-testid': 'conflict-dirty' }, props.conflict.dirtyContent),
      React.createElement('div', { 'data-testid': 'conflict-current' }, props.conflict.currentContent ?? ''),
      props.showCompare
        ? React.createElement('div', { 'data-testid': 'conflict-compare' }, 'compare-on')
        : null,
      React.createElement('button', { 'aria-label': 'Compare versions', onClick: props.onToggleCompare }, 'Compare'),
      React.createElement('button', { 'aria-label': 'Reload current version', onClick: props.onReload }, 'Reload'),
      React.createElement('button', { 'aria-label': 'Overwrite with my edits', onClick: props.onOverwrite }, 'Overwrite'),
      React.createElement('button', { 'aria-label': 'Close conflict dialog', onClick: props.onClose }, 'Close'),
    );
  },
}));

const { DiagramView } = await import('./DiagramView');
const { useUIStore } = await import('@/stores/useUIStore');

// --- Minimal DOM stub (proven pattern from number-input.test.tsx) ---------

interface FakeNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: FakeDocument;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  style: Record<string, unknown>;
  classList: { add(...c: string[]): void; remove(...c: string[]): void; contains(c: string): boolean };
  [key: string]: unknown;
}

interface FakeDocument extends FakeNode {
  defaultView: FakeWindow;
  body: FakeNode;
  documentElement: FakeNode;
  createElement(tag: string): FakeNode;
  createElementNS(_: string, tag: string): FakeNode;
  createTextNode(text: string): FakeNode;
  activeElement: FakeNode | null;
}

interface FakeWindow {
  document: FakeDocument;
  navigator: { userAgent: string; platform: string; maxTouchPoints: number };
  matchMedia(query: string): { matches: boolean; addEventListener(): void; removeEventListener(): void };
  addEventListener(): void;
  removeEventListener(): void;
  dispatchEvent(): boolean;
}

function makeNode(tag: string, owner: FakeDocument): FakeNode {
  const node = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    ownerDocument: owner,
    parentNode: null,
    childNodes: [] as FakeNode[],
    style: { setProperty() {}, getPropertyValue() { return ''; } },
    classList: {
      add() {},
      remove() {},
      contains() { return false; },
    },
    setAttribute() {},
    removeAttribute() {},
    hasAttribute() { return false; },
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c: FakeNode) { (this as FakeNode).childNodes.push(c); c.parentNode = this as unknown as FakeNode; return c; },
    insertBefore(c: FakeNode, ref: FakeNode) {
      const list = (this as FakeNode).childNodes;
      const i = list.indexOf(ref);
      if (i < 0) list.push(c); else list.splice(i, 0, c);
      c.parentNode = this as unknown as FakeNode;
      return c;
    },
    removeChild(c: FakeNode) {
      const list = (this as FakeNode).childNodes;
      const i = list.indexOf(c);
      if (i >= 0) list.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    contains() { return false; },
    focus() {},
    blur() {},
    click() {},
    textContent: '',
    innerHTML: '',
  } as unknown as FakeNode;
  return node;
}

function installDomStub(): { restore: () => void; container: FakeNode } {
  const document = {
    nodeType: 9,
    nodeName: '#document',
    parentNode: null,
    childNodes: [] as FakeNode[],
    style: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    getElementById() { return null; },
    createTextNode(text: string) {
      return { nodeType: 3, nodeName: '#text', textContent: text, parentNode: null } as unknown as FakeNode;
    },
    createElement(tag: string) { return makeNode(tag, document as unknown as FakeDocument); },
    createElementNS(_: string, tag: string) { return makeNode(tag, document as unknown as FakeDocument); },
    activeElement: null,
  } as unknown as FakeDocument;
  document.defaultView = {
    document,
    navigator: { userAgent: 'test', platform: 'test', maxTouchPoints: 0 },
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    Element: class {},
    HTMLElement: class {},
    HTMLIFrameElement: class {},
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
  } as unknown as FakeWindow;
  document.body = makeNode('body', document);
  document.documentElement = makeNode('html', document);
  (document as unknown as Record<string, unknown>)['HTMLIFrameElement'] = (
    document.defaultView as unknown as Record<string, unknown>
  )['HTMLIFrameElement'];

  const g = globalThis as unknown as Record<string, unknown>;
  const previous = {
    document: g['document'],
    window: g['window'],
    navigator: g['navigator'],
    Element: g['Element'],
    HTMLElement: g['HTMLElement'],
    HTMLIFrameElement: g['HTMLIFrameElement'],
    IS_REACT_ACT_ENVIRONMENT: g['IS_REACT_ACT_ENVIRONMENT'],
  };
  g['IS_REACT_ACT_ENVIRONMENT'] = true;
  g['document'] = document;
  g['window'] = document.defaultView;
  g['navigator'] = (document.defaultView as unknown as FakeWindow).navigator;
  g['Element'] = (document.defaultView as unknown as Record<string, unknown>)['Element'];
  g['HTMLElement'] = (document.defaultView as unknown as Record<string, unknown>)['HTMLElement'];
  g['HTMLIFrameElement'] = (document.defaultView as unknown as Record<string, unknown>)['HTMLIFrameElement'];
  const container = document.createElement('div');
  return {
    container,
    restore() {
      g['document'] = previous['document'];
      g['window'] = previous['window'];
      g['navigator'] = previous['navigator'];
      g['Element'] = previous['Element'];
      g['HTMLElement'] = previous['HTMLElement'];
      g['HTMLIFrameElement'] = previous['HTMLIFrameElement'];
      g['IS_REACT_ACT_ENVIRONMENT'] = previous['IS_REACT_ACT_ENVIRONMENT'];
    },
  };
}

const roots: Root[] = [];
const restores: Array<() => void> = [];

const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
};

const findByProp = (container: FakeNode, prop: string, value: string): FakeNode | null => {
  const visit = (node: FakeNode): FakeNode | null => {
    const key = Object.keys(node).find((k) => k.startsWith('__reactProps'));
    if (key) {
      const props = (node as unknown as Record<string, Record<string, unknown>>)[key];
      if (props?.[prop] === value) return node;
    }
    for (const child of node.childNodes) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(container);
};

const clickProp = (container: FakeNode, prop: string, value: string) => {
  const node = findByProp(container, prop, value);
  if (!node) throw new Error(`button ${prop}="${value}" not found`);
  const key = Object.keys(node).find((k) => k.startsWith('__reactProps'))!;
  const props = (node as unknown as Record<string, { onClick: (e: unknown) => void }>)[key]!;
  act(() => {
    props.onClick({ preventDefault() {}, stopPropagation() {} });
  });
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const conflictError = (overrides: { currentRevision?: string | null; exists?: boolean; path?: string } = {}) => Object.assign(
  new Error('File has changed on disk'),
  {
    name: 'FileRevisionConflictError',
    reason: 'file-revision-conflict',
    currentRevision: overrides.currentRevision ?? 'rev-9',
    exists: overrides.exists ?? true,
    filePath: overrides.path ?? '/repo/a.drawio',
  },
);

const resetState = () => {
  editorXml = '<base/>';
  currentRuntimeKey = 'local';
  runtimeListeners = [];
  writes.length = 0;
  toastErrors.length = 0;
  lastDialogProps = null;
  lastEditorProps = null;
  readImpl = async () => ({ content: '<base/>', revision: 'rev-1' });
  writeImpl = async (path) => ({ success: true, path, revision: 'rev-2' });
  useUIStore.getState().setPendingDiagramFile(null);
  useUIStore.setState({ pendingDiagramFile: null });
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  restores.splice(0).forEach((restore) => restore());
  resetState();
});

const renderDiagram = async (path: string) => {
  const stub = installDomStub();
  restores.push(stub.restore);
  useUIStore.getState().setPendingDiagramFile(path);
  const root = createRoot(stub.container as unknown as Element);
  roots.push(root);
  await act(async () => {
    root.render(React.createElement(DiagramView));
  });
  await flush();
  await flush();
  return stub.container;
};

describe('DiagramView stale-save conflict recovery', () => {
  test('409 keeps dirty XML and opens reload/overwrite/compare', async () => {
    readImpl = async () => ({ content: '<base/>', revision: 'rev-1' });
    writeImpl = async () => { throw conflictError(); };
    const container = await renderDiagram('/repo/a.drawio');
    expect(lastEditorProps?.xml).toBe('<base/>');

    editorXml = '<dirty/>';
    // The conflict fetch observes the newer disk bytes.
    readImpl = async () => ({ content: '<disk/>', revision: 'rev-9' });
    clickProp(container, 'title', 'Save diagram');
    await flush();
    await flush();

    expect(lastDialogProps?.open).toBe(true);
    expect(lastDialogProps?.conflict?.dirtyContent).toBe('<dirty/>');
    expect(lastDialogProps?.conflict?.currentContent).toBe('<disk/>');
    expect(lastDialogProps?.conflict?.exists).toBe(true);
    // Dirty editor content is preserved: the loaded base is untouched.
    expect(lastEditorProps?.xml).toBe('<base/>');
    expect(toastErrors).toEqual([]);

    // Compare preview is available through the shared dialog workflow.
    clickProp(container, 'aria-label', 'Compare versions');
    await flush();
    expect(lastDialogProps?.showCompare).toBe(true);
  });

  test('overwrite forces the preserved dirty XML and clears the dialog', async () => {
    readImpl = async () => ({ content: '<base/>', revision: 'rev-1' });
    writeImpl = async () => { throw conflictError(); };
    const container = await renderDiagram('/repo/a.drawio');
    editorXml = '<dirty/>';
    readImpl = async () => ({ content: '<disk/>', revision: 'rev-9' });
    clickProp(container, 'title', 'Save diagram');
    await flush();
    await flush();
    expect(lastDialogProps?.open).toBe(true);

    writeImpl = async (path) => ({ success: true, path, revision: 'rev-10' });
    clickProp(container, 'aria-label', 'Overwrite with my edits');
    await flush();
    await flush();

    const overwrite = writes[writes.length - 1];
    expect(overwrite?.content).toBe('<dirty/>');
    expect(overwrite?.options).toEqual({ expectedRevision: 'rev-1', overwrite: true });
    expect(lastDialogProps?.open).toBe(false);
    expect(lastEditorProps?.xml).toBe('<dirty/>');

    // The new revision backs the next guarded save.
    editorXml = '<dirty-2/>';
    clickProp(container, 'title', 'Save diagram');
    await flush();
    await flush();
    expect(writes[writes.length - 1]?.options).toEqual({ expectedRevision: 'rev-10' });
  });

  test('reload discards dirty only after a successful read', async () => {
    readImpl = async () => ({ content: '<base/>', revision: 'rev-1' });
    writeImpl = async () => { throw conflictError(); };
    const container = await renderDiagram('/repo/a.drawio');
    editorXml = '<dirty/>';
    readImpl = async () => ({ content: '<disk/>', revision: 'rev-9' });
    clickProp(container, 'title', 'Save diagram');
    await flush();
    await flush();
    expect(lastDialogProps?.open).toBe(true);

    readImpl = async () => ({ content: '<reloaded/>', revision: 'rev-11' });
    clickProp(container, 'aria-label', 'Reload current version');
    await flush();
    await flush();
    expect(lastEditorProps?.xml).toBe('<reloaded/>');
    expect(editorXml).toBe('<reloaded/>');
    expect(lastDialogProps?.open).toBe(false);
  });

  test('reload resets dirty buffer when disk matches the loaded base', async () => {
    readImpl = async () => ({ content: '<base/>', revision: 'rev-1' });
    writeImpl = async () => { throw conflictError(); };
    const container = await renderDiagram('/repo/a.drawio');
    expect(lastEditorProps?.xml).toBe('<base/>');
    editorXml = '<dirty/>';
    readImpl = async () => ({ content: '<base/>', revision: 'rev-1' });
    clickProp(container, 'title', 'Save diagram');
    await flush();
    await flush();
    expect(lastDialogProps?.open).toBe(true);
    expect(lastEditorProps?.xml).toBe('<base/>');

    readImpl = async () => ({ content: '<base/>', revision: 'rev-1' });
    clickProp(container, 'aria-label', 'Reload current version');
    await flush();
    await flush();
    expect(lastDialogProps?.open).toBe(false);
    expect(lastEditorProps?.xml).toBe('<base/>');
    expect(editorXml).toBe('<base/>');

    writeImpl = async (path) => ({ success: true, path, revision: 'rev-2' });
    editorXml = '<dirty-2/>';
    clickProp(container, 'title', 'Save diagram');
    await flush();
    await flush();
    expect(writes[writes.length - 1]?.options).toEqual({ expectedRevision: 'rev-1' });
  });

  test('failed reload keeps dirty XML and the open dialog', async () => {
    readImpl = async () => ({ content: '<base/>', revision: 'rev-1' });
    writeImpl = async () => { throw conflictError(); };
    const container = await renderDiagram('/repo/a.drawio');
    editorXml = '<dirty/>';
    readImpl = async () => ({ content: '<disk/>', revision: 'rev-9' });
    clickProp(container, 'title', 'Save diagram');
    await flush();
    await flush();
    expect(lastDialogProps?.open).toBe(true);

    readImpl = async () => { throw new Error('Disk unreachable'); };
    clickProp(container, 'aria-label', 'Reload current version');
    await flush();
    await flush();
    expect(lastDialogProps?.open).toBe(true);
    expect(lastDialogProps?.conflict?.dirtyContent).toBe('<dirty/>');
    expect(lastEditorProps?.xml).toBe('<base/>');
    expect(editorXml).toBe('<dirty/>');
    expect(toastErrors.length).toBeGreaterThan(0);
  });

  test('stale save completion after a file switch never clobbers the new file', async () => {
    readImpl = async (path: string) => (
      path === '/repo/b.drawio'
        ? { content: '<base-b/>', revision: 'rev-b1' }
        : { content: '<base-a/>', revision: 'rev-a1' }
    );
    const gate = deferred<void>();
    writeImpl = async (path: string) => {
      await gate.promise;
      return { success: true, path, revision: 'rev-a2' };
    };
    const container = await renderDiagram('/repo/a.drawio');
    expect(lastEditorProps?.xml).toBe('<base-a/>');

    editorXml = '<dirty-a/>';
    clickProp(container, 'title', 'Save diagram');
    // Switch files while the A write is still in flight.
    await act(async () => {
      useUIStore.getState().setPendingDiagramFile('/repo/b.drawio');
      await Promise.resolve();
    });
    await flush();
    await flush();
    expect(lastEditorProps?.xml).toBe('<base-b/>');

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await flush();
    await flush();

    expect(lastEditorProps?.xml).toBe('<base-b/>');
    expect(lastDialogProps?.open).toBe(false);
  });

  test('missing read for a new path offers no editor or Save and writes nothing', async () => {
    readImpl = async (path: string) => (
      path === '/repo/b.drawio'
        ? undefined as unknown as { content: string; revision?: string | null }
        : { content: '<base-a/>', revision: 'rev-a1' }
    );
    const container = await renderDiagram('/repo/a.drawio');
    expect(lastEditorProps?.xml).toBe('<base-a/>');

    await act(async () => {
      useUIStore.getState().setPendingDiagramFile('/repo/b.drawio');
      await Promise.resolve();
    });
    await flush();
    await flush();
    // Failure is explicit and offers no editing surface with an unknown revision.
    expect(toastErrors.length).toBeGreaterThan(0);
    expect(findByProp(container, 'title', 'Save diagram')).toBeNull();
    expect(writes.length).toBe(0);
    expect(lastDialogProps?.open).toBe(false);

    // Old bytes/revision are not exposed: reopening the target captures a
    // fresh authoritative revision instead of reusing rev-a1 or saving unguarded.
    readImpl = async (path: string) => (
      path === '/repo/b.drawio'
        ? { content: '<base-b/>', revision: 'rev-b1' }
        : { content: '<base-a/>', revision: 'rev-a1' }
    );
    await act(async () => {
      useUIStore.getState().setPendingDiagramFile('/repo/b.drawio');
      await Promise.resolve();
    });
    await flush();
    await flush();
    expect(findByProp(container, 'title', 'Save diagram')).not.toBeNull();
    expect(lastEditorProps?.xml).toBe('<base-b/>');
    editorXml = '<dirty-b/>';
    clickProp(container, 'title', 'Save diagram');
    await flush();
    await flush();
    const last = writes[writes.length - 1];
    expect(last?.path).toBe('/repo/b.drawio');
    expect(last?.content).toBe('<dirty-b/>');
    expect(last?.options).toEqual({ expectedRevision: 'rev-b1' });
  });

  test('throw on new-scope load offers no editor or Save and writes nothing', async () => {
    readImpl = async (path: string) => {
      if (path === '/repo/b.drawio') throw new Error('Disk unreachable');
      return { content: '<base-a/>', revision: 'rev-a1' };
    };
    const container = await renderDiagram('/repo/a.drawio');
    expect(lastEditorProps?.xml).toBe('<base-a/>');

    await act(async () => {
      useUIStore.getState().setPendingDiagramFile('/repo/b.drawio');
      await Promise.resolve();
    });
    await flush();
    await flush();
    expect(toastErrors.length).toBeGreaterThan(0);
    expect(findByProp(container, 'title', 'Save diagram')).toBeNull();
    expect(writes.length).toBe(0);
    expect(lastDialogProps?.open).toBe(false);

    readImpl = async (path: string) => (
      path === '/repo/b.drawio'
        ? { content: '<base-b/>', revision: 'rev-b1' }
        : { content: '<base-a/>', revision: 'rev-a1' }
    );
    await act(async () => {
      useUIStore.getState().setPendingDiagramFile('/repo/b.drawio');
      await Promise.resolve();
    });
    await flush();
    await flush();
    expect(findByProp(container, 'title', 'Save diagram')).not.toBeNull();
    expect(lastEditorProps?.xml).toBe('<base-b/>');
    editorXml = '<dirty-b/>';
    clickProp(container, 'title', 'Save diagram');
    await flush();
    await flush();
    const last = writes[writes.length - 1];
    expect(last?.path).toBe('/repo/b.drawio');
    expect(last?.content).toBe('<dirty-b/>');
    expect(last?.options).toEqual({ expectedRevision: 'rev-b1' });
  });

  test('stale conflict completion after a runtime switch never opens over the new runtime', async () => {
    readImpl = async () => ({ content: '<base/>', revision: 'rev-1' });
    const gate = deferred<void>();
    writeImpl = async () => {
      await gate.promise;
      throw conflictError();
    };
    const container = await renderDiagram('/repo/a.drawio');
    expect(lastEditorProps?.xml).toBe('<base/>');
    editorXml = '<dirty/>';
    readImpl = async () => {
      await gate.promise;
      return { content: '<disk/>', revision: 'rev-9' };
    };
    clickProp(container, 'title', 'Save diagram');
    currentRuntimeKey = 'url:https://remote';
    readImpl = async () => ({ content: '<remote/>', revision: 'rev-r1' });
    await act(async () => {
      for (const listener of [...runtimeListeners]) listener({});
    });
    await flush();
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await flush();
    await flush();

    expect(lastDialogProps?.open).toBe(false);
    expect(toastErrors).toEqual([]);
    expect(lastEditorProps?.xml).toBe('<remote/>');
    expect(editorXml).toBe('<remote/>');

    writeImpl = async (path) => ({ success: true, path, revision: 'rev-r2' });
    editorXml = '<dirty-remote/>';
    clickProp(container, 'title', 'Save diagram');
    await flush();
    await flush();
    const last = writes[writes.length - 1];
    expect(last?.path).toBe('/repo/a.drawio');
    expect(last?.content).toBe('<dirty-remote/>');
    expect(last?.options).toEqual({ expectedRevision: 'rev-r1' });
  });

  test('interleaved edit during save is preserved', async () => {
    readImpl = async () => ({ content: '<base/>', revision: 'rev-1' });
    const gate = deferred<void>();
    writeImpl = async (path: string) => {
      await gate.promise;
      return { success: true, path, revision: 'rev-2' };
    };
    const container = await renderDiagram('/repo/a.drawio');
    expect(lastEditorProps?.xml).toBe('<base/>');

    editorXml = '<dirty/>';
    clickProp(container, 'title', 'Save diagram');
    // Edit typed while the '<dirty/>' write is in flight.
    editorXml = '<dirty+more/>';
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await flush();
    await flush();

    // The stale submitted bytes must not reset the editor and discard edits.
    expect(lastEditorProps?.xml).toBe('<base/>');
    expect(lastDialogProps?.open).toBe(false);
    expect(toastErrors).toEqual([]);

    // The new revision still backs the next guarded save of the latest edits.
    writeImpl = async (path) => ({ success: true, path, revision: 'rev-3' });
    clickProp(container, 'title', 'Save diagram');
    await flush();
    await flush();
    expect(writes[writes.length - 1]?.content).toBe('<dirty+more/>');
    expect(writes[writes.length - 1]?.options).toEqual({ expectedRevision: 'rev-2' });
  });

  test('overwrite captures latest editor XML, not the stale dialog snapshot', async () => {
    readImpl = async () => ({ content: '<base/>', revision: 'rev-1' });
    writeImpl = async () => { throw conflictError(); };
    const container = await renderDiagram('/repo/a.drawio');
    editorXml = '<dirty/>';
    readImpl = async () => ({ content: '<disk/>', revision: 'rev-9' });
    clickProp(container, 'title', 'Save diagram');
    await flush();
    await flush();
    expect(lastDialogProps?.open).toBe(true);
    expect(lastDialogProps?.conflict?.dirtyContent).toBe('<dirty/>');

    // Edits typed after the conflict must win over the dialog snapshot.
    editorXml = '<dirty+latest/>';
    writeImpl = async (path) => ({ success: true, path, revision: 'rev-10' });
    clickProp(container, 'aria-label', 'Overwrite with my edits');
    await flush();
    await flush();

    expect(writes[writes.length - 1]?.content).toBe('<dirty+latest/>');
    expect(writes[writes.length - 1]?.options).toEqual({ expectedRevision: 'rev-1', overwrite: true });
    expect(lastDialogProps?.open).toBe(false);
    expect(lastEditorProps?.xml).toBe('<dirty+latest/>');
  });

  test('interleaved edit during overwrite is preserved', async () => {
    readImpl = async () => ({ content: '<base/>', revision: 'rev-1' });
    writeImpl = async () => { throw conflictError(); };
    const container = await renderDiagram('/repo/a.drawio');
    editorXml = '<dirty/>';
    readImpl = async () => ({ content: '<disk/>', revision: 'rev-9' });
    clickProp(container, 'title', 'Save diagram');
    await flush();
    await flush();
    expect(lastDialogProps?.open).toBe(true);

    const gate = deferred<void>();
    writeImpl = async (path: string) => {
      await gate.promise;
      return { success: true, path, revision: 'rev-10' };
    };
    clickProp(container, 'aria-label', 'Overwrite with my edits');
    // Edit typed while the overwrite write is in flight.
    editorXml = '<dirty+more/>';
    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await flush();
    await flush();

    // Overwrite wrote the click-time bytes but must not reset later edits.
    expect(writes[writes.length - 1]?.content).toBe('<dirty/>');
    expect(lastEditorProps?.xml).toBe('<base/>');
    expect(lastDialogProps?.open).toBe(false);

    // Later edits remain saveable with the new revision.
    writeImpl = async (path) => ({ success: true, path, revision: 'rev-11' });
    clickProp(container, 'title', 'Save diagram');
    await flush();
    await flush();
    expect(writes[writes.length - 1]?.content).toBe('<dirty+more/>');
    expect(writes[writes.length - 1]?.options).toEqual({ expectedRevision: 'rev-10' });
  });

  test('new scope can save after a stale save completes', async () => {
    readImpl = async (path: string) => (
      path === '/repo/b.drawio'
        ? { content: '<base-b/>', revision: 'rev-b1' }
        : { content: '<base-a/>', revision: 'rev-a1' }
    );
    const gate = deferred<void>();
    writeImpl = async (path: string) => {
      await gate.promise;
      return { success: true, path, revision: 'rev-a2' };
    };
    const container = await renderDiagram('/repo/a.drawio');
    editorXml = '<dirty-a/>';
    clickProp(container, 'title', 'Save diagram');
    await act(async () => {
      useUIStore.getState().setPendingDiagramFile('/repo/b.drawio');
      await Promise.resolve();
    });
    await flush();
    await flush();
    expect(lastEditorProps?.xml).toBe('<base-b/>');

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await flush();
    await flush();
    expect(lastEditorProps?.xml).toBe('<base-b/>');

    // The new document must not be stuck saving after the stale completion.
    writeImpl = async (path) => ({ success: true, path, revision: 'rev-b2' });
    editorXml = '<dirty-b/>';
    clickProp(container, 'title', 'Save diagram');
    await flush();
    await flush();
    const last = writes[writes.length - 1];
    expect(last?.path).toBe('/repo/b.drawio');
    expect(last?.content).toBe('<dirty-b/>');
  });

  test('stale non-conflict error after a file switch is dropped', async () => {
    readImpl = async (path: string) => (
      path === '/repo/b.drawio'
        ? { content: '<base-b/>', revision: 'rev-b1' }
        : { content: '<base-a/>', revision: 'rev-a1' }
    );
    const gate = deferred<void>();
    writeImpl = async () => {
      await gate.promise;
      throw new Error('Disk unreachable');
    };
    const container = await renderDiagram('/repo/a.drawio');
    editorXml = '<dirty-a/>';
    clickProp(container, 'title', 'Save diagram');
    await act(async () => {
      useUIStore.getState().setPendingDiagramFile('/repo/b.drawio');
      await Promise.resolve();
    });
    await flush();
    await flush();
    expect(lastEditorProps?.xml).toBe('<base-b/>');

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await flush();
    await flush();

    expect(lastEditorProps?.xml).toBe('<base-b/>');
    expect(lastDialogProps?.open).toBe(false);
    expect(toastErrors).toEqual([]);
  });

  test('Esc/close while resolving keeps the dialog open', async () => {
    readImpl = async () => ({ content: '<base/>', revision: 'rev-1' });
    writeImpl = async () => { throw conflictError(); };
    const container = await renderDiagram('/repo/a.drawio');
    editorXml = '<dirty/>';
    readImpl = async () => ({ content: '<disk/>', revision: 'rev-9' });
    clickProp(container, 'title', 'Save diagram');
    await flush();
    await flush();
    expect(lastDialogProps?.open).toBe(true);

    const gate = deferred<void>();
    writeImpl = async (path: string) => {
      await gate.promise;
      return { success: true, path, revision: 'rev-10' };
    };
    clickProp(container, 'aria-label', 'Overwrite with my edits');
    await flush();
    expect(lastDialogProps?.isResolving).toBe(true);

    await act(async () => {
      lastDialogProps?.onClose();
    });
    await flush();
    expect(lastDialogProps?.open).toBe(true);
    expect(lastDialogProps?.conflict?.dirtyContent).toBe('<dirty/>');

    await act(async () => {
      gate.resolve();
      await gate.promise;
    });
    await flush();
    await flush();
    expect(lastDialogProps?.open).toBe(false);
  });
});
