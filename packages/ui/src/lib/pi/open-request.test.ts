import { describe, expect, test } from 'bun:test';

import {
  decideOpenRequest,
  describeOpenRequestPrompt,
  describeOpenRequestUrl,
  extractOpenableUrls,
  OPEN_REQUEST_NOTICE_MS,
} from './open-request';

const live = { url: 'http://localhost:4000/review', createdAt: 1_000, serverNow: 2_000 };

describe('decideOpenRequest', () => {
  test('targets the PiChamber browser for a server-local page and the device browser otherwise', () => {
    expect(decideOpenRequest(live)).toEqual({ showNotice: true, target: 'panel' });
    expect(decideOpenRequest({ ...live, url: 'https://github.com/login/device' }))
      .toEqual({ showNotice: true, target: 'external' });
  });

  test('ignores replayed requests older than the notice window', () => {
    const stale = { ...live, serverNow: live.createdAt + OPEN_REQUEST_NOTICE_MS + 1 };
    expect(decideOpenRequest(stale).showNotice).toBe(false);
  });

  test('uses only the server clock, so a skewed device clock cannot matter', () => {
    expect(decideOpenRequest({ ...live, createdAt: 5_000, serverNow: 4_000 }).showNotice).toBe(true);
  });
});

describe('describeOpenRequestPrompt', () => {
  const label = 'localhost:4000/review';

  test('asks before opening, and warns when the page would share PiChamber\'s origin', () => {
    const shared = describeOpenRequestPrompt(label, 'panel', { isMobile: false, isolatedBrowser: false });
    expect(shared.canOpen).toBe(true);
    expect(shared.title).toBe('Open this page?');
    expect(shared.description).toContain('can act as you in PiChamber');

    const isolated = describeOpenRequestPrompt(label, 'panel', { isMobile: false, isolatedBrowser: true });
    expect(isolated.canOpen).toBe(true);
    expect(isolated.description).not.toContain('act as you');
  });

  test('only informs on a phone layout, which has no PiChamber browser', () => {
    expect(describeOpenRequestPrompt(label, 'panel', { isMobile: true, isolatedBrowser: false }).canOpen).toBe(false);
  });

  test('offers the device browser for other pages, phone included', () => {
    const prompt = describeOpenRequestPrompt('github.com/login/device', 'external', { isMobile: true, isolatedBrowser: false });
    expect(prompt).toEqual({
      title: 'Open this page?',
      description: 'github.com/login/device. Opens in your browser.',
      canOpen: true,
    });
  });
});

describe('describeOpenRequestUrl', () => {
  test('shows host and path without the query', () => {
    expect(describeOpenRequestUrl('http://localhost:4000/review?token=secret')).toBe('localhost:4000/review');
    expect(describeOpenRequestUrl('https://example.com/')).toBe('example.com');
  });
});

describe('extractOpenableUrls', () => {
  test('finds unique http(s) URLs and drops trailing punctuation', () => {
    expect(extractOpenableUrls('Review at http://localhost:4000/r. Also (https://x.test/a), http://localhost:4000/r'))
      .toEqual(['http://localhost:4000/r', 'https://x.test/a']);
  });

  test('stops at ANSI escapes and respects the limit', () => {
    expect(extractOpenableUrls('\u001b[36mhttp://localhost:1/a\u001b[0m')).toEqual(['http://localhost:1/a']);
    expect(extractOpenableUrls('http://a.test http://b.test http://c.test http://d.test', 2))
      .toEqual(['http://a.test', 'http://b.test']);
  });
});
