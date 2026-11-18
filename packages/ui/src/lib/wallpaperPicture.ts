import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isWallpaperImageVersion } from '@/lib/wallpaper';

/**
 * The server's wallpaper picture (`/api/wallpaper-image`). Which picture the
 * clients expect is the `draftWallpaperImageVersion` UI setting; the bytes
 * live on the server so every device shows the same one.
 */

/** Longest side a picture is scaled to before it is sent. */
const WALLPAPER_PICTURE_MAX_PX = 2560;

export type WallpaperPictureSaved = { version: string };

const errorFor = async (response: Response, fallback: string): Promise<Error> => {
  if (response.status === 413) return new Error('The picture is too large');
  if (response.status === 415) return new Error('Only PNG, JPEG and WebP pictures can be used');
  return new Error(fallback);
};

const canvasBlob = (canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/**
 * Decodes `file`, scales it to at most `WALLPAPER_PICTURE_MAX_PX` on its long
 * side, and re-encodes it as WebP (JPEG where the browser cannot write WebP).
 * Throws when the browser cannot read the file as a picture.
 */
async function prepareWallpaperPicture(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That file could not be read as a picture');
  }
  try {
    const ratio = Math.min(1, WALLPAPER_PICTURE_MAX_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('That file could not be read as a picture');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const webp = await canvasBlob(canvas, 'image/webp', 0.86);
    if (webp?.type === 'image/webp') return webp;
    const jpeg = await canvasBlob(canvas, 'image/jpeg', 0.88);
    if (!jpeg) throw new Error('That file could not be read as a picture');
    return jpeg;
  } finally {
    bitmap.close();
  }
}

/** Sends `file` as the server's picture and returns the version it was saved under. */
export async function uploadWallpaperPicture(file: Blob): Promise<WallpaperPictureSaved> {
  const body = await prepareWallpaperPicture(file);
  const response = await runtimeFetch('/api/wallpaper-image', {
    method: 'PUT',
    headers: { 'content-type': body.type },
    body,
  });
  if (!response.ok) throw await errorFor(response, 'The picture could not be saved');
  const saved = (await response.json()) as { version?: unknown };
  if (!isWallpaperImageVersion(saved.version)) throw new Error('The picture could not be saved');
  return { version: saved.version };
}

export async function removeWallpaperPicture(): Promise<void> {
  const response = await runtimeFetch('/api/wallpaper-image', { method: 'DELETE' });
  if (!response.ok) throw await errorFor(response, 'The picture could not be removed');
}

/**
 * The decoded picture for `version`, or null when the server has none (an
 * answer, not a failure). Other failures reject. One picture is kept per
 * runtime, so switching servers or versions fetches again.
 */
let cached: { key: string; picture: Promise<ImageBitmap | null>; settled?: { value: ImageBitmap | null } } | null = null;

export function loadWallpaperPicture(version: string): Promise<ImageBitmap | null> {
  const key = `${getRuntimeKey()}\u0000${version}`;
  if (cached?.key === key) return cached.picture;
  const picture = (async () => {
    const response = await runtimeFetch('/api/wallpaper-image');
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Wallpaper picture unavailable (${response.status})`);
    return createImageBitmap(await response.blob());
  })();
  const entry: NonNullable<typeof cached> = { key, picture };
  cached = entry;
  picture.then(
    (value) => {
      entry.settled = { value };
    },
    // A failed load is not kept, so the next render tries again.
    () => {
      if (cached === entry) cached = null;
    },
  );
  return picture;
}

/**
 * The picture for `version` if it has already loaded, so a remounted
 * wallpaper draws at once instead of blinking out while the promise settles.
 * Undefined when it has not loaded (yet).
 */
export function peekWallpaperPicture(version: string): { value: ImageBitmap | null } | undefined {
  const key = `${getRuntimeKey()}\u0000${version}`;
  return cached?.key === key ? cached.settled : undefined;
}
