/**
 * Authenticated Tailscale HTTP API (thin entrypoint — domain logic lives in
 * `service.js`). Route conventions follow `/api/pichamber/tunnel/*`.
 *
 * - GET  /api/pichamber/tailscale/status → status model (shared with the UI)
 * - PUT  /api/pichamber/tailscale/config → `{ enabled?, mode?, httpsPort? }`
 * - POST /api/pichamber/tailscale/retry  → re-run reconciliation
 */

export const registerTailscaleRoutes = (app, { express, tailscaleService, uiAuthController }) => {
  if (!tailscaleService) return;
  const requireAuth = (req, res, next) => uiAuthController.requireAuth(req, res, next);

  app.get('/api/pichamber/tailscale/status', requireAuth, async (_req, res) => {
    try {
      res.json(tailscaleService.getStatus());
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to get Tailscale status' });
    }
  });

  app.put('/api/pichamber/tailscale/config', express.json({ limit: '16kb' }), requireAuth, async (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const patch = {};
      if (Object.hasOwn(body, 'enabled')) patch.enabled = body.enabled;
      if (Object.hasOwn(body, 'mode')) patch.mode = body.mode;
      if (Object.hasOwn(body, 'httpsPort')) patch.httpsPort = body.httpsPort;
      const result = await tailscaleService.setConfig(patch);
      res.json(result);
    } catch (error) {
      const code = error?.code || 'unknown';
      const statusCode = code === 'invalid_config' ? 422 : code === 'auth_required' ? 403 : 500;
      res.status(statusCode).json({ error: error?.message || 'Failed to update Tailscale config', code });
    }
  });

  app.post('/api/pichamber/tailscale/retry', requireAuth, async (_req, res) => {
    try {
      res.json(await tailscaleService.retry());
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Tailscale retry failed' });
    }
  });
};
