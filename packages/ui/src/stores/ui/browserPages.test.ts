import { describe, expect, test } from 'bun:test';

import {
  MAX_BROWSER_PAGES,
  activateBrowserPage,
  closeBrowserPage,
  openBrowserPage,
  openBrowserPopup,
  sanitizeBrowserPages,
  updateBrowserPage,
  type BrowserPage,
  type BrowserPages,
} from './browserPages';

const page = (id: string, url: string | null = null, extra: Partial<BrowserPage> = {}): BrowserPage => ({
  id, url, route: null, title: null, ...extra,
});

const ids = (prefix = 'new') => {
  let count = 0;
  return () => `${prefix}-${++count}`;
};

describe('openBrowserPage', () => {
  test('a link opens a new page next to the active one', () => {
    const state: BrowserPages = { pages: [page('a', 'https://a.example'), page('b', 'https://b.example')], activePageId: 'a' };
    const next = openBrowserPage(state, { url: 'https://c.example', target: 'new' }, ids());
    expect(next.pages.map((entry) => entry.id)).toEqual(['a', 'new-1', 'b']);
    expect(next.activePageId).toBe('new-1');
    expect(next.pageId).toBe('new-1');
    expect(next.pages[1]?.url).toBe('https://c.example');
  });

  test('a link fills the active page while it is still empty', () => {
    const state: BrowserPages = { pages: [page('a')], activePageId: 'a' };
    const next = openBrowserPage(state, { url: 'https://a.example', route: 'server', target: 'new' }, ids());
    expect(next.pages).toEqual([page('a', 'https://a.example', { route: 'server' })]);
    expect(next.pageId).toBe('a');
  });

  test('the new-tab button adds an empty page even beside an empty one', () => {
    const state: BrowserPages = { pages: [page('a')], activePageId: 'a' };
    const next = openBrowserPage(state, { url: null, target: 'new' }, ids());
    expect(next.pages.map((entry) => entry.id)).toEqual(['a', 'new-1']);
  });

  test('current replaces the active page and clears its old title', () => {
    const state: BrowserPages = { pages: [page('a', 'https://a.example', { title: 'A', route: 'device' })], activePageId: 'a' };
    const next = openBrowserPage(state, { url: 'https://b.example', target: 'current' }, ids());
    expect(next.pages).toEqual([page('a', 'https://b.example', { route: 'device' })]);
  });

  test('at the limit a link replaces the active page', () => {
    const pages = Array.from({ length: MAX_BROWSER_PAGES }, (_, index) => page(`p${index}`, `https://${index}.example`));
    const next = openBrowserPage({ pages, activePageId: 'p3' }, { url: 'https://new.example', target: 'new' }, ids());
    expect(next.pages).toHaveLength(MAX_BROWSER_PAGES);
    expect(next.pageId).toBe('p3');
    expect(next.pages[3]?.url).toBe('https://new.example');
  });
});

describe('openBrowserPopup', () => {
  test('a popup opens on the server route next to its opener and shows', () => {
    const state: BrowserPages = { pages: [page('a', 'https://a.example', { route: 'device' }), page('b'), page('c')], activePageId: 'c' };
    const next = openBrowserPopup(state, { openerPageId: 'b', popupId: 'claim-1' }, ids());
    expect(next?.pages.map((entry) => entry.id)).toEqual(['a', 'b', 'new-1', 'c']);
    expect(next?.pages[2]).toEqual(page('new-1', null, { route: 'server', popupId: 'claim-1' }));
    expect(next?.activePageId).toBe('new-1');
  });

  test('a popup never replaces a page at the limit', () => {
    const pages = Array.from({ length: MAX_BROWSER_PAGES }, (_, index) => page(`p${index}`));
    expect(openBrowserPopup({ pages, activePageId: 'p0' }, { openerPageId: 'p0', popupId: 'claim-1' }, ids())).toBeNull();
  });

  test('the claim is dropped once made, and never restored', () => {
    const state: BrowserPages = { pages: [page('a', null, { route: 'server', popupId: 'claim-1' })], activePageId: 'a' };
    const next = updateBrowserPage(state, 'a', { popupId: null });
    expect(next.pages[0]).toEqual(page('a', null, { route: 'server' }));
    expect(updateBrowserPage(next, 'a', { popupId: null })).toBe(next);
    const restored = sanitizeBrowserPages(state, { tabId: 'legacy', url: null, route: null });
    expect(restored.pages[0]).toEqual(page('a', null, { route: 'server' }));
  });
});

describe('closeBrowserPage', () => {
  const state: BrowserPages = { pages: [page('a'), page('b'), page('c')], activePageId: 'b' };

  test('closing the active page shows its right neighbour, or the left one when last', () => {
    expect(closeBrowserPage(state, 'b').activePageId).toBe('c');
    expect(closeBrowserPage({ ...state, activePageId: 'c' }, 'c').activePageId).toBe('b');
  });

  test('closing another page keeps the active one', () => {
    const next = closeBrowserPage(state, 'a');
    expect(next.pages.map((entry) => entry.id)).toEqual(['b', 'c']);
    expect(next.activePageId).toBe('b');
  });

  test('closing the only page leaves one empty page', () => {
    const next = closeBrowserPage({ pages: [page('a', 'https://a.example', { route: 'device' })], activePageId: 'a' }, 'a', ids());
    expect(next).toEqual({ pages: [page('new-1', null, { route: 'device' })], activePageId: 'new-1' });
  });

  test('an unknown page changes nothing', () => {
    expect(closeBrowserPage(state, 'missing')).toBe(state);
  });
});

describe('updateBrowserPage', () => {
  const state: BrowserPages = { pages: [page('a', 'https://a.example'), page('b')], activePageId: 'a' };

  test('records an address, title, and route', () => {
    const next = updateBrowserPage(state, 'b', { url: 'https://b.example', title: '  B  page ', route: 'device' });
    expect(next.pages[1]).toEqual(page('b', 'https://b.example', { title: 'B page', route: 'device' }));
    expect(next.pages[0]).toBe(state.pages[0]);
  });

  test('a default route never overrides one already picked', () => {
    const picked: BrowserPages = { pages: [page('a', null, { route: 'device' }), page('b')], activePageId: 'a' };
    expect(updateBrowserPage(picked, 'a', { defaultRoute: 'server' })).toBe(picked);
    expect(updateBrowserPage(picked, 'b', { defaultRoute: 'server' }).pages[1]?.route).toBe('server');
  });

  test('an empty address never erases the last one and no change keeps the same state', () => {
    expect(updateBrowserPage(state, 'a', { url: '' })).toBe(state);
    expect(updateBrowserPage(state, 'a', { url: 'about:blank' })).toBe(state);
    expect(updateBrowserPage(state, 'a', { url: 'https://a.example' })).toBe(state);
    expect(updateBrowserPage(state, 'missing', { url: 'https://x.example' })).toBe(state);
  });
});

describe('helpers', () => {
  test('activateBrowserPage ignores unknown pages and the page already shown', () => {
    const state: BrowserPages = { pages: [page('a'), page('b')], activePageId: 'a' };
    expect(activateBrowserPage(state, 'b').activePageId).toBe('b');
    expect(activateBrowserPage(state, 'missing')).toBe(state);
    expect(activateBrowserPage(state, 'a')).toBe(state);
  });
});
