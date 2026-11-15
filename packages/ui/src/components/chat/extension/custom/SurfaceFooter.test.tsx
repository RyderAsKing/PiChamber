import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PiExtensionSurfaceState } from '@/lib/pi/reducers/customSurfaceReducers';
import { SurfaceFooter } from './SurfaceFooter';
import { surfaceFrameText } from './surfaceDom';

const surface = (overrides: Partial<PiExtensionSurfaceState> = {}): PiExtensionSurfaceState => ({
  surfaceId: 'custom-1',
  title: 'bash',
  mode: 'inline',
  capturing: true,
  hidden: false,
  focused: true,
  z: 1,
  frame: {
    version: 1,
    lines: ['\x1b[1mPermission Required\x1b[22m   ', 'command : \x1b[33mrm /tmp/x\x1b[39m', '', ''],
    cells: [undefined, undefined, undefined, undefined],
    cursor: null,
    layout: null,
    visible: true,
    columns: 80,
    screenColumns: 120,
    rows: 30,
  },
  ...overrides,
});

describe('surfaceFrameText', () => {
  test('drops colours, trailing spaces, and trailing blank lines', () => {
    expect(surfaceFrameText(surface().frame!.lines)).toBe('Permission Required\ncommand : rm /tmp/x');
  });

  test('keeps blank lines between text', () => {
    expect(surfaceFrameText(['a', '', 'b'])).toBe('a\n\nb');
    expect(surfaceFrameText([])).toBe('');
  });
});

describe('SurfaceFooter', () => {
  test('offers copying and the key buttons on a surface that takes keys', () => {
    const html = renderToStaticMarkup(<SurfaceFooter sessionId="sess-1" surface={surface()} />);
    expect(html).toContain('aria-label="Copy the text of bash"');
    expect(html).toContain('>Show key buttons</button>');
    expect(html).toContain('aria-expanded="false"');
    // Before the page knows where focus is, it offers to send typing there.
    expect(html).toContain('Click here to type to the extension.');
    // The key bar is hidden until asked for.
    expect(html).not.toContain('role="toolbar"');
  });

  test('a view-only surface gets only the copy action', () => {
    const html = renderToStaticMarkup(
      <SurfaceFooter sessionId="sess-1" surface={surface({ capturing: false, focused: false })} />,
    );
    expect(html).toContain('Copy text');
    expect(html).not.toContain('key buttons');
    expect(html).not.toContain('type to the extension');
  });

  test('copying is disabled with nothing drawn', () => {
    const html = renderToStaticMarkup(<SurfaceFooter sessionId="sess-1" surface={surface({ frame: null })} />);
    const copyButton = html.split('<button').find((tag) => tag.includes('aria-label="Copy the text of bash"')) ?? '';
    expect(copyButton.includes('disabled=""')).toBe(true);
  });
});
