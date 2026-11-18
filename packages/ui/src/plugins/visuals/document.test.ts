import { describe, expect, test } from 'bun:test';

import {
  buildVisualDocument,
  canOpenLink,
  parseVisualDetails,
  visualContentSecurityPolicy,
  visualOuterPolicy,
  visualFileName,
  type VisualTheme,
} from './document';

const theme: VisualTheme = {
  colorScheme: 'dark',
  bg: '#111',
  surface: '#222',
  fg: '#eee',
  muted: '#999',
  border: '#333',
  accent: 'oklch(0.7 0.1 250)',
  font: '"Inter", sans-serif',
  mono: 'ui-monospace',
  series: ['#1', '#2', '#3', '#4', '#5'],
  good: 'green',
  warn: 'orange',
  bad: 'red',
};

describe('buildVisualDocument', () => {
  const innerOf = (doc: string): string => {
    const match = /<iframe id="p" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="([^"]*)"><\/iframe>/.exec(doc);
    if (!match) throw new Error('no inner frame');
    return match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  };

  test('puts the page in a sandboxed inner frame, policy first, in standards mode', () => {
    const doc = buildVisualDocument({ html: '<!DOCTYPE html><html><body>Hi</body></html>', theme, allowNetwork: false });
    expect(doc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    const inner = innerOf(doc);
    expect(inner.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(inner.match(/<!doctype/gi)?.length).toBe(1);
    expect(inner).toContain('<html><body>Hi</body></html>');
  });

  test('keeps the page inside the srcdoc attribute whatever it contains', () => {
    const html = '<p title="a&quot;b">"x" &amp; </iframe><script>top.x=1</script></p>';
    const doc = buildVisualDocument({ html, theme, allowNetwork: false });
    expect(innerOf(doc).endsWith(html)).toBe(true);
    expect(doc.match(/<iframe /g)?.length).toBe(1);
  });

  test('the outer document blocks the page navigating away while network is off', () => {
    expect(visualOuterPolicy(false)).toContain("frame-src 'none'");
    expect(visualOuterPolicy(false)).toContain("default-src 'none'");
    expect(visualOuterPolicy(true)).not.toContain("frame-src 'none'");
    expect(buildVisualDocument({ html: '', theme, allowNetwork: false })).toContain(`content="${visualOuterPolicy(false)}"`);
  });

  test('blocks the network unless allowed', () => {
    expect(visualContentSecurityPolicy(false)).toContain("connect-src 'none'");
    expect(visualContentSecurityPolicy(false)).toContain("default-src 'none'");
    expect(visualContentSecurityPolicy(true)).not.toContain("connect-src 'none'");
    expect(visualContentSecurityPolicy(true)).toContain("form-action 'none'");
  });

  test('passes the theme as CSS variables and strips declaration breakers', () => {
    const doc = buildVisualDocument({ html: '', theme: { ...theme, bg: 'red;}</style><script>x()</script>' }, allowNetwork: false });
    expect(doc).toContain('color-scheme:dark');
    expect(doc).toContain('--pc-accent:oklch(0.7 0.1 250)');
    expect(doc).toContain('--pc-c1:#1');
    expect(doc).toContain('--pc-c5:#5');
    expect(doc).toContain('--pc-bad:red');
    expect(doc).not.toContain('</style><script>x()');
  });

  test('offers shades of the first series colour for ordered values, strongest first', () => {
    const doc = buildVisualDocument({ html: '', theme, allowNetwork: false });
    expect(doc).toContain('--pc-shade-1:var(--pc-c1)');
    expect(doc).toContain('--pc-shade-2:color-mix(in oklab, var(--pc-c1) 72%, var(--pc-bg))');
    expect(doc).toContain('--pc-shade-4:color-mix(in oklab, var(--pc-c1) 28%, var(--pc-bg))');
    expect(doc).toContain('--pc-radius:10px');
  });

  test('sits on the chat background with a gutter and small muted SVG labels the page can override', () => {
    const doc = buildVisualDocument({ html: '', theme, allowNetwork: false });
    expect(doc).toContain(':where(html){background:var(--pc-bg);padding:8px;');
    // On the svg itself, so text inherits it and any fill on the text or a
    // group (attribute, style, or page rule) wins.
    // An svg's own fill or font-size attribute (an icon's fill="none") is
    // left alone: a page rule would beat it.
    expect(doc).toContain(':where(svg:not([fill])){fill:var(--pc-muted)}');
    expect(doc).toContain(':where(svg:not([font-size])){font-size:12px}');
    expect(/:where\(svg\)\{[^}]*(fill|font-size)/.test(doc)).toBe(false);
    expect(/svg text[^{]*\{fill/.test(doc)).toBe(false);
  });
});

describe('canOpenLink', () => {
  const base = { frameFocused: true, userActive: true, now: 10_000, lastOpenAt: 0 };

  test('opens right after a click in the frame', () => {
    expect(canOpenLink(base)).toBe(true);
    expect(canOpenLink({ ...base, userActive: undefined })).toBe(true);
  });

  test('refuses without a click in the frame', () => {
    expect(canOpenLink({ ...base, frameFocused: false })).toBe(false);
    expect(canOpenLink({ ...base, userActive: false })).toBe(false);
  });

  test('opens at most once a second', () => {
    expect(canOpenLink({ ...base, lastOpenAt: 9_500 })).toBe(false);
    expect(canOpenLink({ ...base, lastOpenAt: 9_000 })).toBe(true);
  });
});

describe('parseVisualDetails', () => {
  test('reads the render_html details', () => {
    expect(parseVisualDetails({ title: ' Chart ', html: '<p>x</p>', height: 300 })).toEqual({ title: 'Chart', html: '<p>x</p>', height: 300 });
    expect(parseVisualDetails({ html: '<p>x</p>' })).toEqual({ title: 'Untitled page', html: '<p>x</p>' });
  });

  test('ignores other shapes', () => {
    expect(parseVisualDetails(undefined)).toBeNull();
    expect(parseVisualDetails({ title: 'x' })).toBeNull();
    expect(parseVisualDetails({ html: '' })).toBeNull();
  });
});

test('visualFileName makes a safe file name', () => {
  expect(visualFileName('Q3 revenue: by region!')).toBe('q3-revenue-by-region.html');
  expect(visualFileName('???')).toBe('page.html');
});
