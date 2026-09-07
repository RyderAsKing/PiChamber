import { describe, expect, mock, test } from 'bun:test';
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

// Interactive toggle / live-to-settled tests mount the block with a minimal
// DOM stub. Replace the overlay scrollbar stack (ResizeObserver /
// MutationObserver / dataset work) with a plain wrapper that preserves the
// bounded `max-h-80` viewport class and children. Static-markup tests still
// assert the real bounded DOM contract through the preserved class.
mock.module('@/components/ui/ScrollableOverlay', () => ({
  ScrollableOverlay: React.forwardRef(
    (
      props: Record<string, unknown>,
      ref: React.Ref<HTMLElement>,
    ) => {
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

// Interactive mounts use a minimal DOM stub without layout, custom elements,
// or a real location. Render markdown content as plain text so expansion
// transitions stay testable without the full Shiki/KaTeX/diffs stack.
// Static-markup assertions only require the content text to be present.
mock.module('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: (props: { content?: unknown }) => React.createElement(
    'div',
    { 'data-markdown-content': 'true' },
    typeof props.content === 'string' ? props.content : '',
  ),
  SimpleMarkdownRenderer: (props: { content?: unknown }) => React.createElement(
    'div',
    { 'data-markdown-content': 'true' },
    typeof props.content === 'string' ? props.content : '',
  ),
}));

const { default: ReasoningPart, ReasoningTimelineBlock } = await import('./ReasoningPart');

// A reasoning text whose summary (first 80 chars) fits in the header but
// whose expanded body content should only appear when the disclosure is open.
const LONG_REASONING =
  'First thought about the task at hand and how to approach it carefully.\n' +
  'This second line goes into much deeper detail about the internal reasoning ' +
  'process that should remain hidden in the collapsed header view.';

// A long text that should render the collapsible header with a label
const LONG_JUSTIFICATION =
  'Sorting by activity first because the active session needs immediate attention.\n' +
  'Secondary sort by last updated timestamp ensures a stable deterministic ordering ' +
  'when multiple sessions have the same activity state.';

// --- Minimal DOM stub for interactive toggle / live-to-settled tests --------

type FakeNode = {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: unknown;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  style: Record<string, unknown>;
  [key: string]: unknown;
};

const makeNode = (tag: string, owner: Record<string, unknown>): FakeNode => {
  const node: FakeNode = {
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
    appendChild(child: FakeNode) {
      node.childNodes.push(child);
      child.parentNode = node;
      return child;
    },
    insertBefore(child: FakeNode, ref: FakeNode) {
      const index = node.childNodes.indexOf(ref);
      if (index < 0) node.childNodes.push(child);
      else node.childNodes.splice(index, 0, child);
      child.parentNode = node;
      return child;
    },
    removeChild(child: FakeNode) {
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

const installDomStub = () => {
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
    createElement: (tag: string) => makeNode(tag, documentStub),
    createElementNS: (_ns: string, tag: string) => makeNode(tag, documentStub),
    createTextNode: (text: string) => ({ nodeType: 3, nodeName: '#text', textContent: text, parentNode: null }),
    getElementById: () => null,
  };
  const rootElement = makeNode('div', documentStub);
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
  const container = (documentStub.createElement as (tag: string) => FakeNode)('div');
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

const getReactProps = (node: FakeNode): Record<string, unknown> | null => {
  const key = Object.keys(node).find((candidate) => candidate.startsWith('__reactProps'));
  if (!key) return null;
  return (node as unknown as Record<string, Record<string, unknown>>)[key] ?? null;
};

const findToggle = (root: FakeNode): FakeNode | null => {
  const visit = (node: FakeNode): FakeNode | null => {
    const props = getReactProps(node);
    const label = props?.['aria-label'];
    if (
      node.nodeType === 1
      && (label === 'Expand reasoning trace' || label === 'Collapse reasoning trace')
    ) {
      return node;
    }
    for (const child of node.childNodes) {
      if (child.nodeType !== 1 && child.nodeType !== 3) continue;
      if (child.nodeType === 1) {
        const found = visit(child);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(root);
};

const readExpanded = (root: FakeNode): boolean => {
  const toggle = findToggle(root);
  if (!toggle) throw new Error('reasoning toggle not found');
  return getReactProps(toggle)?.['aria-expanded'] === true;
};

const clickToggle = (root: FakeNode): void => {
  const toggle = findToggle(root);
  if (!toggle) throw new Error('reasoning toggle not found');
  const props = getReactProps(toggle);
  const onClick = props?.['onClick'] as ((event: unknown) => void) | undefined;
  if (typeof onClick !== 'function') throw new Error('reasoning toggle has no onClick');
  act(() => {
    onClick({ preventDefault() {}, stopPropagation() {} });
  });
};

const findSummaryTitle = (root: FakeNode): string | null => {
  let result: string | null = null;
  const visit = (node: FakeNode): void => {
    if (result !== null) return;
    const props = getReactProps(node);
    if (typeof props?.['title'] === 'string' && (props['title'] as string).includes('First thought')) {
      result = props['title'] as string;
      return;
    }
    for (const child of node.childNodes) {
      if (child.nodeType === 1) visit(child);
    }
  };
  visit(root);
  return result;
};

const findToggleSummaryTitle = (root: FakeNode): string | null => {
  const toggle = findToggle(root);
  if (!toggle) return null;
  let result: string | null = null;
  const visit = (node: FakeNode): void => {
    const props = getReactProps(node);
    if (
      typeof props?.['title'] === 'string'
      && (props['title'] as string).length > 0
      && props['title'] !== 'Thinking'
      && props['title'] !== 'Justification'
    ) {
      result = props['title'] as string;
    }
    for (const child of node.childNodes) {
      if (child.nodeType === 1) visit(child);
    }
  };
  for (const child of toggle.childNodes) {
    if (child.nodeType === 1) visit(child);
  }
  return result;
};

describe('ReasoningTimelineBlock', () => {
  test('history reasoning starts collapsed, visible, and expandable', () => {
    const markup = renderToStaticMarkup(
      <ReasoningTimelineBlock
        text={LONG_REASONING}
        variant="thinking"
        blockId="reasoning-test"
        showDuration={false}
      />,
    );

    // Accessible toggle row is rendered collapsed by default for history.
    expect(markup).toContain('role="button"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand reasoning trace"');

    // Collapsed history keeps the header preview but mounts no body.
    expect(markup).not.toContain('data-message-text-export-source');
    expect(markup).toContain('First thought');
    expect(markup).toContain('…');
    expect(markup).not.toContain('remain hidden in the collapsed header view');
  });

  test('renders "Justification" label for justification variant when settled and collapsed', () => {
    const markup = renderToStaticMarkup(
      <ReasoningTimelineBlock
        text={LONG_JUSTIFICATION}
        variant="justification"
        blockId="justification-test"
        showDuration={false}
      />,
    );

    // Label shown in collapsed header should be "Justification" not "Thinking"
    expect(markup).toContain('Justification');
    expect(markup).not.toContain('Thinking');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand reasoning trace"');
    expect(markup).not.toContain('data-message-text-export-source');
  });

  test('renders "Thinking" label for thinking variant when settled and collapsed', () => {
    const markup = renderToStaticMarkup(
      <ReasoningTimelineBlock
        text={LONG_REASONING}
        variant="thinking"
        blockId="thinking-test"
        showDuration={false}
      />,
    );

    // Label shown in collapsed header should be "Thinking"
    expect(markup).toContain('Thinking');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand reasoning trace"');
    expect(markup).not.toContain('data-message-text-export-source');
  });

  test('collapsed history preview hides the full reasoning body', () => {
    const markup = renderToStaticMarkup(
      <ReasoningTimelineBlock
        text={LONG_REASONING}
        variant="thinking"
        blockId="reasoning-test"
        showDuration={false}
      />,
    );

    // The one-line collapsed preview renders in the header while the full body
    // stays unmounted until the user expands the block.
    expect(markup).not.toContain('data-message-text-export-source');
    expect(markup).toContain('First thought');
    expect(markup).toContain('…');
    expect(markup).not.toContain('remain hidden in the collapsed header view');
  });

  test('collapsed preview truncates the header and strips empty HTML comments', async () => {
    const dom = installDomStub();
    const root: Root = createRoot(dom.container);
    try {
      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text={LONG_REASONING}
            variant="thinking"
            blockId="reasoning-truncate"
          />,
        );
      });
      // Starts collapsed with the truncated preview already in the header.
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(false);

      const summary = findSummaryTitle(dom.container as unknown as FakeNode);
      expect(summary).not.toBe(null);
      expect(summary as string).toContain('…');
      expect(summary as string).not.toContain('remain hidden in the collapsed header view');

      // Click still expands from the collapsed default.
      clickToggle(dom.container as unknown as FakeNode);
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(true);

      clickToggle(dom.container as unknown as FakeNode);
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(false);
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });

  test('omits trailing empty HTML comments from the collapsed header summary', async () => {
    const dom = installDomStub();
    const root: Root = createRoot(dom.container);
    try {
      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text="Planning accessible icon labels with translations <!-- -->"
            variant="thinking"
            blockId="reasoning-comment-test"
          />,
        );
      });
      // Starts collapsed, so the header preview is present without a toggle.
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(false);
      const summary = findToggleSummaryTitle(dom.container as unknown as FakeNode);
      // The collapsed preview keeps the readable text but never the raw comment.
      expect(summary).not.toBe(null);
      expect(summary as string).toContain('Planning accessible icon labels with translations');
      expect(summary as string).not.toContain('<!-- -->');
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });

  test('live thinking starts collapsed with a streaming header preview', () => {
    const markup = renderToStaticMarkup(
      <ReasoningPart
        part={{
          id: 'reasoning-live',
          type: 'reasoning',
          text: LONG_REASONING,
          streaming: true,
        }}
        messageId="message-thinking"
        streamPhase="streaming"
      />,
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand reasoning trace"');
    expect(markup).toContain('Thinking');
    // Collapsed live mounts no body, so neither the plain-text pane nor the
    // markdown renderer is present; the header keeps the latest-line preview.
    expect(markup).not.toContain('data-message-text-export-source');
    expect(markup).not.toContain('max-h-80');
    expect(markup).not.toContain('data-markdown-content');
    expect(markup).toContain('This second line');
    expect(markup).toContain('…');
  });

  test('settled thinking stays collapsed after streaming completes', () => {
    const markup = renderToStaticMarkup(
      <ReasoningPart
        part={{
          id: 'reasoning-finished',
          type: 'reasoning',
          text: LONG_REASONING,
          streaming: false,
        }}
        messageId="message-still-streaming"
        streamPhase="streaming"
      />,
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand reasoning trace"');
    expect(markup).not.toContain('data-message-text-export-source');
    expect(markup).toContain('First thought');
    expect(markup).toContain('…');
  });

  test('history thinking without a live streaming flag still starts collapsed', () => {
    const markup = renderToStaticMarkup(
      <ReasoningPart
        part={{
          id: 'reasoning-unmarked',
          type: 'reasoning',
          text: LONG_REASONING,
        }}
        messageId="message-still-streaming"
        streamPhase="streaming"
      />,
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand reasoning trace"');
    expect(markup).not.toContain('data-message-text-export-source');
  });

  test('manual toggle expands and re-collapses the reasoning block', async () => {
    const dom = installDomStub();
    const root: Root = createRoot(dom.container);
    try {
      const notifications: Array<string | undefined> = [];
      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text={LONG_REASONING}
            variant="thinking"
            blockId="reasoning-toggle"
            onContentChange={(reason) => {
              notifications.push(reason);
            }}
          />,
        );
      });
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(false);

      clickToggle(dom.container as unknown as FakeNode);
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(true);
      expect(notifications).toContain('structural');

      clickToggle(dom.container as unknown as FakeNode);
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(false);
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });

  test('live-to-settled transition keeps the block collapsed', async () => {
    const dom = installDomStub();
    const root: Root = createRoot(dom.container);
    try {
      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text={LONG_REASONING}
            variant="thinking"
            blockId="reasoning-settle"
            isStreaming
          />,
        );
      });
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(false);

      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text={LONG_REASONING}
            variant="thinking"
            blockId="reasoning-settle"
            isStreaming={false}
          />,
        );
      });
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(false);
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });

  test('manually expanded reasoning stays expanded when streaming settles', async () => {
    const dom = installDomStub();
    const root: Root = createRoot(dom.container);
    try {
      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text={LONG_REASONING}
            variant="thinking"
            blockId="reasoning-manual"
            isStreaming
          />,
        );
      });
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(false);
      clickToggle(dom.container as unknown as FakeNode);
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(true);

      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text={LONG_REASONING}
            variant="thinking"
            blockId="reasoning-manual"
            isStreaming={false}
          />,
        );
      });
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(true);
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });

  test('collapsed reasoning stays collapsed through repeated live deltas and settle', async () => {
    const dom = installDomStub();
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
              blockId="reasoning-deltas"
              isStreaming
            />,
          );
        });
        // Repeated deltas never auto-open the mounted block.
        expect(readExpanded(dom.container as unknown as FakeNode)).toBe(false);
      }

      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text={LONG_REASONING}
            variant="thinking"
            blockId="reasoning-deltas"
            isStreaming={false}
          />,
        );
      });
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(false);
      const summary = findSummaryTitle(dom.container as unknown as FakeNode);
      expect(summary).not.toBe(null);
      expect(summary as string).toContain('First thought');
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });

  test('explicit collapse remains collapsed through updates and settle', async () => {
    const dom = installDomStub();
    const root: Root = createRoot(dom.container);
    try {
      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text="First thought about the task."
            variant="thinking"
            blockId="reasoning-collapse-updates"
            isStreaming
          />,
        );
      });
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(false);

      // Expand then explicitly collapse before the next streaming update.
      clickToggle(dom.container as unknown as FakeNode);
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(true);
      clickToggle(dom.container as unknown as FakeNode);
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(false);

      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text={LONG_REASONING}
            variant="thinking"
            blockId="reasoning-collapse-updates"
            isStreaming
          />,
        );
      });
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(false);

      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text={LONG_REASONING}
            variant="thinking"
            blockId="reasoning-collapse-updates"
            isStreaming={false}
          />,
        );
      });
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(false);
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });

  test('collapsed live thinking starts without a body; expanded live keeps a bounded plain-text window', async () => {
    const manyLines = Array.from(
      { length: 50 },
      (_, index) => `Line ${index + 1} of thinking.`,
    ).join('\n');
    const staticMarkup = renderToStaticMarkup(
      <ReasoningTimelineBlock
        text={manyLines}
        variant="thinking"
        blockId="reasoning-live-expanded"
        isStreaming
      />,
    );

    // Collapsed live mounts no body; the header keeps the latest-line preview.
    expect(staticMarkup).toContain('aria-expanded="false"');
    expect(staticMarkup).toContain('aria-label="Expand reasoning trace"');
    expect(staticMarkup).not.toContain('data-message-text-export-source');
    expect(staticMarkup).toContain('Line 50 of thinking.');

    // After the user expands, the live body stays bounded to the tail window.
    const dom = installDomStub();
    const root: Root = createRoot(dom.container);
    try {
      await act(async () => {
        await root.render(
          <ReasoningTimelineBlock
            text={manyLines}
            variant="thinking"
            blockId="reasoning-live-expanded"
            isStreaming
          />,
        );
      });
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(false);
      clickToggle(dom.container as unknown as FakeNode);
      expect(readExpanded(dom.container as unknown as FakeNode)).toBe(true);
      const collectText = (node: FakeNode): string => {
        let out = '';
        const visit = (current: FakeNode): void => {
          const props = getReactProps(current);
          const children = props?.['children'] as unknown;
          if (typeof children === 'string') {
            out += children;
          } else if (Array.isArray(children)) {
            for (const child of children) {
              if (typeof child === 'string') out += child;
            }
          }
          if (typeof current.textContent === 'string' && current.textContent.length > 0) {
            out += current.textContent;
          }
          for (const child of current.childNodes) {
            if (child.nodeType === 3) {
              out += String((child as unknown as { textContent?: unknown }).textContent ?? '');
              const data = (child as unknown as { nodeValue?: unknown; data?: unknown });
              if (typeof data.nodeValue === 'string') out += data.nodeValue;
              if (typeof data.data === 'string') out += data.data;
            } else if (child.nodeType === 1) {
              visit(child);
            }
          }
        };
        visit(node);
        return out;
      };
      const expandedText = collectText(dom.container as unknown as FakeNode);
      expect(expandedText).toContain('Line 50 of thinking.');
      expect(expandedText).toContain('Line 11 of thinking.');
      expect(expandedText).not.toContain('Line 10 of thinking.');
      expect(expandedText).not.toContain('Line 1 of thinking.');
    } finally {
      await act(async () => {
        await root.unmount();
      });
      dom.restore();
    }
  });
});
