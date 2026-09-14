import { describe, expect, test } from 'bun:test';
import { subscribeToDesktopMenuEvents } from './desktopMenuEvents';

describe('Electron application menu events', () => {
  test('delivers renderer-owned menu actions and update checks through the preload bridge', async () => {
    const listeners = new Map<string, (event: { payload?: unknown }) => void>();
    const removed: string[] = [];
    const receivedActions: string[] = [];
    let updateChecks = 0;
    let miniChats = 0;

    const unsubscribe = await subscribeToDesktopMenuEvents(
      {
        listen: async (event, listener) => {
          listeners.set(event, listener);
          return () => {
            removed.push(event);
            listeners.delete(event);
          };
        },
      },
      {
        onAction: (action) => receivedActions.push(action),
        onCheckForUpdates: () => {
          updateChecks += 1;
        },
        onOpenMiniChat: () => {
          miniChats += 1;
        },
      },
    );

    listeners.get('pichamber:menu-action')?.({ payload: 'settings' });
    listeners.get('pichamber:menu-action')?.({ payload: { invalid: true } });
    listeners.get('pichamber:check-for-updates')?.({});
    listeners.get('pichamber:open-mini-chat')?.({});

    expect(receivedActions).toEqual(['settings']);
    expect(updateChecks).toBe(1);
    expect(miniChats).toBe(1);

    unsubscribe();
    expect(removed.sort()).toEqual([
      'pichamber:check-for-updates',
      'pichamber:menu-action',
      'pichamber:open-mini-chat',
    ]);
    expect(listeners.size).toBe(0);
  });
});
