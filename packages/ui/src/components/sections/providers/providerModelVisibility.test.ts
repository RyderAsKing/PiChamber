import { afterEach, describe, expect, test } from 'bun:test';

import { useUIStore } from '@/stores/useUIStore';

const reset = (): void => {
  useUIStore.setState({ hiddenModels: [] });
};

afterEach(reset);

describe('provider model visibility bulk actions', () => {
  test('Hide all publishes a new complete provider selection immediately', () => {
    reset();
    const before = useUIStore.getState().hiddenModels;

    useUIStore.getState().hideAllModels('anthropic', ['opus', 'sonnet', 'opus']);

    const after = useUIStore.getState().hiddenModels;
    expect(after).not.toBe(before);
    expect(after).toEqual([
      { providerID: 'anthropic', modelID: 'opus' },
      { providerID: 'anthropic', modelID: 'sonnet' },
    ]);
  });

  test('Show all removes only the selected provider and publishes immediately', () => {
    useUIStore.setState({
      hiddenModels: [
        { providerID: 'anthropic', modelID: 'opus' },
        { providerID: 'openai', modelID: 'gpt-5' },
      ],
    });
    const before = useUIStore.getState().hiddenModels;

    useUIStore.getState().showAllModels('anthropic');

    const after = useUIStore.getState().hiddenModels;
    expect(after).not.toBe(before);
    expect(after).toEqual([{ providerID: 'openai', modelID: 'gpt-5' }]);
  });
});
