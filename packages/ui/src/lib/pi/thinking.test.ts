import { describe, expect, test } from 'bun:test';

import {
  catalogThinkingLevels,
  clampThinkingLevel,
  configurableThinkingLevels,
  cycleThinkingLevel,
  getSupportedThinkingLevels,
  modelHasConfigurableThinking,
  nearestDiscreteIndex,
  parsePiThinkingLevel,
  resolveComposerThinkingForModel,
  resolveCreateThinking,
  resolveExistingSessionComposerSelection,
  thinkingLevelLabel,
} from './thinking';

describe('thinking levels', () => {
  test('parses the full Pi vocabulary', () => {
    expect(parsePiThinkingLevel('high')).toBe('high');
    expect(parsePiThinkingLevel('minimal')).toBe('minimal');
    expect(parsePiThinkingLevel('max')).toBe('max');
    expect(parsePiThinkingLevel('bogus')).toBeNull();
  });

  test('projects Pi thinkingLevelMap the same way the daemon does', () => {
    expect(getSupportedThinkingLevels({ reasoning: false })).toEqual(['off']);
    expect(getSupportedThinkingLevels({ reasoning: true })).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect(getSupportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: { low: 1, high: null, xhigh: 2 },
    })).toEqual(['off', 'minimal', 'low', 'medium', 'xhigh']);
  });

  test('clamps a missing level up, then down', () => {
    expect(clampThinkingLevel(['off', 'minimal', 'low', 'medium'], 'high')).toBe('medium');
    expect(clampThinkingLevel(['off', 'high', 'xhigh'], 'low')).toBe('high');
  });

  test('hides thinking when the catalog only offers off', () => {
    expect(modelHasConfigurableThinking(['off'])).toBe(false);
    expect(configurableThinkingLevels({ thinkingLevels: ['off'] })).toEqual([]);
    expect(catalogThinkingLevels({ thinkingLevels: ['off'] })).toEqual(['off']);
    expect(catalogThinkingLevels({ thinkingLevels: ['low', 'bad', 'high'] })).toEqual(['low', 'high']);
    expect(configurableThinkingLevels({ thinkingLevels: ['off', 'low', 'high'] })).toEqual(['off', 'low', 'high']);
  });

  test('cycles Default through thinking levels and wraps', () => {
    const levels = ['off', 'low', 'high'];
    expect(cycleThinkingLevel(levels, undefined, 1)).toBe('off');
    expect(cycleThinkingLevel(levels, 'off', 1)).toBe('low');
    expect(cycleThinkingLevel(levels, 'high', 1)).toBe(undefined);
    expect(cycleThinkingLevel(levels, 'high', -1)).toBe('low');
    expect(cycleThinkingLevel(levels, undefined, -1)).toBe('high');
    expect(cycleThinkingLevel(['off'], undefined, 1)).toBe(undefined);
    expect(cycleThinkingLevel(levels, 'xhigh', 1)).toBe('off');
  });

  test('labels thinking levels and snaps slider ticks', () => {
    expect(thinkingLevelLabel(undefined)).toBe('Default');
    expect(thinkingLevelLabel('xhigh')).toBe('Extra high');
    expect(nearestDiscreteIndex(0, 4)).toBe(0);
    expect(nearestDiscreteIndex(1, 4)).toBe(3);
    expect(nearestDiscreteIndex(0.5, 3)).toBe(1);
  });

  test('resolves new-session thinking from the per-model map before leftover global', () => {
    expect(resolveCreateThinking({
      model: { providerId: 'anthropic', modelId: 'opus' },
      defaultThinkingByModel: { 'anthropic/opus': 'high' },
      defaultThinking: 'low',
    })).toBe('high');
    expect(resolveCreateThinking({
      defaultThinking: 'medium',
    })).toBe('medium');
    expect(resolveCreateThinking({
      thinking: 'minimal',
      defaultThinking: 'high',
    })).toBe('minimal');
  });

  test('applies a model default and does not carry xhigh onto a medium-only model', () => {
    expect(resolveComposerThinkingForModel({
      providerId: 'p',
      modelId: 'm',
      thinkingLevels: ['off', 'low', 'medium'],
      previousThinking: 'xhigh',
    })).toBe('medium');
    expect(resolveComposerThinkingForModel({
      providerId: 'p',
      modelId: 'm',
      thinkingLevels: ['off', 'low', 'medium', 'high'],
      defaultThinkingByModel: { 'p/m': 'high' },
      previousThinking: 'low',
    })).toBe('high');
    expect(resolveComposerThinkingForModel({
      providerId: 'p',
      modelId: 'plain',
      thinkingLevels: ['off'],
      previousThinking: 'high',
    })).toBe(undefined);
  });

  test('locks an existing session to the last assistant model and thinking', () => {
    expect(resolveExistingSessionComposerSelection({
      model: { providerId: 'openai', modelId: 'gpt-5' },
      thinking: 'low',
      messages: [
        { role: 'user', createdAt: 1 },
        {
          role: 'assistant',
          createdAt: 2,
          model: { providerId: 'anthropic', modelId: 'opus' },
          thinkingLevel: 'high',
        },
        {
          role: 'assistant',
          createdAt: 3,
          model: { providerId: 'anthropic', modelId: 'sonnet' },
          thinkingLevel: 'max',
        },
      ],
    })).toEqual({
      model: { providerId: 'anthropic', modelId: 'sonnet' },
      thinking: 'max',
    });
  });

  test('falls back to live session fields when the transcript has no assistant model', () => {
    expect(resolveExistingSessionComposerSelection({
      model: { providerId: 'openai', modelId: 'gpt-5' },
      thinking: 'medium',
      messages: [{ role: 'user', createdAt: 1 }],
    })).toEqual({
      model: { providerId: 'openai', modelId: 'gpt-5' },
      thinking: 'medium',
    });
    expect(resolveExistingSessionComposerSelection({
      messages: [{ role: 'assistant', createdAt: 1, thinkingLevel: 'bogus' }],
    })).toEqual({});
  });
});
