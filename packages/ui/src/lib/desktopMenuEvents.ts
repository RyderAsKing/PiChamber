import type { DesktopBridgeGlobal } from './desktopTypes';

type DesktopMenuEventHandlers = {
  onAction: (action: string) => void;
  onCheckForUpdates: () => void;
  onOpenMiniChat?: () => void;
};

const noop = () => undefined;

export async function subscribeToDesktopMenuEvents(
  bridge: Pick<DesktopBridgeGlobal, 'listen'> | null,
  handlers: DesktopMenuEventHandlers,
): Promise<() => void> {
  if (!bridge?.listen) return noop;

  const unsubscribers: Array<() => void> = [];
  try {
    unsubscribers.push(await bridge.listen('pichamber:menu-action', (event) => {
      if (typeof event.payload === 'string') handlers.onAction(event.payload);
    }));
    unsubscribers.push(await bridge.listen('pichamber:check-for-updates', () => {
      handlers.onCheckForUpdates();
    }));
    unsubscribers.push(await bridge.listen('pichamber:open-mini-chat', () => {
      handlers.onOpenMiniChat?.();
    }));
  } catch (error) {
    for (const unsubscribe of unsubscribers) unsubscribe();
    throw error;
  }

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
