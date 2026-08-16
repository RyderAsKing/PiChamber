import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PiChamberLogo } from './PiChamberLogo';

describe('PiChamberLogo', () => {
  test('renders static logo markup when isAnimated is false', () => {
    const markup = renderToStaticMarkup(
      <PiChamberLogo width={100} height={100} isAnimated={false} />,
    );

    expect(markup).toContain('<svg');
    expect(markup).toContain('aria-label="PiChamber logo"');
    expect(markup).not.toContain('pc-shimmer-rect');
    expect(markup).not.toContain('<mask');
  });

  test('renders shimmer mask and gradient sweep when isAnimated is true', () => {
    const markup = renderToStaticMarkup(
      <PiChamberLogo width={120} height={120} isAnimated={true} />,
    );

    expect(markup).toContain('<svg');
    expect(markup).toContain('aria-label="PiChamber logo"');
    expect(markup).toContain('<mask');
    expect(markup).toContain('<linearGradient');
    expect(markup).toContain('pc-shimmer-sweep');
    expect(markup).toContain('pc-shimmer-anim');
  });
});
