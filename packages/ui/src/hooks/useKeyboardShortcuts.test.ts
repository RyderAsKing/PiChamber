import { describe, expect, test } from 'bun:test';

import { shouldHandleModelSelectorShortcut } from './useKeyboardShortcuts';

const modelSelectorKeydown = (repeat: boolean): KeyboardEvent =>
  ({
    key: 'm',
    code: 'KeyM',
    ctrlKey: true,
    metaKey: false,
    shiftKey: true,
    altKey: false,
    repeat,
  }) as KeyboardEvent;

describe('shouldHandleModelSelectorShortcut', () => {
  test('accepts the initial model selector shortcut keydown', () => {
    expect(shouldHandleModelSelectorShortcut(modelSelectorKeydown(false), 'mod+shift+m')).toBe(true);
  });

  test('rejects auto-repeated model selector shortcut keydowns', () => {
    expect(shouldHandleModelSelectorShortcut(modelSelectorKeydown(true), 'mod+shift+m')).toBe(false);
  });
});
