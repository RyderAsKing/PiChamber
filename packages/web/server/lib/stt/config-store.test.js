import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSttConfigStore } from './config-store.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('STT config store', () => {
  test('persists provider credentials but redacts them from public configuration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pichamber-stt-'));
    roots.push(root);
    const file = path.join(root, 'stt', 'config.json');
    const store = createSttConfigStore({ file });
    await store.write({
      enabled: true,
      remoteProvider: { id: 'remote', baseUrl: 'https://speech.example/v1', model: 'whisper-1', apiKey: 'secret-value' },
      providerConfigId: 'remote',
    });
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.providers[0].apiKey).toBe('secret-value');
    expect(await store.readPublic()).toMatchObject({ providers: [{ id: 'remote', apiKeyConfigured: true }] });
    expect(JSON.stringify(await store.readPublic())).not.toContain('secret-value');
  });

  test('keeps an existing key when an update omits it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pichamber-stt-'));
    roots.push(root);
    const store = createSttConfigStore({ file: path.join(root, 'config.json') });
    await store.write({ remoteProvider: { id: 'remote', baseUrl: 'https://speech.example/v1', model: 'one', apiKey: 'kept' } });
    await store.write({ remoteProvider: { id: 'remote', baseUrl: 'https://speech.example/v1', model: 'two' } });
    expect((await store.read()).providers[0]).toMatchObject({ model: 'two', apiKey: 'kept' });
  });
});
