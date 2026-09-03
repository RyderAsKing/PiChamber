import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// UserTextPart pulls the Shiki web-worker build artifact (`?worker&url`),
// which bun test cannot resolve. Stub the presentational leaf so this file
// stays focused on UserMessageBody's own content/footer structure.
mock.module('@/components/chat/message/parts/UserTextPart', () => ({
  default: ({ part }: { part: { text?: string } }) => (
    <span data-testid="user-text-stub">{part.text ?? ''}</span>
  ),
}));

// The worker module itself imports the `?worker&url` artifact at load time.
// Stub it so the UserAuxiliaryParts import chain stays loadable in bun test.
mock.module('@/components/chat/markdown/markdown-worker', () => ({
  highlightCodeInWorker: async () => null,
  highlightLinesInWorker: async () => [],
  highlightTokensInWorker: async () => null,
}));

// Dynamic import: static imports evaluate before mock registration, which
// would load the real worker chain. Dynamic import runs after the mocks.
const { UserMessageBody } = await import('./UserMessageBody');
const { isUserBubbleContentPart } = await import('./partUtils');

const textPart = { id: 't1', type: 'text', text: 'Hello world' } as const;
const filePart = {
  id: 'f1',
  type: 'file',
  filename: 'notes.zip',
} as const;

const baseProps = {
  messageId: 'm1',
  isMobile: false,
  onShowPopup: () => {},
} as const;

describe('isUserBubbleContentPart', () => {
  test('keeps text, subtask, and shell parts inside the bubble', () => {
    expect(isUserBubbleContentPart({ id: 't', type: 'text', text: 'hi' })).toBe(true);
    expect(isUserBubbleContentPart({ id: 's', type: 'subtask' })).toBe(true);
    expect(
      isUserBubbleContentPart({ id: 'sh', type: 'text', text: '/shell', shellAction: { command: 'ls' } }),
    ).toBe(true);
  });

  test('excludes empty text and file parts from bubble content', () => {
    expect(isUserBubbleContentPart({ id: 't', type: 'text', text: '   ' })).toBe(false);
    expect(
      isUserBubbleContentPart({
        id: 'f',
        type: 'file',
        filename: 'a.png',
        mime: 'image/png',
      }),
    ).toBe(false);
  });
});

describe('UserMessageBody footer', () => {
  test('renders attachments in the footer below the text content', () => {
    const markup = renderToStaticMarkup(
      <UserMessageBody {...baseProps} parts={[textPart, filePart]} />,
    );
    expect(markup).toContain('Hello world');
    expect(markup).toContain('View 1 attachment');
    expect(markup).toContain('notes.zip');
    // Footer (group/user-actions) comes after the message text in DOM order,
    // and attachments no longer render in their own in-bubble row.
    expect(markup.indexOf('View 1 attachment')).toBeGreaterThan(
      markup.indexOf('Hello world'),
    );
    expect(markup).toContain('group/user-actions');
    expect(markup).not.toContain('mt-2 pt-1 flex items-center justify-end');
    // Footer order: hover actions on the left, attachments on the right.
    expect(markup.indexOf('View 1 attachment')).toBeGreaterThan(
      markup.indexOf('Fork conversation from here'),
    );
  });

  test('external-actions mode renders the attachment footer without bubble content', () => {
    const markup = renderToStaticMarkup(
      <UserMessageBody
        {...baseProps}
        parts={[filePart]}
        userActionsMode="external-actions"
      />,
    );
    expect(markup).toContain('View 1 attachment');
    expect(markup).toContain('group/user-actions');
  });

  test('external-content mode renders bubble content without the footer', () => {
    const markup = renderToStaticMarkup(
      <UserMessageBody
        {...baseProps}
        parts={[textPart, filePart]}
        userActionsMode="external-content"
      />,
    );
    expect(markup).toContain('Hello world');
    expect(markup).not.toContain('View 1 attachment');
    expect(markup).not.toContain('group/user-actions');
  });
});
