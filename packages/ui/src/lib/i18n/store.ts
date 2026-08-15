import { create } from 'zustand';

import { dict as enDict, type I18nKey } from './messages/en';
import { DEFAULT_LOCALE, type Locale } from './runtime';

export type I18nParams = Record<string, string | number | boolean | null | undefined>;
export type I18nDictionary = Record<I18nKey, string>;

type I18nState = {
  locale: Locale;
  dictionary: I18nDictionary;
};

// PiChamber ships a single English locale; the store never changes after
// creation. It is kept as a store so existing consumers that read the
// dictionary outside React (useI18nStore.getState().dictionary) keep working.
export const useI18nStore = create<I18nState>()(() => ({
  locale: DEFAULT_LOCALE,
  dictionary: enDict,
}));

export function formatMessage(dictionary: I18nDictionary, key: I18nKey, params?: I18nParams): string {
  const template = dictionary[key] ?? enDict[key] ?? key;
  if (!params) {
    return template;
  }

  return template.replace(/\{([^{}]+)\}/g, (match, rawKey) => {
    const value = params[rawKey.trim()];
    return value === null || value === undefined ? match : String(value);
  });
}

export type { I18nKey, Locale };
