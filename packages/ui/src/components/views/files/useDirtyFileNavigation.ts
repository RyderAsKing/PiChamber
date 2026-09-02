import * as React from 'react';

import { useUIStore, type MainTab } from '@/stores/useUIStore';
import type { FileNode } from './filesViewModel';

export type DirtyFileNavigationIntent =
  | { kind: 'select'; file: FileNode }
  | { kind: 'close'; path: string; nextFile: FileNode | null }
  | { kind: 'tab'; tab: MainTab };

type UseDirtyFileNavigationOptions = {
  isDirty: boolean;
  saveDraft: () => Promise<boolean>;
};

/** Owns the single pending intent allowed by the unsaved-file modal. */
export function useDirtyFileNavigation({ isDirty, saveDraft }: UseDirtyFileNavigationOptions) {
  const setMainTabGuard = useUIStore((state) => state.setMainTabGuard);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const pendingIntentRef = React.useRef<DirtyFileNavigationIntent | null>(null);
  const skipDirtyOnceRef = React.useRef(false);

  const requestNavigation = React.useCallback((intent: DirtyFileNavigationIntent): boolean => {
    if (skipDirtyOnceRef.current) {
      skipDirtyOnceRef.current = false;
      return false;
    }
    if (!isDirty) return false;

    pendingIntentRef.current = intent;
    setConfirmOpen(true);
    return true;
  }, [isDirty]);

  React.useEffect(() => {
    if (!isDirty) {
      setMainTabGuard(null);
      return;
    }

    const guard = (nextTab: MainTab) => !requestNavigation({ kind: 'tab', tab: nextTab });
    setMainTabGuard(guard);
    return () => {
      if (useUIStore.getState().mainTabGuard === guard) setMainTabGuard(null);
    };
  }, [isDirty, requestNavigation, setMainTabGuard]);

  const takePendingIntent = React.useCallback(() => {
    const intent = pendingIntentRef.current;
    pendingIntentRef.current = null;
    skipDirtyOnceRef.current = true;
    setConfirmOpen(false);
    if (intent?.kind === 'tab') setMainTabGuard(null);
    return intent;
  }, [setMainTabGuard]);

  const discardAndTakeIntent = React.useCallback(() => takePendingIntent(), [takePendingIntent]);

  const saveAndTakeIntent = React.useCallback(async () => {
    if (!await saveDraft()) {
      skipDirtyOnceRef.current = false;
      return null;
    }
    return takePendingIntent();
  }, [saveDraft, takePendingIntent]);

  const keepModalOpen = React.useCallback((open: boolean) => {
    // This dialog intentionally has no cancel action.
    if (!open) setConfirmOpen(true);
  }, []);

  return {
    confirmOpen,
    discardAndTakeIntent,
    keepModalOpen,
    requestNavigation,
    saveAndTakeIntent,
  };
}
