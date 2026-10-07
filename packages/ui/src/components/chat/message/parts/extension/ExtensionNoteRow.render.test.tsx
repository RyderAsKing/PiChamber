import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('../../../MarkdownRenderer', () => ({
  MarkdownRenderer: (props: { content?: unknown }) => {
    const text = typeof props.content === 'string' ? props.content : '';
    return React.createElement('div', { 'data-markdown-content': 'true' }, text);
  },
}));

const { ExtensionNoteRow } = await import('./ExtensionNoteRow');

const RENDER_LINES = ['✓ Explore repo completed', '  3 tool uses · 12.4k tokens'];
const EXPANDED_LINES = ['✓ Explore repo completed', '  3 tool uses · 12.4k tokens', '  files: src/index.ts'];

const renderNoteRow = (props: Partial<Parameters<typeof ExtensionNoteRow>[0]>) =>
  renderToStaticMarkup(<ExtensionNoteRow messageId="note-1" {...props} />);

describe('ExtensionNoteRow message render', () => {
  test('shows render lines as the main body instead of raw prose', () => {
    const markup = renderNoteRow({
      customType: 'subagent-notification',
      text: 'Explore repo completed',
      details: { tools: 3 },
      render: { message: RENDER_LINES },
    });

    expect(markup).toContain('data-extension-message-render="true"');
    expect(markup).toContain('Explore repo completed');
    expect(markup).toContain('3 tool uses');
    // Raw text and details hide behind the collapsed Raw message disclosure.
    expect(markup).not.toContain('data-markdown-content');
    expect(markup).not.toContain('&quot;tools&quot;');
    expect(markup).not.toContain('aria-label="Show subagent-notification details"');
  });

  test('collapsed render offers Show more; expanded lines stay hidden until toggled', () => {
    const markup = renderNoteRow({
      customType: 'subagent-notification',
      text: 'Explore repo completed',
      render: { message: RENDER_LINES, messageExpanded: EXPANDED_LINES },
    });

    expect(markup).toContain('Show more');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('files: src/index.ts');
  });

  test('raw disclosure toggle is collapsed by default and hides text and details', () => {
    const markup = renderNoteRow({
      customType: 'subagent-notification',
      text: 'Explore repo completed',
      details: { tools: 3 },
      render: { message: RENDER_LINES },
    });

    expect(markup).toContain('Raw message');
    expect(markup).toContain('aria-expanded="false"');
    // Static markup cannot open the disclosure; the closed toggles prove the
    // raw content is not in the main body.
    expect(markup).not.toContain('&quot;tools&quot;');
  });

  test('raw disclosure is omitted when there is no text or payload', () => {
    const markup = renderNoteRow({
      customType: 'subagent-notification',
      render: { message: RENDER_LINES },
    });

    expect(markup).toContain('data-extension-message-render="true"');
    expect(markup).not.toContain('Raw message');
    expect(markup).not.toContain('Show more');
  });

  test('empty render lines fall back to the legacy note display', () => {
    const markup = renderNoteRow({
      customType: 'notifier',
      text: 'Just plain text',
      render: { message: [] },
    });

    expect(markup).not.toContain('data-extension-message-render="true"');
    expect(markup).toContain('data-markdown-content');
    expect(markup).toContain('Just plain text');
  });

  test('no-render output is unchanged: prose plus header details disclosure', () => {
    const markup = renderNoteRow({
      customType: 'analytics',
      text: 'Summary report',
      details: { totalUsers: 42 },
    });

    expect(markup).not.toContain('data-extension-message-render="true"');
    expect(markup).toContain('Summary report');
    expect(markup).toContain('aria-label="Show analytics details"');
    expect(markup).not.toContain('Raw message');
  });
});
