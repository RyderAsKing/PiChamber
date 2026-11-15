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

// One daemon's subscription: its own replay cursor (sequence and stream
// epoch are per daemon), retry timer, and close. A subscription that
// resolves after `close()` is closed at once.
const createDaemonConnection = ({ runtime, retryMs, onEvent }) => {
  let closed = false;
  let closeSubscription = null;
  let retryTimer = null;
  let fromSequence;
  let streamEpoch;

  const scheduleReconnect = () => {
    if (closed || retryTimer) return;
    closeSubscription?.();
    closeSubscription = null;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, retryMs);
  };

  const connect = async () => {
    if (closed) return;
    try {
      closeSubscription?.();
      closeSubscription = null;
      const close = await runtime.subscribe({
        ...(Number.isSafeInteger(fromSequence) && streamEpoch ? { fromSequence, streamEpoch } : {}),
        onEvent: (event) => {
          if (typeof event.streamEpoch === 'string') streamEpoch = event.streamEpoch;
          if (Number.isSafeInteger(event.sequence)) fromSequence = event.sequence;
          onEvent(event);
        },
        onError: scheduleReconnect,
      });
      if (closed) close?.();
      else closeSubscription = close;
    } catch {
      scheduleReconnect();
    }
  };

  return {
    runtime,
    connect,
    close: () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      closeSubscription?.();
      closeSubscription = null;
    },
  };
};

/**
 * Watches every live session daemon in `daemonPool` (or the single
 * `supervisor`) and follows daemons as they are registered and removed.
 * One daemon failing only retries that daemon.
 */
export const createPiNotificationWatcher = ({
  supervisor,
  daemonPool = {
    live: () => (supervisor ? [{ key: 'main', runtime: supervisor }] : []),
    onChange: () => () => {},
  },
  uiSettingsStore,
  notify,
  retryMs = 1_000,
  notifyTimeoutMs = 15_000,
}) => {
  let stopped = false;
  let started = false;
  let unsubscribePool = null;
  const connections = new Map();
  let notifyChain = Promise.resolve();

  const tracker = createPiNotificationTracker({
    emit: (payload) => {
      if (typeof notify !== 'function') return;
      notifyChain = notifyChain.then(async () => {
        const settings = await uiSettingsStore.read();
        if (settings.nativeNotificationsEnabled !== true) return;
        if (payload.data.type === 'completion' && settings.notifyOnCompletion === false) return;
        if (payload.data.type === 'error' && settings.notifyOnError === false) return;
        let timeoutId;
        const timeout = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Notification delivery timed out')), notifyTimeoutMs);
          timeoutId.unref?.();
        });
        try {
          await Promise.race([
            notify({
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

  // Bring subscriptions in line with the pool: connect new daemons, close
  // removed ones, and start over (fresh cursor) for a replaced runtime.
  const sync = async () => {
    if (stopped) return;
    const live = new Map(daemonPool.live().map(({ key, runtime }) => [key, runtime]));
    for (const [key, connection] of connections) {
      if (live.get(key) === connection.runtime) continue;
      connection.close();
      connections.delete(key);
    }
    const opening = [];
    for (const [key, runtime] of live) {
      if (connections.has(key)) continue;
      const connection = createDaemonConnection({ runtime, retryMs, onEvent: tracker.accept });
      connections.set(key, connection);
      opening.push(connection.connect());
    }
    await Promise.all(opening);
  };

  return {
    start: async () => {
      if (stopped || started) return;
      started = true;
      unsubscribePool = daemonPool.onChange(() => { void sync(); });
      await sync();
    },
    stop: async () => {
      stopped = true;
      unsubscribePool?.();
      unsubscribePool = null;
      for (const connection of connections.values()) connection.close();
      connections.clear();
      await notifyChain;
    },
  };
};
