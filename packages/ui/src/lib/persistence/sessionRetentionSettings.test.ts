import { afterEach, describe, expect, test } from 'bun:test';
import { sanitizeWebSettings } from './settingsSanitizers';
import { materializeAuthoritativeUiSettings } from './settingsFieldSanitizers';
import { applyDesktopUiPreferences } from './settingsStoreSync';
import { useUIStore } from '@/stores/useUIStore';

describe('session auto-archive and auto-delete settings', () => {
  afterEach(() => {
    useUIStore.getState().setSessionAutoArchiveAfterDays(0);
    useUIStore.getState().setSessionAutoDeleteAfterDays(0);
  });

  test('sanitizer keeps off and 1 to 365 days', () => {
    for (const value of [0, 1, 7, 365]) {
      const sanitized = sanitizeWebSettings({
        sessionAutoArchiveAfterDays: value,
        sessionAutoDeleteAfterDays: value,
      });
      expect(sanitized?.sessionAutoArchiveAfterDays).toBe(value);
      expect(sanitized?.sessionAutoDeleteAfterDays).toBe(value);
    }
  });

  test('sanitizer drops out-of-range, fractional, and non-number values', () => {
    for (const value of [-1, 366, 2.5, '7', null]) {
      const sanitized = sanitizeWebSettings({
        sessionAutoArchiveAfterDays: value,
        sessionAutoDeleteAfterDays: value,
      });
      expect(sanitized?.sessionAutoArchiveAfterDays).toBeUndefined();
      expect(sanitized?.sessionAutoDeleteAfterDays).toBeUndefined();
    }
  });

  test('the store ignores invalid values', () => {
    useUIStore.getState().setSessionAutoArchiveAfterDays(14);
    useUIStore.getState().setSessionAutoArchiveAfterDays(400);
    useUIStore.getState().setSessionAutoDeleteAfterDays(30);
    useUIStore.getState().setSessionAutoDeleteAfterDays(-3);
    expect(useUIStore.getState().sessionAutoArchiveAfterDays).toBe(14);
    expect(useUIStore.getState().sessionAutoDeleteAfterDays).toBe(30);
  });

  test('server values reach the store', () => {
    applyDesktopUiPreferences(materializeAuthoritativeUiSettings({
      sessionAutoArchiveAfterDays: 7,
      sessionAutoDeleteAfterDays: 30,
    }));
    expect(useUIStore.getState().sessionAutoArchiveAfterDays).toBe(7);
    expect(useUIStore.getState().sessionAutoDeleteAfterDays).toBe(30);
  });

  test('settings without the fields turn both off rather than keep a stale value', () => {
    useUIStore.getState().setSessionAutoArchiveAfterDays(7);
    useUIStore.getState().setSessionAutoDeleteAfterDays(30);
    applyDesktopUiPreferences(materializeAuthoritativeUiSettings({}));
    expect(useUIStore.getState().sessionAutoArchiveAfterDays).toBe(0);
    expect(useUIStore.getState().sessionAutoDeleteAfterDays).toBe(0);
  });
});
