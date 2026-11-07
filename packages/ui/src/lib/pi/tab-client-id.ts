import { createBrowserUuid } from '@/lib/uuid';

let clientId: string | null = null;

/**
 * Identifies this tab to the daemon for `ctx.ui.custom()` sizing: it goes
 * with prompts (a surface the prompt opens is drawn at this tab's size) and
 * with surface input, Close, and viewport reports (the last client that
 * acted sets the size).
 */
export const getTabClientId = (): string => {
  clientId ??= createBrowserUuid();
  return clientId;
};
