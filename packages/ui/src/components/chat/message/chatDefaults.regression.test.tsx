import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('motion', () => ({
  animate: () => ({
    finished: Promise.resolve(),
    stop: () => undefined,
  }),
}));

mock.module('@/components/chat/markdown/markdown-worker', () => ({
  highlightCodeInWorker: async () => null,
  highlightLinesInWorker: async () => [],
  highlightTokensInWorker: async () => null,
}));

mock.module('@/components/ui/ScrollableOverlay', () => ({
  ScrollableOverlay: React.forwardRef(
    (props: Record<string, unknown>, ref: React.Ref<HTMLElement>) => {
      const { outerClassName, children, as: Component = 'div', ...rest } = props as {
        outerClassName?: string;
        children?: React.ReactNode;
        as?: React.ElementType;
      } & Record<string, unknown>;
      const domRest: Record<string, unknown> = { ...(rest as Record<string, unknown>) };
      delete domRest.useScrollShadow;
      delete domRest.scrollShadowSize;
      delete domRest.userIntentOnly;
      delete domRest.observeMutations;
      const Inner = Component as React.ElementType;
      return React.createElement(
        'div',
        { className: outerClassName },
        React.createElement(Inner, { ...(domRest as object), ref }, children),
      );
    },
  ),
}));

// Reasoning settled mounts and user-text mounts both render through the lazy
// markdown stack, which needs RuntimeAPI/context in a full browser. Render
// the markdown source as text (stripping bold markers so '**world**' never
// leaks as raw source) while preserving the layout classes the fixed-default
// assertions check. Static-markup assertions only require content presence.
mock.module('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: (props: { content?: unknown }) => {
    const text = typeof props.content === 'string' ? props.content.replace(/\*\*([^*]+)\*\*/g, '$1') : '';
    return React.createElement('div', { 'data-markdown-content': 'true' }, text);
  },
  SimpleMarkdownRenderer: (props: { content?: unknown }) => {
    const text = typeof props.content === 'string' ? props.content.replace(/\*\*([^*]+)\*\*/g, '$1') : '';
    return React.createElement(
      'div',
      { className: 'break-words w-full min-w-0', 'data-markdown-content': 'true' },
      text,
    );
  },
}));

import type { Message, Part } from '@/lib/chat/types';
import {
  expandedToolsStateCache,
  readExpandedToolsCache,
  writeExpandedToolsCache,
} from './chatToolExpansion';
import { useChatMessagePopupState } from './useChatMessagePopupState';
import { useTurnToolsState } from './useTurnToolsState';
import type { ToolPopupContent } from './types';
import {
  buildProjectionCacheKey,
  getCachedProjection,
  setCachedProjection,
} from '../lib/turns/turnProjectionCache';
import { projectTurnRecords } from '../lib/turns/projectTurnRecords';
import type { ChatMessageEntry, TurnActivityRecord } from '../lib/turns/types';
import UserTextPart from './parts/UserTextPart';
import { sanitizeWebSettings } from '@/lib/persistence/settingsSanitizers';
import { useUIStore } from '@/stores/useUIStore';

const { default: ReasoningPart, ReasoningTimelineBlock } = await import('./parts/ReasoningPart');

const LONG_REASONING =
  'First thought about the task at hand and how to approach it carefully.\n' +
  'This second line goes into much deeper detail about the internal reasoning ' +
  'process that should remain hidden in the collapsed header view.';

