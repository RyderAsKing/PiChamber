import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import zhCN from './locales/zh-CN.json';

export const SUPPORTED_LANGUAGES = [
  { value: 'system', label: 'Follow system' },
  { value: 'en', label: 'English' },
  { value: 'zh-CN', label: '简体中文' },
] as const;

export type LanguagePreference = (typeof SUPPORTED_LANGUAGES)[number]['value'];

const LANGUAGE_STORAGE_KEY = 'pichamber-language';

/**
 * English is the source language: message ids are the English literals used in
 * code, so the `en` catalog is implicit (missing keys render the key itself).
 * Additional locales only need a JSON map from the English text to the
 * translation.
 */
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { translation: zhCN },
    },
    fallbackLng: false,
    supportedLngs: ['en', 'zh-CN'],
    nonExplicitSupportedLngs: true,
    // Keys are the English source strings, so keep the key when a
    // translation is missing.
    returnEmptyString: false,
    returnNull: false,
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
    },
  });

export const getLanguagePreference = (): LanguagePreference => {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === 'en' || stored === 'zh-CN') {
      return stored;
    }
  } catch {
    // localStorage unavailable; fall through to system.
  }
  return 'system';
};

export const setLanguagePreference = (preference: LanguagePreference): void => {
  try {
    if (preference === 'system') {
      window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
      const navigatorLanguage = window.navigator.language?.toLowerCase() ?? '';
      void i18n.changeLanguage(navigatorLanguage.startsWith('zh') ? 'zh-CN' : 'en');
      return;
    }
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, preference);
    void i18n.changeLanguage(preference);
  } catch {
    void i18n.changeLanguage(preference === 'system' ? 'en' : preference);
  }
};

export default i18n;
