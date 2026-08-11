import React from 'react';
import type { RuntimeAPIs } from '@/lib/api/types';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';

export const useRuntimeAPIs = (): RuntimeAPIs => {
  const apis = React.useContext(RuntimeAPIContext);
  if (!apis) {
    throw new Error('Runtime APIs are not available. Did you forget to wrap the app in <RuntimeAPIProvider>?');
  }
  return apis;
};
