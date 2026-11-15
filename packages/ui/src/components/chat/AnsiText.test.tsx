import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnsiText } from './AnsiText';

describe('AnsiText', () => {
  test('renders plain text directly without span wrappers when unstyled', () => {
    const markup = renderToStaticMarkup(<AnsiText text="Clean plain text" />);
    expect(markup).toBe('Clean plain text');
  });

  test('renders empty text as null', () => {
    const markup = renderToStaticMarkup(<AnsiText text="" />);
    expect(markup).toBe('');
  });

  test('renders styled segments with CSS variables and styles', () => {
    const raw = '\x1b[1m\x1b[38;2;1;1;4mActive\x1b[0m \x1b[3m\x1b[9mDeprecated\x1b[0m';
    const markup = renderToStaticMarkup(<AnsiText text={raw} className="custom-root" />);
    expect(markup).toContain('class="custom-root"');
    expect(markup).toContain('Active');
    expect(markup).toContain('Deprecated');
    expect(markup).toContain('font-weight:600');
    expect(markup).toContain('color:var(--term-success, var(--status-success))');
    expect(markup).toContain('font-style:italic');
    expect(markup).toContain('text-decoration:line-through');
  });

  test('renders background colors and dim opacity', () => {
    const raw = '\x1b[2m\x1b[48;2;1;1;0mSelected\x1b[0m';
    const markup = renderToStaticMarkup(<AnsiText text={raw} />);
    expect(markup).toContain('Selected');
    expect(markup).toContain('background-color:var(--term-selectedBg, var(--interactive-selection))');
    expect(markup).toContain('opacity:0.65');
  });

  test('renders literal truecolor RGB', () => {
    const raw = '\x1b[38;2;255;128;64mCustom RGB\x1b[39m';
    const markup = renderToStaticMarkup(<AnsiText text={raw} />);
    expect(markup).toContain('Custom RGB');
    expect(markup).toContain('color:rgb(255, 128, 64)');
  });
});