const RETIRED_UI_KEYS = [
  'showReasoningTraces',
  'collapsibleThinkingBlocks',
  'collapseThinkingByDefault',
  'persistChatDraft',
  'inputSpellcheckEnabled',
  'wideChatLayoutEnabled',
  'codeBlockLineWrap',
  'showToolFileIcons',
  'showTurnChangedFiles',
  'showExpandedBashTools',
  'showExpandedEditTools',
  'desktopWindowControlsPosition',
  'desktopWindowControlsStyle',
  'mermaidRenderingMode',
  'userMessageRenderingMode',
  'collapsibleUserMessages',
  'stickyUserHeader',
  'promptNavigatorEnabled',
  'showSplitAssistantMessageActions',
] as const;

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
  const rootElement = {
    nodeType: 1,
    tagName: 'DIV',
    nodeName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentStub,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  documentStub.documentElement = rootElement;
  documentStub.body = rootElement;
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0),
  );
  setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  return {
    container: rootElement as unknown as Element,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

type ReasoningFakeNode = {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: unknown;
  parentNode: ReasoningFakeNode | null;
  childNodes: ReasoningFakeNode[];
  style: Record<string, unknown>;
  [key: string]: unknown;
};

const makeReasoningNode = (tag: string, owner: Record<string, unknown>): ReasoningFakeNode => {
  const node: ReasoningFakeNode = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    ownerDocument: owner,
    parentNode: null,
    childNodes: [],
    style: {
      setProperty() {},
      getPropertyValue() { return ''; },
    },
    setAttribute() {},
    removeAttribute() {},
    hasAttribute() { return false; },
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child: ReasoningFakeNode) {
      node.childNodes.push(child);
      child.parentNode = node;
      return child;
    },
    insertBefore(child: ReasoningFakeNode, ref: ReasoningFakeNode) {
      const index = node.childNodes.indexOf(ref);
      if (index < 0) node.childNodes.push(child);
      else node.childNodes.splice(index, 0, child);
      child.parentNode = node;
      return child;
    },
    removeChild(child: ReasoningFakeNode) {
      const index = node.childNodes.indexOf(child);
      if (index >= 0) node.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    contains() { return false; },
    textContent: '',
    innerHTML: '',
  };
  return node;
};

const installReasoningDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const documentStub: Record<string, unknown> = {
    nodeType: 9,
    nodeName: '#document',
    defaultView: globalThis,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    createElement: (tag: string) => makeReasoningNode(tag, documentStub),
    createElementNS: (_ns: string, tag: string) => makeReasoningNode(tag, documentStub),
    createTextNode: (text: string) => ({ nodeType: 3, nodeName: '#text', textContent: text, parentNode: null }),
    getElementById: () => null,
  };
  const rootElement = makeReasoningNode('div', documentStub);
  (documentStub as Record<string, unknown>).body = rootElement;
  (documentStub as Record<string, unknown>).documentElement = rootElement;
  (documentStub as Record<string, unknown>).ownerDocument = documentStub;
  class ElementStub {}
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0),
  );
  setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  if (typeof (globalThis as Record<string, unknown>).ResizeObserver === 'undefined') {
    setGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  }
  if (typeof (globalThis as Record<string, unknown>).MutationObserver === 'undefined') {
    setGlobal('MutationObserver', class { observe() {} disconnect() {} });
  }
  // Reasoning settled mounts render through the lazy MarkdownRenderer
  // Suspense fallback, which reads window.location, while the full markdown
  // stack touches customElements for the diffs web component. Stub both so
  // expansion transitions stay testable without the browser stack.
  const previousLocation = (globalThis as Record<string, unknown>).location;
  if (previousLocation === undefined) {
    setGlobal('location', { search: '', href: 'http://localhost/', origin: 'http://localhost' });
  } else if (typeof previousLocation === 'object' && previousLocation !== null) {
    const locationRecord = previousLocation as Record<string, unknown>;
    if (typeof locationRecord.search !== 'string') {
      try {
        (globalThis as { location: { search: string } }).location.search = '';
      } catch {
        setGlobal('location', { ...(locationRecord as object), search: '' });
      }
    }
  }
  if (typeof (globalThis as Record<string, unknown>).customElements === 'undefined') {
    setGlobal('customElements', { get: () => ({}), define: () => undefined });
  }
  if (typeof (globalThis as Record<string, unknown>).matchMedia === 'undefined') {
    setGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  }
  const container = (documentStub.createElement as (tag: string) => ReasoningFakeNode)('div');
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

