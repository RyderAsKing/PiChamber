// Authenticated marketplace routes (the global `/api` auth gate applies).
// They read npm and the featured list only; installing goes through the
// daemon (`POST /api/pi/extensions/packages`, see ../pi/routes.js).

const STATUS_BY_CODE = {
  INVALID_MARKETPLACE_REQUEST: 400,
  MARKETPLACE_PACKAGE_NOT_FOUND: 404,
  MARKETPLACE_UNAVAILABLE: 502,
};

const sendError = (res, error) => {
  const code = Object.hasOwn(STATUS_BY_CODE, error?.code) ? error.code : 'MARKETPLACE_UNAVAILABLE';
  if (code === 'MARKETPLACE_UNAVAILABLE') console.warn('[marketplace] request failed', error?.message ?? error);
  res.status(STATUS_BY_CODE[code]).json({ error: { code } });
};

const badRequest = (res) => res.status(400).json({ error: { code: 'INVALID_MARKETPLACE_REQUEST' } });

const optionalString = (value, max) => value === undefined || (typeof value === 'string' && value.length <= max);

export const registerMarketplaceRoutes = (app, { service }) => {
  // `?q=` search text, `?from=` npm offset, `?pichamber=1` PiChamber-ready only.
  app.get('/api/pi/marketplace/search', async (req, res) => {
    const { q, from, pichamber } = req.query ?? {};
    if (!optionalString(q, 500) || !optionalString(from, 8) || !optionalString(pichamber, 1)) return badRequest(res);
    const offset = from === undefined ? 0 : Number(from);
    if (!Number.isInteger(offset) || offset < 0) return badRequest(res);
    try {
      res.json(await service.search({ query: q ?? '', from: offset, pichamberOnly: pichamber === '1' }));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/pi/marketplace/featured', async (_req, res) => {
    try {
      res.json(await service.featured());
    } catch (error) {
      sendError(res, error);
    }
  });

  // A query parameter, since scoped names carry a slash.
  app.get('/api/pi/marketplace/package', async (req, res) => {
    const { name } = req.query ?? {};
    if (typeof name !== 'string' || name.length > 214) return badRequest(res);
    try {
      res.json(await service.packageDetail(name));
    } catch (error) {
      sendError(res, error);
    }
  });

  // `?names=a,b`: latest versions, for update checks on installed packages.
  app.get('/api/pi/marketplace/versions', async (req, res) => {
    const { names } = req.query ?? {};
    if (typeof names !== 'string' || names.length > 12_000) return badRequest(res);
    try {
      res.json(await service.versions(names.length === 0 ? [] : names.split(',')));
    } catch (error) {
      sendError(res, error);
    }
  });
};
