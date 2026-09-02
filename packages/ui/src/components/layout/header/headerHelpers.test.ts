import { describe, expect, test } from 'bun:test';
import {
  formatCompactHeaderLabel,
  formatTime,
  normalize,
} from './headerHelpers';

describe('headerHelpers', () => {
  describe('formatCompactHeaderLabel', () => {
    test('returns empty string for empty or whitespace input', () => {
      expect(formatCompactHeaderLabel('')).toBe('');
      expect(formatCompactHeaderLabel('   ')).toBe('');
    });

    test('truncates multiple words cleanly', () => {
      expect(formatCompactHeaderLabel('My Cool Project')).toBe('My Coo...');
      expect(formatCompactHeaderLabel('First Second')).toBe('First Sec...');
    });

    test('truncates single long word', () => {
      expect(formatCompactHeaderLabel('SuperLongProjectName')).toBe('SuperLong...');
      expect(formatCompactHeaderLabel('ShortName')).toBe('ShortName');
    });
  });

  describe('formatTime', () => {
    test('returns dash for null or 0 timestamp', () => {
      expect(formatTime(null, 'auto')).toBe('-');
      expect(formatTime(0, 'auto')).toBe('-');
    });

    test('formats valid timestamps', () => {
      const ts = new Date('2025-01-01T12:00:00Z').getTime();
      const formatted = formatTime(ts, '24h');
      expect(typeof formatted).toBe('string');
      expect(formatted).not.toBe('-');
    });
  });

  describe('normalize', () => {
    test('converts backslashes and trims trailing slashes', () => {
      expect(normalize('foo\\bar\\')).toBe('foo/bar');
      expect(normalize('/')).toBe('/');
      expect(normalize('')).toBe('');
    });
  });
});
