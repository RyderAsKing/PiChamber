import React from 'react';

import { useI18nStore, formatMessage, type I18nKey, type I18nParams } from './store';
import { I18nContext, type I18nContextValue } from './react-context';

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const locale = useI18nStore((state) => state.locale);
  const dictionary = useI18nStore((state) => state.dictionary);

  React.useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.lang = locale;
  }, [locale]);

  const value = React.useMemo<I18nContextValue>(() => {
    const t = (key: I18nKey, params?: I18nParams) => formatMessage(dictionary, key, params);
    return { locale, t };
  }, [dictionary, locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};
