import { describe, expect, test } from 'bun:test';
import {
  formatRemaining,
  hasAllowedManagedLocalConfigExtension,
  normalizePresetHostname,
  sanitizePresets,
  toUiTunnelMode,
  ttlOptionLabel,
  ttlOptionValue,
  BOOTSTRAP_TTL_OPTIONS,
} from './tunnelHelpers';

describe('tunnelHelpers', () => {
  describe('hasAllowedManagedLocalConfigExtension', () => {
    test('accepts yaml, yml, and json files', () => {
      expect(hasAllowedManagedLocalConfigExtension('config.yml')).toBe(true);
      expect(hasAllowedManagedLocalConfigExtension('/etc/cloudflared/config.YAML')).toBe(true);
      expect(hasAllowedManagedLocalConfigExtension('config.json')).toBe(true);
    });

    test('rejects other extensions', () => {
      expect(hasAllowedManagedLocalConfigExtension('config.txt')).toBe(false);
      expect(hasAllowedManagedLocalConfigExtension('config.conf')).toBe(false);
      expect(hasAllowedManagedLocalConfigExtension('')).toBe(false);
    });
  });

  describe('toUiTunnelMode', () => {
    test('normalizes modes correctly', () => {
      expect(toUiTunnelMode('quick')).toBe('quick');
      expect(toUiTunnelMode('managed-remote')).toBe('managed-remote');
      expect(toUiTunnelMode('managed-local')).toBe('managed-local');
      expect(toUiTunnelMode('unknown')).toBe('quick');
      expect(toUiTunnelMode(null)).toBe('quick');
    });
  });

  describe('ttlOptionValue & ttlOptionLabel', () => {
    test('resolves option values and labels', () => {
      expect(ttlOptionValue(BOOTSTRAP_TTL_OPTIONS, 1800000, 'fallback')).toBe('1800000');
      expect(ttlOptionValue(BOOTSTRAP_TTL_OPTIONS, 999999, 'fallback')).toBe('fallback');
      expect(ttlOptionLabel(BOOTSTRAP_TTL_OPTIONS, 1800000, 'fallback')).toBe('30m');
      expect(ttlOptionLabel(BOOTSTRAP_TTL_OPTIONS, 999999, 'fallback')).toBe('fallback');
    });
  });

  describe('formatRemaining', () => {
    test('formats hours and minutes', () => {
      expect(formatRemaining(3600 * 1000 + 120 * 1000)).toBe('1h 2m');
    });

    test('formats minutes and seconds', () => {
      expect(formatRemaining(150 * 1000)).toBe('2m 30s');
    });

    test('formats seconds only', () => {
      expect(formatRemaining(45 * 1000)).toBe('45s');
      expect(formatRemaining(0)).toBe('0s');
      expect(formatRemaining(-500)).toBe('0s');
    });
  });

  describe('normalizePresetHostname', () => {
    test('strips protocol and returns lowercased hostname', () => {
      expect(normalizePresetHostname('https://TUNNEL.example.com/path')).toBe('tunnel.example.com');
      expect(normalizePresetHostname('TUNNEL.example.com')).toBe('tunnel.example.com');
      expect(normalizePresetHostname('')).toBe('');
    });
  });

  describe('sanitizePresets', () => {
    test('sanitizes and deduplicates preset entries', () => {
      const raw = [
        { id: '1', name: 'Preset 1', hostname: 'host1.com' },
        { id: '1', name: 'Duplicate ID', hostname: 'host2.com' },
        { id: '2', name: 'Duplicate Host', hostname: 'https://HOST1.com' },
        { id: '3', name: 'Valid 2', hostname: 'host3.com' },
        null,
        'invalid',
        { id: '', name: 'Empty ID', hostname: 'host4.com' },
      ];

      const sanitized = sanitizePresets(raw);
      expect(sanitized).toEqual([
        { id: '1', name: 'Preset 1', hostname: 'host1.com' },
        { id: '3', name: 'Valid 2', hostname: 'host3.com' },
      ]);
    });

    test('returns empty array for non-array input', () => {
      expect(sanitizePresets(null)).toEqual([]);
      expect(sanitizePresets('foo')).toEqual([]);
    });
  });
});
