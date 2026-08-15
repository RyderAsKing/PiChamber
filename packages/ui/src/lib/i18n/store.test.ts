import { describe, expect, test } from 'bun:test';

import { DEFAULT_LOCALE } from './runtime';
import { useI18nStore } from './store';

describe('i18n store', () => {
  test('exposes the default english dictionary and locale', () => {
    const state = useI18nStore.getState();
    expect(state.locale).toBe(DEFAULT_LOCALE);
    expect(state.dictionary['chat.chatInput.placeholder.chatCompact']).toBeTruthy();
  });
});
