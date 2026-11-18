import React from 'react';

import { loadWallpaperPicture, peekWallpaperPicture } from '@/lib/wallpaperPicture';

/**
 * The server's decoded wallpaper picture for `version`. `picture` is null
 * while it loads, when there is none, when the load failed, or when `version`
 * is null; `pending` is true only while it loads, so a caller can wait rather
 * than draw without it and then redraw.
 */
export function useWallpaperPicture(version: string | null): { picture: ImageBitmap | null; pending: boolean } {
  const [picture, setPicture] = React.useState<{ version: string; bitmap: ImageBitmap | null } | null>(() => {
    const loaded = version ? peekWallpaperPicture(version) : undefined;
    return version && loaded ? { version, bitmap: loaded.value } : null;
  });
  React.useEffect(() => {
    if (!version) return;
    const loaded = peekWallpaperPicture(version);
    if (loaded) {
      setPicture((previous) => (previous?.version === version && previous.bitmap === loaded.value ? previous : { version, bitmap: loaded.value }));
      return;
    }
    let cancelled = false;
    loadWallpaperPicture(version).then(
      (bitmap) => {
        if (!cancelled) setPicture({ version, bitmap });
      },
      (error: unknown) => {
        // Drawn without it; the setting is left as it is, so a later visit retries.
        console.warn('[wallpaper] picture could not be loaded', error);
        if (!cancelled) setPicture({ version, bitmap: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [version]);
  if (!version) return { picture: null, pending: false };
  if (picture?.version !== version) return { picture: null, pending: true };
  return { picture: picture.bitmap, pending: false };
}
