import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, mock, test } from 'bun:test';

const turnDiffData = new Map([
  ['src/turn.ts', { original: 'before', modified: 'after', isBinary: false, contextMode: 'patch' as const }],
]);

mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/repo' }));
mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({ git: {}, files: {} }),
}));
mock.module('@/lib/device', () => ({
  useDeviceInfo: () => ({ screenWidth: 1200, isMobile: false }),
}));
mock.module('@/lib/sessionEvents', () => ({
  sessionEvents: { onGitRefreshHint: () => () => undefined },
}));
mock.module('@/stores/useGitStore', () => {
  const state = {
    setActiveDirectory: () => undefined,
    ensureStatus: async () => undefined,
    fetchStatus: async () => undefined,
    clearDiffCache: () => undefined,
    setDiff: () => undefined,
  };
  return {
    useGitStore: (selector: (value: typeof state) => unknown) => selector(state),
    useGitStatus: () => null,
    useIsGitRepo: () => true,
    useGitLoadingStatus: () => false,
  };
});
mock.module('@/stores/useUIStore', () => {
  const state = {
    pendingDiffFile: null,
    pendingDiffStaged: false,
    pendingDiffScope: null,
    setPendingDiffFile: () => undefined,
    diffLayoutPreference: 'inline',
    diffFileLayout: {},
    setDiffFileLayout: () => undefined,
    diffWrapLines: false,
    setDiffWrapLines: () => undefined,
    openContextFileAtLine: () => undefined,
  };
  return { useUIStore: (selector: (value: typeof state) => unknown) => selector(state) };
});
mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: (selector: (value: { currentSessionId: null }) => unknown) => selector({ currentSessionId: null }),
}));
mock.module('@/sync/sync-context', () => ({ useSessionMessageRecords: () => [] }));
mock.module('../useBranchAndTurnDiffs', () => ({
  useBranchAndTurnDiffs: () => ({
    branchDiffs: [{ file: 'src/branch.ts', status: 'modified', additions: 1, deletions: 0 }],
    branchDiffError: null,
    branchDiffLoading: false,
    lastTurnDiffs: [{ file: 'src/turn.ts', status: 'modified', additions: 1, deletions: 1 }],
    lastTurnDiffData: turnDiffData,
    branchDiffData: new Map(),
  }),
}));
mock.module('../useDiffScrollManager', () => ({
  useDiffScrollManager: () => ({
    diffScrollRef: { current: null },
    pinnedStackedTarget: null,
    pendingScrollTargetRef: { current: null },
    shouldPinAfterAlignRef: { current: false },
    pendingScrollAnchorRestoreRef: { current: null },
    lastScrollAnchorRef: { current: null },
    captureScrollAnchor: () => null,
    cancelPendingScrollAlignment: () => undefined,
    queueVisibleStackedFilesSync: () => undefined,
    registerSectionRef: () => undefined,
    scrollToFile: () => false,
  }),
}));
mock.module('../useDiffEditorOpener', () => ({
  useDiffEditorOpener: () => ({ openingEditorFilePath: null, openFileInEditorAtChange: async () => undefined }),
}));

const { useDiffViewState } = await import('../useDiffViewState');
type HookOptions = Parameters<typeof useDiffViewState>[0];
type HookResult = ReturnType<typeof useDiffViewState>;

let latest: HookResult | null = null;
const Probe = (props: HookOptions) => {
  latest = useDiffViewState(props);
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

const renderHook = async (options: HookOptions) => {
  const dom = installMinimalDom();
  restoreFns.push(dom.restore);
  const root = createRoot(dom.container);
  roots.push(root);
  await act(async () => root.render(<Probe {...options} />));
  return root;
};

const rerender = async (root: Root, options: HookOptions) => {
  await act(async () => root.render(<Probe {...options} />));
};

const result = () => {
  if (!latest) throw new Error('Hook did not render');
  return latest;
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  restoreFns.splice(0).forEach((restore) => restore());
  latest = null;
});

describe('useDiffViewState stacked diff mounting', () => {
  test('mounts a directly opened Last-turn diff immediately and removes it on collapse', async () => {
    await renderHook({ diffScope: 'turn', stackedDefaultCollapsedAll: true });

    expect(result().expandedFiles.has('src/turn.ts')).toBe(false);
    expect(result().mountedStackedFiles.has('src/turn.ts')).toBe(false);
    expect(result().lastTurnDiffData.get('src/turn.ts')).toEqual(turnDiffData.get('src/turn.ts'));

    await act(async () => result().handleStackedEntryExpandedChange('src/turn.ts', true));

    expect(result().expandedFiles.has('src/turn.ts')).toBe(true);
    expect(result().mountedStackedFiles.has('src/turn.ts')).toBe(true);

    await act(async () => result().handleStackedEntryExpandedChange('src/turn.ts', false));

    expect(result().expandedFiles.has('src/turn.ts')).toBe(false);
    expect(result().mountedStackedFiles.has('src/turn.ts')).toBe(false);
  });

  test('keeps default and bulk expansion viewport-mounted', async () => {
    await renderHook({ diffScope: 'turn' });

    expect(result().expandedFiles).toEqual(new Set(['src/turn.ts']));
    expect(result().mountedStackedFiles.size).toBe(0);

    await act(async () => result().handleExpandOrCollapseAll());
    await act(async () => result().handleExpandOrCollapseAll());

    expect(result().expandedFiles).toEqual(new Set(['src/turn.ts']));
    expect(result().mountedStackedFiles.size).toBe(0);
  });

  test('clears mounted paths when the diff scope changes', async () => {
    const root = await renderHook({ diffScope: 'turn', stackedDefaultCollapsedAll: true });
    await act(async () => result().handleStackedEntryExpandedChange('src/turn.ts', true));

    await rerender(root, { diffScope: 'branch', stackedDefaultCollapsedAll: true });

    expect(result().activeDiffScope).toBe('branch');
    expect(result().expandedFiles.size).toBe(0);
    expect(result().mountedStackedFiles.size).toBe(0);
  });
});
