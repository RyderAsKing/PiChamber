import { describe, expect, test } from 'bun:test';

import { applyComposerThinking, type ApplyComposerThinkingHost } from './apply-composer-thinking';

const createHost = (options?: {
  variant?: string;
}): ApplyComposerThinkingHost & { variants: string[] } => {
  const host: ApplyComposerThinkingHost & { variants: string[] } = {
    variants: options?.variant ? [options.variant] : [],
    setCurrentVariant: (variant) => {
      host.variants.push(variant ?? '');
    },
  };
  return host;
};

describe('applyComposerThinking', () => {
  test('clears the override without a live session write', () => {
    const host = createHost({ variant: 'high' });
    expect(applyComposerThinking(undefined, host)).toBe('applied');
    expect(host.variants.at(-1)).toBe('');
  });

  test('stores an explicit level on the composer only', () => {
    const host = createHost({ variant: 'low' });
    expect(applyComposerThinking('max', host)).toBe('applied');
    expect(host.variants.at(-1)).toBe('max');
  });
});
