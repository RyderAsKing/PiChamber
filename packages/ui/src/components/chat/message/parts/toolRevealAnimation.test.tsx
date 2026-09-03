import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Bun-only resolver quirk: `chatSurfaceContext.ts` sits next to
// `ChatSurfaceContext.tsx` and bun probes the wrong casing (Vite resolves
// this fine in the real app). Stub the surface mode for these markup tests.
mock.module('@/components/chat/chatSurfaceContext', () => ({
  useChatSurfaceMode: () => 'default' as const,
}));

// MarkdownRendererImpl pulls the Shiki worker artifact (`?worker&url`),
// which bun test cannot resolve. Stub the worker leaf.
mock.module('@/components/chat/markdown/markdown-worker', () => ({
  highlightCodeInWorker: async () => null,
  highlightLinesInWorker: async () => [],
  highlightTokensInWorker: async () => null,
}));

// useProviderLogo uses `import.meta.glob` (Vite-only). Footer logos are
// irrelevant to arrival/footer assertions.
mock.module('@/hooks/useProviderLogo', () => ({
  useProviderLogo: () => ({ src: null, onError: () => {}, hasLogo: false }),
}));

const { ToolRevealOnMount } = await import('./ToolRevealOnMount');
const { MinDurationShineText } = await import('./MinDurationShineText');
const { ReasoningTimelineBlock } = await import('./ReasoningPart');
const { AssistantMessageBody } = await import('../AssistantMessageBody');

describe('tool arrival animation', () => {
  test('arriving rows carry the observable step-in hook', () => {
    const animated = renderToStaticMarkup(
      <ToolRevealOnMount animate={true} wipe={false}><span>row</span></ToolRevealOnMount>,
    );
    expect(animated).toContain('oc-step-in');
  });

  test('settled rows carry no step-in hook', () => {
    const idle = renderToStaticMarkup(
      <ToolRevealOnMount animate={false} wipe={false}><span>row</span></ToolRevealOnMount>,
    );
    expect(idle).not.toContain('oc-step-in');
  });

  test('the wipe path keeps its WAAPI sweep instead of the class', () => {
    const wipe = renderToStaticMarkup(
      <ToolRevealOnMount animate={true} wipe={true}><span>row</span></ToolRevealOnMount>,
    );
    expect(wipe).not.toContain('oc-step-in');
  });

  test('running verbs shimmer like the working animation, settled verbs stay static', () => {
    const running = renderToStaticMarkup(
      <MinDurationShineText active={true}>Read</MinDurationShineText>,
    );
    expect(running).toContain('oc-shimmer-verb');
    const settled = renderToStaticMarkup(
      <MinDurationShineText active={false}>Read</MinDurationShineText>,
    );
    expect(settled).not.toContain('oc-shimmer-verb');
  });
});

describe('thinking block arrival and shimmer', () => {
  const block = (isStreaming: boolean) => ({
    text: 'Checking the theme provider wiring',
    variant: 'thinking',
    blockId: 'r1',
    isStreaming,
  } as const);

  test('live thinking fades in and shimmers its title', () => {
    const markup = renderToStaticMarkup(
      <ReasoningTimelineBlock {...block(true)} />,
    );
    expect(markup).toContain('oc-step-in');
    expect(markup).toContain('oc-shimmer-verb');
  });

  test('settled thinking mounts statically with a dimmed title', () => {
    const markup = renderToStaticMarkup(
      <ReasoningTimelineBlock {...block(false)} />,
    );
    expect(markup).not.toContain('oc-step-in');
    expect(markup).not.toContain('oc-shimmer-verb');
  });
});

