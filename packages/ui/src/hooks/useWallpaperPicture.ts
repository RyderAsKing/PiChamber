import React from 'react';

import { loadWallpaperPicture } from '@/lib/wallpaperPicture';

/**
 * The server's decoded wallpaper picture for `version`; null while it loads,
 * when there is none, when the load failed, or when `version` is null.
 */
export function useWallpaperPicture(version: string | null): ImageBitmap | null {
  const [picture, setPicture] = React.useState<{ version: string; bitmap: ImageBitmap | null } | null>(null);
  React.useEffect(() => {
    if (!version) return;
    let cancelled = false;
    loadWallpaperPicture(version).then(
      (bitmap) => {
        if (!cancelled) setPicture({ version, bitmap });
      },
      (error: unknown) => {
        // Nothing is drawn; the setting is left as it is, so a later visit retries.
        console.warn('[wallpaper] picture could not be loaded', error);
        if (!cancelled) setPicture({ version, bitmap: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [version]);
  return version && picture?.version === version ? picture.bitmap : null;
}
