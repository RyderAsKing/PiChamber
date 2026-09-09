import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Self-contained harness: MessageRow statically imports ChatMessage (the
// user/assistant turn pipeline). Mock it so the module graph stays small and
// so any render through the assistant path is observable below.
let chatMessageRenderCount = 0;
const chatMessageRenderedIds: string[] = [];
mock.module('../ChatMessage', () => ({
  default: (props: { message?: { info?: { id?: string } } }) => {
    chatMessageRenderCount += 1;
    chatMessageRenderedIds.push(props?.message?.info?.id ?? '<unknown>');
    return null;
  },
}));

const { MessageRow } = await import('./MessageRow');
const { UngroupedMessageRow } = await import('./UngroupedMessageRow');

import type { Message, Part } from '@/lib/chat/types';
import type { AnimationHandlers } from '@/hooks/useChatAutoFollow';
import type { ChatMessageEntry } from '../lib/turns/types';

const noop = () => undefined;
const noAnimationHandlers = () => ({}) as AnimationHandlers;

// Mirrors the real producer shape: pi-to-renderable maps a projected
// extension-role message onto `info` with sessionID/customType/data/details/text
// (lib/chat/pi-to-renderable.ts). The producer role union is exactly
// 'user' | 'assistant' | 'extension' (PiReducerMessage/PiProjectedMessage in
// lib/pi/reducers/reducerTypes.ts); there is no clientRole/system producer.
const makeExtensionEntry = (id: string, overrides: Partial<Message> = {}): ChatMessageEntry => ({
  info: {
    id,
    sessionID: 'sess-extension-routing',
    role: 'extension',
    customType: 'my-extension',
    text: 'Status update',
    details: { count: 3 },
    time: { created: 1 },
    ...overrides,
  } as Message,
  parts: [] as Part[],
});

const renderUngrouped = (entry: ChatMessageEntry): string =>
  renderToStaticMarkup(
    <UngroupedMessageRow
      message={entry}
      onMessageContentChange={noop}
      getAnimationHandlers={noAnimationHandlers}
      shouldAnimateUserMessage={() => false}
      onUserAnimationConsumed={noop}
    />,
  );

describe('MessageRow extension routing (ungrouped)', () => {
  test('extension role renders ExtensionMessageCard with customType/text/details and never enters ChatMessage', () => {
    const markup = renderUngrouped(makeExtensionEntry('ext-fallback-1'));

    expect(markup).toContain('data-extension-ui="ext-fallback-1"');
    expect(markup).toContain('my-extension');
    expect(markup).toContain('Status update');
    expect(markup).toContain('&quot;count&quot;: 3');

    expect(chatMessageRenderCount).toBe(0);
    expect(chatMessageRenderedIds).toEqual([]);
  });

  test('extension data payload reaches the card and renders the GUI descriptor', () => {
    const markup = renderUngrouped(
      makeExtensionEntry('ext-gui-1', {
        customType: 'pichamber.ui',
        data: { component: 'progress', props: { label: 'Indexing', value: 40, max: 200 } },
      }),
    );

    expect(markup).toContain('data-extension-ui="ext-gui-1"');
    expect(markup).toContain('Indexing');
    expect(markup).toContain('20%');
    expect(markup).toContain('progressbar');

    expect(chatMessageRenderCount).toBe(0);
    expect(chatMessageRenderedIds).toEqual([]);
  });

  test('MessageRow directly routes extension input before any assistant filtering', () => {
    const markup = renderToStaticMarkup(
      <MessageRow
        message={makeExtensionEntry('ext-direct-1')}
        onContentChange={noop}
        animationHandlers={noAnimationHandlers() as never}
      />,
    );

    expect(markup).toContain('data-extension-ui="ext-direct-1"');
    expect(markup).toContain('my-extension');
    expect(chatMessageRenderCount).toBe(0);
    expect(chatMessageRenderedIds).toEqual([]);
  });

  test('spy validity: non-extension input does reach the mocked ChatMessage', () => {
    const entry: ChatMessageEntry = {
      info: { id: 'assistant-spy-check', role: 'assistant' } as Message,
      parts: [] as Part[],
    };
    renderUngrouped(entry);

    expect(chatMessageRenderCount).toBe(1);
    expect(chatMessageRenderedIds).toContain('assistant-spy-check');
  });
});
