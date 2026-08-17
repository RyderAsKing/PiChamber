import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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
      defaultThinkingByModel: { 'provider/model': 'high' },
      smallModel: { providerId: 'provider', modelId: 'small' },
      walkthroughModel: { providerId: 'provider', modelId: 'review' },
    });
    await expect(store.read()).resolves.toMatchObject({ defaultThinkingByModel: { 'provider/model': 'high' } });
    await expect(store.read()).resolves.not.toHaveProperty('defaultThinking');
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

  it('clears a model field when the patch sets it to null', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-settings-'));
    const file = join(root, 'pi', 'settings.json');
    const store = createPiSettingsStore({ file });
    await store.update({ defaultModel: { providerId: 'provider', modelId: 'model' } });
    await expect(store.update({ defaultModel: null })).resolves.toEqual({ version: 1 });
  });

  it('keeps leftover global thinking when no default model is set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-settings-'));
    const file = join(root, 'pi', 'settings.json');
    const store = createPiSettingsStore({ file });
    await expect(store.update({ defaultThinking: 'minimal' })).resolves.toEqual({
      version: 1,
      defaultThinking: 'minimal',
    });
  });

  it('migrates stored global thinking onto the default model on read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-settings-'));
    const file = join(root, 'pi', 'settings.json');
    await mkdir(join(root, 'pi'), { recursive: true });
    await writeFile(file, JSON.stringify({
      version: 1,
      defaultModel: { providerId: 'provider', modelId: 'model' },
      defaultThinking: 'max',
    }));
    const store = createPiSettingsStore({ file });
    await expect(store.read()).resolves.toEqual({
      version: 1,
      defaultModel: { providerId: 'provider', modelId: 'model' },
      defaultThinkingByModel: { 'provider/model': 'max' },
    });
  });

  it('merges per-model thinking without wiping unrelated keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-settings-'));
    const file = join(root, 'pi', 'settings.json');
    const store = createPiSettingsStore({ file });
    await store.update({
      defaultThinkingByModel: { 'provider/a': 'low', 'provider/b': 'high' },
    });
    await expect(store.update({
      defaultThinkingByModel: { 'provider/b': null, 'provider/c': 'medium' },
    })).resolves.toEqual({
      version: 1,
      defaultThinkingByModel: { 'provider/a': 'low', 'provider/c': 'medium' },
    });
  });

  it('rejects an invalid thinking key without erasing the existing map', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-settings-'));
    const file = join(root, 'pi', 'settings.json');
    const store = createPiSettingsStore({ file });
    await store.update({ defaultThinkingByModel: { 'provider/a': 'low' } });
    await expect(store.update({
      defaultThinkingByModel: { nopath: 'high' },
    })).rejects.toMatchObject({ code: 'PI_SETTINGS_INVALID' });
    await expect(store.read()).resolves.toEqual({
      version: 1,
      defaultThinkingByModel: { 'provider/a': 'low' },
    });
  });

  it('clears every thinking default when the map patch is null', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-settings-'));
    const file = join(root, 'pi', 'settings.json');
    const store = createPiSettingsStore({ file });
    await store.update({ defaultThinkingByModel: { 'provider/a': 'low' } });
    await expect(store.update({ defaultThinkingByModel: null })).resolves.toEqual({ version: 1 });
  });
});