const getReasoningProps = (node: ReasoningFakeNode): Record<string, unknown> | null => {
  const key = Object.keys(node).find((candidate) => candidate.startsWith('__reactProps'));
  if (!key) return null;
  return (node as unknown as Record<string, Record<string, unknown>>)[key] ?? null;
};

const findReasoningToggle = (root: ReasoningFakeNode): ReasoningFakeNode | null => {
  const visit = (node: ReasoningFakeNode): ReasoningFakeNode | null => {
    const props = getReasoningProps(node);
    const label = props?.['aria-label'];
    if (
      node.nodeType === 1
      && (label === 'Expand reasoning trace' || label === 'Collapse reasoning trace')
    ) {
      return node;
    }
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(root);
};

const readReasoningExpanded = (root: ReasoningFakeNode): boolean => {
  const toggle = findReasoningToggle(root);
  if (!toggle) throw new Error('reasoning toggle not found');
  return getReasoningProps(toggle)?.['aria-expanded'] === true;
};

const clickReasoningToggle = (root: ReasoningFakeNode): void => {
  const toggle = findReasoningToggle(root);
  if (!toggle) throw new Error('reasoning toggle not found');
  const props = getReasoningProps(toggle);
  const onClick = props?.['onClick'] as ((event: unknown) => void) | undefined;
  if (typeof onClick !== 'function') throw new Error('reasoning toggle has no onClick');
  act(() => {
    onClick({ preventDefault() {}, stopPropagation() {} });
  });
};

const createEntry = (id: string, text: string): ChatMessageEntry => ({
  info: { id, role: 'assistant' } as Message,
  parts: [{ id: `${id}-part`, type: 'text', text } as Part],
});

const createTurnMessage = ({
  id,
  role,
  parentID,
}: {
  id: string;
  role: 'user' | 'assistant';
  parentID?: string;
}): ChatMessageEntry => ({
  info: {
    id,
    role,
    ...(parentID ? { parentID } : {}),
    time: { created: 1 },
  } as Message,
  parts: [] as Part[],
});

beforeEach(() => {
  expandedToolsStateCache.clear();
});

describe('chat fixed defaults: per-message popup state', () => {
  test('popup opens only for image or mermaid content and tracks the store overlay flag', async () => {
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    try {
      let api: ReturnType<typeof useChatMessagePopupState> | undefined;
      const Harness = () => {
        api = useChatMessagePopupState();
        return null;
      };
      await act(async () => {
        await root.render(React.createElement(Harness));
      });
      expect(api).toBeDefined();
      expect(api?.popupContent.open).toBe(false);

      const textOnly = { open: true, title: 't', content: 'c' } as ToolPopupContent;
      act(() => {
        api?.handleShowPopup(textOnly);
      });
      expect(api?.popupContent.open).toBe(false);
      expect(useUIStore.getState().isImagePreviewOpen).toBe(false);

      const image = { ...textOnly, image: { url: 'data:image/png;base64,AAA' } } as ToolPopupContent;
      act(() => {
        api?.handleShowPopup(image);
      });
      expect(api?.popupContent.open).toBe(true);
      expect(api?.popupContent.image?.url).toBe('data:image/png;base64,AAA');
      expect(useUIStore.getState().isImagePreviewOpen).toBe(true);

      act(() => {
        api?.handlePopupChange(false);
      });
      expect(api?.popupContent.open).toBe(false);
      expect(useUIStore.getState().isImagePreviewOpen).toBe(false);
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });
});

describe('chat fixed defaults: bash/edit disclosure starts closed and toggles', () => {
  test('turn-level rail tools toggle manually and survive remount through the per-message expanded cache', async () => {
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    const activities = [
      {
        id: 'turn-bash-remount',
        turnId: 'turn-1',
        messageId: 'msg-rail-remount',
        partIndex: 0,
        kind: 'tool',
        part: { id: 'turn-bash-remount', type: 'tool', tool: 'bash' },
      },
    ] as unknown as TurnActivityRecord[];
    try {
      let api: ReturnType<typeof useTurnToolsState> | undefined;
      const Harness = () => {
        api = useTurnToolsState({ activities });
        return null;
      };
      let activeRoot: Root = root;
      await act(async () => {
        await activeRoot.render(React.createElement(Harness));
      });
      expect([...(api?.effectiveExpandedTools ?? [])]).toEqual([]);

      act(() => {
        api?.handleToggleTool('turn-bash-remount');
      });
      expect(api?.effectiveExpandedTools.has('turn-bash-remount')).toBe(true);
      expect(readExpandedToolsCache('msg-rail-remount').has('turn-bash-remount')).toBe(true);

      await act(async () => {
        await activeRoot.unmount();
      });
      activeRoot = createRoot(dom.container);
      await act(async () => {
        await activeRoot.render(React.createElement(Harness));
      });
      expect(api?.effectiveExpandedTools.has('turn-bash-remount')).toBe(true);

      act(() => {
        api?.handleToggleTool('turn-bash-remount');
      });
      expect(api?.effectiveExpandedTools.has('turn-bash-remount')).toBe(false);
      expect(readExpandedToolsCache('msg-rail-remount').has('turn-bash-remount')).toBe(false);
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });

  test('turn-level tools start closed, toggle, and preserve unrelated cached tools for the same owner', async () => {
    writeExpandedToolsCache('msg-owner', new Set(['outside-turn-tool']));

    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    try {
      let api: ReturnType<typeof useTurnToolsState> | undefined;
      const activities = [
        {
          id: 'turn-bash-1',
          turnId: 'turn-1',
          messageId: 'msg-owner',
          partIndex: 0,
          kind: 'tool',
          part: { id: 'turn-bash-1', type: 'tool', tool: 'bash' },
        },
        {
          id: 'turn-edit-1',
          turnId: 'turn-1',
          messageId: 'msg-owner',
          partIndex: 1,
          kind: 'tool',
          part: { id: 'turn-edit-1', type: 'tool', tool: 'edit' },
        },
      ] as unknown as TurnActivityRecord[];
      const Harness = () => {
        api = useTurnToolsState({ activities });
        return null;
      };
      await act(async () => {
        await root.render(React.createElement(Harness));
      });
      expect([...(api?.effectiveExpandedTools ?? [])]).toEqual([]);

      act(() => {
        api?.handleToggleTool('turn-bash-1');
      });
      expect(api?.effectiveExpandedTools.has('turn-bash-1')).toBe(true);
      expect(api?.effectiveExpandedTools.has('turn-edit-1')).toBe(false);
      expect(readExpandedToolsCache('msg-owner').has('outside-turn-tool')).toBe(true);
      expect(readExpandedToolsCache('msg-owner').has('turn-bash-1')).toBe(true);

      act(() => {
        api?.handleToggleTool('turn-bash-1');
      });
      expect(api?.effectiveExpandedTools.has('turn-bash-1')).toBe(false);
      expect(readExpandedToolsCache('msg-owner').has('outside-turn-tool')).toBe(true);
      expect(readExpandedToolsCache('msg-owner').has('turn-bash-1')).toBe(false);
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });

  test('turn-level toggle ignores unknown tool ids without changing disclosure', async () => {
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    try {
      let api: ReturnType<typeof useTurnToolsState> | undefined;
      const activities = [
        {
          id: 'turn-known-1',
          turnId: 'turn-1',
          messageId: 'msg-unknown-check',
          partIndex: 0,
          kind: 'tool',
          part: { id: 'turn-known-1', type: 'tool', tool: 'bash' },
        },
      ] as unknown as TurnActivityRecord[];
      const Harness = () => {
        api = useTurnToolsState({ activities });
        return null;
      };
      await act(async () => {
        await root.render(React.createElement(Harness));
      });
      act(() => {
        api?.handleToggleTool('missing-tool');
      });
      expect([...(api?.effectiveExpandedTools ?? [])]).toEqual([]);
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });
});

describe('chat fixed defaults: projection and cache semantics survive the retired flags', () => {
  test('projection cache key stays stable, reacts to content, and round-trips through the LRU', () => {
    const messages = [createEntry('msg_1', 'hello')];
    const first = buildProjectionCacheKey('session-fixed-1', messages, false, 'merge');
    const second = buildProjectionCacheKey('session-fixed-1', messages, false, 'merge');
    expect(second).toBe(first);

    const updated = [
      {
        info: messages[0]?.info as Message,
        parts: [{ id: 'hello-part', type: 'text', text: 'hello world' } as Part],
      },
    ];
    expect(buildProjectionCacheKey('session-fixed-1', updated, false, 'merge')).not.toBe(first);
    expect(buildProjectionCacheKey('session-fixed-1', messages, true, 'merge')).not.toBe(first);

    const projection = projectTurnRecords([
      createTurnMessage({ id: 'u-fixed-1', role: 'user' }),
      createTurnMessage({ id: 'a-fixed-1', role: 'assistant', parentID: 'u-fixed-1' }),
    ]);
    setCachedProjection(first, projection);
    expect(getCachedProjection(first)).toBe(projection);
  });

  test('projected turns never carry changed files, even when a retired flag is passed', () => {
    const user = createTurnMessage({ id: 'u-fixed-2', role: 'user' });
    const assistant = createTurnMessage({ id: 'a-fixed-2', role: 'assistant', parentID: 'u-fixed-2' });

    const plain = projectTurnRecords([user, assistant]);
    expect(plain.turns).toHaveLength(1);
    expect(plain.turns[0]?.changedFiles).toBe(undefined);

    const withRetiredFlag = projectTurnRecords([user, assistant], {
      showTurnChangedFiles: true,
    } as unknown as Partial<Parameters<typeof projectTurnRecords>[1]>);
    expect(withRetiredFlag.turns).toHaveLength(1);
    expect(withRetiredFlag.turns[0]?.changedFiles).toBe(undefined);
  });

  test('previous-projection reuse still isolates disclosure from unrelated turn updates', () => {
    const user1 = createTurnMessage({ id: 'u-reuse-1', role: 'user' });
    const assistant1 = createTurnMessage({ id: 'a-reuse-1', role: 'assistant', parentID: 'u-reuse-1' });
    const user2 = createTurnMessage({ id: 'u-reuse-2', role: 'user' });
    const assistant2 = createTurnMessage({ id: 'a-reuse-2', role: 'assistant', parentID: 'u-reuse-2' });
    const initial = projectTurnRecords([user1, assistant1, user2, assistant2]);
    const updatedAssistant2: ChatMessageEntry = {
      ...assistant2,
      parts: [{ type: 'text', text: 'stream update' } as Part],
    };
    const next = projectTurnRecords([user1, assistant1, user2, updatedAssistant2], {
      previousProjection: initial,
    });
    expect(next.turns[0]).toBe(initial.turns[0]);
    expect(next.turns[1]).not.toBe(initial.turns[1]);
  });
});

describe('chat fixed defaults: reasoning stays visible, collapsible, and starts collapsed', () => {
  test('non-empty reasoning renders a visible Thinking disclosure that starts collapsed', () => {
    const markup = renderToStaticMarkup(
      <ReasoningTimelineBlock
        text={LONG_REASONING}
        variant="thinking"
        blockId="reasoning-fixed-visible"
      />,
    );
    expect(markup).toContain('Thinking');
    expect(markup).toContain('role="button"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand reasoning trace"');
    expect(markup).toContain('First thought');
    expect(markup).toContain('…');
    expect(markup).not.toContain('data-message-text-export-source');
    expect(markup).not.toContain('remain hidden in the collapsed header view');
  });

  test('empty reasoning renders nothing instead of an empty disclosure', () => {
    const markup = renderToStaticMarkup(
      <ReasoningTimelineBlock text="   " variant="thinking" blockId="reasoning-fixed-empty" />,
    );
    expect(markup).toBe('');
  });

  test('live thinking starts collapsed with a streaming header preview', () => {
    const markup = renderToStaticMarkup(
      <ReasoningPart
        part={{
          id: 'reasoning-fixed-live',
          type: 'reasoning',
          text: LONG_REASONING,
          streaming: true,
        }}
        messageId="message-fixed-live"
        streamPhase="streaming"
      />,
    );
    expect(markup).toContain('Thinking');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand reasoning trace"');
    expect(markup).not.toContain('data-message-text-export-source');
    expect(markup).not.toContain('max-h-80');
    expect(markup).toContain('This second line');
    expect(markup).toContain('…');
  });

  test('settled thinking stays collapsed instead of opening away', () => {
    const markup = renderToStaticMarkup(
      <ReasoningPart
        part={{
          id: 'reasoning-fixed-settled',
          type: 'reasoning',
          text: LONG_REASONING,
          streaming: false,
        }}
        messageId="message-fixed-settled"
        streamPhase="streaming"
      />,
    );
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand reasoning trace"');
    expect(markup).not.toContain('data-message-text-export-source');
    expect(markup).toContain('First thought');
  });

  test('manual toggle expands and re-collapses the fixed reasoning block', async () => {
    const dom = installReasoningDom();
    const root: Root = createRoot(dom.container);
    try {
      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text={LONG_REASONING}
            variant="thinking"
            blockId="reasoning-fixed-toggle"
            isStreaming
          />,
        );
      });
      expect(readReasoningExpanded(dom.container as unknown as ReasoningFakeNode)).toBe(false);

      clickReasoningToggle(dom.container as unknown as ReasoningFakeNode);
      expect(readReasoningExpanded(dom.container as unknown as ReasoningFakeNode)).toBe(true);

      clickReasoningToggle(dom.container as unknown as ReasoningFakeNode);
      expect(readReasoningExpanded(dom.container as unknown as ReasoningFakeNode)).toBe(false);
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });

  test('live-to-settled keeps the fixed reasoning block collapsed', async () => {
    const dom = installReasoningDom();
    const root: Root = createRoot(dom.container);
    try {
      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text={LONG_REASONING}
            variant="thinking"
            blockId="reasoning-fixed-settle"
            isStreaming
          />,
        );
      });
      expect(readReasoningExpanded(dom.container as unknown as ReasoningFakeNode)).toBe(false);

      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text={LONG_REASONING}
            variant="thinking"
            blockId="reasoning-fixed-settle"
            isStreaming={false}
          />,
        );
      });
      expect(readReasoningExpanded(dom.container as unknown as ReasoningFakeNode)).toBe(false);
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });

  test('manually expanded reasoning stays expanded when the fixed block settles', async () => {
    const dom = installReasoningDom();
    const root: Root = createRoot(dom.container);
    try {
      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text={LONG_REASONING}
            variant="thinking"
            blockId="reasoning-fixed-manual"
            isStreaming
          />,
        );
      });
      expect(readReasoningExpanded(dom.container as unknown as ReasoningFakeNode)).toBe(false);
      clickReasoningToggle(dom.container as unknown as ReasoningFakeNode);
      expect(readReasoningExpanded(dom.container as unknown as ReasoningFakeNode)).toBe(true);

      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text={LONG_REASONING}
            variant="thinking"
            blockId="reasoning-fixed-manual"
            isStreaming={false}
          />,
        );
      });
      expect(readReasoningExpanded(dom.container as unknown as ReasoningFakeNode)).toBe(true);
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });

  test('collapsed reasoning stays collapsed through repeated deltas and settle', async () => {
    const dom = installReasoningDom();
    const root: Root = createRoot(dom.container);
    try {
      const deltas = [
        'First thought about the task.',
        'First thought about the task.\nSecond line arrives with more detail.',
        LONG_REASONING,
      ];
      for (const text of deltas) {
        await act(async () => {
          await root.render(
            <ReasoningTimelineBlock
              text={text}
              variant="thinking"
              blockId="reasoning-fixed-deltas"
              isStreaming
            />,
          );
        });
        expect(readReasoningExpanded(dom.container as unknown as ReasoningFakeNode)).toBe(false);
      }

      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text={LONG_REASONING}
            variant="thinking"
            blockId="reasoning-fixed-deltas"
            isStreaming={false}
          />,
        );
      });
      expect(readReasoningExpanded(dom.container as unknown as ReasoningFakeNode)).toBe(false);
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });

  test('explicit collapse remains collapsed through updates and settle', async () => {
    const dom = installReasoningDom();
    const root: Root = createRoot(dom.container);
    try {
      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text="First thought about the task."
            variant="thinking"
            blockId="reasoning-fixed-collapse-updates"
            isStreaming
          />,
        );
      });
      expect(readReasoningExpanded(dom.container as unknown as ReasoningFakeNode)).toBe(false);
      clickReasoningToggle(dom.container as unknown as ReasoningFakeNode);
      expect(readReasoningExpanded(dom.container as unknown as ReasoningFakeNode)).toBe(true);
      clickReasoningToggle(dom.container as unknown as ReasoningFakeNode);
      expect(readReasoningExpanded(dom.container as unknown as ReasoningFakeNode)).toBe(false);

      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text={LONG_REASONING}
            variant="thinking"
            blockId="reasoning-fixed-collapse-updates"
            isStreaming
          />,
        );
      });
      expect(readReasoningExpanded(dom.container as unknown as ReasoningFakeNode)).toBe(false);

      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text={LONG_REASONING}
            variant="thinking"
            blockId="reasoning-fixed-collapse-updates"
            isStreaming={false}
          />,
        );
      });
      expect(readReasoningExpanded(dom.container as unknown as ReasoningFakeNode)).toBe(false);
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });
});

