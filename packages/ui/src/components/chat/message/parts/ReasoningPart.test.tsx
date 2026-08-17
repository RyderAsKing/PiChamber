import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import ReasoningPart, { ReasoningTimelineBlock } from './ReasoningPart';

// A reasoning text whose summary (first 120 chars) fits in the header but
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

describe('ReasoningTimelineBlock', () => {
  test('renders reasoning traces behind an accessible collapsed disclosure by default', () => {
    const markup = renderToStaticMarkup(
        <ReasoningTimelineBlock
          text={LONG_REASONING}
          variant="thinking"
          blockId="reasoning-test"
          showDuration={false}
        />
    );

    // Accessible toggle row is rendered
    expect(markup).toContain('role="button"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand reasoning trace"');

    // Summary preview (beginning of text) is visible in the header
    expect(markup).toContain('First thought');

    // Historical collapsed blocks do not mount the expanded body, avoiding a
    // first-frame flash when Activity reveals previously hidden rows.
    expect(markup).not.toContain('data-message-text-export-source');
  });

  test('renders "Justification" label for justification variant when pre-expanded and not streaming', () => {
    const markup = renderToStaticMarkup(
        <ReasoningTimelineBlock
          text={LONG_JUSTIFICATION}
          variant="justification"
          blockId="justification-test"
          showDuration={false}
          defaultExpanded={true}
        />
    );

    // Label shown in expanded header should be "Justification" not "Thinking"
    expect(markup).toContain('Justification');
    expect(markup).not.toContain('Thinking');
  });

  test('renders "Thinking" label for thinking variant when pre-expanded and not streaming', () => {
    const markup = renderToStaticMarkup(
        <ReasoningTimelineBlock
          text={LONG_REASONING}
          variant="thinking"
          blockId="thinking-test"
          showDuration={false}
          defaultExpanded={true}
        />
    );

    // Label shown in expanded header should be "Thinking"
    expect(markup).toContain('Thinking');
  });

  test('header summary is a truncated excerpt from the beginning', () => {
    const markup = renderToStaticMarkup(
        <ReasoningTimelineBlock
          text={LONG_REASONING}
          variant="thinking"
          blockId="reasoning-test"
          showDuration={false}
        />
    );

    // Deep body content beyond 120 chars should be cut from the summary span
    expect(markup).not.toContain('remain hidden in the collapsed header view');
    // The ellipsis character marks that the text was truncated
    expect(markup).toContain('…');
  });

  test('omits trailing empty HTML comments from the header summary', () => {
    const markup = renderToStaticMarkup(
        <ReasoningTimelineBlock
          text={'Planning accessible icon labels with translations <!-- -->'}
          variant="thinking"
          blockId="reasoning-comment-test"
          showDuration={false}
        />
    );

    expect(markup).toContain('Planning accessible icon labels with translations');
    expect(markup).not.toContain('&lt;!-- --&gt;');
  });

  test('auto-expands live thinking into a max-height plain-text pane', () => {
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
      />
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-label="Collapse reasoning trace"');
    expect(markup).toContain('Thinking');
    expect(markup).toContain('data-message-text-export-source');
    expect(markup).toContain('max-h-80');
    expect(markup).not.toContain('data-markdown-content');
    expect(markup).toContain('First thought');
  });

  test('collapses thinking when the part is no longer streaming', () => {
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
      />
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('data-message-text-export-source');
  });

  test('keeps live thinking as a one-line header when collapseByDefault is off', () => {
    const markup = renderToStaticMarkup(
      <ReasoningPart
        part={{
          id: 'reasoning-live-collapsed',
          type: 'reasoning',
          text: LONG_REASONING,
          streaming: true,
        }}
        messageId="message-thinking"
        streamPhase="streaming"
        collapseByDefault={false}
      />
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Expand reasoning trace"');
    expect(markup).toContain('Thinking');
    expect(markup).toContain('This second line goes into much deeper detail');
    expect(markup).not.toContain('data-message-text-export-source');
    expect(markup).not.toContain('max-h-80');
  });

  test('keeps settled thinking collapsed when collapseByDefault is off', () => {
    const markup = renderToStaticMarkup(
      <ReasoningPart
        part={{
          id: 'reasoning-finished-collapsed',
          type: 'reasoning',
          text: LONG_REASONING,
          streaming: false,
        }}
        messageId="message-still-streaming"
        streamPhase="streaming"
        collapseByDefault={false}
      />
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('data-message-text-export-source');
  });

  test('does not auto-expand thinking without an authoritative live streaming flag', () => {
    const markup = renderToStaticMarkup(
      <ReasoningPart
        part={{
          id: 'reasoning-unmarked',
          type: 'reasoning',
          text: LONG_REASONING,
        }}
        messageId="message-still-streaming"
        streamPhase="streaming"
      />
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('data-message-text-export-source');
  });

  test('expanded live thinking renders a bounded plain-text window', () => {
    const manyLines = Array.from(
      { length: 50 },
      (_, index) => `Line ${index + 1} of thinking.`,
    ).join('\n');
    const markup = renderToStaticMarkup(
      <ReasoningTimelineBlock
        text={manyLines}
        variant="thinking"
        blockId="reasoning-live-expanded"
        isStreaming
        defaultExpanded
      />
    );

    expect(markup).toContain('data-message-text-export-source');
    expect(markup).not.toContain('data-markdown-content');
    expect(markup).toContain('Line 50 of thinking.');
    expect(markup).toContain('Line 11 of thinking.');
    expect(markup).not.toContain('Line 10 of thinking.');
    expect(markup).not.toContain('Line 1 of thinking.');
  });
});
