import { describe, expect, it, vi } from 'vitest';

import { createPiNotificationTracker, createPiNotificationWatcher } from './pi-notification-watcher.js';

const event = (name, sequence, payload = {}, sessionId = 'session-1') => ({
  protocolVersion: 1,
  kind: 'event',
  name,
  sequence,
  streamEpoch: 'epoch-1',
  sessionId,
  directory: '/repo',
  payload,
});

describe('Pi notification tracker', () => {
  it('notifies once when active work completes', () => {
    const notifications = [];
    const tracker = createPiNotificationTracker({ emit: (payload) => notifications.push(payload) });

    tracker.accept(event('session.lifecycle', 1, { state: 'busy' }));
    tracker.accept(event('assistant.message.start', 2, { messageId: 'm1' }));
    tracker.accept(event('session.lifecycle', 3, { state: 'idle' }));
    tracker.accept(event('session.lifecycle', 4, { state: 'idle' }));

    expect(notifications).toEqual([expect.objectContaining({
      title: 'Work completed',
      tag: 'pichamber:completion:session-1:3',
    })]);
  });

  it('collapses message and lifecycle error boundaries into one notification', () => {
    const notifications = [];
    const tracker = createPiNotificationTracker({ emit: (payload) => notifications.push(payload) });

    tracker.accept(event('session.lifecycle', 1, { state: 'busy' }));
    tracker.accept(event('session.error', 2, { code: 'ASSISTANT_ERROR', message: 'limit reached' }));
    tracker.accept(event('session.lifecycle', 3, { state: 'error' }));

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual(expect.objectContaining({
      title: 'Work failed',
      tag: 'pichamber:error:session-1:2',
    }));
  });

  it('does not notify for interrupted work or settled bootstrap snapshots', () => {
    const notifications = [];
    const tracker = createPiNotificationTracker({ emit: (payload) => notifications.push(payload) });

    tracker.accept(event('session.snapshot', 1, { snapshot: { lifecycle: 'idle', isStreaming: false } }));
    tracker.accept(event('session.lifecycle', 2, { state: 'busy' }));
    tracker.accept(event('session.interrupted', 3, { reason: 'user-abort', streaming: true }));
    tracker.accept(event('session.lifecycle', 4, { state: 'idle' }));

    expect(notifications).toEqual([]);
  });

  it('closes a failed subscription before reconnecting', async () => {
    const closes = [];
    const subscriptions = [];
    const supervisor = {
      subscribe: async (options) => {
        subscriptions.push(options);
        const close = () => closes.push(subscriptions.length);
        return close;
      },
    };
    const watcher = createPiNotificationWatcher({
      supervisor,
      uiSettingsStore: { read: async () => ({}) },
      notify: async () => undefined,
      retryMs: 1,
    });

    await watcher.start();
    subscriptions[0].onError(new Error('disconnected'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(subscriptions).toHaveLength(2);
    expect(closes).toEqual([1]);
    await watcher.stop();
  });

  it('delivers terminal completions to the desktop callback with the desktop payload', async () => {
    const seen = [];
    let onEvent;
    const supervisor = {
      subscribe: async (options) => {
        onEvent = options.onEvent;
        return () => {};
      },
    };
    const watcher = createPiNotificationWatcher({
      supervisor,
      uiSettingsStore: { read: async () => ({ nativeNotificationsEnabled: true }) },
      notify: async (payload) => { seen.push(payload); },
      retryMs: 1,
    });

    await watcher.start();
    onEvent(event('session.lifecycle', 1, { state: 'busy' }));
    onEvent(event('session.lifecycle', 2, { state: 'idle' }));
    await watcher.stop();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      title: 'Work completed',
      kind: 'completion',
      sessionId: 'session-1',
      requireHidden: true,
    });
  });

  it('gates desktop delivery on the notification settings', async () => {
    for (const settings of [
      { nativeNotificationsEnabled: false },
      { nativeNotificationsEnabled: true, notifyOnCompletion: false },
    ]) {
      const seen = [];
      let onEvent;
      const supervisor = {
        subscribe: async (options) => {
          onEvent = options.onEvent;
          return () => {};
        },
      };
      const watcher = createPiNotificationWatcher({
        supervisor,
        uiSettingsStore: { read: async () => settings },
        notify: async (payload) => { seen.push(payload); },
        retryMs: 1,
      });

      await watcher.start();
      onEvent(event('session.lifecycle', 1, { state: 'busy' }));
      onEvent(event('session.lifecycle', 2, { state: 'idle' }));
      await watcher.stop();

      expect(seen).toEqual([]);
    }
  });

  it('catches desktop callback failures instead of breaking the watcher', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let onEvent;
    const supervisor = {
      subscribe: async (options) => {
        onEvent = options.onEvent;
        return () => {};
      },
    };
    const watcher = createPiNotificationWatcher({
      supervisor,
      uiSettingsStore: { read: async () => ({ nativeNotificationsEnabled: true }) },
      notify: async () => { throw new Error('native bridge exploded'); },
      retryMs: 1,
    });

    try {
      await watcher.start();
      onEvent(event('session.lifecycle', 1, { state: 'busy' }));
      onEvent(event('session.lifecycle', 2, { state: 'idle' }));
      await watcher.stop();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[Notifications] delivery failed'));
    } finally {
      warn.mockRestore();
    }
  });
});
