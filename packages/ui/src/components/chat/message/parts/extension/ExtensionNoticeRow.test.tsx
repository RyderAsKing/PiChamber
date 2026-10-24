import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { ExtensionNoticeRow } = await import('./ExtensionNoticeRow');

const renderNoticeRow = (props?: Partial<Parameters<typeof ExtensionNoticeRow>[0]>) =>
  renderToStaticMarkup(
    <ExtensionNoticeRow messageId="notice-1" level="info" message="done" {...props} />,
  );

describe('ExtensionNoticeRow', () => {
  test('info renders a muted Notice header and the message body', () => {
    const markup = renderNoticeRow({ message: 'Indexed 12 files' });

    expect(markup).toContain('data-extension-notice="notice-1"');
    expect(markup).toContain('>Notice<');
    expect(markup).toContain('Indexed 12 files');
    expect(markup).not.toContain('>Warning<');
    expect(markup).not.toContain('>Error<');
  });

  test('warning and error use their level label', () => {
    expect(renderNoticeRow({ level: 'warning' })).toContain('>Warning<');
    expect(renderNoticeRow({ level: 'error' })).toContain('>Error<');
  });

  test('multiline bodies keep every line, including empty ones', () => {
    const markup = renderNoticeRow({ message: 'line one\n\nline three' });

    expect(markup).toContain('line one');
    expect(markup).toContain('line three');
    expect(markup).toContain('data-extension-notice-body="true"');
  });

  test('long bodies clamp behind a Show more toggle with accessible state', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const markup = renderNoticeRow({ message: lines.join('\n') });

    expect(markup).toContain('line 12');
    expect(markup).not.toContain('line 13');
    expect(markup).toContain('Show more');
    expect(markup).toContain('normal-case');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('Show more of the extension notice');
  });

  test('short bodies render without a toggle', () => {
    const markup = renderNoticeRow({ message: 'short' });

    expect(markup).not.toContain('Show more');
    expect(markup).not.toContain('aria-expanded');
  });

  test('an empty message falls back instead of rendering a blank row', () => {
    const markup = renderNoticeRow({ message: '   ' });

    expect(markup).toContain('Extension notification');
  });
});
