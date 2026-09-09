import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';

import { createPiSessionRuntime } from './session-daemon.js';
import { getPiSessionDirectory } from './session-jsonl.js';

// Exercise the installed SDK, not mocked catalogs or a developer's Pi home.
describe('pinned SDK upgrade compatibility', () => {
  let root;
  let server;
  let runtime;

  afterEach(async () => {
    await runtime?.dispose();
    runtime = undefined;
    if (server) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('restores an existing model cache and preserves custom models across refresh, 304, and failure', async () => {
    root = await mkdtemp(join(tmpdir(), 'pichamber-sdk-catalog-'));
    let responseStatus = 200;
    let remoteModels = [];
    const requests = [];
    server = createServer((request, response) => {
      requests.push({ url: request.url, etag: request.headers['if-none-match'] });
      response.writeHead(responseStatus, {
        'content-type': 'application/json',
        etag: '"upgrade-catalog"',
        'last-modified': 'Wed, 01 Jan 2031 00:00:00 GMT',
      });
      response.end(responseStatus === 200 ? JSON.stringify(remoteModels) : undefined);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const options = {
      authPath: join(root, 'auth.json'),
      modelsPath: join(root, 'models.json'),
      modelsStorePath: join(root, 'models-store.json'),
      catalogBaseUrl: `http://127.0.0.1:${server.address().port}`,
      allowModelNetwork: false,
    };
    const baseline = await ModelRuntime.create(options);
    expect(baseline.getModel('opencode', 'deepseek-v4-flash-free')).toBeUndefined();
    const flash = baseline.getModel('opencode', 'deepseek-v4-flash');
    expect(flash).toBeDefined();
    const cached = { ...flash, id: 'upgrade-cached-model', name: 'Cached model' };
    await writeFile(options.modelsStorePath, JSON.stringify({
      opencode: { models: [cached], checkedAt: Date.now(), lastModified: Date.UTC(2030, 0, 1), etag: '"old-catalog"' },
    }));
    const customConfig = JSON.stringify({ providers: { opencode: {
      baseUrl: 'https://opencode.ai/zen/v1',
      models: [{ id: 'upgrade-custom-model', name: 'My custom model', api: 'openai-completions', contextWindow: 8192, maxTokens: 1024 }],
      modelOverrides: { 'deepseek-v4-flash': { name: 'My Flash override' } },
    } } });
    await writeFile(options.modelsPath, customConfig);
    const models = await ModelRuntime.create(options);
    await models.setRuntimeApiKey('opencode', 'pichamber-test-catalog-only');
    expect(requests).toHaveLength(0);
    expect(models.getModel('opencode', cached.id)).toEqual(cached);
    expect(models.getModel('opencode', 'upgrade-custom-model')?.name).toBe('My custom model');
    expect(models.getModel('opencode', flash.id)?.name).toBe('My Flash override');
    expect(models.getModel('opencode', 'deepseek-v4-flash-free')).toBeUndefined();

    remoteModels = [{ ...flash, id: 'upgrade-remote-model', name: 'Remote model' }];
    const refresh = () => models.refresh({ providers: ['opencode'], allowNetwork: true, force: true, signal: AbortSignal.timeout(5000) });
    expect((await refresh()).errors.size).toBe(0);
    expect(requests).toEqual([{ url: '/api/models/providers/opencode', etag: '"old-catalog"' }]);
    expect(models.getModel('opencode', cached.id)).toBeUndefined();
    expect(models.getModel('opencode', remoteModels[0].id)).toBeDefined();

    responseStatus = 304;
    expect((await refresh()).errors.size).toBe(0);
    expect(requests.at(-1).etag).toBe('"upgrade-catalog"');
    // A non-retryable HTTP error makes failure deterministic without waiting for backoff.
    responseStatus = 403;
    expect((await refresh()).errors.has('opencode')).toBe(true);
    expect(models.getModel('opencode', remoteModels[0].id)).toBeDefined();
    expect(models.getModel('opencode', 'upgrade-custom-model')?.name).toBe('My custom model');
    expect(models.getModel('opencode', flash.id)?.name).toBe('My Flash override');
    expect(models.getModel('opencode', 'deepseek-v4-flash-free')).toBeUndefined();
    expect(await readFile(options.modelsPath, 'utf8')).toBe(customConfig);
    await models.removeRuntimeApiKey('opencode');

    const restarted = await ModelRuntime.create(options);
    expect(restarted.getModel('opencode', remoteModels[0].id)).toBeDefined();
    expect(restarted.getModel('opencode', 'upgrade-custom-model')).toBeDefined();
    expect(restarted.getModel('opencode', 'deepseek-v4-flash-free')).toBeUndefined();

    // Removal from the bundled catalog must not blacklist an explicit user model.
    const explicit = JSON.parse(customConfig);
    explicit.providers.opencode.models.push({ ...explicit.providers.opencode.models[0], id: 'deepseek-v4-flash-free' });
    await writeFile(options.modelsPath, JSON.stringify(explicit));
    const withExplicitModel = await ModelRuntime.create(options);
    expect(withExplicitModel.getModel('opencode', 'deepseek-v4-flash-free')?.name).toBe('My custom model');
  }, 30_000);

  it.each(['deepseek-v4-flash', 'deepseek-v4-flash-free'])('preserves a pre-upgrade v3 session and settings selecting %s', async (modelId) => {
    root = await mkdtemp(join(tmpdir(), 'pichamber-sdk-session-'));
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const sessionDir = getPiSessionDirectory({ cwd, agentDir });
    await mkdir(cwd, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    const timestamp = '2026-08-07T12:00:00.000Z';
    const sessionId = '26e6d482-9b6d-4b26-bc80-1a6b13b2b87c';
    const sessionFile = join(sessionDir, `2026-08-07T12-00-00-000Z_${sessionId}.jsonl`);
    // Literal v3 records preserve the old wire format independently of the new writer.
    const entries = [
      { type: 'session', version: 3, id: sessionId, timestamp, cwd },
      { type: 'model_change', id: '00000001', parentId: null, timestamp, provider: 'opencode', modelId },
      { type: 'thinking_level_change', id: '00000002', parentId: '00000001', timestamp, thinkingLevel: 'low' },
      { type: 'message', id: '00000003', parentId: '00000002', timestamp, message: { role: 'user', content: 'Existing question', timestamp: Date.parse(timestamp) } },
      { type: 'message', id: '00000004', parentId: '00000003', timestamp, message: {
        role: 'assistant', content: [{ type: 'text', text: 'Existing answer' }], provider: 'opencode', model: modelId, api: 'openai-completions', stopReason: 'stop', timestamp: Date.parse(timestamp),
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } },
      { type: 'custom', id: '00000005', parentId: '00000004', timestamp, customType: 'upgrade-extension', data: { enabled: true } },
      { type: 'label', id: '00000006', parentId: '00000005', timestamp, targetId: '00000003', label: 'Existing checkpoint' },
      { type: 'session_info', id: '00000007', parentId: '00000006', timestamp, name: 'Existing chat' },
    ];
    // Also covers the upstream fix for a session saved without a final newline.
    const original = entries.map((entry) => JSON.stringify(entry)).join('\n');
    await writeFile(sessionFile, original);
    const settingsFile = join(agentDir, 'settings.json');
    const settings = JSON.stringify({ defaultProvider: 'opencode', defaultModel: modelId, defaultThinkingLevel: 'low', compaction: { enabled: false } });
    await writeFile(settingsFile, settings);

    runtime = await createPiSessionRuntime({ cwd, agentDir, sessionFile });
    expect(runtime.session.sessionId).toBe(sessionId);
    expect(runtime.session.model?.id).not.toBe('deepseek-v4-flash-free');
    expect(runtime.session.messages.map((message) => message.content)).toEqual(['Existing question', [{ type: 'text', text: 'Existing answer' }]]);
    const manager = runtime.session.sessionManager;
    expect(manager.getSessionName()).toBe('Existing chat');
    expect(manager.getLabel('00000003')).toBe('Existing checkpoint');
    expect(manager.getEntry('00000005').data).toEqual({ enabled: true });
    // The SDK repairs only the missing line delimiter when opening the file.
    expect(await readFile(sessionFile, 'utf8')).toBe(`${original}\n`);
    manager.appendSessionInfo('Renamed after upgrade');
    await runtime.dispose();
    runtime = undefined;

    const saved = await readFile(sessionFile, 'utf8');
    expect(saved.startsWith(`${original}\n`)).toBe(true);
    const reopened = SessionManager.open(sessionFile, sessionDir, cwd);
    expect(reopened.getSessionId()).toBe(sessionId);
    expect(reopened.getSessionName()).toBe('Renamed after upgrade');
    expect(reopened.getEntries().slice(0, entries.length - 1)).toEqual(entries.slice(1));
    expect(await readFile(settingsFile, 'utf8')).toBe(settings);
  }, 30_000);
});
