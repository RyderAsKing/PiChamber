import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Stub the surface mode for these markup tests (provider lives in
// `chatSurfaceProvider.tsx`; context/hook live in `chatSurfaceContext.ts`).
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

mock.module('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ currentTheme: null }),
  useOptionalThemeSystem: () => null,
}));

const { ToolRevealOnMount } = await import('./ToolRevealOnMount');
const { MinDurationShineText } = await import('./MinDurationShineText');
const { ReasoningTimelineBlock } = await import('./ReasoningPart');
const { WorkingPlaceholder } = await import('./WorkingPlaceholder');
const { AssistantMessageBody } = await import('../AssistantMessageBody');

describe('tool arrival animation', () => {
  test('arriving rows carry the observable step-in hook', () => {
    const animated = renderToStaticMarkup(
      <ToolRevealOnMount animate={true}><span>row</span></ToolRevealOnMount>,
    );
    expect(animated).toContain('oc-step-in');
  });

  test('settled rows carry no step-in hook', () => {
    const idle = renderToStaticMarkup(
      <ToolRevealOnMount animate={false}><span>row</span></ToolRevealOnMount>,
    );
    expect(idle).not.toContain('oc-step-in');
  });

  test('running verbs use a bounded opacity transition, settled verbs stay static', () => {
    const running = renderToStaticMarkup(
      <MinDurationShineText active={true}>Read</MinDurationShineText>,
    );
    expect(running).toContain('opacity-70');
    expect(running).not.toContain('oc-shimmer-verb');
    const settled = renderToStaticMarkup(
      <MinDurationShineText active={false}>Read</MinDurationShineText>,
    );
    expect(settled).not.toContain('oc-shimmer-verb');
  });
});

describe('thinking block arrival', () => {
  const block = (isStreaming: boolean) => ({
    text: 'Checking the theme provider wiring',
    variant: 'thinking',
    blockId: 'r1',
    isStreaming,
  } as const);

  test('live thinking fades in and dims its title', () => {
    const markup = renderToStaticMarkup(
      <ReasoningTimelineBlock {...block(true)} />,
    );
    expect(markup).toContain('oc-step-in');
    expect(markup).toContain('opacity-70');
    expect(markup).toContain('color:color-mix(in srgb, var(--tools-title) 72%, var(--tools-description))');
    expect(markup).not.toContain('oc-shimmer-verb');
  });

  test('settled thinking mounts statically with a dimmed title', () => {
    const markup = renderToStaticMarkup(
      <ReasoningTimelineBlock {...block(false)} />,
    );
    expect(markup).not.toContain('oc-step-in');
    expect(markup).toContain('color:color-mix(in srgb, var(--tools-title) 72%, var(--tools-description))');
    expect(markup).not.toContain('oc-shimmer-verb');
  });
});

describe('working footer stability between tools', () => {
  test('renders the current tool phase without an effect-delayed empty frame', () => {
    const markup = renderToStaticMarkup(
      <WorkingPlaceholder
        isWorking
        statusText="reading file"
        isGenericStatus={false}
        modelName="Claude"
      />,
    );

    expect(markup).toContain('Claude is reading file');
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

  test('latest message omits revert without reserving an empty slot', async () => {
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
    // The latest message omits revert without leaving a blank action slot.
    const slots = (markup: string): number => markup.split('h-8 w-8').length - 1;
    expect(slots(latest)).toBe(slots(old) - 1);
    expect(latest).not.toContain('aria-hidden="true" class="h-8 w-8 flex-shrink-0"');
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

  test('historical settled footers do not request an entry animation', () => {
    const markup = renderToStaticMarkup(
      <AssistantMessageBody
        {...base}
        isMessageCompleted
        messageFinish="stop"
        hasTextContent
        footerModelName="Claude"
        parts={[{ id: 'tx', type: 'text', text: 'done' }, mkTool('tp1', 'completed')] as never}
        turnGroupingContext={ctxIdle}
      />,
    );

    expect(markup).toContain('Claude');
    expect(markup).toContain('gap-y-1 text-sm text-muted-foreground');
    expect(markup).not.toContain('text-muted-foreground/60');
    expect(markup).not.toContain('message-footer-enter');
  });
});
