import React from 'react';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { normalizePath } from '@/lib/pathNormalization';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { focusPreferenceForDirectory } from '@/sync/pi-session-focus-preference';

/**
 * Mobile folder focus: the directory store drives the Pi session store's
 * focused folder whenever the folder or the connection changes.
 *
 * The bridge in `AppEffects` copies Pi focus back into the directory store,
 * and both effects can run in the same commit. Each one reads the other
 * store at effect time and skips a value that is already stale, so the two
 * cannot swap folders back and forth until React aborts the render.
 */
export function useMobileFolderFocus(currentDirectory: string, isConnected: boolean): void {
  React.useEffect(() => {
    if (!isConnected) return;
    // The bridge may have moved the directory store after this render; the
    // newer value has its own render coming.
    if (normalizePath(useDirectoryStore.getState().currentDirectory) !== normalizePath(currentDirectory)) return;
    // A null preference would let a list that is still in flight pick its
    // first row; carry only a selection that already belongs to this folder.
    void getPiSessionStore().focusProject(currentDirectory, focusPreferenceForDirectory(currentDirectory));
  }, [currentDirectory, isConnected]);
}
