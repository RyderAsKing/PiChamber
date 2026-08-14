import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listPiCustomThemes } from './custom-themes.js';

describe('Pi custom themes', () => {
  it('returns an empty authoritative list when the directory is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-themes-'));
    await expect(listPiCustomThemes({ directory: join(root, 'missing') })).resolves.toEqual([]);
  });

  it('keeps valid themes when another theme is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-themes-'));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'valid.json'), JSON.stringify({ metadata: { id: 'valid' } }));
    await writeFile(join(root, 'broken.json'), '{broken');
    await expect(listPiCustomThemes({ directory: root })).resolves.toEqual([{ metadata: { id: 'valid' } }]);
  });
});
