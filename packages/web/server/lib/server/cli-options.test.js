import { describe, expect, test } from 'vitest';

import { parseServeCliOptions } from './cli-options.js';

const parse = (argv) => parseServeCliOptions({ argv, env: {}, defaultPort: 3000 });

describe('--public-url', () => {
  test('omitted leaves it unset, so PICHAMBER_PUBLIC_URL applies', () => {
    expect(parse([]).publicUrl).toBeUndefined();
  });

  test('keeps a given value', () => {
    expect(parse(['--public-url', ' https://pichamber.example.com ']).publicUrl).toBe('https://pichamber.example.com');
    expect(parse(['--public-url=https://pichamber.example.com']).publicUrl).toBe('https://pichamber.example.com');
  });

  test('present without a value is blank, which startup rejects', () => {
    expect(parse(['--public-url']).publicUrl).toBe('');
    expect(parse(['--public-url', '--port', '4000']).publicUrl).toBe('');
    expect(parse(['--public-url=']).publicUrl).toBe('');
  });
});
