// Authenticated public plugin routes (the global `/api` auth gate applies).
// Each mutation tells `onChange` after the store commits; the daemon push
// behind it never delays or fails the request.

const STATUS_BY_CODE = {
  PLUGIN_NOT_FOUND: 404,
  INVALID_PLUGIN_REQUEST: 400,
  PLUGINS_UNREADABLE: 500,
};

const sendError = (res, error) => {
  const code = Object.hasOwn(STATUS_BY_CODE, error?.code) ? error.code : 'PLUGINS_UNREADABLE';
  if (code === 'PLUGINS_UNREADABLE' && error?.code !== 'PLUGINS_UNREADABLE') {
    console.warn('[plugins] request failed', error?.code ?? error?.message ?? error);
  }
  res.status(STATUS_BY_CODE[code]).json({ error: { code } });
};

const badRequest = (res) => res.status(400).json({ error: { code: 'INVALID_PLUGIN_REQUEST' } });
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const registerPluginRoutes = (app, { service, onChange = () => {} }) => {
  const changed = () => {
    try {
      onChange();
    } catch (error) {
      console.warn('[plugins] change notification failed', error?.message ?? error);
    }
  };

  app.get('/api/pi/plugins', async (req, res) => {
    const { directory } = req.query ?? {};
    if (directory !== undefined && typeof directory !== 'string') return badRequest(res);
    try {
      res.json({ plugins: await service.list({ directory }) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/pi/plugins/:id', async (req, res) => {
    if (!isRecord(req.body) || typeof req.body.enabled !== 'boolean') return badRequest(res);
    try {
      const view = await service.setEnabled(req.params.id, req.body.enabled);
      changed();
      res.json(view);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/pi/plugins/sessions/:sessionId', async (req, res) => {
    try {
      res.json(await service.sessionState(req.params.sessionId));
    } catch (error) {
      sendError(res, error);
    }
  });

  // A composer switch: one session's own value. `value: null` clears it, so
  // the session follows the plugin's settings again.
  app.put('/api/pi/plugins/:id/sessions/:sessionId', async (req, res) => {
    const body = req.body;
    if (!isRecord(body) || typeof body.key !== 'string'
      || (body.value !== null && typeof body.value !== 'boolean' && typeof body.value !== 'string')) {
      return badRequest(res);
    }
    try {
      const result = await service.setSessionState(req.params.id, req.params.sessionId, { key: body.key, value: body.value });
      changed();
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.put('/api/pi/plugins/:id/state', async (req, res) => {
    const body = req.body;
    if (!isRecord(body) || typeof body.key !== 'string'
      || (typeof body.value !== 'boolean' && typeof body.value !== 'string')
      || (body.directory !== undefined && typeof body.directory !== 'string')) {
      return badRequest(res);
    }
    try {
      const view = await service.setState(req.params.id, { key: body.key, value: body.value, directory: body.directory });
      changed();
      res.json(view);
    } catch (error) {
      sendError(res, error);
    }
  });
};
