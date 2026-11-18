import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileAtomic } from '../fs/atomic-write.js';

/** The UI scales pictures down before sending, so this only stops abuse. */
export const MAX_WALLPAPER_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_FILE = 'image';
const META_FILE = 'image.json';

const wallpaperError = (code, message) => Object.assign(new Error(message), { code });

/** Image type from the file's first bytes; the client's Content-Type is not trusted. */
export const sniffImageType = (buffer) => {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
};

const isMeta = (value) => value !== null
  && typeof value === 'object'
  && typeof value.version === 'string'
  && /^[0-9a-f]{16}$/.test(value.version)
  && ['image/png', 'image/jpeg', 'image/webp'].includes(value.type);

/**
 * The server's one wallpaper picture, in `<dataDir>/wallpaper/`. Every
 * client of the server shows the same one. `version` is a hash of the bytes,
 * so clients can tell a new picture from a cached one.
 */
export const createWallpaperImageStore = ({ dataDir }) => {
  const dir = join(dataDir, 'wallpaper');
  const imagePath = join(dir, IMAGE_FILE);
  const metaPath = join(dir, META_FILE);

  const readMeta = async () => {
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      return isMeta(meta) ? { version: meta.version, type: meta.type } : null;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      // A torn or hand-edited file reads as no picture rather than failing every request.
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  };

  return {
    /** `{ version, type, buffer }`, or null when there is no picture. */
    async read() {
      const meta = await readMeta();
      if (!meta) return null;
      try {
        const buffer = await readFile(imagePath);
        // The picture was replaced between the two reads; the newer write wins next time.
        if (createHash('sha256').update(buffer).digest('hex').slice(0, 16) !== meta.version) return null;
        return { ...meta, buffer };
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    },

    /** Saves `buffer` as the picture and returns its `{ version, type }`. */
    async write(buffer) {
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw wallpaperError('WALLPAPER_IMAGE_UNSUPPORTED', 'Empty image');
      if (buffer.length > MAX_WALLPAPER_IMAGE_BYTES) throw wallpaperError('WALLPAPER_IMAGE_TOO_LARGE', 'Image is too large');
      const type = sniffImageType(buffer);
      if (!type) throw wallpaperError('WALLPAPER_IMAGE_UNSUPPORTED', 'Only PNG, JPEG and WebP images are accepted');
      const version = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // Picture first, then the record naming it: a crash between the two
      // leaves the old record, which no longer matches and reads as none.
      await writeFileAtomic(imagePath, buffer);
      await writeFileAtomic(metaPath, `${JSON.stringify({ version, type })}\n`);
      return { version, type };
    },

    async remove() {
      await rm(metaPath, { force: true });
      await rm(imagePath, { force: true });
    },
  };
};
