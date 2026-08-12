import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createPiSettingsStore } from './settings-store.js';

describe('Pi settings sidecar', () => {
  it('round-trips PiChamber defaults without mixing them into Pi settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-settings-'));
    const piSettings = join(root, 'agent-settings.json');
    const file = join(root, 'pi', 'settings.json');
    await writeFile(piSettings, JSON.stringify({ defaultProvider: 'pi-owned' }));
    const store = createPiSettingsStore({ file });

    await expect(store.update({
      defaultModel: { providerId: 'provider', modelId: 'model' },
      defaultThinking: 'high',
      smallModel: { providerId: 'provider', modelId: 'small' },
      walkthroughModel: { providerId: 'provider', modelId: 'review' },
    })).resolves.toEqual({
      version: 1,
      defaultModel: { providerId: 'provider', modelId: 'model' },
      defaultThinking: 'high',
      smallModel: { providerId: 'provider', modelId: 'small' },
      walkthroughModel: { providerId: 'provider', modelId: 'review' },
    });
    await expect(store.read()).resolves.toMatchObject({ defaultThinking: 'high' });
    await expect(readFile(piSettings, 'utf8')).resolves.toBe(JSON.stringify({ defaultProvider: 'pi-owned' }));
  });

  it('keeps malformed sidecar state explicit rather than treating it as defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-settings-'));
    const file = join(root, 'pi', 'settings.json');
    const store = createPiSettingsStore({ file });
    await store.update({ defaultThinking: 'medium' });
    await writeFile(file, '{not json');
    await expect(store.read()).rejects.toMatchObject({ code: 'PI_SETTINGS_INVALID' });
  });
});
