import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SnippetMarkdownEditor } from './SnippetMarkdownEditor';

describe('SnippetMarkdownEditor initial content mode', () => {
  test('opens a new editable snippet in Write mode', () => {
    const html = renderToStaticMarkup(
      <SnippetMarkdownEditor value="" onChange={() => {}} initialMode="write" />,
    );

    expect(html).toContain('<textarea');
    expect(html).toContain('aria-label="Snippet content"');
  });

  test('keeps Preview as the default for existing snippet viewers', () => {
    const html = renderToStaticMarkup(
      <SnippetMarkdownEditor value="" onChange={() => {}} />,
    );

    expect(html).not.toContain('<textarea');
    expect(html).toContain('Nothing to preview');
  });
});
