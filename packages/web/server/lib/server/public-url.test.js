import { describe, expect, test } from 'vitest';

import { parsePublicUrl, PublicUrlError } from './public-url.js';

describe('parsePublicUrl', () => {
  test('unset or blank means no public URL', () => {
    expect(parsePublicUrl(undefined)).toBeNull();
    expect(parsePublicUrl(null)).toBeNull();
    expect(parsePublicUrl('   ')).toBeNull();
  });

  test('returns the origin of a site-root address', () => {
    expect(parsePublicUrl(' https://pichamber.example.com/ ')).toBe('https://pichamber.example.com');
    expect(parsePublicUrl('http://box.lan:8080')).toBe('http://box.lan:8080');
    expect(parsePublicUrl('https://pichamber.example.com:443')).toBe('https://pichamber.example.com');
  });

  test.each([
    ['not a url', 'is not a valid URL'],
    ['ftp://pichamber.example.com', 'must start with http:// or https://'],
    ['https://user:secret@pichamber.example.com', 'must not contain a user name or password'],
    ['https://example.com/pichamber', 'without a path, query, or fragment'],
    ['https://example.com/?a=1', 'without a path, query, or fragment'],
  ])('rejects %s', (value, message) => {
    expect(() => parsePublicUrl(value)).toThrow(PublicUrlError);
    expect(() => parsePublicUrl(value)).toThrow(message);
  });

  test('errors name the source and never echo the value', () => {
    let error;
    try {
      parsePublicUrl('https://user:secret@example.com', { source: '--public-url' });
    } catch (caught) {
      error = caught;
    }
    expect(error.message.startsWith('--public-url ')).toBe(true);
    expect(error.message).not.toContain('secret');
  });
});
