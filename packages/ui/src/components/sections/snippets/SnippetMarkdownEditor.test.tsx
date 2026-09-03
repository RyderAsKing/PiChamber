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

  test('renders a dynamic snippet trigger instead of a literal placeholder', () => {
    const html = renderToStaticMarkup(
      <SnippetMarkdownEditor value="hello" onChange={() => {}} initialMode="write" triggerPreview="#my-snippet" />,
    );

    expect(html).toContain('#my-snippet');
    expect(html).toContain('Expands as');
    expect(html).not.toContain('#{name}');
  });

  test('renders a slash-command trigger for prompt templates', () => {
    const html = renderToStaticMarkup(
      <SnippetMarkdownEditor
        value="hello"
        onChange={() => {}}
        initialMode="write"
        contentLabel="Prompt content"
        triggerPreview="/review"
        triggerActionLabel="Runs as"
      />,
    );

    expect(html).toContain('/review');
    expect(html).toContain('Runs as');
    expect(html).toContain('aria-label="Prompt content"');
    expect(html).not.toContain('#{name}');
    expect(html).not.toContain('Expands as');
  });

  test('offers variable chips in Write mode only', () => {
    const chips = [
      { value: "$1", hint: "Insert $1, the first argument" },
      { value: "$@", hint: "Insert $@, all arguments" },
    ];
    const writeHtml = renderToStaticMarkup(
      <SnippetMarkdownEditor value="hello" onChange={() => {}} initialMode="write" variableChips={chips} />,
    );
    expect(writeHtml).toContain('Variables');
    expect(writeHtml).toContain('aria-label="Insert $1, the first argument"');
    expect(writeHtml).toContain('$@');

    const previewHtml = renderToStaticMarkup(
      <SnippetMarkdownEditor value="hello" onChange={() => {}} variableChips={chips} />,
    );
    expect(previewHtml).not.toContain('Variables');
    expect(previewHtml).not.toContain('Insert $1');

    const noChipsHtml = renderToStaticMarkup(
      <SnippetMarkdownEditor value="hello" onChange={() => {}} initialMode="write" />,
    );
    expect(noChipsHtml).not.toContain('Variables');
  });

  test('hides the trigger note when no preview is provided', () => {
    const html = renderToStaticMarkup(
      <SnippetMarkdownEditor value="hello" onChange={() => {}} initialMode="write" />,
    );

    expect(html).not.toContain('#{name}');
    expect(html).not.toContain('Expands as');
  });
});