describe('footer stability across sends', () => {
  const files = [
    { file: 'src/a.ts', additions: 3, deletions: 1 },
    { file: 'src/b.ts', additions: 10, deletions: 0 },
  ] as never;

  test('file pills keep button DOM when the turn stops being latest', async () => {
    const { TurnChangedFilePills } = await import('../TurnChangedFilesPills');
    const latest = renderToStaticMarkup(
      <TurnChangedFilePills files={files} isInteractive={true} />,
    );
    const old = renderToStaticMarkup(
      <TurnChangedFilePills files={files} isInteractive={false} />,
    );
    // Same element types (no button<->span swap that drops focus and
    // repaints every chip); only the disabled state flips.
    expect(latest.match(/<button/g)?.length).toBe(2);
    expect(old.match(/<button/g)?.length).toBe(2);
    expect(latest).not.toContain('disabled=""');
    expect(old).toContain('disabled=""');
  });

  test('revert slot reserves geometry before it appears', async () => {
    const { AssistantMessageActionButtons } = await import('../AssistantMessageActionButtons');
    const buttons = (isLatestMessage: boolean) => renderToStaticMarkup(
      <AssistantMessageActionButtons
        sessionId="s"
        messageId="m1"
        isLatestMessage={isLatestMessage}
        isTouchContext={false}
        hasCopyableText={true}
        onCopyMessage={() => {}}
        onShareImage={async () => {}}
      />,
    );
    const latest = buttons(true);
    const old = buttons(false);
    expect(old).toContain('Revert conversation to here');
    expect(latest).not.toContain('Revert conversation to here');
    // Same number of h-8 w-8 action slots before and after: the placeholder
    // keeps siblings from shifting when revert inserts on send.
    const slots = (markup: string): number => markup.split('h-8 w-8').length - 1;
    expect(slots(latest)).toBe(slots(old));
    expect(latest).toContain('Fork conversation from here');
    expect(old).toContain('Fork conversation from here');
  });
});

describe('assistant turn footer across tool batches', () => {
  const mkTool = (id: string, status: string) => ({
    id,
    type: 'tool',
    tool: 'read',
    state: { status, input: { filePath: 'src/a.ts' }, metadata: {} },
  });

  const base = {
    sessionId: 's',
    messageId: 'm1',
    isMessageCompleted: false,
    isMobile: false,
    expandedTools: new Set<string>(),
    onToggleTool: () => {},
    onShowPopup: () => {},
    copiedCode: null,
    onCopyCode: () => {},
    allowAnimation: false,
    streamPhase: 'streaming',
    hasTextContent: false,
    showReasoningTraces: false,
  } as const;

  const ctxWorking = {
    turnId: 't',
    isFirstAssistantInTurn: true,
    isLastAssistantInTurn: true,
    isLatestTurn: true,
    hasTools: true,
    hasReasoning: false,
    isWorking: true,
  } as never;

  const ctxIdle = {
    ...(ctxWorking as unknown as Record<string, unknown>),
    isWorking: false,
  } as never;

  test('no footer mounts while the turn is working, however many batches land', () => {
    const one = renderToStaticMarkup(
      <AssistantMessageBody
        {...base}
        parts={[mkTool('tp1', 'running')] as never}
        turnGroupingContext={ctxWorking}
      />,
    );
    const two = renderToStaticMarkup(
      <AssistantMessageBody
        {...base}
        parts={[mkTool('tp1', 'completed'), mkTool('tp2', 'running')] as never}
        turnGroupingContext={ctxWorking}
      />,
    );
    expect(one).not.toContain('message-footer');
    expect(two).not.toContain('message-footer');
  });

  test('the settled footer is identical no matter how many tools the turn ran', () => {
    const renderSettled = (parts: unknown) => renderToStaticMarkup(
      <AssistantMessageBody
        {...base}
        isMessageCompleted
        messageFinish="stop"
        hasTextContent
        parts={[{ id: 'tx', type: 'text', text: 'done' }, ...(parts as never[])] as never}
        turnGroupingContext={ctxIdle}
      />,
    );
    const footerOf = (markup: string): string => {
      const start = markup.indexOf('message-footer-enter');
      expect(start).toBeGreaterThan(-1);
      return markup.slice(start);
    };
    expect(footerOf(renderSettled([mkTool('tp1', 'completed')])))
      .toBe(footerOf(renderSettled([mkTool('tp1', 'completed'), mkTool('tp2', 'completed')])));
  });
});
