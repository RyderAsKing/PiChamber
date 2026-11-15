/**
 * Public sandbox routes (#242 "Public API"). Responses carry launcher ids,
 * versions, stable reason codes and the project's own settings; never server
 * paths, PIDs, credentials or raw launcher output.
 *
 *   GET  /api/pi/sandbox                      launcher status
 *   POST /api/pi/sandbox/recheck              probe the launcher again
 *   GET  /api/pi/sandbox/projects             every project's sandbox state
 *   PUT  /api/pi/sandbox/projects/:projectId  save one project's setting
 */
export const registerPiSandboxRoutes = (app, { sandboxManager }) => {
  const fail = (res, error) => {
    const code = typeof error?.code === 'string' ? error.code : 'SANDBOX_REQUEST_FAILED';
    const status = code === 'INVALID_SANDBOX_SETTING' ? 400 : code === 'PROJECT_NOT_FOUND' ? 404 : 500;
    if (status === 500) console.warn('[pi-sandbox] request failed', code);
    res.status(status).json({ error: { code: status === 500 ? 'SANDBOX_REQUEST_FAILED' : code } });
  };

  app.get('/api/pi/sandbox', async (_req, res) => {
    try {
      res.json({ launchers: await sandboxManager.launcherStatus() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/pi/sandbox/recheck', async (_req, res) => {
    try {
      res.json({ launchers: await sandboxManager.launcherStatus({ recheck: true }) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/api/pi/sandbox/projects', async (_req, res) => {
    try {
      res.json({ projects: await sandboxManager.listProjects() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.put('/api/pi/sandbox/projects/:projectId', async (req, res) => {
    try {
      const project = await sandboxManager.setProjectSandbox(req.params.projectId, req.body);
      res.json({ project });
    } catch (error) {
      fail(res, error);
    }
  });
};
