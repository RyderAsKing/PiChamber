import { beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_LOCALE } from './runtime';
import { resetI18nDictionaryCacheForTests, useI18nStore } from './store';

const defaultDictionary = useI18nStore.getState().dictionary;

const resetStore = () => {
  resetI18nDictionaryCacheForTests();
  useI18nStore.setState({
    locale: DEFAULT_LOCALE,
    dictionary: defaultDictionary,
    loadingLocale: null,
  });
};

describe('i18n store', () => {
  beforeEach(resetStore);

  test('keeps the default english dictionary and never enters a loading state', () => {
    expect(useI18nStore.getState().locale).toBe(DEFAULT_LOCALE);
    expect(useI18nStore.getState().loadingLocale).toBeNull();
    expect(useI18nStore.getState().dictionary['common.language.english']).toBeTruthy();
  });

  test('setLocale with the only supported locale is a no-op', () => {
    useI18nStore.getState().setLocale(DEFAULT_LOCALE);
    expect(useI18nStore.getState().locale).toBe(DEFAULT_LOCALE);
    expect(useI18nStore.getState().loadingLocale).toBeNull();
  });
});
