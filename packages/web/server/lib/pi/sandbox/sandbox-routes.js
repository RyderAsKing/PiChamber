/**
 * Public sandbox routes (#242 "Public API"). Responses carry launcher ids,
 * versions, stable reason codes and the project's own settings; never PIDs,
 * credentials or the data folder's layout. The profile routes are the one
 * exception to "no server paths, no launcher output": the owner asked where
 * the profile is so they can edit it, and a refused profile comes back with
 * what nono said is wrong with it.
 *
 *   GET  /api/pi/sandbox                      launcher status
 *   POST /api/pi/sandbox/recheck              probe the launcher again
 *   GET  /api/pi/sandbox/projects             every project's sandbox state
 *   PUT  /api/pi/sandbox/projects/:projectId  save one project's setting
 *   GET  /api/pi/sandbox/defaults             the host's sandbox default
 *   PUT  /api/pi/sandbox/defaults             save it and apply it
 *   GET    /api/pi/sandbox/profile            the launcher profile in use
 *   PUT    /api/pi/sandbox/profile            save `{ content }` as the custom profile
 *   DELETE /api/pi/sandbox/profile            back to the built-in profile
 */
export const registerPiSandboxRoutes = (app, { sandboxManager }) => {
  const fail = (res, error) => {
    const code = typeof error?.code === 'string' ? error.code : 'SANDBOX_REQUEST_FAILED';
    const status = code === 'INVALID_SANDBOX_SETTING' || code === 'INVALID_SANDBOX_PROFILE' ? 400 : code === 'PROJECT_NOT_FOUND' ? 404 : 500;
    if (status === 500) console.warn('[pi-sandbox] request failed', code);
    const reason = status === 400 && typeof error?.reason === 'string' && /^[A-Z][A-Z_]{1,31}$/.test(error.reason) ? error.reason : undefined;
    const messages = code === 'INVALID_SANDBOX_PROFILE' && Array.isArray(error?.messages)
      ? error.messages.filter((message) => typeof message === 'string')
      : undefined;
    res.status(status).json({
      error: {
        code: status === 500 ? 'SANDBOX_REQUEST_FAILED' : code,
        ...(reason ? { reason } : {}),
        ...(messages ? { messages } : {}),
      },
    });
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

  app.get('/api/pi/sandbox/defaults', async (_req, res) => {
    try {
      res.json({ defaults: await sandboxManager.sandboxDefaults() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.put('/api/pi/sandbox/defaults', async (req, res) => {
    try {
      const defaults = await sandboxManager.setSandboxDefaults(req.body);
      res.json({ defaults, projects: await sandboxManager.listProjects() });
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

  app.get('/api/pi/sandbox/profile', async (_req, res) => {
    try {
      res.json({ profile: await sandboxManager.sandboxProfile() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.put('/api/pi/sandbox/profile', async (req, res) => {
    try {
      res.json({ profile: await sandboxManager.setSandboxProfile(req.body?.content) });
    } catch (error) {
      fail(res, error);
    }
  });

  app.delete('/api/pi/sandbox/profile', async (_req, res) => {
    try {
      res.json({ profile: await sandboxManager.resetSandboxProfile() });
    } catch (error) {
      fail(res, error);
    }
  });
};
