import { afterEach, describe, expect, test } from 'bun:test';
import { sanitizeWebSettings } from './settingsSanitizers';
import { materializeAuthoritativeUiSettings } from './settingsFieldSanitizers';
import { applyDesktopUiPreferences } from './settingsStoreSync';
import { useUIStore } from '@/stores/useUIStore';
import { DEFAULT_SIDEBAR_VIEW_MODE } from '@/lib/sidebarViewMode';

describe('sidebarViewMode settings synchronization and sanitization', () => {
  afterEach(() => {
    useUIStore.getState().setSidebarViewMode(DEFAULT_SIDEBAR_VIEW_MODE);
  });

  describe('sanitizeWebSettings', () => {
    test('keeps each of the three valid values', () => {
      expect(sanitizeWebSettings({ sidebarViewMode: 'workspace' })?.sidebarViewMode).toBe('workspace');
      expect(sanitizeWebSettings({ sidebarViewMode: 'folder' })?.sidebarViewMode).toBe('folder');
      expect(sanitizeWebSettings({ sidebarViewMode: 'timeline' })?.sidebarViewMode).toBe('timeline');
    });

    test('drops an invalid string, a number, and null', () => {
      expect(sanitizeWebSettings({ sidebarViewMode: 'invalid-mode' })?.sidebarViewMode).toBeUndefined();
      expect(sanitizeWebSettings({ sidebarViewMode: 123 })?.sidebarViewMode).toBeUndefined();
      expect(sanitizeWebSettings({ sidebarViewMode: null })?.sidebarViewMode).toBeUndefined();
    });
  });

  describe('materializeAuthoritativeUiSettings', () => {
    test('yields sidebarViewMode workspace by default', () => {
      const materialized = materializeAuthoritativeUiSettings({});
      expect(materialized.sidebarViewMode).toBe('workspace');
    });

    test('keeps explicit sidebarViewMode timeline', () => {
      const materialized = materializeAuthoritativeUiSettings({ sidebarViewMode: 'timeline' });
      expect(materialized.sidebarViewMode).toBe('timeline');
    });
  });

  describe('applyDesktopUiPreferences', () => {
    test('sets the store from workspace to folder', () => {
      useUIStore.getState().setSidebarViewMode('workspace');
      expect(useUIStore.getState().sidebarViewMode).toBe('workspace');

      applyDesktopUiPreferences({ sidebarViewMode: 'folder' });
      expect(useUIStore.getState().sidebarViewMode).toBe('folder');
    });

    test('resets store holding timeline back to workspace when authoritative settings lack the key', () => {
      useUIStore.getState().setSidebarViewMode('timeline');
      expect(useUIStore.getState().sidebarViewMode).toBe('timeline');

      const authoritative = materializeAuthoritativeUiSettings({});
      applyDesktopUiPreferences(authoritative);
      expect(useUIStore.getState().sidebarViewMode).toBe('workspace');
    });
  });
});
