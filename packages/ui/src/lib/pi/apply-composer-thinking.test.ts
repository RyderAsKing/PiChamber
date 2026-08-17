import { describe, expect, test } from 'bun:test';

import { applyComposerThinking, type ApplyComposerThinkingHost } from './apply-composer-thinking';
import type { PiThinkingLevel } from './types';

const createHost = (options?: {
  variant?: string;
  sessionId?: string | null;
  setThinking?: (sessionId: string, thinking: PiThinkingLevel) => Promise<void>;
}): ApplyComposerThinkingHost & { variants: string[]; thinkingCalls: Array<[string, PiThinkingLevel]> } => {
  const thinkingCalls: Array<[string, PiThinkingLevel]> = [];
  const host: ApplyComposerThinkingHost & { variants: string[]; thinkingCalls: Array<[string, PiThinkingLevel]> } = {
    variants: options?.variant ? [options.variant] : [],
    thinkingCalls,
    getCurrentVariant: () => host.variants[host.variants.length - 1],
    setCurrentVariant: (variant) => {
      host.variants.push(variant ?? '');
    },
    getSessionId: () => options?.sessionId,
    setSessionThinking: async (sessionId, thinking) => {
      thinkingCalls.push([sessionId, thinking]);
      if (options?.setThinking) {
        await options.setThinking(sessionId, thinking);
      }
    },
  };
  return host;
};

describe('applyComposerThinking', () => {
  test('clears the override without inventing a live thinking write', async () => {
    const host = createHost({ variant: 'high', sessionId: 's1' });
    expect(await applyComposerThinking(undefined, host)).toBe('applied');
    expect(host.variants.at(-1)).toBe('');
    expect(host.thinkingCalls).toEqual([]);
  });

  test('applies an explicit level to an open session', async () => {
    const host = createHost({ variant: 'low', sessionId: 's1' });
    expect(await applyComposerThinking('max', host)).toBe('applied');
    expect(host.variants.at(-1)).toBe('max');
    expect(host.thinkingCalls).toEqual([['s1', 'max']]);
  });

  test('rolls back the composer value when setThinking fails', async () => {
    const host = createHost({
      variant: 'low',
      sessionId: 's1',
      setThinking: async () => {
        throw new Error('nope');
      },
    });
    await expect(applyComposerThinking('high', host)).rejects.toThrow('nope');
    expect(host.variants.at(-1)).toBe('low');
  });

  test('does not roll back after a newer apply owns the composer value', async () => {
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const host = createHost({
      variant: 'low',
      sessionId: 's1',
      setThinking: async (_sessionId, thinking) => {
        if (thinking === 'medium') await first;
      },
    });

    const pending = applyComposerThinking('medium', host);
    const latest = applyComposerThinking('max', host);
    await latest;
    releaseFirst?.();
    expect(await pending).toBe('superseded');
    expect(host.variants.at(-1)).toBe('max');
  });
});
