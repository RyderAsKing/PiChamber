import { describe, expect, test } from 'bun:test';

import {
  formatPiModelRef,
  hasLegacyUiModelDefaultsPatch,
  legacyUiModelDefaultsPatch,
  parsePiModelRef,
  parsePiThinkingLevel,
} from './session-defaults';

describe('session-defaults', () => {
  test('formats and parses provider/model refs', () => {
    expect(formatPiModelRef({ providerId: 'anthropic', modelId: 'claude-opus' })).toBe('anthropic/claude-opus');
    expect(parsePiModelRef('anthropic/claude-opus')).toEqual({ providerId: 'anthropic', modelId: 'claude-opus' });
    expect(parsePiModelRef('')).toBeNull();
    expect(parsePiModelRef('nopath')).toBeNull();
  });

  test('accepts only PiChamber thinking levels', () => {
    expect(parsePiThinkingLevel('high')).toBe('high');
    expect(parsePiThinkingLevel('minimal')).toBe('minimal');
    expect(parsePiThinkingLevel('max')).toBe('max');
  });

  test('adopts leftover UI model strings only for unset sidecar fields', () => {
    const patch = legacyUiModelDefaultsPatch({
      defaultModel: 'openai/gpt-5',
      smallModelUseDefault: false,
      smallModelOverride: 'openai/gpt-4.1-mini',
      walkthroughModelOverride: 'anthropic/claude-sonnet',
    });
    expect(patch).toEqual({
      defaultModel: { providerId: 'openai', modelId: 'gpt-5' },
      smallModel: { providerId: 'openai', modelId: 'gpt-4.1-mini' },
      walkthroughModel: { providerId: 'anthropic', modelId: 'claude-sonnet' },
    });
    expect(hasLegacyUiModelDefaultsPatch(patch)).toBe(true);
  });

  test('does not adopt a small-model override while the default-small checkbox is on', () => {
    expect(legacyUiModelDefaultsPatch({
      smallModelUseDefault: true,
      smallModelOverride: 'openai/gpt-4.1-mini',
    })).toEqual({});
  });

  test('skips leftover UI values that already exist on the sidecar', () => {
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
});
