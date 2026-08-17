import { describe, expect, it, vi } from 'vitest';

import { adoptLegacyUiModelDefaults, legacyUiModelDefaultsPatch } from './legacy-ui-model-defaults.js';

describe('legacy UI model defaults', () => {
  it('adopts leftover UI strings only for unset sidecar fields', () => {
    expect(legacyUiModelDefaultsPatch({
      defaultModel: 'openai/gpt-5',
      smallModelUseDefault: false,
      smallModelOverride: 'openai/mini',
      walkthroughModelOverride: 'anthropic/sonnet',
    }, {
      defaultModel: { providerId: 'google', modelId: 'gemini' },
    })).toEqual({
      smallModel: { providerId: 'openai', modelId: 'mini' },
      walkthroughModel: { providerId: 'anthropic', modelId: 'sonnet' },
    });
  });

  it('does not adopt a small-model override while the default-small checkbox is on', () => {
    expect(legacyUiModelDefaultsPatch({
      smallModelUseDefault: true,
      smallModelOverride: 'openai/mini',
    })).toEqual({});
  });

  it('writes adopted values into the sidecar and clears leftover UI keys', async () => {
    const settingsStore = {
      read: vi.fn(async () => ({ version: 1 })),
      update: vi.fn(async (patch) => ({ version: 1, ...patch })),
    };
    const uiSettingsStore = {
      read: vi.fn(async () => ({ defaultModel: 'openai/gpt-5', themeMode: 'dark' })),
      write: vi.fn(async () => ({})),
    };
    await expect(adoptLegacyUiModelDefaults(settingsStore, uiSettingsStore)).resolves.toEqual({
      version: 1,
      defaultModel: { providerId: 'openai', modelId: 'gpt-5' },
    });
    expect(settingsStore.update).toHaveBeenCalledWith({ defaultModel: { providerId: 'openai', modelId: 'gpt-5' } });
    expect(uiSettingsStore.write).toHaveBeenCalledWith({
      defaultModel: '',
      smallModelOverride: '',
      walkthroughModelOverride: '',
    });
  });

  it('leaves sidecar unchanged when UI settings are unreadable', async () => {
    const settingsStore = {
      read: vi.fn(async () => ({ version: 1, defaultThinking: 'high' })),
      update: vi.fn(),
    };
    const uiSettingsStore = {
      read: vi.fn(async () => {
        throw new Error('UI_SETTINGS_INVALID');
      }),
      write: vi.fn(),
    };
    await expect(adoptLegacyUiModelDefaults(settingsStore, uiSettingsStore)).resolves.toEqual({
      version: 1,
      defaultThinking: 'high',
    });
    expect(settingsStore.update).not.toHaveBeenCalled();
  });
});
