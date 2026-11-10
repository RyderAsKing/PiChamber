import { describe, expect, test } from 'bun:test';
import { leadingIndentColumns } from './hangingIndent';

describe('leadingIndentColumns', () => {
  test('counts spaces and expands tabs to the next tab stop', () => {
    expect(leadingIndentColumns('code', 4)).toBe(0);
    expect(leadingIndentColumns('    return x;', 4)).toBe(4);
    expect(leadingIndentColumns('\treturn x;', 4)).toBe(4);
    expect(leadingIndentColumns('  \treturn x;', 4)).toBe(4);
    expect(leadingIndentColumns('   ', 2)).toBe(3);
  });
});
