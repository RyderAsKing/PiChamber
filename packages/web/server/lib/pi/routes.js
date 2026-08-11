/**
 * Browser-visible Pi runtime health is intentionally narrower than the private
 * daemon protocol. It never exposes the local endpoint, credential, pid, or
 * server filesystem paths.
 */
export const registerPiRuntimeRoutes = (app, { getPiSessionDaemonRuntime }) => {
  app.get('/api/pi/runtime', async (_req, res) => {
    const runtime = getPiSessionDaemonRuntime();
    if (!runtime) {
      res.status(503).json({
        protocolVersion: 1,
        state: 'unavailable',
        error: { code: 'DAEMON_UNAVAILABLE' },
      });
      return;
    }

    const health = await runtime.health();
    if (health.state !== 'ready') {
      res.status(503).json({
        protocolVersion: health.protocolVersion,
        state: 'unavailable',
        error: { code: health.error?.code ?? 'DAEMON_UNAVAILABLE' },
      });
      return;
    }
    res.json({
      protocolVersion: health.protocolVersion,
      state: 'ready',
      capabilities: Array.isArray(health.capabilities) ? health.capabilities : [],
    });
  });
};
