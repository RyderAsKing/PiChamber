import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPiModelConfigStore } from './model-config-store.js';

const createStore = async (providers = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-models-'));
  const file = join(root, 'models.json');
  await writeFile(file, JSON.stringify({ providers }));
  return { file, store: createPiModelConfigStore({ file }) };
};

const customProvider = (models = []) => ({
  name: 'Custom',
  baseUrl: 'https://api.example.test/v1',
  api: 'openai-completions',
  models,
});

describe('Pi models configuration store', () => {
  it('writes supported custom-provider model fields without exposing credentials', async () => {
    const { file, store } = await createStore({ builtin: { baseUrl: 'https://proxy.test', api: 'openai-completions' } });
    await expect(store.update({
      providerId: 'custom-provider',
      label: 'Custom Provider',
      baseUrl: 'https://api.example.test/v1',
      models: [{
        id: 'model-1', name: 'Model 1', contextWindow: 128_000, maxTokens: 8_192,
        reasoning: true, input: ['text', 'image'], thinkingLevelMap: { high: 'high-effort' },
      }],
      headers: { 'X-Client': 'PiChamber' },
      apiKeyReference: '{env:CUSTOM_API_KEY}',
    })).resolves.toMatchObject({ providerId: 'custom-provider', models: [{ id: 'model-1', label: 'Model 1' }] });

    const persisted = JSON.parse(await readFile(file, 'utf8'));
    expect(persisted.providers.builtin).toEqual({ baseUrl: 'https://proxy.test', api: 'openai-completions' });
    expect(persisted.providers['custom-provider'].models[0]).toEqual({
      id: 'model-1', name: 'Model 1', reasoning: true,
      thinkingLevelMap: { high: 'high-effort' }, input: ['text', 'image'],
      contextWindow: 128_000, maxTokens: 8_192,
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(await store.get('custom-provider'))).not.toContain('CUSTOM_API_KEY');
    expect(JSON.stringify(await store.get('custom-provider'))).not.toContain('X-Client');
  });

  it('preserves unexposed existing model metadata during provider edits', async () => {
    const { file, store } = await createStore({ custom: customProvider([{
      id: 'model-1', name: 'Old', maxTokens: 4096,
      api: 'openai-responses', baseUrl: 'https://override.test',
      headers: { 'X-Secret': 'value' }, compat: { supportsStrictMode: true },
      cost: { input: 1 }, samplingParams: { temperature: 0.2 }, customMetadata: true,
    }]) });

    await store.update({
      providerId: 'custom', label: 'Custom', baseUrl: 'https://api.example.test/v1', api: 'openai-completions',
      models: [{ id: 'model-1', name: 'Edited', maxTokens: 8192 }],
    });

    const model = JSON.parse(await readFile(file, 'utf8')).providers.custom.models[0];
    expect(model).toEqual({
      id: 'model-1', name: 'Edited', maxTokens: 8192,
      api: 'openai-responses', baseUrl: 'https://override.test',
      headers: { 'X-Secret': 'value' }, compat: { supportsStrictMode: true },
      cost: { input: 1 }, samplingParams: { temperature: 0.2 }, customMetadata: true,
    });
    expect(JSON.stringify(await store.get('custom'))).not.toContain('X-Secret');
  });

  it('appends one supported model while preserving providers and metadata', async () => {
    const existing = customProvider([{ id: 'model-1', name: 'Model 1', cost: { input: 1 } }]);
    existing.customMetadata = true;
    const { file, store } = await createStore({ custom: existing, other: customProvider([{ id: 'other' }]) });

    await expect(store.addModel({
      providerId: 'custom',
      model: { id: ' model-2 ', name: ' Model 2 ', contextWindow: 32_000 },
    })).resolves.toMatchObject({ providerId: 'custom', models: [{ id: 'model-1' }, { id: 'model-2' }] });

    const persisted = JSON.parse(await readFile(file, 'utf8'));
    expect(persisted.providers.custom.models).toEqual([
      { id: 'model-1', name: 'Model 1', cost: { input: 1 } },
      { id: 'model-2', name: 'Model 2', contextWindow: 32_000 },
    ]);
    expect(persisted.providers.custom.customMetadata).toBe(true);
    expect(persisted.providers.other.models).toEqual([{ id: 'other' }]);
  });

  it('rejects duplicate model IDs without writing', async () => {
    const { file, store } = await createStore({ custom: customProvider([{ id: 'model-1' }]) });
    const before = await readFile(file, 'utf8');
    await expect(store.addModel({ providerId: 'custom', model: { id: ' model-1 ' } }))
      .rejects.toMatchObject({ code: 'PI_MODEL_DUPLICATE' });
    await expect(readFile(file, 'utf8')).resolves.toBe(before);
  });

  it('serializes concurrent duplicate additions', async () => {
    const { file, store } = await createStore({ custom: customProvider([]) });
    const first = store.addModel({ providerId: 'custom', model: { id: 'model-2' } });
    const second = store.addModel({ providerId: 'custom', model: { id: ' model-2 ' } });
    await expect(first).resolves.toBeTruthy();
    await expect(second).rejects.toMatchObject({ code: 'PI_MODEL_DUPLICATE' });
    expect(JSON.parse(await readFile(file, 'utf8')).providers.custom.models).toEqual([{ id: 'model-2' }]);
  });

  it('seeds a missing provider from validated provider metadata', async () => {
    const { file, store } = await createStore();
    await expect(store.addModel({ providerId: 'custom', model: { id: 'm1' } }))
      .rejects.toMatchObject({ code: 'PI_MODEL_CONFIG_INVALID' });
    await store.addModel({
      providerId: 'custom',
      model: { id: 'm1', name: 'M1', reasoning: true },
      seed: { label: 'Custom', baseUrl: 'https://api.example.test/v1', api: 'openai-responses' },
    });
    expect(JSON.parse(await readFile(file, 'utf8')).providers.custom).toEqual({
      name: 'Custom', baseUrl: 'https://api.example.test/v1', api: 'openai-responses',
      models: [{ id: 'm1', name: 'M1', reasoning: true }],
    });
  });

  it('rejects malformed supported fields without writing', async () => {
    const cases = [
      { id: '' },
      { id: 'm', name: ' ' },
      { id: 'm', contextWindow: 0 },
      { id: 'm', maxTokens: -1 },
      { id: 'm', input: [] },
      { id: 'm', input: ['audio'] },
      { id: 'm', input: ['text', 'text'] },
      { id: 'm', thinkingLevelMap: { ultra: 'x' } },
      { id: 'm', thinkingLevelMap: { low: 42 } },
    ];
    for (const model of cases) {
      const { file, store } = await createStore({ custom: customProvider([]) });
      const before = await readFile(file, 'utf8');
      await expect(store.addModel({ providerId: 'custom', model })).rejects.toMatchObject({ code: 'PI_MODEL_CONFIG_INVALID' });
      await expect(readFile(file, 'utf8')).resolves.toBe(before);
    }
  });

  it('reports malformed files explicitly', async () => {
    const { file, store } = await createStore();
    await writeFile(file, '{ invalid');
    await expect(store.get('custom')).rejects.toMatchObject({ code: 'PI_MODEL_CONFIG_INVALID' });
  });
});
