import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { NotificationPayload } from '@/lib/api/types';
import { useUIStore } from '@/stores/useUIStore';
import {
  dispatchInputNeededNotification,
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
    notifyOnInputNeeded: useUIStore.getState().notifyOnInputNeeded,
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

  test('dispatches input-needed notifications with fixed titles and since-scoped tags', async () => {
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
      notifyOnInputNeeded: true,
    });

    dispatchInputNeededNotification({
      sessionId: 's1', directory: '/repo', since: 111, kind: 'input', title: 'Fix notifications',
    });
    dispatchInputNeededNotification({
      sessionId: 's1', directory: '/repo', since: 222, kind: 'approval', title: 'Fix notifications',
    });
    await Promise.resolve();

    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.title).toBe('Input needed');
    expect(payloads[0]?.body).toBe('Fix notifications');
    expect(payloads[0]?.tag).toBe('pichamber:input:s1:111');
    expect(payloads[0]?.kind).toBe('input');
    expect(payloads[0]?.requireHidden).toBe(true);
    expect(payloads[1]?.title).toBe('Approval needed');
    expect(payloads[1]?.tag).toBe('pichamber:input:s1:222');
  });

  test('input-needed dispatch respects gates and falls back without a title', async () => {
    const payloads: Array<NotificationPayload | undefined> = [];
    registerRuntimeAPIs({
      notifications: {
        notify: async (payload: NotificationPayload | undefined) => {
          payloads.push(payload);
          return true;
        },
      },
    } as never);

    useUIStore.setState({ nativeNotificationsEnabled: false, notifyOnInputNeeded: true });
    dispatchInputNeededNotification({ sessionId: 's1', since: 1, kind: 'input' });
    expect(payloads).toHaveLength(0);

    useUIStore.setState({ nativeNotificationsEnabled: true, notifyOnInputNeeded: false });
    dispatchInputNeededNotification({ sessionId: 's1', since: 1, kind: 'input' });
    expect(payloads).toHaveLength(0);

    // Absent (undefined) behaves like the default true.
    useUIStore.setState({ nativeNotificationsEnabled: true, notifyOnInputNeeded: undefined as never });
    dispatchInputNeededNotification({ sessionId: 's1', since: 1, kind: 'input', title: '  ' });
    await Promise.resolve();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.body).toBe('Open PiChamber to answer.');

    useUIStore.setState({ nativeNotificationsEnabled: true, notificationMode: 'always', notifyOnInputNeeded: true });
    dispatchInputNeededNotification({ sessionId: 's2', since: 2, kind: 'input', title: 'T' });
    await Promise.resolve();
    expect(payloads).toHaveLength(2);
    expect(payloads[1]?.requireHidden).toBe(false);
  });
});
