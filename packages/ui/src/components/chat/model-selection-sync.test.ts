import { describe, expect, test } from 'bun:test';

import { classifyAuthoritativeComposerSelection } from './model-selection-sync';

describe('classifyAuthoritativeComposerSelection', () => {
  test('does not restore the old authoritative model when its thinking echo follows a manual model pick', () => {
    expect(classifyAuthoritativeComposerSelection({
      authoritative: { providerId: 'provider', modelId: 'model-b', thinking: 'high' },
      observed: { providerId: 'provider', modelId: 'model-b', thinking: 'low' },
      composer: { providerId: 'provider', modelId: 'model-a', thinking: 'high' },
    })).toBe('observe');
  });

  test('applies a genuinely changed authoritative model', () => {
    expect(classifyAuthoritativeComposerSelection({
      authoritative: { providerId: 'provider', modelId: 'model-b', thinking: 'high' },
      observed: { providerId: 'provider', modelId: 'model-a', thinking: 'high' },
      composer: { providerId: 'provider', modelId: 'model-a', thinking: 'high' },
    })).toBe('apply');
  });

  test('ignores an already observed authoritative selection', () => {
    expect(classifyAuthoritativeComposerSelection({
      authoritative: { providerId: 'provider', modelId: 'model-b', thinking: 'high' },
      observed: { providerId: 'provider', modelId: 'model-b', thinking: 'high' },
      composer: { providerId: 'provider', modelId: 'model-a', thinking: 'low' },
    })).toBe('ignore');
  });

  test('keeps pending composer thinking when the committed session has not changed', () => {
    expect(classifyAuthoritativeComposerSelection({
      authoritative: { providerId: 'provider', modelId: 'model-a', thinking: 'xhigh' },
      observed: { providerId: 'provider', modelId: 'model-a', thinking: 'xhigh' },
      composer: { providerId: 'provider', modelId: 'model-a', thinking: 'low' },
    })).toBe('ignore');
  });

  test('applies an external thinking change on the same already-observed model', () => {
    expect(classifyAuthoritativeComposerSelection({
      authoritative: { providerId: 'provider', modelId: 'model-a', thinking: 'max' },
      observed: { providerId: 'provider', modelId: 'model-a', thinking: 'xhigh' },
      composer: { providerId: 'provider', modelId: 'model-a', thinking: 'low' },
    })).toBe('apply');
  });

  test('replaces an unsent model pick with an extension\'s thinking-only choice', () => {
    // The session stays on model-a; a mode command changes only its
    // thinking while the composer holds an unsent model-b.
    expect(classifyAuthoritativeComposerSelection({
      authoritative: { providerId: 'provider', modelId: 'model-a', thinking: 'high' },
      observed: { providerId: 'provider', modelId: 'model-a', thinking: 'medium' },
      composer: { providerId: 'provider', modelId: 'model-b', thinking: 'medium' },
      extensionChoice: true,
    })).toBe('apply');
  });

  test('applies an extension choice the composer had already observed', () => {
    // The thinking event arrives first and is observed; the extension's own
    // event that follows carries the same values but still wins.
    expect(classifyAuthoritativeComposerSelection({
      authoritative: { providerId: 'provider', modelId: 'model-a', thinking: 'high' },
      observed: { providerId: 'provider', modelId: 'model-a', thinking: 'high' },
      composer: { providerId: 'provider', modelId: 'model-b', thinking: 'medium' },
      extensionChoice: true,
    })).toBe('apply');
  });

  test('only observes an extension choice the composer already shows', () => {
    expect(classifyAuthoritativeComposerSelection({
      authoritative: { providerId: 'provider', modelId: 'model-a', thinking: 'high' },
      observed: { providerId: 'provider', modelId: 'model-a', thinking: 'medium' },
      composer: { providerId: 'provider', modelId: 'model-a', thinking: 'high' },
      extensionChoice: true,
    })).toBe('observe');
  });
});
