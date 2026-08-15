import React from 'react';

import type { I18nKey, I18nParams } from './store';
import type { Locale } from './runtime';

export type I18nContextValue = {
  locale: Locale;
  t: (key: I18nKey, params?: I18nParams) => string;
};

export const I18nContext = React.createContext<I18nContextValue | null>(null);
