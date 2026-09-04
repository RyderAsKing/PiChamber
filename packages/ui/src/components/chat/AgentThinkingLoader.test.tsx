import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentThinkingLoader } from './AgentThinkingLoader';

describe('AgentThinkingLoader elapsed origin', () => {
  test('counts from the authoritative start instead of mount time', () => {
    const markup = renderToStaticMarkup(
      <AgentThinkingLoader text="Working" startedAt={Date.now() - 65_000} />,
    );
    expect(markup).toContain('1m 5.');
  });

  test('the same start renders the same elapsed across remounts', () => {
    const startedAt = Date.now() - 65_000;
    const first = renderToStaticMarkup(
      <AgentThinkingLoader text="Working" startedAt={startedAt} />,
    );
    const second = renderToStaticMarkup(
      <AgentThinkingLoader text="Working" startedAt={startedAt} />,
    );
    expect(first).toContain('1m 5.');
    expect(second).toContain('1m 5.');
  });

  test('omitted start keeps mount-relative timing', () => {
    const markup = renderToStaticMarkup(<AgentThinkingLoader text="Working" />);
    expect(markup).toContain('0.0s');
  });

  test('keeps changing status labels on one line', () => {
    const markup = renderToStaticMarkup(
      <AgentThinkingLoader text="A long model name is searching content" />,
    );
    expect(markup).toContain('truncate');
    expect(markup).toContain('whitespace-nowrap');
  });

  test('animates a live phase label without changing the loader identity', () => {
    const markup = renderToStaticMarkup(
      <AgentThinkingLoader text="Claude is reading file" animateText />,
    );
    expect(markup).toContain('agent-thinking-label-enter');
    expect(markup).toContain('pixel-loader-label');
  });
});
