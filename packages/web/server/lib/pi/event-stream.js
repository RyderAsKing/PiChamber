/**
 * Pi event stream connection lifecycle.
 *
 * Owns everything one `/api/pi/events` SSE connection needs to run safely, so
 * the route stays a thin adapter:
 *
 * - Cleanup is installed before `subscribe` is awaited, so a client that
 *   disconnects while the subscription is still opening cannot leak the daemon
 *   subscription; when the late subscription resolves it is closed exactly
 *   once.
 * - Every teardown path (client disconnect, subscription error, server
 *   shutdown) funnels through one idempotent cleanup, so close/end/heartbeat
 *   teardown runs at most once per connection regardless of how many close
 *   events race.
 * - An `AbortSignal` is handed through the supervisor to the IPC client, so
 *   shutdown can cancel a subscription while its daemon socket is opening.
 * - Named heartbeat events are never written to a dead response, and no late
 *   frame is written after cleanup.
 * - The response socket buffer is byte-bounded and enforced BEFORE each
 *   write, so no frame ever overshoots the bound by one huge write. A frame
 *   that would not fit is never written: the stream ends and the client
 *   reconnects from its last accepted sequence, where the daemon replays the
 *   missed suffix or issues an authoritative snapshot. Nothing is silently
 *   removed from an otherwise contiguous stream, but frames that were never
 *   flushed to the socket are NOT promised as delivered — the reconnect
 *   replay is the delivery guarantee.
 * - A stalled reader is always released with a bounded deadline. When a
 *   write returns false, a drain deadline ends the connection even if the
 *   client goes quiet before crossing the byte bound. After `res.end()`, a
 *   terminate deadline destroys the response: `end()` alone only queues the
 *   FIN behind unflushed data, so a client that never reads would hold the
 *   socket (and server shutdown) open forever.
 * - The response `'error'` guard stays attached for the response's lifetime
 *   and is idempotent: cleanup can complete while data is still in flight,
 *   and a late `'error'` with no listener would crash the process.
 * - A healthy client's connection is independent of a slow one.
 */

export const DEFAULT_EVENT_STREAM_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const DEFAULT_EVENT_STREAM_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_EVENT_STREAM_TERMINATE_TIMEOUT_MS = 5_000;

/**
 * Tracks live event stream connections so the server can end all of them
 * (active or still opening) during shutdown.
 */
export const createPiEventStreamRegistry = () => {
  const connections = new Set();
  return {
    get size() {
      return connections.size;
    },
    add: (connection) => {
      connections.add(connection);
    },
    delete: (connection) => {
      connections.delete(connection);
    },
    /** Idempotent per connection: closing twice closes the subscription once. */
    closeAll: () => {
      for (const connection of [...connections]) connection.close();
    },
  };
};

/**
 * Run one SSE event stream connection to completion.
 *
 * The route must have already validated the query, checked the runtime, and
 * flushed the SSE headers. `subscribe` receives `{ onEvent, onError, signal }`
 * and resolves to a close function (or undefined).
 */
