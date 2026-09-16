const notificationPayload = (event, kind, title) => ({
  title: kind === 'error' ? 'Work failed' : 'Work completed',
  body: title || 'Open PiChamber to review the session.',
  tag: `pichamber:${kind}:${event.sessionId}:${event.sequence}`,
  data: {
    type: kind,
    sessionId: event.sessionId,
    ...(event.directory ? { directory: event.directory } : {}),
    url: `/?session=${encodeURIComponent(event.sessionId)}`,
  },
});

export const createPiNotificationTracker = ({ emit }) => {
  const activeSessions = new Set();
  const titleBySession = new Map();

  const settle = (event, kind) => {
    if (!activeSessions.delete(event.sessionId)) return;
    emit(notificationPayload(event, kind, titleBySession.get(event.sessionId)));
  };

  const accept = (event) => {
    if (!event || typeof event.sessionId !== 'string') return;
    if (event.name === 'session.snapshot') {
      const snapshot = event.payload?.snapshot;
      if (typeof snapshot?.title === 'string' && snapshot.title.trim()) {
        titleBySession.set(event.sessionId, snapshot.title.trim());
      }
      const active = snapshot?.isStreaming === true
        || snapshot?.lifecycle === 'busy'
        || snapshot?.lifecycle === 'retry';
      if (active) activeSessions.add(event.sessionId);
      else activeSessions.delete(event.sessionId);
      return;
    }
    if (event.name === 'session.updated' && typeof event.payload?.title === 'string') {
      titleBySession.set(event.sessionId, event.payload.title.trim());
      return;
    }
    if (event.name === 'session.deleted') {
      activeSessions.delete(event.sessionId);
      titleBySession.delete(event.sessionId);
      return;
    }
    if (event.name === 'assistant.message.start') {
      activeSessions.add(event.sessionId);
      return;
    }
    if (event.name === 'session.lifecycle') {
      if (event.payload?.state === 'busy' || event.payload?.state === 'retry') {
        activeSessions.add(event.sessionId);
      } else if (event.payload?.state === 'idle') {
        settle(event, 'completion');
      } else if (event.payload?.state === 'error') {
        settle(event, 'error');
      }
      return;
    }
    if (event.name === 'session.error') {
      settle(event, 'error');
      return;
    }
    if (event.name === 'session.interrupted') activeSessions.delete(event.sessionId);
  };

  return { accept };
};

export const createPiNotificationWatcher = ({
  supervisor,
  uiSettingsStore,
  delivery,
  retryMs = 1_000,
  deliveryTimeoutMs = 15_000,
}) => {
  let stopped = false;
  let closeSubscription = null;
  let retryTimer = null;
  let fromSequence;
  let streamEpoch;
  let deliveryChain = Promise.resolve();

  const tracker = createPiNotificationTracker({
    emit: (payload) => {
      deliveryChain = deliveryChain.then(async () => {
        const settings = await uiSettingsStore.read();
        if (settings.nativeNotificationsEnabled !== true) return;
        if (payload.data.type === 'completion' && settings.notifyOnCompletion === false) return;
        if (payload.data.type === 'error' && settings.notifyOnError === false) return;
        let timeoutId;
        const timeout = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Notification delivery timed out')), deliveryTimeoutMs);
          timeoutId.unref?.();
        });
        try {
          await Promise.race([
            delivery.send({
              ...payload,
              kind: payload.data.type,
              sessionId: payload.data.sessionId,
              directory: payload.data.directory,
              requireHidden: settings.notificationMode !== 'always',
            }),
            timeout,
          ]);
        } finally {
          clearTimeout(timeoutId);
        }
      }).catch((error) => {
        console.warn(`[Notifications] delivery failed: ${error?.message ?? 'unknown error'}`);
      });
    },
  });

  const scheduleReconnect = () => {
    if (stopped || retryTimer) return;
    closeSubscription?.();
    closeSubscription = null;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, retryMs);
  };

  const connect = async () => {
    if (stopped) return;
    try {
      closeSubscription?.();
      closeSubscription = await supervisor.subscribe({
        ...(Number.isSafeInteger(fromSequence) && streamEpoch ? { fromSequence, streamEpoch } : {}),
        onEvent: (event) => {
          if (typeof event.streamEpoch === 'string') streamEpoch = event.streamEpoch;
          if (Number.isSafeInteger(event.sequence)) fromSequence = event.sequence;
          tracker.accept(event);
        },
        onError: scheduleReconnect,
      });
    } catch {
      scheduleReconnect();
    }
  };

  return {
    start: connect,
    stop: async () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      closeSubscription?.();
      closeSubscription = null;
      await deliveryChain;
    },
  };
};
