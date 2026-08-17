import { describe, expect, test } from 'bun:test';

import { isHiddenModelRef, visibleModelOptions } from './hidden-models';

const hidden = [{ providerID: 'openai', modelID: 'gpt-4' }];

describe('visibleModelOptions', () => {
  test('omits hidden models from selection lists', () => {
    const options = [
      { providerId: 'openai', modelId: 'gpt-4' },
      { providerId: 'openai', modelId: 'gpt-5' },
    ];
    expect(visibleModelOptions(options, hidden).map((option) => option.modelId)).toEqual(['gpt-5']);
  });

  test('keeps currently selected hidden models so the control can still display them', () => {
    const options = [
      { providerId: 'openai', modelId: 'gpt-4' },
      { providerId: 'openai', modelId: 'gpt-5' },
    ];
    expect(visibleModelOptions(options, hidden, { providerId: 'openai', modelId: 'gpt-4' })).toEqual(options);
    expect(visibleModelOptions(options, hidden, [{ providerId: 'openai', modelId: 'gpt-4' }])).toEqual(options);
  });

  test('isHiddenModelRef matches provider and model together', () => {
    expect(isHiddenModelRef(hidden, 'openai', 'gpt-4')).toBe(true);
    expect(isHiddenModelRef(hidden, 'openai', 'gpt-5')).toBe(false);
    expect(isHiddenModelRef(hidden, 'anthropic', 'gpt-4')).toBe(false);
  });
});
