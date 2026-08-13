const EVENT_STREAM_HEARTBEAT_MS = 25_000;

/**
 * Registers the low-frequency PiChamber session-control event stream.
 *
 * CLI/control-created sessions use it to refresh their owning directory and
 * worktree topology.
 */
export const registerPiChamberSessionEventRoutes = (app, { getPiChamberEventClients, writeSseEvent }) => {
  app.get('/api/openchamber/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const clients = getPiChamberEventClients();
    clients.add(res);

    try {
      writeSseEvent(res, {
        type: 'openchamber:event-stream-ready',
        properties: { connectedAt: Date.now() },
      });
    } catch {
      clients.delete(res);
      return;
    }

    const heartbeat = setInterval(() => {
      try {
        writeSseEvent(res, {
          type: 'openchamber:heartbeat',
          properties: { timestamp: Date.now() },
        });
      } catch {
        clearInterval(heartbeat);
        clients.delete(res);
      }
    }, EVENT_STREAM_HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  });
};
