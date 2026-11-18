import React from 'react';

import { reportSettingsSaveState } from '@/lib/persistence';

/** Run a settings write and report saving, then saved or failed. */
export function useSaveReporter() {
  return React.useCallback(async (write: () => Promise<boolean>) => {
    reportSettingsSaveState('saving');
    const ok = await write();
    reportSettingsSaveState(ok ? 'saved' : 'error');
    return ok;
  }, []);
}
