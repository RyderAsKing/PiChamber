import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let iconUrl: string | null = null;

const actualProjectIcon = await import('@/lib/projectIcon');
mock.module('@/lib/projectIcon', () => ({
  ...actualProjectIcon,
  useProjectIconUrl: () => iconUrl,
}));

const { ProjectIcon } = await import('./ProjectIcon');

const render = () => renderToStaticMarkup(<ProjectIcon directory="/code/web" label="web" />);

describe('ProjectIcon', () => {
  test('shows the fallback mark of an idle project in color', () => {
    iconUrl = null;
    const markup = render();
    expect(markup).toContain('data-project-icon="mark"');
    expect(markup).not.toContain('grayscale');
  });

  test('shows the icon of an idle project in color', () => {
    iconUrl = 'blob:project-icon';
    const markup = render();
    expect(markup).toContain('data-project-icon="image"');
    expect(markup).toContain('src="blob:project-icon"');
    expect(markup).not.toContain('grayscale');
  });
});
