import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolvePiChamberDataPath } from '../pichamber-data-dir.js';

const MAX_THEME_BYTES = 1024 * 1024;

export const listPiCustomThemes = async ({
  directory = resolvePiChamberDataPath('themes'),
  fs = { readdir, readFile },
} = {}) => {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const themes = [];
  for (const entry of entries) {
    if (!entry?.isFile?.() || !entry.name.toLowerCase().endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(join(directory, entry.name), 'utf8');
      if (Buffer.byteLength(raw) > MAX_THEME_BYTES) continue;
      const theme = JSON.parse(raw);
      if (theme && typeof theme === 'object' && !Array.isArray(theme)) themes.push(theme);
    } catch {
      // One malformed theme must not hide unrelated valid themes.
    }
  }
  return themes;
};
