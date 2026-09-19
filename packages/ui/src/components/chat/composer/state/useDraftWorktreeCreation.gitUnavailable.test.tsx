import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import type { DraftWorktreeIntent } from '@/sync/session-ui-store';
import type { AttachedFile } from '@/stores/types/sessionTypes';

let runtimeKey = 'runtime-a';

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => runtimeKey,
}));

mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({ git: null }),
}));

mock.module('@/components/chat/composer/state/worktreeName', () => ({
  deriveWorktreeName: async () => 'named-tree',
}));

const { useWorktreeCreationStore } = await import('@/stores/useWorktreeCreationStore');
const { useDraftWorktreeCreation } = await import('./useDraftWorktreeCreation');

const intent = (overrides: Partial<DraftWorktreeIntent> = {}): DraftWorktreeIntent => ({
  runtimeKey,
  projectRoot: '/repo',
  sourceDirectory: '/repo',
  startRef: 'main',
  ...overrides,
});

const readyFile = (id: string): AttachedFile => ({
  id,
  file: new File(['payload'], `${id}.txt`, { type: 'text/plain' }),
  dataUrl: 'data:text/plain;base64,cGF5bG9hZA==',
  mimeType: 'text/plain',
  filename: `${id}.txt`,
  size: 7,
  source: 'local',
  uploadState: { status: 'ready', attachmentId: `opaque-${id}`, expiresAt: Date.now() + 60_000 },
});

// Minimal DOM stub (useChatAutoFollow.test.ts precedent): enough for
// react-dom/client + act to mount a hook probe without a browser.
const installMinimalDom = (): (() => void) => {
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
  setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return () => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
};

const roots: Root[] = [];
const domRestores: Array<() => void> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  for (const restore of domRestores.splice(0)) restore();
});

type RequestFn = (params: {
  intent: DraftWorktreeIntent;
  prompt: string;
  failedSend?: {
    prompt: string;
    confirmedMentions: readonly string[] | Set<string>;
    attachments: readonly AttachedFile[];
  };
}) => Promise<unknown>;

const Harness: React.FC<{ taskId: string; draftIntent: DraftWorktreeIntent; onRequest: (fn: RequestFn) => void }> = ({
  taskId,
  draftIntent,
  onRequest,
}) => {
  const api = useDraftWorktreeCreation({ taskId, intent: draftIntent });
  React.useEffect(() => {
    onRequest(api.request as RequestFn);
  }, [api, onRequest]);
  return null;
};

describe('useDraftWorktreeCreation git-unavailable retention', () => {
  beforeEach(() => {
    runtimeKey = 'runtime-a';
    useWorktreeCreationStore.getState().resetForRuntimeSwitch(runtimeKey);
  });

  test('a missing runtime git still retains the failed send in task-owned state', async () => {
    domRestores.push(installMinimalDom());
    const container = (globalThis as unknown as { document: { body: Element } }).document.body;
    const root = createRoot(container);
    roots.push(root);
    let latestRequest: RequestFn | null = null;
    const draftIntent = intent();
    await act(async () => {
      root.render(
        React.createElement(Harness, {
          taskId: 'draft-git-missing',
          draftIntent,
          onRequest: (fn) => {
            latestRequest = fn;
          },
        }),
      );
    });
    expect(latestRequest).not.toBeNull();

    // The hook reports failure as null (like every creation failure), but the
    // store must own the retained prompt so Background tasks can Restore draft
    // after ChatInput has already rotated the draft.
    let result: unknown = 'pending';
    await act(async () => {
      result = await latestRequest!({
        intent: draftIntent,
        prompt: 'fix the flaky test @src/a.ts',
        failedSend: {
          prompt: 'fix the flaky test @src/a.ts',
          confirmedMentions: ['src/a.ts'],
          attachments: [readyFile('a')],
        },
      });
    });
    expect(result).toBeNull();

    const entry = useWorktreeCreationStore.getState().getEntryByKey('draft-git-missing');
    expect(entry?.state?.phase).toBe('failed');
    expect(entry?.state?.error).toContain('unavailable');
    // Task-owned retention under the draft task ID: prompt, mentions, files.
    expect(entry?.failedSend?.prompt).toBe('fix the flaky test @src/a.ts');
    expect(entry?.failedSend?.confirmedMentions).toEqual(['src/a.ts']);
    expect(entry?.failedSend?.attachments.map((file) => file.id)).toEqual(['a']);
    // Immutable snapshot: preview URLs stay stripped for dispatch fallback.
    expect(entry?.failedSend?.attachments[0].previewUrl).toBeUndefined();
  });
});
