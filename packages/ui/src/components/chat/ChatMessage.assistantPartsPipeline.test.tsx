import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Production-pipeline test: mounts ChatMessage (the real assistant turn
// pipeline ChatMessage -> MessageBody -> AssistantMessageBody ->
// useAssistantMessageLifecycle) and proves that filterAssistantFinalParts
// removes tool, reasoning, and rail-projected justification parts before the
// response body renders. Self-contained mocks mirror the static-markup
// harness used by message/parts/toolRevealAnimation.test.tsx.

// Stub the surface mode (provider lives in `chatSurfaceProvider.tsx`).
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
// irrelevant to pipeline assertions.
mock.module('@/hooks/useProviderLogo', () => ({
  useProviderLogo: () => ({ src: null, onError: () => {}, hasLogo: false }),
}));

// Assistant text mounts render through the lazy markdown stack; render the
// markdown source as text so body assertions can check which parts survive.
mock.module('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: (props: { content?: unknown }) => {
    const text = typeof props.content === 'string' ? props.content : '';
    return React.createElement('div', { 'data-markdown-content': 'true' }, text);
  },
  SimpleMarkdownRenderer: (props: { content?: unknown }) => {
    const text = typeof props.content === 'string' ? props.content : '';
    return React.createElement(
      'div',
      { className: 'break-words w-full min-w-0', 'data-markdown-content': 'true' },
      text,
    );
  },
}));

mock.module('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ currentTheme: null }),
  useOptionalThemeSystem: () => null,
}));

// ToolOutputDialog is lazily imported by ChatMessage; stub it so the popup
// graph (@pierre/diffs + worker-highlighted code) stays out of this harness.
mock.module('@/components/chat/message/ToolOutputDialog', () => ({
  default: () => null,
}));

const { default: ChatMessage } = await import('./ChatMessage');

const assistantEntry = (parts: unknown[]) => ({
  info: {
    id: 'a1',
    sessionID: 'sess-pipeline',
    role: 'assistant',
    time: { created: 1_000, completed: 61_000 },
    finish: 'stop',
  },
  parts,
});

const turnContext = (activityParts: unknown[]) => ({
  turnId: 'turn-1',
  isFirstAssistantInTurn: true,
  isLastAssistantInTurn: true,
  isLatestTurn: true,
  hasTools: true,
  hasReasoning: true,
  isWorking: false,
  userMessageCreatedAt: 500,
  activityParts,
});

describe('assistant parts pipeline (ChatMessage -> response body)', () => {
  test('tool, reasoning, and rail-projected justification parts never reach the response body', () => {
    const toolPart = {
      id: 'tool-1',
      type: 'tool',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'SECRET_TOOL_INPUT' },
        output: 'SECRET_TOOL_OUTPUT',
      },
    };
    const reasoningPart = { id: 'reason-1', type: 'reasoning', text: 'SECRET_REASONING_TRACE' };
    const justificationPart = { id: 'just-1', type: 'text', text: 'SECRET_JUSTIFICATION_TEXT' };
    const answerPart = { id: 'answer', type: 'text', text: 'Here is the final answer.' };

    const markup = renderToStaticMarkup(
      <ChatMessage
        message={assistantEntry([toolPart, reasoningPart, justificationPart, answerPart]) as never}
        turnGroupingContext={turnContext([
          {
            id: 'tool-1',
            turnId: 'turn-1',
            messageId: 'a1',
            partIndex: 0,
            kind: 'tool',
            part: toolPart,
          },
          {
            id: 'reason-1',
            turnId: 'turn-1',
            messageId: 'a1',
            partIndex: 1,
            kind: 'reasoning',
            part: reasoningPart,
          },
          {
            id: 'just-1',
            turnId: 'turn-1',
            messageId: 'a1',
            partIndex: 2,
            kind: 'justification',
            part: justificationPart,
          },
        ]) as never}
      />,
    );

    expect(markup).toContain('Here is the final answer.');
    expect(markup).not.toContain('SECRET_TOOL_INPUT');
    expect(markup).not.toContain('SECRET_TOOL_OUTPUT');
    expect(markup).not.toContain('SECRET_REASONING_TRACE');
    expect(markup).not.toContain('SECRET_JUSTIFICATION_TEXT');
  });

  test('completed turn footer with duration, timestamp, and text-driven preview stays intact', () => {
    const markup = renderToStaticMarkup(
      <ChatMessage
        message={assistantEntry([
          {
            id: 'answer',
            type: 'text',
            text: 'Dev server ready at http://127.0.0.1:3000/preview',
          },
        ]) as never}
        turnGroupingContext={turnContext([]) as never}
      />,
    );

    // The turn footer mounts for the last settled assistant, the timestamp is
    // derived from the completed time, and the loopback preview URL found in
    // final text still opens the context preview.
    expect(markup).toContain('message-footer__label');
    expect(markup).toContain('Message time:');
    expect(markup).toContain('Open preview');
  });
});
