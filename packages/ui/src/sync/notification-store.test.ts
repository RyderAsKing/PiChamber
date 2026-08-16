import { beforeEach, describe, expect, test } from 'bun:test';

import { notifySessionTurnComplete, useNotificationStore } from './notification-store';

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
  beforeEach(() => resetNotifications());

  test('records one unseen complete per session until it is viewed', () => {
    notifySessionTurnComplete('s1', '/repo');
    notifySessionTurnComplete('s1', '/repo');
    expect(useNotificationStore.getState().sessionUnseenCount('s1')).toBe(1);

    useNotificationStore.getState().markSessionViewed('s1');
    expect(useNotificationStore.getState().sessionUnseenCount('s1')).toBe(0);
  });
});
