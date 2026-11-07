import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { SurfaceKeyBar } from './SurfaceKeyBar';

describe('SurfaceKeyBar', () => {
  test('offers the keys a touch screen lacks and a keyboard toggle', () => {
    const html = renderToStaticMarkup(<SurfaceKeyBar sessionId="sess-1" surfaceId="custom-1" />);
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="Extension keys"');
    for (const label of ['Esc', 'Tab', 'Enter', 'Keyboard']) expect(html).toContain(`>${label}</button>`);
    for (const label of ['Left', 'Up', 'Down', 'Right']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-label="Type to the extension"');
  });
});
