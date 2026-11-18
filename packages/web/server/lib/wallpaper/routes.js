import { MAX_WALLPAPER_IMAGE_BYTES } from './store.js';

// Authenticated routes (the global `/api` auth gate applies) for the
// new-session wallpaper picture. Which wallpaper shows, and how, is the
// `draftWallpaper*` UI settings; these only hold the picture.

const STATUS_BY_CODE = {
  WALLPAPER_IMAGE_TOO_LARGE: 413,
  WALLPAPER_IMAGE_UNSUPPORTED: 415,
};

const sendError = (res, error) => {
  const status = STATUS_BY_CODE[error?.code];
  if (status) return res.status(status).json({ error: { code: error.code } });
  console.warn('[wallpaper] image request failed', error?.code ?? error);
  return res.status(500).json({ error: { code: 'WALLPAPER_IMAGE_UNAVAILABLE' } });
};

export const registerWallpaperRoutes = (app, { express, store }) => {
  app.get('/api/wallpaper-image', async (_req, res) => {
    try {
      const image = await store.read();
      if (!image) return res.status(404).json({ error: { code: 'WALLPAPER_IMAGE_NOT_FOUND' } });
      res.set({
        'Content-Type': image.type,
        'Cache-Control': 'private, no-cache',
        ETag: `"${image.version}"`,
        'X-Content-Type-Options': 'nosniff',
        'X-Wallpaper-Version': image.version,
      });
      return res.send(image.buffer);
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.put(
    '/api/wallpaper-image',
    express.raw({ type: () => true, limit: MAX_WALLPAPER_IMAGE_BYTES }),
    async (req, res) => {
      try {
        return res.json(await store.write(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)));
      } catch (error) {
        return sendError(res, error);
      }
    },
  );

  app.delete('/api/wallpaper-image', async (_req, res) => {
    try {
      await store.remove();
      return res.status(204).end();
    } catch (error) {
      return sendError(res, error);
    }
  });

  // express.raw reports an oversized body before the handler runs.
  app.use('/api/wallpaper-image', (error, _req, res, next) => {
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'WALLPAPER_IMAGE_TOO_LARGE' } });
    return next(error);
  });
};
