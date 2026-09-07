import { describe, expect, test } from 'bun:test';
import {
  normalizePwaOrientation,
} from './visualSettingsConstants';

describe('visualSettingsConstants helpers', () => {
  describe('normalizePwaOrientation', () => {
    test('accepts valid orientations', () => {
      expect(normalizePwaOrientation('portrait')).toBe('portrait');
      expect(normalizePwaOrientation('landscape')).toBe('landscape');
      expect(normalizePwaOrientation('system')).toBe('system');
    });

    test('defaults invalid values to system', () => {
      expect(normalizePwaOrientation('unknown')).toBe('system');
      expect(normalizePwaOrientation(null)).toBe('system');
      expect(normalizePwaOrientation(123)).toBe('system');
    });
  });
});