describe('chat fixed defaults: user text stays markdown-only', () => {
  test('user text mounts collapsed through the markdown renderer slot without a plain-text branch', () => {
    const markup = renderToStaticMarkup(
      <UserTextPart
        part={{ id: 'user-fixed-1', type: 'text', text: 'hello **world**' } as Part}
        messageId="message-user-fixed"
        isMobile={false}
      />,
    );
    expect(markup).toContain('line-clamp-2');
    expect(markup).toContain('break-words w-full min-w-0');
    expect(markup).not.toContain('whitespace-pre-wrap');
    expect(markup).not.toContain('hello **world**');
  });

  test('retired rendering and collapse keys in UIStore cannot switch user text back to plain or unclamped text', () => {
    const previous = useUIStore.getState() as unknown as Record<string, unknown>;
    const hadRenderingMode = previous['userMessageRenderingMode'];
    const hadCollapsible = previous['collapsibleUserMessages'];
    useUIStore.setState({
      userMessageRenderingMode: 'plain',
      collapsibleUserMessages: false,
    } as unknown as Partial<ReturnType<typeof useUIStore.getState>>);
    try {
      const markup = renderToStaticMarkup(
        <UserTextPart
          part={{ id: 'user-fixed-2', type: 'text', text: 'hello **world**' } as Part}
          messageId="message-user-fixed-retired"
          isMobile={false}
        />,
      );
      expect(markup).toContain('line-clamp-2');
      expect(markup).toContain('break-words w-full min-w-0');
      expect(markup).not.toContain('whitespace-pre-wrap');
    } finally {
      useUIStore.setState({
        userMessageRenderingMode: hadRenderingMode,
        collapsibleUserMessages: hadCollapsible,
      } as unknown as Partial<ReturnType<typeof useUIStore.getState>>);
    }
  });

  test('empty user text renders nothing', () => {
    const markup = renderToStaticMarkup(
      <UserTextPart
        part={{ id: 'user-fixed-empty', type: 'text', text: '   ' } as Part}
        messageId="message-user-fixed-empty"
        isMobile={false}
      />,
    );
    expect(markup).toBe('');
  });
});

