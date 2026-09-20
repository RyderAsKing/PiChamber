import { describe, expect, test } from 'bun:test';
import {
  PI_DEFAULT_CONTEXT_WINDOW,
  PI_DEFAULT_MAX_TOKENS,
  isInsideThinkingLevelQuote,
  parseThinkingLevelEntries,
  validateAddProviderModel,
  validateThinkingMapText,
} from './add-provider-model';

describe('validateAddProviderModel', () => {
  test('requires a trimmed model ID', () => {
    expect(validateAddProviderModel({ modelId: '   ' }).errors.modelId).toBe('Required');
    expect(validateAddProviderModel({ modelId: ' model-1 ' }).result).toEqual({ id: 'model-1' });
  });

  test('omits untouched optional fields so Pi applies defaults', () => {
    expect(validateAddProviderModel({ modelId: 'model-1' }).result).toEqual({ id: 'model-1' });
  });

  test('builds the supported advanced model payload', () => {
    expect(validateAddProviderModel({
      modelId: ' model-1 ',
      displayName: ' Model One ',
      contextWindowText: '200000',
      maxTokensText: '32000',
      inputText: true,
      inputImage: true,
      supportsThinking: true,
      thinkingLevelMapText: 'low-effort\nhigh-effort',
    }).result).toEqual({
      id: 'model-1',
      name: 'Model One',
      contextWindow: 200000,
      maxTokens: 32000,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: { low: 'low-effort', high: 'high-effort' },
    });
  });

  test('rejects invalid token limits', () => {
    expect(validateAddProviderModel({ modelId: 'm', contextWindowText: '0' }).errors.contextWindow).toBeDefined();
    expect(validateAddProviderModel({ modelId: 'm', contextWindowText: '1e3' }).errors.contextWindow).toBeDefined();
    expect(validateAddProviderModel({ modelId: 'm', maxTokensText: '1.5' }).errors.maxTokens).toBeDefined();
  });

  test('requires thinking support when levels are configured', () => {
    expect(validateAddProviderModel({ modelId: 'm', thinkingLevelMapText: 'low-effort' }).errors.thinkingLevelMap)
      .toBe('Enable Supports thinking to add thinking levels');
  });

  test('keeps commas from submitting while a quoted value is open', () => {
    expect(isInsideThinkingLevelQuote('low="fast')).toBe(true);
    expect(isInsideThinkingLevelQuote('low="say \\"yes\\"')).toBe(true);
    expect(isInsideThinkingLevelQuote('low="fast,careful"')).toBe(false);
  });

  test('keeps separators inside quoted thinking-level values', () => {
    expect(parseThinkingLevelEntries('low="fast,careful"\nhigh="say \\"yes\\""')).toEqual([
      'low="fast,careful"',
      'high="say \\"yes\\""',
    ]);
  });

  test('parses explicit thinking-level keys and null entries without losing legacy values', () => {
    expect(validateThinkingMapText('low="thinking-2000"\nminimal=null\nhigh-effort').value).toEqual({
      low: 'thinking-2000',
      minimal: null,
      high: 'high-effort',
    });
  });

  test('rejects unknown and duplicate thinking levels', () => {
    expect(validateThinkingMapText('turbo').error).toBeDefined();
    expect(validateThinkingMapText('low-a\nlow-b').error).toBe('Only one low value is allowed');
    expect(validateThinkingMapText('low=null\nlow=other').error).toBe('Only one low value is allowed');
  });

  test('exposes Pi defaults for dialog copy', () => {
    expect(PI_DEFAULT_CONTEXT_WINDOW).toBe(128000);
    expect(PI_DEFAULT_MAX_TOKENS).toBe(16384);
  });
});
