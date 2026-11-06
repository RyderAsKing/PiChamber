import { resolveDefaultBrowserRoute } from '@/components/layout/context-panel/browserRoute';
import type { OpenRequestTarget } from '@/lib/pi/open-request';
import { openExternalUrl } from '@/lib/url';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * The directory whose panel this device shows: the same resolution as
 * `useEffectiveDirectory`, read once when an action runs.
 */
export const getDeviceDirectory = (): string | undefined => {
  const { currentSessionId, newSessionDraft } = useSessionUIStore.getState();
  if (currentSessionId) {
    const state = getPiSessionStore().getState();
    const directory = state.catalog.byId.get(currentSessionId)?.directory ?? state.directory;
    if (directory) return directory;
  }
  if (newSessionDraft?.open && newSessionDraft.directoryOverride) return newSessionDraft.directoryOverride;
  return useDirectoryStore.getState().currentDirectory ?? undefined;
};

/** Opens a request where it can load. Returns false when this device cannot. */
export const openRequestOnDevice = (
  target: OpenRequestTarget,
  url: string,
  directory: string,
): boolean => {
  if (target === 'external') {
    void openExternalUrl(url);
    return true;
  }
  const ui = useUIStore.getState();
  // A phone layout has no PiChamber browser.
  if (ui.isMobile) return false;
  ui.openContextBrowser(directory, url, { route: resolveDefaultBrowserRoute() });
  return true;
};

/**
 * Opens a web link clicked in chat where the user chose: the PiChamber
 * browser, or the system browser. Phones and pages without a project
 * always use the system browser.
 */
export const openChatLink = (url: string): void => {
  const ui = useUIStore.getState();
  const directory = ui.chatLinkTarget === 'pichamber' && !ui.isMobile ? getDeviceDirectory() : undefined;
  if (!directory) {
    void openExternalUrl(url);
    return;
  }
  ui.openContextBrowser(directory, url, { route: resolveDefaultBrowserRoute() });
};
