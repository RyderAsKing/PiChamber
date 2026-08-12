import { describe, expect, test } from 'bun:test';

import { parsePiResourceSettingsPage } from './pi-resource-settings-page';

describe('parsePiResourceSettingsPage', () => {
  test('accepts mounted resource settings slugs and the skills alias', () => {
    expect(parsePiResourceSettingsPage('skills')).toBe('skills.installed');
    expect(parsePiResourceSettingsPage('skills.installed')).toBe('skills.installed');
    expect(parsePiResourceSettingsPage('snippets')).toBe('snippets');
    expect(parsePiResourceSettingsPage('behavior')).toBe('behavior');
    expect(parsePiResourceSettingsPage('magic-prompts')).toBe('magic-prompts');
    expect(parsePiResourceSettingsPage('providers')).toBe('providers');
  });

  test('rejects unrelated settings slugs instead of inventing a page', () => {
    expect(parsePiResourceSettingsPage('home')).toBeNull();
    expect(parsePiResourceSettingsPage('')).toBeNull();
    expect(parsePiResourceSettingsPage(null)).toBeNull();
  });
});
