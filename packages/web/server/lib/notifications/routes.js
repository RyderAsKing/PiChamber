const text = (value, maxLength) => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : '';
};

export const registerNotificationRoutes = (app, { uiAuthController, delivery }) => {
  const clientId = (req, res) => uiAuthController.ensureSessionToken(req, res);

  app.get('/api/push/vapid-public-key', async (_req, res) => {
    try {
      const keys = await delivery.getOrCreateVapidKeys();
      res.json({ publicKey: keys.publicKey });
    } catch {
      res.status(500).json({ error: 'Push notifications are unavailable' });
    }
  });

  app.post('/api/push/subscribe', async (req, res) => {
    const id = await clientId(req, res);
    if (!id) return;
    const endpoint = text(req.body?.endpoint, 4096);
    const p256dh = text(req.body?.keys?.p256dh, 1024);
    const auth = text(req.body?.keys?.auth, 1024);
    if (!endpoint || !p256dh || !auth) return res.status(400).json({ error: 'Invalid push subscription' });
    await delivery.addWebSubscription(id, {
      endpoint,
      p256dh,
      auth,
      platform: text(req.body?.platform, 32) || undefined,
    });
    res.json({ ok: true });
  });

  app.delete('/api/push/subscribe', async (req, res) => {
    const id = await clientId(req, res);
    if (!id) return;
    const endpoint = text(req.body?.endpoint, 4096);
    if (!endpoint) return res.status(400).json({ error: 'Invalid push subscription' });
    await delivery.removeWebSubscription(id, endpoint);
    res.json({ ok: true });
  });

  app.post('/api/push/apns-token', async (req, res) => {
    const id = await clientId(req, res);
    if (!id) return;
    const token = text(req.body?.token, 4096);
    const platform = req.body?.platform === 'android' ? 'android' : 'ios';
    const environment = req.body?.environment === 'sandbox' ? 'sandbox' : 'production';
    if (!token) return res.status(400).json({ error: 'Invalid native push token' });
    try {
      await delivery.addNativeToken(id, { token, platform, environment });
      res.json({ ok: true });
    } catch {
      res.status(502).json({ error: 'Native push registration failed' });
    }
  });

  app.delete('/api/push/apns-token', async (req, res) => {
    const id = await clientId(req, res);
    if (!id) return;
    const token = text(req.body?.token, 4096);
    if (!token) return res.status(400).json({ error: 'Invalid native push token' });
    await delivery.removeNativeToken(id, token);
    res.json({ ok: true });
  });

  app.post('/api/push/visibility', async (req, res) => {
    const id = await clientId(req, res);
    if (!id) return;
    delivery.updateVisibility(id, req.body?.visible === true, text(req.body?.platform, 32) || undefined);
    res.json({ ok: true });
  });
};
