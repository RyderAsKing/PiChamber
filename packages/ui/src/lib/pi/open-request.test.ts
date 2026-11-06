import { describe, expect, test } from 'bun:test';

import {
  decideOpenRequest,
  describeOpenRequestPrompt,
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

  test('asks before opening a server-local page in the PiChamber browser', () => {
    expect(describeOpenRequestPrompt(label, 'panel', { isMobile: false })).toEqual({
      title: 'Open this page?',
      description: 'localhost:4000/review. Opens in the PiChamber browser.',
      canOpen: true,
    });
  });

  test('only informs on a phone layout, which has no PiChamber browser', () => {
    expect(describeOpenRequestPrompt(label, 'panel', { isMobile: true }).canOpen).toBe(false);
  });

  test('offers the device browser for other pages, phone included', () => {
    const prompt = describeOpenRequestPrompt('github.com/login/device', 'external', { isMobile: true });
    expect(prompt).toEqual({
      title: 'Open this page?',
      description: 'github.com/login/device. Opens in your browser.',
      canOpen: true,
    });
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