export const openPiEventStream = ({
  req,
  res,
  subscribe,
  projectFrame,
  heartbeatMs = 15_000,
  maxBufferedBytes = DEFAULT_EVENT_STREAM_MAX_BUFFERED_BYTES,
  drainTimeoutMs = DEFAULT_EVENT_STREAM_DRAIN_TIMEOUT_MS,
  terminateTimeoutMs = DEFAULT_EVENT_STREAM_TERMINATE_TIMEOUT_MS,
  registry,
  respondWithError,
}) => {
  let closed = false;
  let heartbeat;
  let drainTimer;
  let terminateTimer;
  let subscriptionClose;
  let subscriptionClosed = false;
  const abort = new AbortController();
  const connection = { close: () => endConnection() };

  const closeSubscriptionOnce = (close) => {
    if (subscriptionClosed || typeof close !== 'function') return;
    subscriptionClosed = true;
    try {
      close();
    } catch {
      // A subscriber that throws on close must not break teardown.
    }
  };

  const isDead = () => closed || res.destroyed === true || res.writableEnded === true;

  const clearHeartbeat = () => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };

  const clearDrainTimer = () => {
    if (drainTimer !== undefined) {
      clearTimeout(drainTimer);
      drainTimer = undefined;
    }
  };

  const clearTerminateTimer = () => {
    if (terminateTimer !== undefined) {
      clearTimeout(terminateTimer);
      terminateTimer = undefined;
    }
  };

  function cleanup() {
    if (closed) return;
    closed = true;
    clearHeartbeat();
    clearDrainTimer();
    clearTerminateTimer();
    abort.abort();
    closeSubscriptionOnce(subscriptionClose);
    req.off('close', onGone);
    res.off('close', onResClose);
    res.off('drain', onDrain);
    // The 'error' guard intentionally stays attached: teardown can complete
    // while data is still in flight, and an unhandled late 'error' would
    // crash the process. It is idempotent (cleanup re-enters as a no-op) and
    // dies with the response object.
    registry?.delete(connection);
  }

  const onGone = () => cleanup();
  const onDrain = () => clearDrainTimer();

  const onResClose = () => {
    // The response fully finished (end flushed or destroyed): no further
    // error can occur, so the guard can be detached now. The terminate
    // deadline is cleared even when cleanup already ran (its early return
    // would otherwise leave the timer pending behind a finished response).
    res.off('error', onGone);
    clearTerminateTimer();
    cleanup();
  };

  /**
   * End the stream after teardown so the client reconnects (shutdown, error,
   * backpressure). The response socket may still hold unflushed data for a
   * stalled reader — `res.end()` alone queues the FIN behind it and the
   * socket stays open forever — so a bounded terminate deadline destroys the
   * socket if it does not finish in time.
   */
  const endConnection = () => {
    cleanup();
    if (!res.writableEnded && !res.destroyed) res.end();
    if (!res.destroyed) {
      // `res.end()` alone only queues the FIN behind unflushed data: a
      // stalled reader never receives it, so the socket (and server
      // shutdown) stays open forever. Bound the wait and destroy. The timer
      // is cleared only by the response's 'close' event — 'finish' fires as
      // soon as the data is handed to the socket, which proves nothing about
      // the socket actually releasing.
      terminateTimer = setTimeout(() => {
        terminateTimer = undefined;
        if (!res.destroyed) res.destroy();
      }, terminateTimeoutMs);
    }
  };

  /** Bound the wait for 'drain' after a full socket buffer, even for a client that then goes quiet. */
  const armDrainDeadline = () => {
    if (drainTimer !== undefined) return;
    res.once('drain', onDrain);
    drainTimer = setTimeout(() => {
      drainTimer = undefined;
      res.off('drain', onDrain);
      // A socket that never drains must not hold the connection (and server
      // shutdown) open indefinitely: end it so the client reconnects from its
      // last accepted sequence and the daemon replays or snapshots.
      endConnection();
    }, drainTimeoutMs);
  };

  const write = (chunk) => {
    if (isDead()) return false;
    const size = Buffer.byteLength(chunk);
    // Enforce the byte bound BEFORE writing: a frame that would not fit is
    // never written, so the socket buffer never overshoots the bound by one
    // huge frame. Everything after this point is skipped because cleanup ends
    // the stream, so the client never observes a silently missing frame
    // inside an otherwise contiguous stream — it reconnects from its last
    // accepted sequence and the daemon replays or snapshots.
    if (res.writableLength + size > maxBufferedBytes) {
      endConnection();
      return false;
    }
    const drained = res.write(chunk);
    if (!drained) armDrainDeadline();
    return drained;
  };

  const send = (frame) => {
    if (isDead()) return;
    const event = projectFrame(frame);
    if (event) write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Install cleanup before awaiting subscribe so a disconnect during the
  // opening window cannot leak the daemon subscription.
  req.once('close', onGone);
  res.once('close', onResClose);
  res.on('error', onGone);
  registry?.add(connection);

  void (async () => {
    let attach;
    try {
      attach = await subscribe({
        onEvent: send,
        onError: endConnection,
        signal: abort.signal,
      });
    } catch (error) {
      cleanup();
      if (typeof respondWithError === 'function') respondWithError(error);
      else if (!res.writableEnded && !res.destroyed) res.end();
      return;
    }
    // The client disconnected, the subscription errored, or the server shut
    // down while the subscription was opening: close the late subscription
    // exactly once and never attach a heartbeat to a dead response.
    if (closed) {
      closeSubscriptionOnce(attach);
      return;
    }
    subscriptionClose = attach;

    const sendHeartbeat = () => {
      if (isDead()) return;
      // Named heartbeat events are visible to native EventSource clients.
      // Comment-only SSE heartbeats keep proxies open but are hidden from the
      // EventSource API, so WKWebView cannot use them to detect a silent link.
      write('event: heartbeat\ndata: {}\n\n');
    };
    // Send one immediately so an empty replay still proves the connection is
    // healthy before the client resets its reconnect backoff.
    sendHeartbeat();
    heartbeat = setInterval(sendHeartbeat, heartbeatMs);
  })();

  return {
    get closed() {
      return closed;
    },
    abortSignal: abort.signal,
  };
};
