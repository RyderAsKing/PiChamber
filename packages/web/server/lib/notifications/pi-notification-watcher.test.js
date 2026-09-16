import { describe, expect, it } from 'vitest';

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
      delivery: { send: async () => undefined },
      retryMs: 1,
    });

    await watcher.start();
    subscriptions[0].onError(new Error('disconnected'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(subscriptions).toHaveLength(2);
    expect(closes).toEqual([1]);
    await watcher.stop();
  });
});
