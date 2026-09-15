import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { NotificationPayload } from '@/lib/api/types';
import { useUIStore } from '@/stores/useUIStore';
import {
  dispatchSessionNotification,
  notifySessionTurnComplete,
  useNotificationStore,
} from './notification-store';

const resetNotifications = () => {
  useNotificationStore.setState({
    list: [],
    index: {
      session: { unseenCount: {}, unseenHasError: {} },
      project: { unseenCount: {}, unseenHasError: {} },
    },
  });
};

describe('session turn-complete notifications', () => {
  const originalSettings = {
    nativeNotificationsEnabled: useUIStore.getState().nativeNotificationsEnabled,
    notificationMode: useUIStore.getState().notificationMode,
    notifyOnCompletion: useUIStore.getState().notifyOnCompletion,
    notifyOnError: useUIStore.getState().notifyOnError,
  };

  beforeEach(() => resetNotifications());
  afterEach(() => {
    registerRuntimeAPIs(null);
    useUIStore.setState(originalSettings);
  });

  test('records one unseen complete per session until it is viewed', () => {
    notifySessionTurnComplete('s1', '/repo');
    notifySessionTurnComplete('s1', '/repo');
    expect(useNotificationStore.getState().sessionUnseenCount('s1')).toBe(1);

    useNotificationStore.getState().markSessionViewed('s1');
    expect(useNotificationStore.getState().sessionUnseenCount('s1')).toBe(0);
  });

  test('records terminal errors as error attention', () => {
    notifySessionTurnComplete('s1', '/repo', {
      error: { code: 'ASSISTANT_ERROR', message: 'limit reached' },
    });

    expect(useNotificationStore.getState().sessionUnseenCount('s1')).toBe(1);
    expect(useNotificationStore.getState().sessionHasError('s1')).toBe(true);
  });

  test('dispatches enabled completion and error notifications with event-stable tags', async () => {
    const payloads: Array<NotificationPayload | undefined> = [];
    registerRuntimeAPIs({
      notifications: {
        notify: async (payload: NotificationPayload | undefined) => {
          payloads.push(payload);
          return true;
        },
      },
    } as never);
    useUIStore.setState({
      nativeNotificationsEnabled: true,
      notificationMode: 'hidden-only',
      notifyOnCompletion: true,
      notifyOnError: true,
    });

    dispatchSessionNotification({
      sessionId: 's1', directory: '/repo', sequence: 8, title: 'Fix notifications', kind: 'completion',
    });
    dispatchSessionNotification({
      sessionId: 's1', directory: '/repo', sequence: 9, title: 'Fix notifications', kind: 'error',
    });
    await Promise.resolve();

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.title).toBe('Work completed');
    expect(payloads[0]?.tag).toBe('pichamber:completion:s1:8');
    expect(payloads[0]?.requireHidden).toBe(true);
    expect(payloads[1]?.title).toBe('Work failed');
    expect(payloads[1]?.tag).toBe('pichamber:error:s1:9');
    expect(payloads[1]?.requireHidden).toBe(true);
  });
});
