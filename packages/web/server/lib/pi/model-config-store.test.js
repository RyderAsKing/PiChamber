import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPiModelConfigStore } from './model-config-store.js';

describe('Pi models configuration store', () => {
  it('atomically writes a credential-blind custom provider while preserving unrelated Pi configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-models-'));
    const file = join(root, 'models.json');
    await writeFile(file, `// Pi accepts comments in models.json\n{ "providers": { "builtin": { "baseUrl": "https://proxy.test", "api": "openai-completions" } } }`);
    const store = createPiModelConfigStore({ file });

    await expect(store.update({
      providerId: 'custom-provider', label: 'Custom Provider', baseUrl: 'https://api.example.test/v1',
      models: [{ id: 'model-1', providerId: 'custom-provider', label: 'Model 1', contextWindow: 128_000, supportsThinking: true }],
      headers: { 'X-Client': 'PiChamber' }, apiKeyReference: '{env:CUSTOM_API_KEY}',
    })).resolves.toEqual({
      providerId: 'custom-provider', label: 'Custom Provider', baseUrl: 'https://api.example.test/v1', api: 'openai-completions',
      models: [{ id: 'model-1', providerId: 'custom-provider', label: 'Model 1', contextWindow: 128_000, supportsThinking: true }],
    });

    const persisted = JSON.parse(await readFile(file, 'utf8'));
    expect(persisted.providers.builtin).toEqual({ baseUrl: 'https://proxy.test', api: 'openai-completions' });
    expect(persisted.providers['custom-provider']).toMatchObject({ apiKey: '{env:CUSTOM_API_KEY}', headers: { 'X-Client': 'PiChamber' } });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(await store.get('custom-provider'))).not.toContain('CUSTOM_API_KEY');
    expect(JSON.stringify(await store.get('custom-provider'))).not.toContain('X-Client');
    await expect(store.get('amazon-bedrock')).resolves.toBeNull();
    await expect(store.get('builtin')).resolves.toBeNull();
  });

  it('keeps malformed Pi models configuration explicit and rejects unsafe updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pichamber-pi-models-'));
    const file = join(root, 'models.json');
    await writeFile(file, '{ invalid');
    const store = createPiModelConfigStore({ file });
    await expect(store.get('custom')).rejects.toMatchObject({ code: 'PI_MODEL_CONFIG_INVALID' });
    await expect(store.update({ providerId: '../unsafe', label: 'Unsafe', baseUrl: 'https://example.test', models: [] })).rejects.toMatchObject({ code: 'PI_MODEL_CONFIG_INVALID' });
  });
});