describe('chat fixed defaults: retired settings cannot override through UIStore', () => {
  test('retired presentation keys and setters are absent from the live store', () => {
    const state = useUIStore.getState() as unknown as Record<string, unknown>;
    for (const key of RETIRED_UI_KEYS) {
      expect(state[key]).toBe(undefined);
    }
    expect(state['setShowReasoningTraces']).toBe(undefined);
    expect(state['setCollapsibleThinkingBlocks']).toBe(undefined);
    expect(state['setCollapseThinkingByDefault']).toBe(undefined);
    expect(state['setShowExpandedBashTools']).toBe(undefined);
    expect(state['setShowExpandedEditTools']).toBe(undefined);
    expect(state['setMermaidRenderingMode']).toBe(undefined);
    expect(state['setUserMessageRenderingMode']).toBe(undefined);
  });

  test('persist migrate strips retired keys while keeping unrelated preferences', () => {
    const options = (
      useUIStore as unknown as {
        persist: { getOptions: () => { migrate: (s: unknown, v: number) => unknown } };
      }
    ).persist.getOptions();
    const migrated = options.migrate(
      {
        showReasoningTraces: false,
        collapseThinkingByDefault: true,
        showExpandedBashTools: true,
        mermaidRenderingMode: 'ascii',
        userMessageRenderingMode: 'plain',
        diffLayoutPreference: 'side-by-side',
      },
      18,
    ) as Record<string, unknown>;
    for (const key of RETIRED_UI_KEYS) {
      expect(migrated[key]).toBe(undefined);
    }
    expect(migrated['diffLayoutPreference']).toBe('side-by-side');
  });

  test('persist partialize never writes retired keys even when they are present in memory', () => {
    const options = (
      useUIStore as unknown as {
        persist: {
          getOptions: () => {
            partialize: (s: Record<string, unknown>) => Record<string, unknown>;
          };
        };
      }
    ).persist.getOptions();
    const persisted = options.partialize({
      ...(useUIStore.getState() as unknown as Record<string, unknown>),
      showReasoningTraces: false,
      collapseThinkingByDefault: true,
      showExpandedBashTools: true,
      mermaidRenderingMode: 'ascii',
      userMessageRenderingMode: 'plain',
    });
    for (const key of RETIRED_UI_KEYS) {
      expect(persisted[key]).toBe(undefined);
    }
  });

  test('web-settings sanitizer drops retired chat keys while keeping unrelated settings', () => {
    const sanitized = sanitizeWebSettings({
      showReasoningTraces: false,
      collapsibleThinkingBlocks: false,
      collapseThinkingByDefault: true,
      showExpandedBashTools: true,
      showExpandedEditTools: true,
      mermaidRenderingMode: 'ascii',
      userMessageRenderingMode: 'plain',
      codeBlockLineWrap: false,
      gitmojiEnabled: true,
      diffLayoutPreference: 'side-by-side',
      gitChangesViewMode: 'tree',
    }) as unknown as Record<string, unknown> | null;
    expect(sanitized).not.toBe(null);
    for (const key of [
      'showReasoningTraces',
      'collapsibleThinkingBlocks',
      'collapseThinkingByDefault',
      'showExpandedBashTools',
      'showExpandedEditTools',
      'mermaidRenderingMode',
      'userMessageRenderingMode',
      'codeBlockLineWrap',
      'gitmojiEnabled',
    ]) {
      expect(sanitized?.[key]).toBe(undefined);
    }
    expect(sanitized?.['diffLayoutPreference']).toBe('side-by-side');
    expect(sanitized?.['gitChangesViewMode']).toBe('tree');
  });
});
