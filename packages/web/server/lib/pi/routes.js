/**
 * Browser-visible Pi routes deliberately translate the authenticated server
 * boundary to private daemon requests. They never expose local daemon details.
 */

const UNAVAILABLE_CODES = new Set([
  'DAEMON_UNAVAILABLE',
  'DAEMON_AUTH_FAILED',
  'DAEMON_REQUEST_FAILED',
  'DAEMON_TIMEOUT',
  'DAEMON_PROTOCOL_MISMATCH',
  'DAEMON_ENDPOINT_UNVERIFIED',
  'DAEMON_CREDENTIAL_UNAVAILABLE',
  'MALFORMED_SESSION_JSONL',
  'SESSION_JSONL_UNREADABLE',
]);

const writeDaemonError = (res, error) => {
  const code = typeof error?.code === 'string' ? error.code : 'DAEMON_REQUEST_FAILED';
  const status = UNAVAILABLE_CODES.has(code) ? 503 : code === 'INVALID_SESSION' ? 404 : 400;
  res.status(status).json({ error: { code } });
};

const getDaemonRuntime = (getPiSessionDaemonRuntime) => {
  const runtime = getPiSessionDaemonRuntime();
  if (!runtime) {
    const error = new Error('The Pi session daemon is unavailable.');
    error.code = 'DAEMON_UNAVAILABLE';
    throw error;
  }
  return runtime;
};

const protocolMismatch = () => {
  const error = new Error('The Pi session daemon returned an invalid response.');
  error.code = 'DAEMON_PROTOCOL_MISMATCH';
  return error;
};

const projectSession = (value) => {
  if (!value || typeof value !== 'object'
    || typeof value.id !== 'string' || value.id.length === 0
    || typeof value.directory !== 'string' || value.directory.length === 0
    || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)) {
    throw protocolMismatch();
  }
  return {
    id: value.id,
    directory: value.directory,
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.parentId === 'string' || value.parentId === null ? { parentId: value.parentId } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(Number.isSafeInteger(value.messageCount) && value.messageCount >= 0 ? { messageCount: value.messageCount } : {}),
  };
};

const projectSessionList = (sessions) => {
  if (!Array.isArray(sessions)) throw protocolMismatch();
  return sessions.map((item) => {
    if (!item || typeof item !== 'object' || !Number.isFinite(item.updatedAt)) throw protocolMismatch();
    return {
      session: projectSession(item.session),
      ...(typeof item.preview === 'string' ? { preview: item.preview } : {}),
      updatedAt: item.updatedAt,
    };
  });
};

/**
 * Browser-visible Pi runtime and session-collection routes. The authenticated
 * /api middleware is registered by the server composition root before these
 * adapters; this function is mounted before the generic OpenCode proxy.
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

  app.get('/api/pi/sessions', async (req, res) => {
    const directory = req.query.directory;
    if (directory !== undefined && (typeof directory !== 'string' || directory.length === 0)) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }

    try {
      const result = await getDaemonRuntime(getPiSessionDaemonRuntime).request('sessions.list', {
        ...(typeof directory === 'string' ? { directory } : {}),
      });
      res.json({ sessions: projectSessionList(result?.sessions) });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.patch('/api/pi/sessions/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const title = req.body?.title;
    if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof title !== 'string') {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }

    try {
      await getDaemonRuntime(getPiSessionDaemonRuntime).request('sessions.rename', { sessionId, title });
      res.status(204).end();
    } catch (error) {
      writeDaemonError(res, error);
    }
  });

  app.post('/api/pi/sessions', async (req, res) => {
    const input = req.body;
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.cwd !== 'string' || input.cwd.length === 0) {
      res.status(400).json({ error: { code: 'INVALID_ARGUMENT' } });
      return;
    }

    try {
      const result = await getDaemonRuntime(getPiSessionDaemonRuntime).request('sessions.create', input);
      if (!result || typeof result !== 'object' || !Array.isArray(result.messages) || result.messages.length !== 0 || !Number.isSafeInteger(result.lastSequence)) {
        throw protocolMismatch();
      }
      res.status(201).json({
        session: projectSession(result.session),
        messages: [],
        lastSequence: result.lastSequence,
      });
    } catch (error) {
      writeDaemonError(res, error);
    }
  });
};
